/* DeepLink —— 入口与事件绑定 */
(function () {
  const $ = UI.$;
  const state = {
    settings: null,
    sessionId: "",
    attachments: [],
    abort: null,
    busy: false,
    selecting: false,
    selected: null,
    editCtx: null,
    histMode: "time",
    msgWin: null,
    msgAnchor: null,
    /* 正在流式的那条消息节点 + 它属于哪个会话：
       生成期间别处触发 renderMessages() 时靠它把节点挂回去，
       否则整列重建会把这条回复（连思考）一起冲掉。 */
    streamEl: null,
    streamSid: "",
    /* 发送闸门：从点发送到真正进入 runGeneration 之间有一小段「异步等待」
       （等图片描述拿回来，可能几秒），这期间 state.busy 还没置位。
       不额外上个锁，用户在这窗口里再点一次就会开出第二条生成、彼此覆盖 abort 与流式节点。 */
    sending: false
  };

  /* 录音态跨模块共享：chat.js 的 toggleMic 与 app.js 的 syncToggles 都要读写，
     let 基本类型没法跨文件传引用，所以放进对象。 */
  const audioState = { recording: false };

  /* ── 启动动画：等「首屏渲染完成」再撤，**不提供「点击跳过」**────
     踩过的坑：以前点任意处会走 hideSplash → UI.forceRepaint()
     （body 先 display:none 再还原）。启动还没跑完时被点一下，
     Chrome 83 的 WebView 会把整页渲染搞乱（白屏/错版）。
     所以跳过整个砍掉，只保留「自动收尾」，并且把 forceRepaint 也去掉。

     【为什么要等就绪，而不是按固定时间】入场动画自跑到 2.4s，而 init() 里
     unlockMemory / 数据迁移 / renderAll 可能更久；#app 从一开始就在 DOM 里、
     只是被启动页盖着 —— 固定时间一到就把盖子掀了，用户会看到「还没画完就进应用」。
     另：pageshow / focus 在【首次加载】时也会触发，不是只在恢复时，
     所以它们同样必须过闸门，不能再直接 hideSplash。

     撤的条件 = ① window.__deeplinkReady（init 首屏渲染完成）且 ② 已跑满 SPLASH_MIN_MS。
     另设 SPLASH_MAX_MS 兜底：init 出错也不会让启动页永远盖着。
     触发入口（都走同一闸门 requestSplashHide，谁先满足谁撤）：
       ① init() 渲染完成后主动调
       ② 页面重新可见 / pageshow / focus（切后台、录屏、投屏回来，定时器可能被冻过）
       ③ 兜底最长 SPLASH_MAX_MS
       ④ index.html 内联脚本里还有一档纯 DOM 兜底（不依赖任何 JS 模块） */
  const SPLASH_MIN_MS = 2600;   /* 入场动画自跑到 2.4s（版权行 1.6s 起 +0.8s），早于此会「没播完就闪走」 */
  const SPLASH_MAX_MS = 9000;   /* 兜底：init 出错或迟迟不就绪，也别让启动页一直盖着 */
  const splashStartTs = Date.now();
  let splashGone = false;
  function hideSplash() {
    const el = document.getElementById("splash");
    if (el) {
      if (el.className.indexOf("hide") < 0) el.className += " hide";
      el.style.pointerEvents = "none";
    }
    if (splashGone) return;
    splashGone = true;
    const kill = () => { if (el && el.parentNode) el.parentNode.removeChild(el); };
    setTimeout(kill, 620);
    setTimeout(kill, 1600);
  }
  /* 统一闸门：非 force 时，必须「渲染完成 + 动画跑满」才撤；差哪条就再等。 */
  function requestSplashHide(force) {
    const elapsed = Date.now() - splashStartTs;
    if (!force && elapsed < SPLASH_MIN_MS) {
      setTimeout(function () { requestSplashHide(false); }, SPLASH_MIN_MS - elapsed);
      return;
    }
    if (!force && !window.__deeplinkReady && elapsed < SPLASH_MAX_MS) {
      setTimeout(function () { requestSplashHide(false); }, 120);
      return;
    }
    hideSplash();
  }
  setTimeout(function () { requestSplashHide(true); }, SPLASH_MAX_MS);   /* 兜底强撤 */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) setTimeout(function () { requestSplashHide(false); }, 150);
  });
  window.addEventListener("pageshow", function () { setTimeout(function () { requestSplashHide(false); }, 150); });
  window.addEventListener("focus", function () { setTimeout(function () { requestSplashHide(false); }, 150); });

  /* 软键盘遮挡：安卓 WebView 里 100vh 不随键盘收缩（vh 钉在最大视口上），
     键盘一弹输入框就被盖住。改成实时量可视视口高度喂给 --app-h（见 app.css 的 #app）。 */
  let lastViewH = 0;
  function syncViewportHeight() {
    const vv = window.visualViewport;
    const h = Math.round((vv && vv.height) ? vv.height : window.innerHeight);
    if (!(h > 0)) return;
    const shrank = lastViewH > 0 && h < lastViewH - 40; /* 缩小一大截 ≈ 键盘弹起 */
    lastViewH = h;
    document.documentElement.style.setProperty("--app-h", h + "px");
    /* 键盘弹起时，如果焦点在输入框里，把最新消息顶上来，免得最后几条被切掉 */
    if (shrank) {
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
      if (typing) {
        try { if (window.UI && UI.scrollToBottom) requestAnimationFrame(UI.scrollToBottom); } catch (e) { /* 忽略 */ }
      }
    }
  }
  syncViewportHeight();
  window.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", syncViewportHeight);
  document.addEventListener("focusin", function () { setTimeout(syncViewportHeight, 320); });
  document.addEventListener("focusout", function () { setTimeout(syncViewportHeight, 120); });

  /* 未捕获错误提示出来，方便定位（只报前几条，网络类错误不扰民） */
  let errToasts = 0;
  window.addEventListener("error", (e) => {
    const msg = e && e.message ? e.message : "未知错误";
    console.error("[DeepLink] 运行时错误：", msg, e && e.filename, e && e.lineno);
    if (errToasts >= 2 || /Failed to fetch|NetworkError|Load failed/i.test(msg)) return;
    errToasts++;
    try { UI.toast("运行时错误：" + msg, true); } catch (e2) { /* UI 未就绪 */ }
  });

  function isTouch() {
    return ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
  }

  function session() {
    return Store.getSessions().find((s) => s.id === state.sessionId) || null;
  }

  function sessionById(id) {
    return Store.getSessions().find((x) => x.id === id) || null;
  }

  /* 按会话 id 写入，避免流式输出期间切换会话把回复写错地方 */
  function appendMessage(id, msg, title) {
    const list = Store.getSessions();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return null;
    if (!msg.ts) msg.ts = Date.now();
    list[i].messages.push(msg);
    if (title) list[i].title = title;
    list[i].updatedAt = Date.now();
    Store.saveSessions(list);
    return list[i];
  }

  /* ── 渲染 ──────────────────────────────────────── */
  function agentId() {
    return state.settings.roleplayEnabled ? (state.settings.activeCharacterId || "") : "";
  }
  function characterFor(s) {
    const id = s && s.characterId ? s.characterId : "";
    if (!id) return null;
    return Store.getCharacters().find((c) => c.id === id) || null;
  }
  function activeCharacter() {
    const id = state.settings.activeCharacterId || "";
    return id ? (Store.getCharacters().find((c) => c.id === id) || null) : null;
  }

  function renderSessionList() {
    const aid = agentId();
    const list = Store.getSessions().filter((s) => (s.characterId || "") === aid);
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    UI.sessionListEl(list, state.sessionId, {
      onOpen(id) {
        exitSelect();
        state.sessionId = id;
        Store.setCurrentId(id);
        closeSidebar();
        renderAll();
      },
      onLongPress(id) { openRowMenu("session", id); },
      async onDelete(id) {
        const ok = await UI.confirmDialog("删除对话", "删除后无法恢复，确定吗？");
        if (!ok) return;
        exitSelect();
        Store.deleteSession(id);
        const remaining = Store.getSessions().filter((s) => (s.characterId || "") === aid);
        if (state.sessionId === id) state.sessionId = remaining[0] ? remaining[0].id : "";
        if (!remaining.length) newSession();
        else renderAll();
      }
    });
    renderCharBar();
  }

  function renderAll() {
    const s = session();
    if (s && sweepImageExpiry(s)) Store.saveSessions(Store.getSessions());
    const ch = characterFor(s);
    setText("#chatTitle", s ? (s.title || (ch ? ch.name : "新对话")) : "新对话");
    setText("#modelBadge", state.settings.model);
    renderSessionList();
    renderMessages();
    syncPlaceholder();
  }

  function newSession() {
    exitSelect();
    const aid = agentId();
    const s = Store.createSession(aid);
    if (aid && !Store.getSessions().some((x) => (x.characterId || "") === aid && x.mainLine)) {
      Store.updateSession(s.id, { mainLine: true });
    }
    state.sessionId = s.id;
    renderAll();
  }

  function saveSession() { Store.saveSessions(Store.getSessions()); }
  function setMainLine(sid) {
    const s = sessionById(sid);
    if (!s) return;
    const aid = s.characterId || "";
    const list = Store.getSessions();
    /* 「主线」是【每个角色各自一条】：只改同角色的会话。
       之前对全表 forEach 会顺手把别的角色的主线标记也清掉（主线查询 characterMainSession、
       新建会话补齐主线都按角色过滤，三处语义必须一致）。 */
    list.forEach((x) => { if ((x.characterId || "") === aid) x.mainLine = (x.id === sid); });
    Store.saveSessions(list);
    renderSessionList();
    fillSessionForm(session());
    UI.toast("已把这条对话设为主线");
  }

  function openAbout() {
    const pv = packagedVersion();
    const cv = CONFIG.APP_VERSION || "";
    /* 只拿「版名」和前端版本比：打包版名（"4.5.2"）与版号（"452"）是两码事，
       早先直接拿拼好的 "4.5.2/452" 去比 "4.5.2"，恒不相等 → 告警次次误报。 */
    const pn = packagedName();
    const same = !pn || !cv || pn === cv;
    setText("#aboutVersion", "v" + cv + (pv ? ("（打包 " + pv + (same ? "" : "（与代码版本不一致，可能忘了重新打包）") + "）") : ""));
    UI.openModal("aboutModal");
  }

  function openSidebar() { $("#sidebar").classList.add("open"); $("#scrim").classList.add("show"); }
  function closeSidebar() { $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); }

  /* ── 原生桥相关的小工具（无桥时全部安全空转） ─────── */
  function packagedVersion() {
    const n = Store.callBridge("获取应用版名");
    const c = Store.callBridge("获取应用版号");
    if (!n && !c) return "";
    return String(n || "") + (c ? "/" + c : "");
  }
  /* 打包「版名」单独取一份，给版本一致性判断用（打包版号是 "452" 这种，不能混进来比） */
  function packagedName() {
    const n = Store.callBridge("获取应用版名");
    return n ? String(n).trim() : "";
  }
  function toB64(str) {
    try { return btoa(unescape(encodeURIComponent(str))); } catch (e) { return ""; }
  }
  function jsonDataUrl(json) { return "data:application/json;base64," + toB64(json); }
  function exportFileName(kind) { return "DeepLink-" + kind + ".json"; }

  function applyNoImage(v) {
    /* 只靠 CSS 隐藏聊天里的图（原生的「无图显示」会把头像也一起隐藏，所以不用它） */
    document.body.classList.toggle("no-image", !!v);
  }

  function setBusy(busy, showStop) {
    const was = state.busy;
    state.busy = busy;
    setDisabled("#sendBtn", busy);
    $("#stopBtn").hidden = !(busy && showStop !== false);
    Store.callBridge("设置屏幕常亮", !!busy);   /* 生成中别让屏幕黑掉 */
    if (busy) { busySid = state.sessionId; genHiddenSeen = document.hidden; }   /* 记下是哪条对话在生成（B3 通知要用） */
    else if (was) notifyGenDone();             /* 由忙转闲 = 生成结束 → 视情况发一条状态栏通知 */
  }

  /* 启动自检：这些 id 缺任何一个都可能让界面部分失灵 */
  const REQUIRED_IDS = "attachBtn attachmentBar audioInput avatarInput chatTitle customSearchField deleteCancel deleteList deleteOk dialogCancel dialogOk dialogText dialogTitle passModal passTitle passNote passInput passConfirmWrap passConfirm passOk passCancel pickModal pickTitle pickList replayIntroBtn resetSettingsBtn dataUsageLine dropHint editCancel editSave editText editTitle effortSelect effortWrap fileInput histFrom histKeyword histKeywordField histResults histSearchBtn histTimeField histTo imgChip imgToggle input main menuBtn messages micBtn modeBtn modeSwitch modelBadge modelPanel modelPanelList modelSwitchBtn msgMenuList rowMenuModal rowMenuList rowMenuTitle newChatBtn openSearchBtn openSettingsBtn openThemesBtn saveSettingsBtn scrim searchModeSwitch searchToggle selectBar selectCancel selectCopy selectCount selectDelete selfTestBtn selfTestOut sendBtn sessionBtn sessionList sessionPromptReset sessionPromptSave msetAsr msetImg msetMain msetTts msetVision providerNowLine setAsrEnabled setAsrLang setAvatarAiClear setAvatarAiPick setAvatarAiPreview setAvatarUserClear setAvatarUserPick setAvatarUserPreview setCustomKey setCustomUrl setImgEnabled setImgSize setMainCompat setInstances setSearchProvider setSessionAlias setSessionAvatarAiClear setSessionAvatarAiPick setSessionAvatarAiPreview setSessionAvatarUserClear setSessionAvatarUserPick setSessionAvatarUserPreview setSessionFollow setSessionPrompt setSessionTempVal setSessionTemperature setSessionTitle setSessionTopP setSessionTopPVal setSessionScene setSessionSceneEvery setSessionRelation setSessionShared setSessionCognition setSessionAutoBackup sessionRoleWrap sessionMemoryBox charMemoryBox setMemoryList sessionLineBadge sessionCognitionUpdate sessionRelationUpdate sessionReCompress sessionCorrectInput sessionCorrectRun sessionBackupNow sessionRestoreBackup sessionSetMain setSystemPrompt setTavilyKey setTempVal setTemperature setTopP setTopPVal setTtsAuto setTtsEnabled setTtsVoice setVisionEnabled sidebar stopBtn tavilyField themeGrid thinkToggle toasts characterBtn charBar characterModal charList charNewBtn charForm charEmpty charTools charName charSave charFilterRule charFilterEvery charFilterAI charFilterNow charFilterState charSplitBtn charSplitHelp charSplitHint charSplitPanel charSplitInput charSplitRun charSplitCancel charSplitState openAboutBtn aboutModal aboutVersion openDataBtn dataModal exportScope exportCharWrap exportCharSel exportSessionWrap exportSessionSel exportKeys exportDownload exportCopy importText importFileBtn importTextBtn importFileInput importClipBtn exportShare clearCacheBtn setNoImage setNotifyTasks introModal introTree introDots introNext introPrev introSkip guideTree setImgToText setImgExpireTurns charUsageLine usageModal usageGlobal usageSessions usageChars openUsageBtn setRoleplayEnabled setMyName setMyPersona setMyAppearance setMyBackground setMyLikes setAssistantCompress setCompressModel setTokenWarn setBgKeep sessionMakeShortcut sessionRemoveShortcut charMakeShortcut charRemoveShortcut exportNoImg setLockEnabled setLockNote setLockChange setLockCode setLockState lockScreen lockPassBox lockInput lockOk lockForgot lockErr lockRecoverBox recInput recOk recAi recBack recErr recNote lockQuizBox quizNote quizQ quizA quizOk quizBack quizErr lockResetBox resetNote resetPass1 resetPass2 resetOk resetBack resetErr lockDeadBox deadNote deadOk codeScreen codeText codeCopy codeOk".split(" ");
  function missingIds() { return REQUIRED_IDS.filter((id) => !document.getElementById(id)); }

  /* ── 空值安全的表单读写（元素缺失时不再抛异常）──── */
  const $v = (sel) => { const el = $(sel); return el ? String(el.value == null ? "" : el.value) : ""; };
  const checkedOf = (sel) => { const el = $(sel); return !!(el && el.checked); };
  const setVal = (sel, v) => { const el = $(sel); if (el) el.value = (v == null ? "" : v); };
  const setChecked = (sel, v) => { const el = $(sel); if (el) el.checked = !!v; };
  const setText = (sel, t) => { const el = $(sel); if (el) el.textContent = t; };
  const setDisplay = (sel, d) => { const el = $(sel); if (el) el.style.display = d; };
  const setDisabled = (sel, d) => { const el = $(sel); if (el) el.disabled = !!d; };
  const setHidden = (sel, hide) => { const el = $(sel); if (el) el.hidden = !!hide; };

  /* ── 头像 ──────────────────────────────────────── */
  function effectiveAvatar(role, s) {
    const ses = s || session();
    const key = role === "user" ? "avatarUser" : "avatarAi";
    const sessVal = ses && ses[key] ? ses[key] : "";
    const globVal = state.settings[key] || "";
    return sessVal || globVal || "";
  }

  /* 头像草稿存在 JS 里：不依赖 <input type="hidden">（封装工具可能把它剔掉） */
  const avatarDraft = { settingsUser: "", settingsAi: "", sessionUser: "", sessionAi: "" };

  function renderAvatarPreview(previewSel, url, role, fallback) {
    const box = $(previewSel);
    if (!box) return;
    const shown = url || fallback || "";
    box.innerHTML = "";
    if (shown) {
      const im = document.createElement("img");
      im.src = shown;
      im.alt = "";
      box.appendChild(im);
    } else {
      box.innerHTML = UI.iconSvg(role === "user" ? "account" : "creation");
    }
  }

  /* 读本地图片，居中裁剪成 192×192 JPEG 数据 URL */
  function readAvatarFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type || "")) { reject(new Error("请选择图片文件")); return; }
      const fr = new FileReader();
      fr.onload = () => {
        const raw = String(fr.result || "");
        const img = new Image();
        img.onload = () => {
          const size = 192;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          const scale = Math.max(size / img.width, size / img.height);
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          ctx.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
          try { resolve(canvas.toDataURL("image/jpeg", 0.85)); }
          catch (e) { resolve(raw); }
        };
        img.onerror = () => reject(new Error("图片读取失败"));
        img.src = raw;
      };
      fr.onerror = () => reject(new Error("图片读取失败"));
      fr.readAsDataURL(file);
    });
  }

  /* ── 消息操作 ──────────────────────────────────── */

  /* ── 设置 ──────────────────────────────────────── */

  /* 空值安全的绑定：bind() 与拆分出去的模块共用（提到模块作用域，便于暴露给模块） */
  const on = (sel, evt, fn, opts) => {
    const el = $(sel);
    if (!el) { console.warn("[DeepLink] 缺少元素：" + sel); return null; }
    el.addEventListener(evt, fn, opts);
    return el;
  };

  /* ── 转发到 chat.js（拆分阶段②）───────────────────
     chat.js 在 index.html 里排在 app.js 之后加载，届时 window.DL 已补齐这些成员。
     app.js 里对它们的调用点保持原样、函数体一个字没改，这里只在运行时转发过去。
     ⚠️ 不要在下面的 window.DL 字面量里再写这些名字 —— 那会转发到它自己，无限递归。 */
  function send() { return window.DL.send.apply(null, arguments); }
  function stop() { return window.DL.stop.apply(null, arguments); }
  function addFiles() { return window.DL.addFiles.apply(null, arguments); }
  function toggleMic() { return window.DL.toggleMic.apply(null, arguments); }
  function doTranscribe() { return window.DL.doTranscribe.apply(null, arguments); }
  function stopRead() { return window.DL.stopRead.apply(null, arguments); }
  function autoResize() { return window.DL.autoResize.apply(null, arguments); }
  function exitSelect() { return window.DL.exitSelect.apply(null, arguments); }
  function saveEdit() { return window.DL.saveEdit.apply(null, arguments); }
  function copySelected() { return window.DL.copySelected.apply(null, arguments); }
  function openDeleteDialog() { return window.DL.openDeleteDialog.apply(null, arguments); }
  function confirmDelete() { return window.DL.confirmDelete.apply(null, arguments); }
  function bindMessageGestures() { return window.DL.bindMessageGestures.apply(null, arguments); }
  function runHistorySearch() { return window.DL.runHistorySearch.apply(null, arguments); }
  function openSearchModal() { return window.DL.openSearchModal.apply(null, arguments); }
  function renderMessages() { return window.DL.renderMessages.apply(null, arguments); }
  function sweepImageExpiry() { return window.DL.sweepImageExpiry.apply(null, arguments); }
  function syncPlaceholder() { return window.DL.syncPlaceholder.apply(null, arguments); }

  /* ── 转发到 roleplay.js（拆分阶段③）────────────────
     roleplay.js 在 index.html 里排在 app.js 之后加载，届时 window.DL 已补齐这些成员。
     app.js 里对它们的调用点保持原样、函数体一个字没改，这里只在运行时转发过去。
     ⚠️ 不要在下面的 window.DL 字面量里再写这些名字 —— 那会转发到它自己，无限递归。 */
  function saveChar() { return window.DL.saveChar.apply(null, arguments); }
  function renderCharBar() { return window.DL.renderCharBar.apply(null, arguments); }
  function openRowMenu() { return window.DL.openRowMenu.apply(null, arguments); }
  function renderSettingsMemory() { return window.DL.renderSettingsMemory.apply(null, arguments); }
  function runCharSplit() { return window.DL.runCharSplit.apply(null, arguments); }
  function fillCharacterForm() { return window.DL.fillCharacterForm.apply(null, arguments); }
  function saveCharacter() { return window.DL.saveCharacter.apply(null, arguments); }
  function newCharacter() { return window.DL.newCharacter.apply(null, arguments); }
  function updateCognitionNow() { return window.DL.updateCognitionNow.apply(null, arguments); }
  function updateRelationSharedNow() { return window.DL.updateRelationSharedNow.apply(null, arguments); }
  function runMemoryCorrect() { return window.DL.runMemoryCorrect.apply(null, arguments); }
  function runReCompress() { return window.DL.runReCompress.apply(null, arguments); }
  function washFilterNow() { return window.DL.washFilterNow.apply(null, arguments); }
  function aiFilterRule() { return window.DL.aiFilterRule.apply(null, arguments); }
  function maybeAutoWash() { return window.DL.maybeAutoWash.apply(null, arguments); }
  function openCharacterModal() { return window.DL.openCharacterModal.apply(null, arguments); }
  function maybeAutoCompress() { return window.DL.maybeAutoCompress.apply(null, arguments); }
  function syncSessionParamFields() { return window.DL.syncSessionParamFields.apply(null, arguments); }
  function fillSessionForm() { return window.DL.fillSessionForm.apply(null, arguments); }

  /* ── 转发到 settings.js（拆分阶段④）────────────────
     settings.js 在 index.html 里排在 app.js 之后加载，届时 window.DL 已补齐这些成员。
     app.js 里对它们的调用点保持原样、函数体一个字没改，这里只在运行时转发过去。
     ⚠️ 不要在下面的 window.DL 字面量里再写这些名字 —— 那会转发到它自己，无限递归。 */
  function openIntro() { return window.DL.openIntro.apply(null, arguments); }
  function introShow() { return window.DL.introShow.apply(null, arguments); }
  function introFinish() { return window.DL.introFinish.apply(null, arguments); }
  function introNext() { return window.DL.introNext.apply(null, arguments); }
  function introPrev() { return window.DL.introPrev.apply(null, arguments); }
  function doExportDownload() { return window.DL.doExportDownload.apply(null, arguments); }
  function doExportShare() { return window.DL.doExportShare.apply(null, arguments); }
  function doExportCopy() { return window.DL.doExportCopy.apply(null, arguments); }
  function importFromText() { return window.DL.importFromText.apply(null, arguments); }
  function importFromFile() { return window.DL.importFromFile.apply(null, arguments); }
  function syncExportScope() { return window.DL.syncExportScope.apply(null, arguments); }
  function openData() { return window.DL.openData.apply(null, arguments); }
  function saveImage() { return window.DL.saveImage.apply(null, arguments); }
  function maybeAutoBackup() { return window.DL.maybeAutoBackup.apply(null, arguments); }
  function backupNow() { return window.DL.backupNow.apply(null, arguments); }
  function restoreBackupNow() { return window.DL.restoreBackupNow.apply(null, arguments); }
  function renderBackupLine() { return window.DL.renderBackupLine.apply(null, arguments); }
  function renderCharUsage() { return window.DL.renderCharUsage.apply(null, arguments); }
  function recordUsage() { return window.DL.recordUsage.apply(null, arguments); }
  function renderUsageStats() { return window.DL.renderUsageStats.apply(null, arguments); }
  function migrateData() { return window.DL.migrateData.apply(null, arguments); }
  function resetGroup() { return window.DL.resetGroup.apply(null, arguments); }
  function resetAllSettings() { return window.DL.resetAllSettings.apply(null, arguments); }
  function fillSettings() { return window.DL.fillSettings.apply(null, arguments); }
  function syncRangeLabels() { return window.DL.syncRangeLabels.apply(null, arguments); }
  function syncProviderFields() { return window.DL.syncProviderFields.apply(null, arguments); }
  function readSettingsForm() { return window.DL.readSettingsForm.apply(null, arguments); }
  function syncChip() { return window.DL.syncChip.apply(null, arguments); }
  function syncToggles() { return window.DL.syncToggles.apply(null, arguments); }
  function selfTest() { return window.DL.selfTest.apply(null, arguments); }

  /* ── 转发到 settings.js（D2 应用加密 / 锁屏层）─────── */
  function lockSubmit() { return window.DL.lockSubmit.apply(null, arguments); }
  function lockForgot() { return window.DL.lockForgot.apply(null, arguments); }
  function lockBackToPass() { return window.DL.lockBackToPass.apply(null, arguments); }
  function recSubmit() { return window.DL.recSubmit.apply(null, arguments); }
  function quizStart() { return window.DL.quizStart.apply(null, arguments); }
  function quizSubmit() { return window.DL.quizSubmit.apply(null, arguments); }
  function quizGiveUp() { return window.DL.quizGiveUp.apply(null, arguments); }
  function lockResetSave() { return window.DL.lockResetSave.apply(null, arguments); }
  function lockResetBack() { return window.DL.lockResetBack.apply(null, arguments); }
  function lockQuit() { return window.DL.lockQuit.apply(null, arguments); }
  function lockToggle() { return window.DL.lockToggle.apply(null, arguments); }
  function lockChangePass() { return window.DL.lockChangePass.apply(null, arguments); }
  function lockResetCode() { return window.DL.lockResetCode.apply(null, arguments); }
  function codeCopy() { return window.DL.codeCopy.apply(null, arguments); }
  function codeClose() { return window.DL.codeClose.apply(null, arguments); }

  /* ══════════ B 批：返回键 / 桌面快捷方式 / 后台常驻与通知 ══════════
     全部经 Store.callBridge（无桥时安全空转）→ 浏览器 / 无头测试 / 预览里行为完全不变。
     接口签名以产物里的 assets/lib/jointapi.txt 为准，不靠猜。 */

  /* ── B1 接管返回键 ──────────────────────────────────
     接管是全覆盖的：原来「连按两次退出」由原生提供，接管后必须自己实现。
     优先级：相机层 → 任意打开着的弹窗 → 侧栏 → 多选态 → 都没有才「再按一次退出」。 */
  let backAt = 0;
  function topOpenModalId() {
    /* 取文档里最后一个带 .show 的 .modal：越靠后的弹窗越可能是后开的。
       为什么不用「调用栈」：ui.js 内部（confirmDialog / pickOpen）直接调的是自己的
       openModal，不走 UI.openModal，所以从外面包一层是接不住的 —— 查 DOM 才全覆盖。 */
    const all = document.querySelectorAll(".modal.show");
    for (let i = all.length - 1; i >= 0; i--) {
      const id = all[i].id;
      /* 首次引导有自己的「跳过」按钮，返回键不关它（关了下次启动还会再弹一次） */
      if (id && id !== "introModal") return id;
    }
    return "";
  }
  function onBackKey() {
    try {
      /* 1) 相机层（它是 .camera-layer，不在 .modal 里，要单独判） */
      const cam = window.DL && window.DL.camera;
      if (cam && typeof cam.isOpen === "function" && cam.isOpen()) { cam.close(); return; }
      /* 2) 任意打开着的弹窗 */
      const mid = topOpenModalId();
      if (mid) { UI.closeModal(mid); return; }
      /* 3) 侧栏 */
      const sb = $("#sidebar");
      if (sb && sb.classList.contains("open")) { closeSidebar(); return; }
      /* 4) 多选态 */
      if (state.selecting) { exitSelect(); return; }
      /* 5) 都没有 → 2 秒内按第二次才真退出 */
      const now = Date.now();
      if (now - backAt < 2000) { Store.callBridge("关闭应用退出"); return; }
      backAt = now;
      UI.toast("再按一次返回键退出");
    } catch (e) { console.warn("[DeepLink] 返回键处理出错", e); }
  }
  function bindBackKey() {
    try {
      window.__dlOnBackKey = onBackKey;
      if (Store.hasBridge("自定义返回键")) Store.callBridge("自定义返回键", "window.__dlOnBackKey()");
    } catch (e) { console.warn("[DeepLink] 返回键接管失败", e); }
  }

  /* ── B2 桌面快捷方式 ────────────────────────────────
     ⚠️ 真实签名（jointapi.txt）：
        添加快捷方式('快捷名称', 'base64图标', '脚本', id, 长按显示)
        第 1 参是【名称】、第 4 参才是【id】。需求文档里写的 (id, 图标, 脚本, 1, false) 顺序是错的。
     图标先传空串（用 App 默认图标，最稳）。id 用 "dl-shortcut-<会话id>" 固定派生，便于移除。 */
  const SHORTCUT_PREFIX = "dl-shortcut-";
  function shortcutIdFor(sid) { return SHORTCUT_PREFIX + String(sid || ""); }

  /* 用快捷方式冷启动时，脚本可能早于 init 就跑到了 → 先挂起，init 完成后再进那条对话 */
  let pendingOpenId = "";
  let inited = false;
  function openSessionById(id) {
    const s = sessionById(id);
    if (!s) { UI.toast("这条对话已经不在了", true); return false; }
    exitSelect();
    state.sessionId = s.id;
    Store.setCurrentId(s.id);
    closeSidebar();
    renderAll();
    return true;
  }
  window.__dlOpen = function (id) {
    try {
      const sid = String(id == null ? "" : id);
      if (!sid) return;
      if (!inited) { pendingOpenId = sid; return; }
      openSessionById(sid);
    } catch (e) { console.warn("[DeepLink] 打开指定对话失败", e); }
  };

  function shortcutNameOf(s) {
    if (!s) return "DeepLink";
    const t = String(s.title || "").trim();
    if (t && t !== "新对话") return t;
    const ch = characterFor(s);
    return ch && ch.name ? ch.name : "DeepLink";
  }
  function makeShortcut(s) {
    if (!s) { UI.toast("先选一条对话", true); return; }
    if (!Store.hasBridge("添加快捷方式")) { UI.toast("当前环境不支持创建桌面快捷方式", true); return; }
    /* 有些桌面/系统不支持，先问一次（不支持就别报「已创建」骗人） */
    if (Store.hasBridge("判断快捷方式") && Store.callBridge("判断快捷方式") === false) {
      UI.toast("这台设备不支持添加快捷方式", true);
      return;
    }
    const name = shortcutNameOf(s);
    let ret;
    try { ret = Store.callBridge("添加快捷方式", name, "", "window.__dlOpen('" + s.id + "')", shortcutIdFor(s.id), false); }
    catch (e) { UI.toast("创建桌面快捷方式失败：" + (e.message || e), true); return; }
    /* 原生多半不返回结果；只有明确 false 才敢断定失败。别再无脑报「已创建」——
       真机上出现过「提示已创建、桌面上却没有」的情况。 */
    if (ret === false) { UI.toast("系统拒绝了创建请求，没能添加桌面快捷方式", true); return; }
    UI.toast("已请求添加桌面快捷方式「" + name + "」；若桌面仍没出现图标，说明这台设备的桌面不支持，可在设置里跑自检看「原生接口诊断」");
  }
  function removeShortcut(s) {
    if (!s) { UI.toast("先选一条对话", true); return; }
    if (!Store.hasBridge("移除快捷方式")) { UI.toast("当前环境不支持移除快捷方式", true); return; }
    Store.callBridge("移除快捷方式", shortcutIdFor(s.id));
    UI.toast("已移除该对话的桌面快捷方式");
  }
  /* 角色弹窗用：这个角色的「主线」对话（没有主线就取它第一条） */
  function characterMainSession(ch) {
    if (!ch) return null;
    const list = Store.getSessions().filter((s) => (s.characterId || "") === ch.id);
    if (!list.length) return null;
    return list.find((s) => s.mainLine) || list[0];
  }

  /* ── B3 后台常驻 + 完成通知（设置开关，默认关）───────
     开启后：① 允许转后台持续运行 ② 引导「电池不优化」权限 ③ 生成完成时（且 App 在后台）
     发一条状态栏通知，点通知直接回到那条对话。 */
  let busySid = "";
  let notifNagShown = false;
  /* 本轮生成期间是否「切到过后台」。不能只看生成结束那一刻的 document.hidden：
     切后台时 WebView 常被挂起，生成回调要等人回到前台才跑，那时 hidden 已经是 false
     → 一律判成「人看着」，通知永远发不出来（真机实测就是这个现象）。 */
  let genHiddenSeen = false;
  function notifyBgKeepHint() {
    if (notifNagShown) return;
    notifNagShown = true;
    UI.toast("后台常驻已开启：建议允许通知，否则生成完成后收不到提醒", true);
  }
  async function applyBgKeep(silent) {
    const on = !!state.settings.bgKeep;
    Store.callBridge("设置后台状态", on);   /* 语义：true = 允许转后台持续运行 */
    if (!on) return;
    /* 电池优化权限：没给就引导一次（用户拒绝也不影响本机其它功能） */
    if (Store.hasBridge("判断优化权限") && Store.callBridge("判断优化权限") === false && !silent) {
      const ok = await UI.confirmDialog("后台常驻", "系统可能限制后台运行。是否现在申请「电池不优化」权限？");
      if (ok && Store.hasBridge("申请优化权限")) Store.callBridge("申请优化权限");
    }
    if (Store.hasBridge("判断通知权限") && Store.callBridge("判断通知权限") === false) notifyBgKeepHint();
  }
  /* 生成结束（setBusy 由 true 变 false）时调用：只在「切到后台」时才打扰用户 */
  function notifyGenDone() {
    /* 先取值再复位：无论后面哪一步 return 都不能把这个标记留下 */
    const wasBg = document.hidden || genHiddenSeen;
    genHiddenSeen = false;
    if (!state.settings || !state.settings.bgKeep) return;
    if (!wasBg) return;                                  /* 全程都在前台看着，不打扰 */
    if (!Store.hasBridge("发送状态栏内容")) return;
    let granted = null;
    try { if (Store.hasBridge("判断通知权限")) granted = Store.callBridge("判断通知权限"); }
    catch (e) { granted = null; }
    if (granted === false) {                             /* 被屏蔽了：引导去开，别白发 */
      if (Store.hasBridge("打开通知设置")) Store.callBridge("打开通知设置");
      return;
    }
    const sid = busySid || state.sessionId || "";
    const s = sid ? sessionById(sid) : null;
    const body = s ? ("「" + shortcutNameOf(s) + "」的新回复已经好了") : "新的回复已经好了";
    /* 通知 id 固定为 1：多次生成只留最新一条，不刷屏 */
    Store.callBridge("发送状态栏内容", 1, "生成完成", body, "window.__dlOpen('" + sid + "')");
  }

  /* ── 初始化 ────────────────────────────────────── */
  function bind() {
    /* 元素缺失也不能让后面的绑定中断（曾导致顶栏按钮全部失效） */    on("#menuBtn", "click", openSidebar);
    on("#scrim", "click", closeSidebar);
    on("#newChatBtn", "click", () => { newSession(); closeSidebar(); });
    on("#openSearchBtn", "click", () => { openSearchModal(); closeSidebar(); });

    on("#sendBtn", "click", send);
    on("#stopBtn", "click", stop);

    const input = $("#input");
    input.addEventListener("input", autoResize);
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.shiftKey) return;
      if (isTouch()) return;
      e.preventDefault();
      send();
    });

    on("#attachBtn", "click", () => $("#fileInput").click());
    on("#fileInput", "change", (e) => {
      if (e.target.files && e.target.files.length) addFiles(e.target.files);
      e.target.value = "";
    });

    on("#micBtn", "click", toggleMic);
    on("#audioInput", "change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) await doTranscribe(f, f.name || "audio.webm");
    });

    const AVATAR_FIELDS = [
      { draft: "settingsUser", pick: "#setAvatarUserPick", clear: "#setAvatarUserClear", preview: "#setAvatarUserPreview", role: "user" },
      { draft: "settingsAi", pick: "#setAvatarAiPick", clear: "#setAvatarAiClear", preview: "#setAvatarAiPreview", role: "assistant" },
      { draft: "sessionUser", pick: "#setSessionAvatarUserPick", clear: "#setSessionAvatarUserClear", preview: "#setSessionAvatarUserPreview", role: "user" },
      { draft: "sessionAi", pick: "#setSessionAvatarAiPick", clear: "#setSessionAvatarAiClear", preview: "#setSessionAvatarAiPreview", role: "assistant" }
    ];
    let avatarTarget = null;
    AVATAR_FIELDS.forEach((f) => {
      on(f.pick, "click", () => { avatarTarget = f; $("#avatarInput").click(); });
      on(f.clear, "click", () => {
        avatarDraft[f.draft] = "";
        renderAvatarPreview(f.preview, "", f.role);
      });
    });
    on("#avatarInput", "change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file || !avatarTarget) return;
      const t = avatarTarget;
      try {
        const url = await readAvatarFile(file);
        avatarDraft[t.draft] = url;
        renderAvatarPreview(t.preview, url, t.role);
      } catch (err) {
        UI.toast(err.message || "头像读取失败", true);
      }
    });

    on("#main", "dragover", (e) => { e.preventDefault(); const d = $("#dropHint"); if (d) d.classList.add("show"); });
    on("#main", "dragleave", (e) => {
      if (e.target === e.currentTarget) { const d = $("#dropHint"); if (d) d.classList.remove("show"); }
    });
    on("#main", "drop", (e) => {
      e.preventDefault();
      const d = $("#dropHint"); if (d) d.classList.remove("show");
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    document.addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.files;
      if (items && items.length) { addFiles(items); }
    });

    on("#searchToggle", "change", (e) => {
      state.settings = Store.saveSettings({ searchEnabled: e.target.checked });
      syncChip(e.target);
    });
    on("#thinkToggle", "change", (e) => {
      state.settings = Store.saveSettings({ thinkingEnabled: e.target.checked });
      syncChip(e.target);
      syncToggles();
    });
    on("#effortSelect", "change", (e) => {
      state.settings = Store.saveSettings({ reasoning: e.target.value });
    });
    on("#imgToggle", "change", (e) => {
      syncChip(e.target);
      syncPlaceholder();
    });

    on("#openSettingsBtn", "click", () => { fillSettings(); UI.openModal("settingsModal"); closeSidebar(); });

    /* 顶栏「主模型」按钮 → 自绘切换面板（面板内容的渲染在 settings.js 里） */
    on("#modelSwitchBtn", "click", (ev) => {
      ev.stopPropagation();
      window.DL.toggleModelPanel();
    });
    /* 点面板外面任意地方收起。面板自己与按钮要排除，否则一点就关。 */
    document.addEventListener("click", (ev) => {
      const panel = $("#modelPanel");
      if (!panel || panel.hidden) return;
      const t = ev.target;
      if (t && t.closest && (t.closest("#modelPanel") || t.closest("#modelSwitchBtn"))) return;
      window.DL.closeModelPanel();
    });
    on("#openThemesBtn", "click", () => {
      openThemeModal();
      UI.openModal("themeModal");
      closeSidebar();
    });
    on("#modeBtn", "click", toggleMode);

    document.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => UI.closeModal(btn.getAttribute("data-close")));
    });
    document.querySelectorAll(".modal").forEach((m) => {
      m.addEventListener("click", (e) => {
        /* 确认框（confirmDialog）的 Promise 只由「确定 / 取消」按钮 resolve。
           点蒙层直接 closeModal 会让它永远不 resolve —— 正在 await 它的流程
           （删除对话、申请后台权限…）就永久卡住，监听还会残留、下次叠加一份。
           所以确认框不走蒙层关闭，必须点按钮。 */
        if (m.id === "dialogModal") return;
        if (e.target === m) UI.closeModal(m.id);
      });
    });

    on("#setSearchProvider", "change", syncProviderFields);
    on("#setTemperature", "input", syncRangeLabels);
    on("#setTopP", "input", syncRangeLabels);

    on("#sessionBtn", "click", () => {
      fillSessionForm(session());
      UI.openModal("sessionModal");
    });
    on("#setSessionFollow", "change", syncSessionParamFields);
    on("#setSessionTemperature", "input", syncSessionParamFields);
    on("#setSessionTopP", "input", syncSessionParamFields);
    on("#sessionPromptReset", "click", () => {
      setVal("#setSessionPrompt", "");
    });
    on("#sessionPromptSave", "click", () => {
      const s = session();
      if (!s) return;
      const follow = checkedOf("#setSessionFollow");
      Store.updateSession(s.id, {
        title: $v("#setSessionTitle").trim() || "新对话",
        systemPrompt: $v("#setSessionPrompt").trim(),
        alias: $v("#setSessionAlias").trim(),
        temperature: follow ? null : Number($v("#setSessionTemperature")),
        topP: follow ? null : Number($v("#setSessionTopP")),
        avatarUser: avatarDraft.sessionUser,
        avatarAi: avatarDraft.sessionAi,
        scene: $v("#setSessionScene"),
        sceneEvery: Number($v("#setSessionSceneEvery")) || 10,
        relation: $v("#setSessionRelation"),
        shared: $v("#setSessionShared"),
        cognition: $v("#setSessionCognition"),
        autoBackup: checkedOf("#setSessionAutoBackup")
      });
      renderAll();
      syncPlaceholder();
      UI.closeModal("sessionModal");
      UI.toast("已保存");
    });
    on("#saveSettingsBtn", "click", () => {
      state.settings = Store.saveSettings(readSettingsForm());
      syncToggles();
      renderAll();
      stopRead();
      UI.closeModal("settingsModal");
      UI.toast("设置已保存");
      applyBgKeep();   /* B3：开关变了要同步给原生（后台状态 / 电池优化 / 通知权限） */
    });
    on("#setRoleplayEnabled", "change", (e) => {
      state.settings = Store.saveSettings({ roleplayEnabled: e.target.checked });
      renderAll();
    });
    on("#openUsageBtn", "click", () => { renderUsageStats(); UI.closeModal("settingsModal"); UI.openModal("usageModal"); });
    on("#openAboutBtn", "click", openAbout);
    on("#characterBtn", "click", openCharacterModal);
    on("#charNewBtn", "click", newCharacter);
    on("#charSave", "click", saveCharacter);
    /* B2：桌面快捷方式（角色弹窗 → 该角色的主线对话） */
    on("#charMakeShortcut", "click", () => {
      const ch = activeCharacter();
      if (!ch) { UI.toast("先选一个角色", true); return; }
      const s = characterMainSession(ch);
      if (!s) { UI.toast("这个角色还没有对话，先聊一句再建", true); return; }
      makeShortcut(s);
    });
    on("#charRemoveShortcut", "click", () => {
      const ch = activeCharacter();
      if (!ch) { UI.toast("先选一个角色", true); return; }
      const s = characterMainSession(ch);
      if (!s) { UI.toast("这个角色还没有对话", true); return; }
      removeShortcut(s);
    });
    document.querySelectorAll("[data-reset]").forEach((btn) => {
      btn.addEventListener("click", () => resetGroup(btn.getAttribute("data-reset")));
    });
    on("#resetSettingsBtn", "click", resetAllSettings);
    on("#replayIntroBtn", "click", () => { UI.closeModal("aboutModal"); openIntro(); });
    on("#importClipBtn", "click", () => {
      const txt = Store.callBridge("获取粘贴内容");
      if (!txt) { UI.toast("这里拿不到剪贴板，请手动粘贴", true); return; }
      setVal("#importText", String(txt));
      UI.toast("已从剪贴板填入");
    });
    on("#exportShare", "click", doExportShare);
    on("#clearCacheBtn", "click", () => {
      if (!Store.hasBridge("设置清空缓存")) { UI.toast("当前环境不支持清页面缓存", true); return; }
      Store.callBridge("设置清空缓存");
      UI.toast("已清理页面缓存，下次启动会重新加载");
    });
    on("#setNoImage", "change", () => {
      state.settings = Store.saveSettings({ noImage: checkedOf("#setNoImage") });
      applyNoImage(checkedOf("#setNoImage"));
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { if (state.busy) genHiddenSeen = true; return; }
      /* 回到前台就把「生成完成」那条状态栏通知收掉 */
      Store.callBridge("清空状态栏内容");
      if (state.settings.mode === "auto") applyThemeAll(false);
    });
    UI.pickBind($("#effortSelect"), "思考强度");
    UI.pickBind($("#setSearchProvider"), "联网搜索数据源");
    UI.pickBind($("#exportScope"), "导出范围");
    UI.pickBind($("#exportCharSel"), "选择角色");
    UI.pickBind($("#exportSessionSel"), "选择会话");
    on("#charSplitBtn", "click", () => { setHidden("#charSplitHint", true); setHidden("#charSplitPanel", false); });
    on("#charSplitHelp", "click", () => { const el = $("#charSplitHint"); if (el) el.hidden = !el.hidden; });
    on("#charSplitHint", "click", () => setHidden("#charSplitPanel", false));
    on("#charSplitCancel", "click", () => setHidden("#charSplitPanel", true));
    on("#charSplitRun", "click", runCharSplit);
    on("#charFilterAI", "click", aiFilterRule);
    on("#charFilterNow", "click", washFilterNow);
    on("#openDataBtn", "click", openData);
    on("#introNext", "click", introNext);
    on("#introPrev", "click", introPrev);
    on("#introSkip", "click", introFinish);
    on("#exportScope", "change", syncExportScope);
    on("#exportDownload", "click", doExportDownload);
    on("#exportCopy", "click", doExportCopy);
    on("#importTextBtn", "click", importFromText);
    on("#importFileBtn", "click", () => { const el = $("#importFileInput"); if (el) el.click(); });
    on("#importFileInput", "change", async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) await importFromFile(f); });
    on("#sessionCognitionUpdate", "click", updateCognitionNow);
    on("#sessionRelationUpdate", "click", updateRelationSharedNow);
    on("#sessionReCompress", "click", runReCompress);
    on("#sessionCorrectRun", "click", runMemoryCorrect);
    on("#sessionBackupNow", "click", backupNow);
    on("#sessionRestoreBackup", "click", restoreBackupNow);
    on("#sessionSetMain", "click", () => setMainLine(state.sessionId));
    /* B2：桌面快捷方式（会话弹窗） */
    on("#sessionMakeShortcut", "click", () => makeShortcut(session()));
    on("#sessionRemoveShortcut", "click", () => removeShortcut(session()));
    on("#selfTestBtn", "click", selfTest);

    /* ── D2 应用加密：锁屏层 + 设置页那一段 ─────────────
       一律走 on()（空值安全）：这套元素只在带了对应版本的 index.html 里存在，
       拿不到就跳过，不会因为少一个元素就把整页初始化搞崩。 */
    on("#lockOk", "click", lockSubmit);
    on("#lockForgot", "click", lockForgot);
    on("#lockInput", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lockSubmit(); } });
    on("#recOk", "click", recSubmit);
    on("#recAi", "click", quizStart);
    on("#recBack", "click", lockBackToPass);
    on("#recInput", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); recSubmit(); } });
    on("#quizOk", "click", quizSubmit);
    on("#quizBack", "click", quizGiveUp);
    on("#quizA", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); quizSubmit(); } });
    on("#resetOk", "click", lockResetSave);
    on("#resetBack", "click", lockResetBack);
    on("#resetPass2", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lockResetSave(); } });
    on("#deadOk", "click", lockQuit);
    on("#codeCopy", "click", codeCopy);
    on("#codeOk", "click", codeClose);
    on("#setLockEnabled", "change", lockToggle);
    on("#setLockChange", "click", lockChangePass);
    on("#setLockCode", "click", lockResetCode);

    bindMessageGestures();
    on("#editCancel", "click", () => { state.editCtx = null; UI.closeModal("editModal"); });
    on("#editSave", "click", saveEdit);
    on("#deleteCancel", "click", () => UI.closeModal("deleteModal"));
    on("#deleteOk", "click", confirmDelete);
    on("#selectCancel", "click", exitSelect);
    on("#selectDelete", "click", () => {
      if (state.selected && state.selected.size) openDeleteDialog(Array.from(state.selected));
    });
    on("#selectCopy", "click", copySelected);
    on("#histSearchBtn", "click", runHistorySearch);
    on("#histKeyword", "keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); runHistorySearch(); }
    });
    on("#histFrom", "change", () => {
      if (!$v("#histTo")) setVal("#histTo", $v("#histFrom"));
    });

    document.addEventListener("click", (e) => {
      const sv = e.target.closest("[data-save-img]");
      if (sv) {
        e.preventDefault();
        const box = sv.closest(".gen-img-wrap, .att");
        const img = box ? box.querySelector("img") : null;
        saveImage(img && img.src, (img && img.getAttribute("alt")) || "");
        return;
      }
      const copy = e.target.closest(".copy-btn");
      if (copy) {
        const block = copy.closest(".code-block");
        const code = block ? block.querySelector("pre").textContent : "";
        UI.copyText(code).then((ok) => UI.toast(ok ? "已复制" : "复制失败", !ok));
        return;
      }
      const link = e.target.closest(".bubble a, a.ext-link");
      if (link) {
        e.preventDefault();
        const url = link.getAttribute("href");
        const w = window.open(url, "_blank");
        if (!w) UI.toast(url);
      }
    });
  }

  function applyThemeAll(repaint) {
    const rm = resolvedMode();
    UI.applyTheme(state.settings.theme, rm);
    const icon = rm === "dark" ? "white-balance-sunny" : "weather-night";
    $("#modeBtn").innerHTML = UI.iconSvg(icon);
    /* 状态栏/导航栏跟随主题色（无桥时自动空转） */
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.content) Store.callBridge("设置状态栏变色", meta.content);
    /* 只在用户主动切主题时才强制重绘；初始化时不重绘，以免拖慢启动动画 */
    if (repaint) UI.forceRepaint();
  }

  /* 当前实际生效的明暗：mode 可以是 light / dark / auto（auto = 读系统，注意接口返回 true=浅色） */
  function resolvedMode() {
    const m = state.settings.mode;
    if (m === "auto") {
      const isDefault = Store.callBridge("判断深色模式状态");
      if (isDefault === true) return "light";
      if (isDefault === false) return "dark";
      return "dark";
    }
    return m === "light" ? "light" : "dark";
  }

  function openThemeModal() {
    UI.buildModeSwitch(state.settings.mode, pickMode);
    UI.buildThemeGrid(state.settings.theme, resolvedMode(), pickTheme);
  }

  function pickTheme(id) {
    state.settings = Store.saveSettings({ theme: id });
    applyThemeAll(true);
    UI.buildThemeGrid(id, resolvedMode(), pickTheme);
  }

  function pickMode(mode) {
    state.settings = Store.saveSettings({ mode });
    applyThemeAll(true);
    openThemeModal();
  }

  function toggleMode() {
    const rm = resolvedMode();
    pickMode(rm === "dark" ? "light" : "dark");
  }

  function loadWorkspace() {
    state.settings = Store.getSettings();
    const sessions = Store.getSessions();
    if (!sessions.length) {
      newSession();
    } else {
      const cur = Store.getCurrentId();
      state.sessionId = sessions.some((s) => s.id === cur) ? cur : sessions[0].id;
      Store.setCurrentId(state.sessionId);
    }
  }

  /* 首次读本地存储失败时（偶发），延迟再读一次；期间 saveSessions 被拦，绝不会把历史洗掉 */
  function reloadWorkspace() {
    if (Store.readFailed()) {
      UI.toast("本地存储仍不可用，请重启 App（未覆盖你的历史）", true);
      return;
    }
    loadWorkspace();
    applyThemeAll(false);
    syncToggles();
    renderAll();
  }

  async function init() {
    /* 启动页不再按固定时间撤（会「没渲染完就进应用」）：改由 init 末尾渲染完成时
       requestSplashHide 统一撤。这里只挂兜底，init 中途出错也不会让启动页卡死。 */
    setTimeout(function () { requestSplashHide(true); }, SPLASH_MAX_MS);
    try {
      Store.resetReadError();
      /* D2：开了应用加密就先盖上锁屏层（z-index 比启动页还高），后面这一切渲染都在它底下进行。
         【故意不等解锁】—— 等的话，用户不解锁整个启动就停摆了；
         门由 settings.js 自己盖（它一跑就盖，比这里还早），这里只是补一次。 */
      try { if (window.DL.lockGate) window.DL.lockGate(); } catch (e) { /* ignore */ }
      await Store.unlockMemory();   /* 先解开记忆密文，之后 getSessions 同步拿得到明文 */
      loadWorkspace();
      /* 版本变了（更新过）→ 清一次页面缓存，避免还在用旧页面 */
      const appVer = CONFIG.APP_VERSION || "";
      if (state.settings.lastRunVersion !== appVer) {
        state.settings = Store.saveSettings({ lastRunVersion: appVer });
        if (Store.hasBridge("设置清空缓存")) {
          Store.callBridge("设置清空缓存");
          console.warn("[DeepLink] 版本变化，已清页面缓存");
        }
      }
      /* 图片外置：把历史会话里还在内联的图片搬进文件。
         放到启动流程【之后】再跑 —— 手机写文件有耗时，别拖住启动页；
         saveSessions 每次也会顺带搬，这一步只是把首批老数据提前处理掉。
         失败不影响使用：搬不动的那些原样留着内联（见 store.js 的三条底线）。 */
      setTimeout(() => {
        try {
          const r = Store.migrateImages();
          if (r && r.hoisted) {
            console.warn("[DeepLink] 图片外置迁移：搬走 " + r.hoisted + " 张，仍留内联 " + r.left + " 张");
          }
        } catch (e) { /* 迁移失败不影响使用 */ }
      }, 2600);
      /* 无图模式按设置生效（除了原生开关，自己再加一层 CSS 兜底，保证一定生效） */
      applyNoImage(state.settings.noImage);
      migrateData();
      UI.applyIcons(document);
      applyThemeAll(false);

      UI.setAvatarResolver(effectiveAvatar);
      bindBackKey();   /* B1：把原生返回键全部接管过来（无桥环境自动空转） */
      bind();
      syncToggles();
      renderAll();
      /* D2：启动流程到这儿算跑完了 —— 锁屏层这时才允许收（已经解锁的话） */
      try { if (window.DL.lockAppReady) window.DL.lockAppReady(); } catch (e) { /* ignore */ }

      /* B3：后台常驻（默认关）。启动时静默同步，不弹权限对话框 */
      if (state.settings.bgKeep) applyBgKeep(true);

      maybeAutoCompress();
      Store.getSessions().forEach((s) => maybeAutoBackup(s, "load"));
      setText("#guideTree", CONFIG.FEATURE_TREE || "");
      setText("#introTree", CONFIG.FEATURE_TREE || "");
      if (!state.settings.onboarded) setTimeout(openIntro, 2800);

      if (Store.readFailed()) {
        UI.toast("本地存储读取异常，正在重试（不会覆盖历史）", true);
        setTimeout(reloadWorkspace, 1200);
      }

      const miss = missingIds();
      if (miss.length) {
        console.warn("[DeepLink] 缺少界面元素：", miss);
        setTimeout(() => UI.toast("v" + (CONFIG.APP_VERSION || "") + " 缺少界面元素：" + miss.slice(0, 6).join("、") + (miss.length > 6 ? " 等" + miss.length + " 个" : "") + "；多半是打包用了旧的 index.html（退出重进封装软件再打一次）", true), 2300);
      }

      if (!state.settings.apiKey && !Store.readFailed()) {
        setTimeout(() => UI.toast("先点「设置」填入 API Key 即可开始"), 1700);
      }

      /* 加密能力不可用时明确告知一次（否则记忆会静默明文、导出会失败） */
      if (!Store.canEncrypt() && !state.settings.cryptWarned) {
        state.settings = Store.saveSettings({ cryptWarned: true });
        setTimeout(() => UI.toast("此环境不支持加密接口，记忆将明文保存、导出也会失败", true), 2600);
      }

      /* 已就绪：若这次是被桌面快捷方式冷启动的，现在可以进那条对话了 */
      inited = true;
      if (pendingOpenId) {
        const pid = pendingOpenId;
        pendingOpenId = "";
        setTimeout(() => openSessionById(pid), 300);
      }

      /* 告知 index.html 的启动自愈脚本：已就绪（否则它会自动刷新），并清掉重试计数 */
      window.__deeplinkReady = true;
      try { sessionStorage.removeItem("deeplink.bootTry"); } catch (e) { /* ignore */ }
      /* 首屏渲染完成 → 撤启动页（requestSplashHide 会再确认「动画已跑满」） */
      requestSplashHide(false);
    } catch (e) {
      console.error("[DeepLink] 初始化出错", e);
      try { UI.toast("初始化出错：" + (e && e.message ? e.message : e), true); } catch (e2) { /* ignore */ }
    }
  }

  /* ── 对拆分出去的模块暴露共享件（camera.js / roleplay.js / settings.js / chat.js）──
     这些模块在 index.html 里排在 app.js 之后加载，那时 window.DL 已存在；
     state 是 const、永不整体重新赋值，模块持有它的引用是安全的（只改属性）。
     模块需但这里没暴露的，**不要去改 app.js** —— 在 WORKLOG-PC.md 里写「需补暴露 X」，由容器端加。 */
  window.DL = {
    /* 跨文件的全局一律用 window. 前缀取（浏览器里裸名也行，但 jsdom 等环境里裸名不保证能解析） */
    /* ⚠️ 这 8 个模块必须用 getter（惰性取值），不能写成 `Api: window.Api` 这种快照。
       原因：打包工具不一定按 index.html 的顺序执行脚本。若某个模块晚于 app.js 执行，
       快照会把它【永久钉死在 undefined】—— 症状是发消息报
       「Cannot read property 'run' of undefined」（只在真机上出现，浏览器/无头里都正常）。
       getter 形式下，谁晚到都不影响：取值那一刻才去读 window。 */
    get CONFIG() { return window.CONFIG; }, get UI() { return window.UI; },
    get Store() { return window.Store; }, get Memory() { return window.Memory; },
    get Files() { return window.Files; }, get Api() { return window.Api; },
    get Media() { return window.Media; }, get Search() { return window.Search; },
    state: state,
    $: $, $v: $v, checkedOf: checkedOf,
    setVal: setVal, setChecked: setChecked, setText: setText,
    setDisplay: setDisplay, setDisabled: setDisabled, setHidden: setHidden, on: on,
    renderAll: renderAll, isTouch: isTouch,
    toast: UI.toast, err: function (t) { UI.toast(t, true); },
    session: session, sessionById: sessionById, agentId: agentId, characterFor: characterFor, activeCharacter: activeCharacter,
    saveSession: saveSession, setMainLine: setMainLine,
    newSession: newSession, appendMessage: appendMessage, renderSessionList: renderSessionList,
    /* 阶段④搬走、由各子模块末尾自注册补挂到这里的（**别在这写裸名字**，写了就成了转发到自己的死循环）：
       recordUsage / renderCharUsage / renderBackupLine / maybeAutoBackup / syncChip / maybeAutoWash → settings.js 与 roleplay.js；
       renderAttachments / syncPlaceholder / send / exitSelect → chat.js。
       chat.js 的 syncModules 与 roleplay.js / camera.js 的 syncModules 都会惰性重取，晚到也不怕。 */

    /* 录音态共享对象（chat.js 的 toggleMic 与 app.js 的 syncToggles 共用） */
    audioState: audioState,
    openSidebar: openSidebar, closeSidebar: closeSidebar, setBusy: setBusy,
    applyNoImage: applyNoImage, packagedVersion: packagedVersion,
    jsonDataUrl: jsonDataUrl, exportFileName: exportFileName,
    /* roleplay.js（阶段③）要用、但仍留在 app.js 的：头像是草稿对象（要共享同一份引用）。 */
    avatarDraft: avatarDraft, renderAvatarPreview: renderAvatarPreview,
    /* settings.js（阶段④）自检要用、仍留在 app.js 的：交付元素自检清单。 */
    missingIds: missingIds
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
