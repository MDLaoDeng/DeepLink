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
  const SPLASH_MAX_MS = 15000;  /* 兜底：init 出错或迟迟不就绪，也别让启动页一直盖着。
                                   跟 index.html 内联脚本的硬兜底保持一致 —— 启动动画里的图片
                                   要是在后台重试，这里得给它留够时间（但也不能真卡死）。 */
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
    /* 启动动画的图片还没加载完（或在后台重试）也不放行：等它渲染完再退出。
       注意只要「还没到硬兜底时间」就继续等，别把用户撂在「没画完就进应用」的状态。 */
    if (!force && (window.__splashAssetPending || !window.__deeplinkReady) && elapsed < SPLASH_MAX_MS) {
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
    /* 贴底判断必须在「改高度之前」做：改完 clientHeight 变小，
       同一位置会被算成「离底很远」，本来贴着底的人也会被误判成在翻历史。
       取不到 UI 时按「贴底」处理，保持老行为。 */
    let stick = true;
    if (shrank) {
      try { stick = !(window.UI && UI.isNearBottom) || UI.isNearBottom(); } catch (e) { stick = true; }
    }
    lastViewH = h;
    document.documentElement.style.setProperty("--app-h", h + "px");
    /* 键盘弹起时把最新消息顶上来，免得最后几条被切掉 —— 但只在用户本来就贴着底部时。
       翻上去看历史时（比如长按选中、往回翻对话）弹键盘，绝不能把他硬拽回末尾。 */
    if (shrank && stick) {
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
  /* 内置助手「听澜」的固定 id：不随机，方便识别、也方便以后回滚。
     用户 10-17 定的口径是「新建一个固定身份的内置助手，把老会话挂过去」——
     所以「助手」不再是一个无名身份，而是听澜这个角色。 */
  const TINGLAN_ID = "c_tinglan";

  function agentId() {
    if (state.settings.roleplayEnabled) return state.settings.activeCharacterId || TINGLAN_ID;
    return TINGLAN_ID;
  }
  function characterFor(s) {
    const id = s && s.characterId ? s.characterId : "";
    if (!id) return null;
    return Store.getCharacters().find((c) => c.id === id) || null;
  }
  /* 朗读用的设置副本：这条线单独设了音色就用它的，否则沿用全局。
     只返回合并后的副本，**不碰 state.settings 本体**（那是全局设置）。 */
  function voiceSettingsFor(s) {
    const own = s && typeof s.ttsVoice === "string" ? s.ttsVoice.trim() : "";
    if (!own) return state.settings;
    return Object.assign({}, state.settings, { ttsVoice: own });
  }
  function activeCharacter() {
    const id = state.settings.activeCharacterId || "";
    return id ? (Store.getCharacters().find((c) => c.id === id) || null) : null;
  }

  /* ── 删线的护栏（10-18 用户要求）─────────────────────────
     群聊给每位成员绑了一条线（session.memberLine）。这条线一旦删掉，那个群就再也
     同步不到那位成员了 —— 用户口径是「有该线的群聊自动解散」，而且删线必须先给
     严重警告、确认按钮 10 秒后才可点（UI.confirmDialog 的 delayMs 就是干这个的）。 */
  function groupsUsingLine(sid) {
    const out = [];
    Store.getSessions().forEach((g) => {
      if (!g || !g.isGroup) return;
      let hit = false;
      const bind = g.memberLine || {};
      Object.keys(bind).forEach((k) => { if (bind[k] === sid) hit = true; });
      if (!hit && g.memberMem) {
        Object.keys(g.memberMem).forEach((k) => {
          const r = g.memberMem[k];
          if (r && r.fromId === sid) hit = true;
        });
      }
      if (hit) out.push(g);
    });
    return out;
  }

  /* 返回 true = 已经删掉了；false = 用户取消 */
  async function deleteSessionWithGuard(id) {
    const used = groupsUsingLine(id);
    if (used.length) {
      const names = used.map((g) => "「" + (g.title || "群聊") + "」").join("");
      const ok = await UI.confirmDialog("这条线被群聊用着",
        "群聊" + names + "把这条线当成某位成员的记忆来源。删掉这条线后，" + names +
        "会被一并解散（里面的对话也一起没了，不能恢复）。\n\n确定要删吗？", 10000);
      if (!ok) return false;
      exitSelect();
      Store.deleteSession(id);
      used.forEach((g) => { try { Store.deleteSession(g.id); } catch (e) { /* 单条失败不影响其它 */ } });
      if (used.some((g) => g.id === state.sessionId)) state.sessionId = Store.getCurrentId() || "";
      renderAll();
      UI.toast("已删除这条线，并解散了 " + used.length + " 个群聊");
      return true;
    }
    const ok = await UI.confirmDialog("删除对话", "删除后无法恢复，确定吗？");
    if (!ok) return false;
    exitSelect();
    Store.deleteSession(id);
    return true;
  }

  /* ── 侧栏三栏（10-16 用户要求）：助手 / 现实扮演角色 / 手机角色。
     三栏共用 renderSessionList 这个入口，按 state.sideTab 决定渲染哪一栏。
     「现实扮演角色」= 原来的逻辑（当前角色的会话），基本没动。 */
  const sideTab = () => state.sideTab || "role";

  function renderSessionList() {
    const tab = sideTab();
    const asstPane = $("#sidePaneAsst"), rolePane = $("#sidePaneRole"), phonePane = $("#sidePanePhone");
    if (asstPane) asstPane.hidden = tab !== "assistant";
    if (rolePane) rolePane.hidden = tab !== "role";
    if (phonePane) phonePane.hidden = tab !== "phone";
    const tabs = document.querySelectorAll("#sideTabs .side-tab");
    for (let i = 0; i < tabs.length; i++) tabs[i].classList.toggle("on", tabs[i].getAttribute("data-side") === tab);

    if (tab === "assistant") {
      /* 听澜的线算「助手」这一栏 —— 它是内置助手，不是要切过去才能聊的角色卡。
         不加这一条，听澜的会话会被分到「角色」栏，助手栏反而空掉。 */
      const list = Store.getSessions().filter((s) => (!s.characterId || s.characterId === TINGLAN_ID) && !s.isGroup && !s.phoneOnly);
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
          const done = await deleteSessionWithGuard(id);
          if (!done) return;
          renderAll();
        }
      }, $("#sessionListAsst"));
      return;
    }
    if (tab === "phone") { renderPhonePane(); return; }

    /* 「角色」栏只列用户当前切过去的那个角色 —— 这里**不能**用 agentId()：
       那个函数在没选角色时会兜底返回听澜，于是听澜的线会同时出现在「助手」栏
       和这里（重复），而群聊（characterId 为空）反而两边都落不进去、直接消失。 */
    const aid = state.settings.roleplayEnabled ? (state.settings.activeCharacterId || "") : "";
    const list = Store.getSessions().filter((s) => (s.characterId || "") === aid && !s.phoneOnly);
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
        const done = await deleteSessionWithGuard(id);
        if (!done) return;
        const remaining = Store.getSessions().filter((s) => (s.characterId || "") === aid);
        if (state.sessionId === id) state.sessionId = remaining[0] ? remaining[0].id : "";
        if (!remaining.length) newSession();
        else renderAll();
      }
    });
    renderCharBar();
  }

  /* 「手机角色」栏：列出所有纯手机角色；点一个直接进手机页跟 Ta 聊。
     纯手机角色 = character.phoneOnly（手机页右上角「+ → 新建联系人」建的）。 */
  function renderPhonePane() {
    const box = $("#phoneCharList");
    if (!box) return;
    box.innerHTML = "";
    const chars = Store.getCharacters().filter((c) => c.phoneOnly);
    if (!chars.length) {
      const e = document.createElement("div");
      e.className = "session-item";
      e.style.color = "var(--text-mute)";
      e.textContent = "还没有手机角色（去手机页右上角「+」新建联系人）";
      box.appendChild(e);
      return;
    }
    chars.forEach((c) => {
      const item = document.createElement("div");
      item.className = "session-item";
      const av = document.createElement("div");
      av.className = "s-avatar";
      if (c.avatar) { av.innerHTML = '<img src="' + c.avatar + '" alt="">'; }
      else av.innerHTML = UI.iconSvg("account");
      item.appendChild(av);
      const t = document.createElement("span");
      t.className = "s-title";
      t.textContent = c.name || "手机角色";
      item.appendChild(t);
      const mine = Store.getSessions().filter((s) => s.characterId === c.id && s.phoneOnly);
      const bd = document.createElement("span");
      bd.className = "s-badge";
      bd.textContent = mine.length ? (mine.length + " 条") : "新";
      item.appendChild(bd);
      item.addEventListener("click", () => {
        closeSidebar();
        let s = mine[0];
        if (!s) {
          s = Store.createSession(c.id, true);
          if (s && s.id) Store.updateSession(s.id, { phoneOnly: true, title: c.name || "手机角色" });
        }
        if (s && s.id && window.DL.openPhoneFor) window.DL.openPhoneFor(s.id);
      });
      box.appendChild(item);
    });
  }

  /* ── 故事时钟（挂在顶层「对话设置」按钮上）──────────────────────
     只在「这条会话开了时间系统」时显示；超出角色设定的合法时段整条变红。
     点这个按钮 = 弹出两栏小浮窗（进对话设置 / 看实时时间）；双击 = 冻结 / 解冻时间。 */
  let clockTapTimer = null;
  function toggleClockFreeze(s) {
    if (!s || !Memory) return;
    if (Memory.isFrozen(s)) { Memory.unfreezeTime(s); UI.toast("时间已解冻，从此刻继续"); }
    else { Memory.freezeTime(s); UI.toast("时间已冻结（再双击时钟解冻）"); }
    Store.updateSession(s.id, { time: s.time });
    syncChatClock();
  }
  function syncChatClock() {
    const el = $("#sessionBtn");
    const txt = $("#sessionClockText");
    if (!el || !txt) return;
    const s = session();
    if (!s || !Memory || !Memory.hasTimeline || !Memory.hasTimeline(s)) {
      txt.textContent = "";
      el.classList.remove("out");
      el.title = "对话设置";
      return;
    }
    const ms = Memory.nowOf(s);
    const ch = characterFor(s);
    const ck = Memory.checkTime(ch, ms);
    const frozen = Memory.isFrozen ? Memory.isFrozen(s) : false;
    txt.textContent = Memory.fmtHM(ms);
    el.classList.toggle("out", !ck.ok);
    el.classList.toggle("frozen", !!frozen);
    el.title = (frozen ? "【已冻结】故事时间停在 " : "故事时间：") + Memory.fmtStory(ms, true)
      + (ck.ok ? "" : " 已超出角色设定的合法时段") + "（双击冻结 / 解冻）";
    const live = $("#sessionClockLive");
    if (live) live.textContent = Memory.fmtStory(ms, true) + " " + Memory.weekdayOf(ms);
  }

  /* ── 退出时按秒记下「离开那一刻」────────────────────────────────
     pagehide / 切后台都算。下次进来算「所隔时间」用它来决定要不要补剧情、
     角色要不要主动发消息；生成完之后 Memory.rebaseTime 会把锚点换成新的
     （用户口径：只保留有对应剧情、动作的时间节点）。 */
  var lastLeaveMark = 0;
  function rememberLeave() {
    try {
      const now = Date.now();
      if (now - lastLeaveMark < 30000) return;   /* 频繁切前后台别每回都写盘 */
      lastLeaveMark = now;
      const list = Store.getSessions();
      let dirty = false;
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].time && Memory && Memory.markLeft) dirty = Memory.markLeft(list[i], now) || dirty;
      }
      if (dirty) Store.saveSessions(list);
      state.settings = Store.saveSettings({ lastSeenAt: now });
    } catch (e) { /* 退出这步出问题不能拦住关页 */ }
  }

  /* ── 弹出式小浮窗（加号 / 对话设置共用）─────────────────────────
     位置按锚点按钮实时算，贴在按钮边上；点外面、点某一项、再点一次按钮都收起。
     ⚠️ 按钮的 click 只绑一次（__poBound 挡着）—— 同一个绑定跑两遍会让「开」和
     「立刻关」在一次点击里连着发生，表现成「点了没反应」。 */
  function popoverPlace(panel, anchor, above) {
    panel.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth || 160;
    const h = panel.offsetHeight || 90;
    const vw = window.innerWidth || 360;
    const vh = window.innerHeight || 640;
    let left = r.left;
    let top = above ? (r.top - h - 8) : (r.bottom + 8);
    if (left + w > vw - 8) left = vw - w - 8;
    if (left < 8) left = 8;
    if (top + h > vh - 8) top = vh - h - 8;
    if (top < 8) top = 8;
    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
  }
  var poAnchor = null;
  function popoverClose() {
    const pm = $("#plusMenu"), hm = $("#headMenu");
    if (pm) pm.hidden = true;
    if (hm) hm.hidden = true;
    poAnchor = null;
  }
  function popoverToggle(sel, anchor, above) {
    const panel = $(sel);
    if (!panel || !anchor) return;
    const wasOpen = !panel.hidden;
    popoverClose();
    if (wasOpen) return;
    poAnchor = anchor;
    popoverPlace(panel, anchor, above);
  }
  function bindPopovers() {
    const pb = $("#plusBtn");
    if (pb && !pb.__poBound) {
      pb.__poBound = true;
      pb.addEventListener("click", (e) => {
        e.preventDefault();
        popoverToggle("#plusMenu", pb, true);      /* 贴在加号上方，和它相连 */
      });
    }
    if (!document.__poOutBound) {
      document.__poOutBound = true;
      document.addEventListener("click", (e) => {
        if (!poAnchor) return;
        const t = e.target;
        if (t && t.closest && (t.closest("#plusMenu") || t.closest("#headMenu"))) return;
        if (t && t.closest && (t.closest("#plusBtn") || t.closest("#sessionBtn"))) return;
        popoverClose();
      });
    }
  }

  /* ── 时间系统的三个动作（对话设置里那几个按钮）──────────────────
     一律先过「角色合法时段」这道闸：越界就**拒绝并说清为什么**，
     还告诉用户该去改年龄还是出生日期（这正是需求里要求的提示）。 */
  function sessionTimeSet(ms, tip) {
    const s = session();
    if (!s) return false;
    const ch = characterFor(s);
    const ck = Memory.checkTime(ch, ms);
    if (!ck.ok) {
      UI.toast("这个时间不合角色设定：只能落在 " + Memory.fmtStory(ck.from).slice(0, 10) +
        " ~ " + Memory.fmtStory(ck.to).slice(0, 10) +
        " 之间（由出生日期 + 当前年龄算出来）。请把角色的年龄或出生日期改到能覆盖这个时间。", true);
      return false;
    }
    Store.updateSession(s.id, { time: { start: ms, setAt: Date.now(), leftAt: Date.now() } });
    syncChatClock();
    try { fillSessionForm(session()); } catch (e) { /* ignore */ }
    renderAll();
    UI.toast(tip || ("故事时间已设为 " + Memory.fmtStory(ms)));
    return true;
  }
  function sessionTimeApply() {
    const v = $v("#setSessionTime");
    if (!v) { UI.toast("先选一个时间", true); return; }
    const ms = new Date(v).getTime();
    if (!isFinite(ms)) { UI.toast("时间格式不对", true); return; }
    sessionTimeSet(ms, "时间已应用：" + Memory.fmtStory(ms));
  }
  function sessionTimeClear() {
    const s = session();
    if (!s) return;
    const list = Store.getSessions();
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) { delete list[i].time; Store.saveSessions(list); }
    syncChatClock();
    try { fillSessionForm(session()); } catch (e) { /* ignore */ }
    renderAll();
    UI.toast("已关掉时间系统（对话里回到现实时间）");
  }

  function renderAll() {
    const s = session();
    if (s && sweepImageExpiry(s)) Store.saveSessions(Store.getSessions());
    const ch = characterFor(s);
    setText("#chatTitle", s ? (s.title || (ch ? ch.name : "新对话")) : "新对话");
    setText("#modelBadge", state.settings.model);
    syncChatClock();
    renderSessionList();
    renderMessages();
    syncPlaceholder();
    applyChatBackground();
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

  /* ── 群聊：新建一个多人群（成员 ≥ 2），可选从某条已有的线导入记忆 ── */
  function openGroupModal() {
    const box = $("#groupMembers");
    if (box) {
      box.innerHTML = "";
      const chars = Store.getCharacters();
      if (!chars.length) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = "还没有角色。先去「角色扮演」建一个角色，再来开群。";
        box.appendChild(p);
      } else {
        chars.forEach((c) => {
          const row = document.createElement("label");
          row.className = "group-member";
          const cb = document.createElement("input");
          cb.type = "checkbox"; cb.value = c.id; cb.className = "g-member";
          const av = document.createElement("span");
          av.className = "g-av";
          if (c.avatar) { const im = document.createElement("img"); im.src = c.avatar; im.alt = ""; av.appendChild(im); }
          else av.innerHTML = UI.iconSvg("creation");
          const nm = document.createElement("span");
          nm.className = "g-name";
          nm.textContent = c.name || "角色";
          row.appendChild(cb); row.appendChild(av); row.appendChild(nm);
          /* 关联哪条线（10-18 用户口径：进群就必须给每人选一条线）。
             同步到各自线靠这条绑定；没有线的角色不让进群 —— 否则它那份记忆永远同步不到。 */
          const lines = Store.getSessions().filter((x) => !x.isGroup && (x.characterId || "") === c.id);
          if (!lines.length) {
            /* 没有线的角色：不给下拉，直接写「没有线」—— 留一块空白看着像按钮没渲染出来 */
            cb.disabled = true;
            row.classList.add("no-line");
            const no = document.createElement("span");
            no.className = "g-noline";
            no.textContent = "没有线";
            row.appendChild(no);
            box.appendChild(row);
            return;
          }
          const sel = document.createElement("select");
          sel.className = "g-line";
          sel.setAttribute("data-char", c.id);
          lines.sort((a, b) => (b.mainLine ? 1 : 0) - (a.mainLine ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
          lines.forEach((x) => {
            const o = document.createElement("option");
            o.value = x.id;
            o.textContent = (x.title || "新对话") + (x.mainLine ? "（主线）" : "");
            sel.appendChild(o);
          });
          row.appendChild(sel);
          if (UI.pickBind) UI.pickBind(sel, (c.name || "角色") + " 关联的线");
          box.appendChild(row);
        });
      }
    }
    const sel = $("#groupImport");
    if (sel) {
      sel.innerHTML = '<option value="">不导入</option>';
      /* 10-17：来源放开到「多人群」。只有多角色线才可能对群聊的「共同经历」有贡献 ——
         那条支路（importLineMemoryToGroup → mergeGroupShared）原先只认 isGroup 的来源，
         而这里正好把群聊 filter 掉了，等于那条功能永远走不到。多人群在标签里标出来。 */
      Store.getSessions().forEach((s) => {
        /* 不排除当前会话：新建群时正在看的那条线，往往正是最想导进来的那条
           （新群是另一个会话，不存在"导入自己"的问题）。 */
        const o = document.createElement("option");
        o.value = s.id;
        o.textContent = (s.title || "新对话") + (s.mainLine ? "（主线）" : "")
          + (s.isGroup ? "（多人群）" : "");
        sel.appendChild(o);
      });
      /* 选项是重建的 → 刷新自绘按钮上的文字（按钮上显示的是当前选中项的名字） */
      if (UI.pickRefreshAll) UI.pickRefreshAll();
    }
    setVal("#groupName", "");
    UI.openModal("groupModal");
  }

  function createGroup() {
    const box = $("#groupMembers");
    const picked = box ? Array.from(box.querySelectorAll("input.g-member:checked")) : [];
    const ids = picked.map((x) => x.value);
    if (ids.length < 2) { UI.toast("至少选两个角色才能开群", true); return; }
    /* 每人绑一条线：勾了谁就记谁那条线（建群弹窗里每个成员已经选好了） */
    const memberLine = {};
    picked.forEach((cb) => {
      const row = cb.closest ? cb.closest(".group-member") : null;
      const sel = row ? row.querySelector("select.g-line") : null;
      const sid = sel ? String(sel.value || "") : "";
      if (sid) memberLine[cb.value] = sid;
    });
    const missing = ids.filter((id) => !memberLine[id]);
    if (missing.length) { UI.toast("有 " + missing.length + " 位成员还没选线，先给他们选一条", true); return; }
    const chars = Store.getCharacters();
    const names = ids.map((id) => {
      const c = chars.find((x) => x.id === id);
      return c ? (c.name || "角色") : "";
    }).filter(Boolean);
    let title = $v("#groupName").trim();
    if (!title) title = names.join("、");
    const s = Store.createSession("");
    Store.updateSession(s.id, { isGroup: true, members: ids, title: title, memberLine: memberLine });
    /* 可选：把某条线的记忆导进群聊（口径见 importLineMemoryToGroup） */
    const src = $v("#groupImport");
    if (src) {
      const from = sessionById(src);
      if (from) importLineMemoryToGroup(s.id, from);
    }
    state.sessionId = s.id;
    UI.closeModal("groupModal");
    renderAll();
    UI.toast("群聊建好了");
  }

  /* 把一条线的记忆导进群聊。用户拍板的口径：
     ① **导入是「给那条线所属的角色」** —— 记忆存进群聊的 memberMem[角色id]，
        群聊自己的认知/场景/关系/共同经历/摘要 **一个字都不动**
        （以前的写法是整套覆盖，等于把群聊的记忆冲掉，已改掉）；
     ② 只有当那条线**本身就是多角色的线**时，它才可能对群聊的「共同经历」有贡献 ——
        由 AI 只挑「多人共有、时间不冲突、前后讲得通」的部分，**追加**进去（绝不覆盖）。 */
  function importLineMemoryToGroup(groupId, from) {
    const gs = sessionById(groupId);
    if (!gs || !from) return;
    const key = from.characterId || "__assistant__";
    const mem = Object.assign({}, gs.memberMem || {});
    mem[key] = {
      fromId: from.id,
      fromTitle: from.title || "",
      cognition: from.cognition || "",
      scene: from.scene || "",
      relation: from.relation || "",
      shared: from.shared || "",
      memory: from.memory ? JSON.parse(JSON.stringify(from.memory)) : null,
      ts: Date.now()
    };
    Store.updateSession(groupId, { memberMem: mem });
    /* 多角色的线：再请 AI 挑一遍「大家的共同经历」。异步补上，不挡建群。 */
    if (from.isGroup && window.DL.mergeGroupShared) {
      window.DL.mergeGroupShared(groupId, from).then(function (added) {
        if (added) UI.toast("已把这条线里「大家都参与过」的事并进群聊共同经历");
      });
    }
  }

  /* ── 世界生成（可关）：离线够久 → 让 AI 补一段空档剧情 ── */
  const WORLD_GAP_H = 6;      /* 离线超过这么多小时才提示 */
  let worldSid = "";
  let worldDraft = "";   /* 真正生成出来的剧情；采纳只用它，绝不从提示行的文字里抠
                            （否则「正在补写…」/「生成失败：…」会被当成剧情节写进对话） */
  /* 这条线有没有「记忆」可用（日 / 周 / 月摘要任一非空）——
     世界生成拿它当依据；一条记忆都没有时，补出来的剧情全是凭空编的，所以干脆不做。 */
  function hasAnyMemory(s) {
    try {
      const m = (Memory && Memory.ensureMemory) ? Memory.ensureMemory(s) : (s && s.memory);
      if (!m) return false;
      return !!((m.days && m.days.length) || (m.weeks && m.weeks.length) || (m.months && m.months.length));
    } catch (e) { return false; }
  }

  function openWorldCheck() {
    try {
      if (state.settings.worldGen === false) return;
      const s = session();
      const now = Date.now();
      const lastSeen = state.settings.lastSeenAt || 0;
      if (!s || !s.characterId) { state.settings = Store.saveSettings({ lastSeenAt: now }); return; }
      /* 两条前提（用户口径）：
         ① 角色设定没填齐 → 不做世界生成（设定都不全，补出来的剧情必然跑偏）；
         ② 这条线还没有任何记忆 → 也不做（没有「你们之间发生过什么」当依据）。
         两处都只是「这次不弹」，仍然刷新 lastSeenAt，免得下次一算又是好几天。 */
      const missW = (window.DL && window.DL.charMissingFields) ? window.DL.charMissingFields(s) : [];
      if (missW.length) { state.settings = Store.saveSettings({ lastSeenAt: now }); return; }
      if (!hasAnyMemory(s)) { state.settings = Store.saveSettings({ lastSeenAt: now }); return; }
      /* 「所隔时间」优先取这条会话自己的离线锚点（退出那一刻按秒记下的），
         没有才退回全局 lastSeenAt —— 全局那个最后一次保存就可能被刷新掉。 */
      const gap = (Memory && Memory.awayGap) ? Memory.awayGap(s, now) : null;
      const away = (typeof gap === "number") ? gap : (lastSeen ? (now - lastSeen) : 0);
      if (away / 3600000 < WORLD_GAP_H) { state.settings = Store.saveSettings({ lastSeenAt: now }); return; }
      worldSid = s.id;
      UI.openModal("worldModal");
      worldRegen();
    } catch (e) { /* 世界生成出问题不能挡住启动 */ }
  }
  /* 剧情「可修改」（用户口径：和快捷回复一样）：生成出来的每一段各自一个输入框，
     想改哪儿改哪儿，点「采纳」时读的是**框里的内容**（不是原始生成结果）。 */
  /* AI 被要求「1. 3月12日」这样起头：**一天一段**，段里还会有各时段的好几行。
     所以按「序号开头的行」切，**不能按每一行切** —— 那样一天会被拆成一堆框。 */
  function worldParts(t) {
    const s = String(t || "").trim();
    if (!s) return [];
    const isHead = (ln) => /^\s*\d+\s*[.、)）]\s*\S/.test(ln);
    const parts = [];
    let buf = [];
    s.split(/\r?\n/).forEach((ln) => {
      if (isHead(ln)) {
        if (buf.length) parts.push(buf.join("\n").trim());
        buf = [ln.replace(/^\s*\d+\s*[.、)）]\s*/, "").trim()];
      } else if (buf.length) {
        buf.push(ln.replace(/\s+$/, ""));
      } else if (ln.trim()) {
        buf.push(ln.trim());
      }
    });
    if (buf.length) parts.push(buf.join("\n").trim());
    return parts.filter(Boolean);
  }
  function worldBoxShow(lines) {
    const box = $("#worldText");
    if (!box) return;
    box.innerHTML = "";
    lines.forEach((line) => {
      const ta = document.createElement("textarea");
      /* 一天一段，段里有几行就开几行高（还是可以自己往下拖） */
      ta.rows = Math.max(2, Math.min(12, String(line).split("\n").length + 1));
      ta.value = line;
      box.appendChild(ta);
    });
  }
  function worldBoxMessage(text) {
    const box = $("#worldText");
    if (!box) return;
    box.innerHTML = "";
    const d = document.createElement("div");
    d.className = "hint";
    d.textContent = text;
    box.appendChild(d);
  }
  function worldRead() {
    const box = $("#worldText");
    if (!box) return "";
    const parts = [];
    box.querySelectorAll("textarea").forEach((ta) => {
      const v = String(ta.value || "").trim();
      if (v) parts.push(v);
    });
    return parts.join("\n\n");
  }

  async function worldRegen() {
    const sid = worldSid;
    worldDraft = "";
    worldBoxMessage("正在补写…");
    try {
      const s = sessionById(sid);
      const t = await window.DL.generateWorld(s);
      if (sid !== worldSid) return;   /* 期间换了会话：丢弃这次结果 */
      worldDraft = (t || "").trim();
      const parts = worldParts(worldDraft);
      if (!parts.length) worldBoxMessage("（没有生成内容）");
      else worldBoxShow(parts);
    } catch (e) {
      if (sid !== worldSid) return;
      worldBoxMessage("生成失败：" + (e && e.message ? e.message : e));
    }
  }
  function worldAdopt() {
    /* 以输入框里的内容为准；一处都没填时才退回原始生成结果 */
    const t = worldRead() || worldDraft;
    if (t && worldSid) window.DL.applyWorld(worldSid, t);
    UI.closeModal("worldModal");
    state.settings = Store.saveSettings({ lastSeenAt: Date.now() });
    renderAll();
    UI.toast(t ? "已采纳这段剧情" : "还没有可采纳的内容");
  }
  function worldSkip() {
    UI.closeModal("worldModal");
    /* 10-18 用户口径：**跳过剧情生成 → 时间承接上一次离开那一刻**（离线那段作废）；
       采纳了剧情才算「那段时间已经交代过」，时间照常推进。 */
    try {
      const s = worldSid ? sessionById(worldSid) : null;
      if (s && Memory && Memory.awayGap && Memory.holdTime) {
        const gap = Memory.awayGap(s);
        if (typeof gap === "number" && gap > 0) {
          Memory.holdTime(s, gap);
          Store.saveSessions(Store.getSessions());
        }
      }
    } catch (e) { /* 时间回拨失败不影响关闭弹窗 */ }
    state.settings = Store.saveSettings({ lastSeenAt: Date.now() });
  }

  /* ── 自动发信息（默认关）：你在后台时，角色按性格主动找你 ──
     间隔取「设置 → 自动发信息间隔」（分钟，默认 30）。一次只找一条，别刷屏。 */
  let autoMsgTimer = null;
  let autoMsgBusy = false;
  function startAutoMessage() {
    if (autoMsgTimer) return;
    autoMsgTimer = setInterval(autoMessageTick, 180000);
  }
  async function autoMessageTick() {
    if (autoMsgBusy) return;
    if (!document.hidden) return;      /* 只在你不在前台时才主动 */
    if (state.busy) return;
    const mins = Number(state.settings.autoMessageMin) || 30;
    /* 手机模式：主动消息投进【手机】，还能顺带配一张图（见 phone.js 的 applyAutoShare） */
    const toPhone = !!state.settings.autoMessagePhone;
    const globalOn = !!state.settings.autoMessage;
    const list = Store.getSessions().filter((s) => s.characterId && !s.isGroup);
    if (!list.length) return;
    autoMsgBusy = true;
    try {
      for (let i = 0; i < list.length; i++) {
        const snap = list[i];
        /* 会话级优先：会话上明确写了的（允许/不允许）压过全局开关；
           没写就跟随全局。所以全局关着、某条线单独打开，也照样会主动找你。 */
        const allowed = (snap.autoMsgOn === true || snap.autoMsgOn === false) ? snap.autoMsgOn : globalOn;
        if (!allowed) continue;
        /* 前提：这条线要开着「时间系统」（对话设置里设过故事时间，即 s.time）。
           没有时间轴就不知道「隔了多久、现在是几点」，主动发来的话会没头没尾。 */
        if (!snap.time || !snap.time.start) continue;
        /* 手机模式看手机的最后一条、主对话模式看主对话的最后一条 —— 各按各的间隔算 */
        const msgs = toPhone ? ((snap.phone && snap.phone.msgs) || []) : (snap.messages || []);
        const lastTs = msgs.length ? (msgs[msgs.length - 1].ts || 0) : 0;
        if (!lastTs || Date.now() - lastTs < mins * 60000) continue;
        const cur = sessionById(snap.id);
        if (!cur) continue;
        /* 会话级明确选了「允许」→ 让 AI 发之前先看「当前场景」：你俩在一块儿就别发 */
        const sceneCheck = (snap.autoMsgOn === true);
        if (toPhone) {
          const share = await window.DL.generatePhoneShare(cur, { checkScene: sceneCheck });
          if (!share || (!share.text && !share.image)) continue;
          const sent = await window.DL.applyAutoShare(snap.id, share);
          if (!sent) continue;
          if (snap.id === state.sessionId) renderMessages();
          renderSessionList();
          UI.toast(share.image ? "对方在手机里给你发了张图" : "对方在手机里给你发了消息");
          break;                        /* 一次只找一条 */
        }
        const text = await window.DL.generateAutoMessage(cur, { checkScene: sceneCheck });
        if (!text) continue;
        window.DL.applyAutoMessage(snap.id, text);
        if (snap.id === state.sessionId) renderMessages();
        renderSessionList();
        UI.toast("对方主动发来了消息");
        break;                          /* 一次只找一条 */
      }
    } catch (e) { /* 主动联系失败不打扰用户 */ }
    finally { autoMsgBusy = false; }
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

  /* 侧栏开关顺带同步 aria-hidden：它是 <aside aria-hidden="true"> 起步的，
     不开时对读屏软件隐藏、打开后必须放开，否则读屏用户永远够不到主导航。 */
  function openSidebar() {
    const sb = $("#sidebar");
    if (sb) { sb.classList.add("open"); sb.setAttribute("aria-hidden", "false"); }
    const sc = $("#scrim"); if (sc) sc.classList.add("show");
  }
  function closeSidebar() {
    const sb = $("#sidebar");
    if (sb) { sb.classList.remove("open"); sb.setAttribute("aria-hidden", "true"); }
    const sc = $("#scrim"); if (sc) sc.classList.remove("show");
  }

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
  const REQUIRED_IDS = "cameraModal camStage camVideo camCanvas camShutter camClose camAttach camRetake camTextInput camEdit charSplitAgain charSplitRoleOnly charReadyHint plusBtn plusCamera plusFile plusMenu headMenu headMenuSet worldView worldViewBack worldViewBody attachmentBar audioInput avatarInput chatTitle customSearchField deleteCancel deleteList deleteOk dialogCancel dialogOk dialogText dialogTitle passModal passTitle passNote passInput passConfirmWrap passConfirm passOk passCancel pickModal pickTitle pickList replayIntroBtn resetSettingsBtn dataUsageLine dropHint editCancel editSave editText editTitle effortSelect effortWrap fileInput histFrom histKeyword histKeywordField histResults histSearchBtn histTimeField histTo imgChip imgToggle input main menuBtn messages micBtn modeBtn modeSwitch modelBadge modelPanel modelPanelList modelSwitchBtn msgMenuList rowMenuModal rowMenuList rowMenuTitle newChatBtn openSearchBtn openSettingsBtn openThemesBtn saveSettingsBtn scrim searchModeSwitch searchToggle selectBar selectCancel selectCopy selectCount selectDelete selfTestBtn selfTestOut sendBtn sessionBtn sessionList sessionPromptReset sessionPromptSave msetAsr msetImg msetMain msetTts msetVision providerNowLine setAsrEnabled setAsrLang setAvatarAiClear setAvatarAiPick setAvatarAiPreview setAvatarUserClear setAvatarUserPick setAvatarUserPreview setCustomKey setCustomUrl setImgEnabled setImgSize setImgToImg setPhoneShareImg setMainCompat setInstances setSearchProvider setSessionAlias setSessionAvatarAiClear setSessionAvatarAiPick setSessionAvatarAiPreview setSessionAvatarUserClear setSessionAvatarUserPick setSessionAvatarUserPreview setSessionFollow setSessionPrompt setSessionTempVal setSessionTemperature setSessionTitle setSessionTopP setSessionTopPVal setSessionScene setSessionSceneEvery setSessionRelation setSessionShared setSessionCognition setSessionAutoBackup sessionRoleWrap sessionMemoryBox charMemoryBox setMemoryList sessionLineBadge sessionCognitionUpdate sessionRelationUpdate sessionReCompress sessionCorrectInput sessionCorrectRun sessionBackupNow sessionRestoreBackup sessionSetMain setSystemPrompt setTavilyKey setTempVal setTemperature setTopP setTopPVal setTtsAuto setTtsEnabled setTtsVoice setVideoEnabled setVideoBaseUrl setVideoKey setVideoModel setVideoMode setVideoRatio setVideoSize setVideoDuration setVideoFps setVideoCreatePath setVideoStatusPath setVideoResultField setVideoPollMs setVideoPollMax setVideoTemplate setMusicEnabled setMusicBaseUrl setMusicKey setMusicModel setMusicDuration setMusicFormat setMusicWithLyrics setMusicCreatePath setMusicStatusPath setMusicResultField setMusicPollMs setMusicPollMax setMusicTemplate setVisionEnabled sidebar stopBtn tavilyField themeGrid thinkToggle toasts characterBtn charBar characterModal charList charNewBtn charForm charEmpty charTools charName charSave charFilterRule charFilterEvery charFilterAI charFilterNow charFilterState charSplitBtn charSplitHelp charSplitHint charSplitPanel charSplitInput charSplitRun charSplitCancel charSplitState openAboutBtn aboutModal aboutVersion openDataBtn dataModal exportScope exportCharWrap exportCharSel exportSessionWrap exportSessionSel exportKeys exportDownload exportCopy importText importFileBtn importTextBtn importFileInput importClipBtn exportShare clearCacheBtn setNoImage setNotifyTasks introModal introTree introDots introNext introPrev introSkip guideTree setImgToText setImgExpireTurns charUsageLine usageModal usageGlobal usageSessions usageChars openUsageBtn setRoleplayEnabled setMyName setMyPersona setMyAppearance setMyBackground setMyLikes setAssistantCompress setCompressModel setTokenWarn setBgKeep sessionMakeShortcut sessionRemoveShortcut charMakeShortcut charRemoveShortcut exportNoImg setLockEnabled setLockNote setLockChange setLockCode setLockState lockScreen lockPassBox lockInput lockOk lockForgot lockErr lockRecoverBox recInput recOk recAi recBack recErr recNote lockQuizBox quizNote quizQ quizA quizOk quizBack quizErr lockResetBox resetNote resetPass1 resetPass2 resetOk resetBack resetErr lockDeadBox deadNote deadOk codeScreen codeText codeCopy codeOk setDailyUpdate setWorldGen setStatusQuant setAutoMessage setAutoMessagePhone setAdoptFormat setBgPreview setBgPick setBgAi setBgClear bgInput setBgBlur setBgBlurVal setBgBright setBgBrightVal setUsagePriceMode setUsagePriceHit setUsagePriceIn setUsagePriceOut setPhoneWarn resetUsageBtn usageCats setSessionFormat setSessionTtsVoice setSessionBgPreview setSessionBgPick setSessionBgAi setSessionBgClear setSessionBgFollow chatBg charImportBtn charImportInput phoneBtn phoneTopBtn phoneModal phoneClock phoneListView phoneCloseBtn phoneList phoneChatView phoneBack phoneTitle phoneMsgs phoneActCall phoneActTransfer phoneActLoc phoneActImg phoneActVoice phoneActVoiceLabel phoneMore phoneSetBtn phoneInput phoneSend phoneSheet phoneSheetTitle phoneSheetBody phoneSheetCancel phoneSheetOk phoneCall phoneCallAvatar phoneCallName phoneCallState phoneCallTimer phoneCallSaid phoneCallTalk phoneCallTalkLabel phoneCallHang phoneImgInput phoneMomentsView phoneMoments phoneMomentsBack phoneMomentsPost phoneMomentsClose phoneMomentImg newGroupBtn groupModal reminderDot reminderModal reminderText reminderAsTime reminderTimeField reminderAt reminderAddBtn reminderList groupName groupMembers groupImport groupCancel groupOk setSessionStatusQuant setSessionDiary sessionDiarySave sessionDiaryClear sessionDiaryList sessionSummaryRun sessionSummaryOut worldModal worldText worldSkip worldRegen worldAdopt setAutoMessageMin setLive2dEnabled setLive2dModel live2dUploadBtn live2dFolderInput live2dUploadState live2dTestBtn live2dTestOut phoneActVideo phoneActAvatar phoneCallCam phoneCallCamLabel phoneCallStage phoneCallCanvas phoneCallFallback charPresetBtn presetModal presetList setSplashAnim setSplashText setSplashSub setSplashImage setSplashAvatar phoneTypingBar quickBtn quickPanel qpList qpRefresh qpClose qpCount sessionClockText sessionClockLive setSessionAutoMsg setSessionTime setSessionTimeSync sessionTimeApply sessionTimeNow sessionTimeClear sessionTimeLine setPhoneBgPreview setPhoneBgPick setPhoneBgClear setPhoneBgBlur setPhoneBgBlurVal setPhoneBgBright setPhoneBgBrightVal charImportAI charImportUser groupCogSection setPeerCogOn peerCogList peerCogUpdate peerCogState groupSyncBtn groupSyncState updateCheckBtn updateState settingsHome settingsBack settingsTitle settingsBody personaPick personaCount personaFields personaNewBtn personaDelBtn personaApplyBtn personaSplitInput personaSplitRun personaSplitAgain personaSplitState sideTabs sidePaneAsst sidePaneRole sidePanePhone sessionListAsst phoneCharList phoneAddSheet phoneAddBtn phoneAddCancel phAddMoment phAddContact freezeAskModal freezeAskOn freezeAskNever freezeAskStay freezeAskGo reasonDrawer reasonMask reasonClose reasonList reasonNewInput reasonAddBtn openReasonBtn setSessionReason setReasonLock sessionReasonExit charUpgradeRow charUpgradeBtn upgradeModal upgradeMeet upgradeCancel upgradeOk".split(" ");
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

  /* 群聊里每条消息的头像按「发言人」取：角色自己的头像优先，没有就用全局 AI 头像 */
  function speakerAvatar(charId, s) {
    const c = Store.getCharacters().find((x) => x.id === charId);
    if (c && c.avatar) return c.avatar;
    const ses = s || session();
    return (ses && ses.avatarAi) || state.settings.avatarAi || "";
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

  /* ── 自定义聊天背景（6.0.0）────────────────────────
     全局默认存 settings.bgImage，会话覆盖存 session.bgImage（bgFollow=false 时生效）。
     值可能是内联 dataURL，也可能是外置文件路径（imgRef）—— 大图一律走外置，见 store.js。 */
  const bgDraft = { settings: "", session: "", phone: "" };

  function bgUrl(val) {
    if (!val) return "";
    if (String(val).slice(0, 5) === "data:") return String(val);
    try { return Store.imageURL({ imgRef: val }) || ""; } catch (e) { return ""; }
  }
  function renderBgPreview(sel, val) {
    const box = $(sel);
    if (!box) return;
    const url = bgUrl(val);
    box.style.backgroundImage = url ? ("url(" + url + ")") : "";
  }
  function syncBgLabels() {
    setText("#setBgBlurVal", String(Number($v("#setBgBlur")) || 0));
    setText("#setBgBrightVal", String(Number($v("#setBgBright")) || 100));
    setText("#setPhoneBgBlurVal", String(Number($v("#setPhoneBgBlur")) || 0));
    setText("#setPhoneBgBrightVal", String(Number($v("#setPhoneBgBright")) || 100));
  }

  /* ── 背景图 AI 生成（10-17 定的，10-18 落地）──────────────
     全局背景 / 本对话背景各一个入口，走「设置 → 画图」那套模型配置
     （和聊天里发图同一条通道）。生成结果先落进 bgDraft，点「保存」才真正写库，
     免得试了几张不满意的就改掉原背景。 */
  async function genBgByAi(target, prevSel) {
    const s = session();
    const ch = s ? characterFor(s) : null;
    let hint = "描述想要的画面：地点、天气、时间、色调。不要写人物（背景里出现人会很怪）。";
    if (target === "session" && s) {
      const bits = [];
      if (s.scene) bits.push("当前场景：" + s.scene);
      const world = ch && ch.fields ? String(ch.fields.world || "") : "";
      if (world) bits.push("世界观：" + world);
      if (bits.length) hint = bits.join("；") + "。想换个具体的画面就写在这里。";
    }
    const desc = await UI.askDialog(target === "session" ? "AI 生成这张对话的背景" : "AI 生成全局背景", hint,
      "例：傍晚的海边栈道，暖橙色天空，远处有灯");
    if (!desc) return;
    if (!Media.capable("img", state.settings)) {
      UI.toast("先在「设置 → 画图」里填好接口地址、密钥和模型", true);
      return;
    }
    UI.toast("正在生成背景，可能要十几秒…");
    try {
      const url = await Media.image(desc + "，用作聊天界面背景：横构图，画面不要出现人物和文字",
        state.settings, null);
      if (!url) { UI.toast("模型没有返回图片", true); return; }
      bgDraft[target] = url;
      renderBgPreview(prevSel, url);
      if (target === "session") setChecked("#setSessionBgFollow", false);
      UI.toast("已生成，点右下角「保存」生效");
    } catch (e) {
      UI.toast("生成失败：" + ((e && e.message) || e), true);
    }
  }

  /* 手机聊天页**单独**的背景，跟聊天背景互不干扰（各存各的值）。 */
  function applyPhoneBackground() {
    const layer = $("#phoneBg");
    if (!layer) return;
    /* 这条线在手机页「这条线」里单独设过背景就用它的，否则用全局那套。
       问 phone.js 要「当前手机页显示的是哪条线」——它才是那个状态的唯一持有者。 */
    let src = state.settings.phoneBgImage || "";
    try {
      const own = (window.DL && window.DL.phoneLineBg) ? String(window.DL.phoneLineBg() || "") : "";
      if (own) src = own;
    } catch (e) { /* ignore */ }
    const url = bgUrl(src);
    if (!url) { layer.hidden = true; layer.style.backgroundImage = ""; return; }
    const blur = Number(state.settings.phoneBgBlur) || 0;
    const bright = Number(state.settings.phoneBgBright) || 100;
    /* 跟聊天背景同一套：压一层同色半透明罩，保证气泡文字读得清 */
    const ov = resolvedMode() === "dark" ? "rgba(0,0,0,.34)" : "rgba(255,255,255,.30)";
    layer.hidden = false;
    layer.style.backgroundImage = "linear-gradient(" + ov + "," + ov + "), url(" + url + ")";
    layer.style.filter = "blur(" + blur + "px) brightness(" + bright + "%)";
  }
  function effectiveBgImage() {
    const s = session();
    const sess = (s && s.bgFollow === false) ? (s.bgImage || "") : "";
    return sess || state.settings.bgImage || "";
  }
  function applyChatBackground() {
    const layer = $("#chatBg");
    if (!layer) return;
    const url = bgUrl(effectiveBgImage());
    if (!url) { layer.hidden = true; layer.style.backgroundImage = ""; return; }
    const blur = Number(state.settings.bgBlur) || 0;
    const bright = Number(state.settings.bgBright) || 100;
    /* 压一层同色半透明罩：保证浅色 / 深色主题下气泡文字都读得清 */
    const ov = resolvedMode() === "dark" ? "rgba(0,0,0,.34)" : "rgba(255,255,255,.30)";
    layer.hidden = false;
    layer.style.backgroundImage = "linear-gradient(" + ov + "," + ov + "), url(" + url + ")";
    layer.style.filter = "blur(" + blur + "px) brightness(" + bright + "%)";
  }
  /* 读本地图片 → 缩到最长边 1280 的 JPEG（背景只需够用，别把几 MB 原图外置） */
  function readBgFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type || "")) { reject(new Error("请选择图片文件")); return; }
      const fr = new FileReader();
      fr.onload = () => {
        const raw = String(fr.result || "");
        const img = new Image();
        img.onload = () => {
          const maxW = 1280;
          const scale = Math.min(1, maxW / Math.max(1, img.width));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          cv.getContext("2d").drawImage(img, 0, 0, w, h);
          try { resolve(cv.toDataURL("image/jpeg", 0.82)); } catch (e) { resolve(raw); }
        };
        img.onerror = () => reject(new Error("图片读取失败"));
        img.src = raw;
      };
      fr.onerror = () => reject(new Error("图片读取失败"));
      fr.readAsDataURL(file);
    });
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
  function openPresetPicker() { return window.DL.openPresetPicker.apply(null, arguments); }
  function updateCognitionNow() { return window.DL.updateCognitionNow.apply(null, arguments); }
  function updateRelationSharedNow() { return window.DL.updateRelationSharedNow.apply(null, arguments); }
  function runMemoryCorrect() { return window.DL.runMemoryCorrect.apply(null, arguments); }
  function runReCompress() { return window.DL.runReCompress.apply(null, arguments); }
  function sessionDiarySave() { return window.DL.sessionDiarySave.apply(null, arguments); }
  function sessionDiaryClear() { return window.DL.sessionDiaryClear.apply(null, arguments); }
  function runAssistantSummary() { return window.DL.runAssistantSummary.apply(null, arguments); }
  function generateWorld() { return window.DL.generateWorld.apply(null, arguments); }
  function applyWorld() { return window.DL.applyWorld.apply(null, arguments); }
  function generateAutoMessage() { return window.DL.generateAutoMessage.apply(null, arguments); }
  function applyAutoMessage() { return window.DL.applyAutoMessage.apply(null, arguments); }
  function generatePhoneShare() { return window.DL.generatePhoneShare.apply(null, arguments); }
  function applyPhoneShare() { return window.DL.applyAutoShare.apply(null, arguments); }
  function washFilterNow() { return window.DL.washFilterNow.apply(null, arguments); }
  function aiFilterRule() { return window.DL.aiFilterRule.apply(null, arguments); }
  function maybeAutoWash() { return window.DL.maybeAutoWash.apply(null, arguments); }
  function openCharacterModal() { return window.DL.openCharacterModal.apply(null, arguments); }
  function maybeAutoCompress() { return window.DL.maybeAutoCompress.apply(null, arguments); }
  function maybeDailyRefresh() { return window.DL.maybeDailyRefresh.apply(null, arguments); }
  function importTavernCard() { return window.DL.importTavernCard.apply(null, arguments); }
  function bindQuickReply() { return window.DL.bindQuickReply.apply(null, arguments); }
  function bindWorldView() { return window.DL.bindWorldView.apply(null, arguments); }
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
    /* 取「层级最高」的那个弹窗关。
       为什么不再按 DOM 顺序取最后一个：现在层级是写死在各弹窗上的
       （设置页 88 / 用量统计与导入导出 90 / 自绘选择面板 75），
       已经和 DOM 先后不一致了，按 z-index 才准。同层时后面的那个在上。 */
    const all = document.querySelectorAll(".modal.show");
    let best = "", bestZ = -1;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const id = el.id;
      /* 首次引导有自己的「跳过」按钮，返回键不关它（关了下次启动还会再弹一次） */
      if (!id || id === "introModal") continue;
      let z = 60;
      try { z = parseInt(getComputedStyle(el).zIndex, 10); if (isNaN(z)) z = 60; } catch (e) { z = 60; }
      if (z >= bestZ) { bestZ = z; best = id; }
    }
    return best;
  }
  function onBackKey() {
    try {
      /* 1) 相机层（它是 .camera-layer，不在 .modal 里，要单独判） */
      const cam = window.DL && window.DL.camera;
      if (cam && typeof cam.isOpen === "function" && cam.isOpen()) { cam.close(); return; }
      /* 1.5) 手机层（.phone-layer，同样不在 .modal 里）：通话中先挂断，其次聊天 → 列表 → 关闭 */
      const ph = window.DL && window.DL.phone;
      if (ph && typeof ph.isOpen === "function" && ph.isOpen()) { ph.close(); return; }
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
      if (now - backAt < 2000) { requestExit(); return; }
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

  /* ── 退出前问一句「要不要冻结时间」（10-16 用户要求）────────────
     只在「当前会话开着时间系统、还没冻结、且没勾过不再问」时才弹。
     勾了「不再弹出」再点退出 → 先弹一个后果警告（确认按钮 5 秒后才可点）。 */
  function requestExit() {
    const doExit = () => { try { Store.callBridge("关闭应用退出"); } catch (e) { /* ignore */ } };
    const s = session();
    const hasTL = !!(s && Memory && Memory.hasTimeline && Memory.hasTimeline(s));
    const frozen = !!(s && Memory && Memory.isFrozen && Memory.isFrozen(s));
    if (!hasTL || frozen || (state.settings && state.settings.noFreezeAsk)) { doExit(); return; }
    const on = $("#freezeAskOn"), never = $("#freezeAskNever");
    if (on) on.checked = true;
    if (never) never.checked = false;
    UI.openModal("freezeAskModal");
  }
  async function confirmExit() {
    const s = session();
    const never = $("#freezeAskNever");
    const on = $("#freezeAskOn");
    const wantNever = !!(never && never.checked);
    const wantFreeze = !!(on && on.checked);
    if (wantNever) {
      const ok = await UI.confirmDialog("要关掉这个提醒吗？",
        "以后退出应用都不再问你冻不冻时间。想重新打开，去「对话设置 → 时间」里双击时钟，或清一次设置。", 5000);
      if (!ok) return;
      state.settings = Store.saveSettings({ noFreezeAsk: true });
    }
    if (wantFreeze && s && Memory && Memory.hasTimeline && Memory.hasTimeline(s)) {
      Memory.freezeTime(s);
      Store.updateSession(s.id, { time: s.time });
    }
    UI.closeModal("freezeAskModal");
    try { Store.callBridge("关闭应用退出"); } catch (e) { /* ignore */ }
  }

  /* ── 离线原因（10-17 用户要求）──────────────────────────
     会话里选一条 + 可选「锁定」——锁定后不管怎么离线都按它算（防手滑清后台）。
     只在开着时间系统时生效。 */
  function saveSessionReason() {
    const s = session();
    if (!s) return;
    const el = $("#setSessionReason");
    Store.updateSession(s.id, { offlineReasonId: el ? el.value : "" });
  }
  function saveReasonLock() {
    const s = session();
    if (!s) return;
    const el = $("#setReasonLock");
    Store.updateSession(s.id, { offlineReasonLocked: !!(el && el.checked) });
  }
  /* 「按此退出应用」：先把离线原因 + 毫秒级离开时间写盘、回读核对无误，才真退出。
     任何一步对不上就**不退出**并如实报错 —— 宁可留在应用里，也不带着没写好的数据离开。 */
  function exitWithReason() {
    const s = session();
    if (!s) return;
    if (!Memory || !Memory.hasTimeline || !Memory.hasTimeline(s)) { UI.toast("这条对话没开时间系统，用不了", true); return; }
    const el = $("#setSessionReason");
    const wantId = el ? el.value : "";
    const lockEl = $("#setReasonLock");
    const wantLock = !!(lockEl && lockEl.checked);
    const wantLeft = Date.now();
    if (!s.time) { UI.toast("这条对话没有时间轴，用不了", true); return; }
    const nextTime = Object.assign({}, s.time, { leftAt: wantLeft, leftReasonId: wantId });
    const r = Store.updateSession(s.id, { offlineReasonId: wantId, offlineReasonLocked: wantLock, time: nextTime });
    if (!r) { UI.toast("写入失败，先别退出（数据没丢）", true); return; }
    /* 回读核对：读回来必须和刚写的完全一致（毫秒级） */
    const back = (Store.getSessions() || []).filter((x) => x.id === s.id)[0];
    const okBack = !!(back && back.offlineReasonId === wantId
      && (!!back.offlineReasonLocked) === wantLock
      && back.time && back.time.leftAt === wantLeft);
    if (!okBack) { UI.toast("回读核对不一致，已停在应用里（没退出）", true); return; }
    UI.toast("已记下离线原因与离开时间，正在退出…");
    try { Store.callBridge("关闭应用退出"); } catch (e) { /* ignore */ }
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

  /* ── 打开外部链接：要交给系统浏览器，不能在应用内打开 ──────────
     用户口径（10-18）：使用指南里 DeepSeek 开放平台那个链接点了会在应用内打开，
     把整个界面顶掉，回来还得重新进。所以这里改成「唤醒默认浏览器」。
     通道优先级：
       ① 原生桥（各家封装命名不一，挨个试一遍，有就用）
       ② window.open(url, "_system") —— 部分 WebView 认这个目标名，会交给系统
       ③ 兜底复制链接 —— 宁可让用户自己粘，也不要在应用内跳走（那才是原来的毛病） */
  const EXT_OPEN_BRIDGES = ["打开指定链接", "打开链接", "打开浏览器", "用浏览器打开",
    "打开外部链接", "打开网页", "openUrl", "打开指定网址"];

  function openExternal(url) {
    const u = String(url || "").trim();
    if (!u) return false;
    for (let i = 0; i < EXT_OPEN_BRIDGES.length; i++) {
      const n = EXT_OPEN_BRIDGES[i];
      if (!Store.hasBridge(n)) continue;
      try {
        const r = Store.callBridge(n, u);
        if (r !== false) return true;
      } catch (e) { /* 这个名字不通就试下一个 */ }
    }
    try {
      const w = window.open(u, "_system");
      if (w) return true;
    } catch (e) { /* ignore */ }
    UI.copyText(u).then((ok) => UI.toast(ok ? "已复制链接，粘到浏览器里打开" : u, !ok));
    return false;
  }


  /* ── 更新检查（10-18 用户要求）──────────────────────────
     纯前端拿不到「下载并安装」的权限，所以只做：读清单 → 比版本 → 给说明 + 下载地址。
     清单地址在 config.js 的 UPDATE_URL（留空 = 不检查，关于页显示「还没配」）。
     静默检查一天只跑一次；发现新版本才弹窗，取消即记下「跳过这个版本」。 */
  const UPDATE_DAY_KEY = "deeplink.updateCheckDay";
  const UPDATE_SKIP_KEY = "deeplink.updateSkip";

  /* 版本号比较：a 比 b 新返回 1，相同 0，旧 -1（"6.10.0" 要大于 "6.9.9"，不能按字符串比） */
  function vCmp(a, b) {
    const pa = String(a || "").split(".").map((x) => parseInt(x, 10) || 0);
    const pb = String(b || "").split(".").map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  async function fetchUpdateInfo() {
    const url = String(CONFIG.UPDATE_URL || "").trim();
    if (!url) return { ok: false, why: "还没配更新地址（config.js 的 UPDATE_URL 是空的）" };
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return { ok: false, why: "读取更新清单失败：HTTP " + r.status };
      const j = await r.json();
      if (!j || typeof j !== "object") return { ok: false, why: "更新清单格式不对（应该是一个 JSON 对象）" };
      return { ok: true, info: j };
    } catch (e) {
      return { ok: false, why: "连不上更新地址（" + ((e && e.message) || e) + "）" };
    }
  }

  async function checkUpdate(manual) {
    const box = $("#updateState");
    if (manual && box) setText("#updateState", "正在检查…");
    const r = await fetchUpdateInfo();
    if (!r.ok) {
      if (manual && box) setText("#updateState", r.why);
      return r;
    }
    const info = r.info || {};
    const cur = CONFIG.APP_VERSION || "0";
    const remote = String(info.version || "").trim();
    if (!remote) {
      if (manual && box) setText("#updateState", "清单里没写 version 字段");
      return { ok: false, why: "清单里没写 version" };
    }
    if (vCmp(remote, cur) <= 0) {
      if (manual && box) setText("#updateState", "已是最新版本（" + cur + "）");
      return { ok: true, latest: true };
    }
    let skip = "";
    try { skip = localStorage.getItem(UPDATE_SKIP_KEY) || ""; } catch (e) { skip = ""; }
    if (!manual && skip && vCmp(remote, skip) <= 0) return { ok: true, skipped: true };
    if (box) setText("#updateState", "有新版本 " + remote);
    return promptUpdate(info, cur, remote, box);
  }

  function promptUpdate(info, cur, remote, box) {
    const notes = String(info.notes || "").trim();
    const dl = String(info.url || "").trim() || String(CONFIG.UPDATE_PAGE || "").trim();
    const text = "当前 " + cur + "　→　最新 " + remote + "\n\n"
      + (notes ? notes.slice(0, 800) + "\n\n" : "")
      + (dl ? "下载地址：" + dl + "\n\n" : "（清单里没有下载地址）\n\n")
      + "装之前先去「设置 → 导入导出」导出一次备份。只有签名一致的包才能直接覆盖安装；"
      + "装不上就只能卸载重装，而卸载会把本机数据一起删掉。";
    return UI.confirmDialog("发现新版本 " + remote, text).then((ok) => {
      if (ok) {
        if (dl) openExternal(dl);
        else UI.toast("清单里没有下载地址", true);
      } else {
        /* 取消 = 这个版本先跳过，静默检查不再提它；手动检查仍会提示 */
        try { localStorage.setItem(UPDATE_SKIP_KEY, remote); } catch (e) { /* ignore */ }
        UI.toast("已跳过 " + remote + "（手动检查仍会提示）");
        if (box) setText("#updateState", "已跳过 " + remote);
      }
      return { ok: true, found: true, remote: remote };
    });
  }

  /* 启动后静默查一次（一天一次，没配地址就什么都不做） */
  function maybeCheckUpdate() {
    if (!String(CONFIG.UPDATE_URL || "").trim()) return;
    const key = todayKey();
    try {
      if (localStorage.getItem(UPDATE_DAY_KEY) === key) return;
      localStorage.setItem(UPDATE_DAY_KEY, key);
    } catch (e) { /* 存不了就还是查，最多多查几次 */ }
    setTimeout(() => { checkUpdate(false).catch(() => { /* 静默 */ }); }, 4500);
  }

  /* ── Live2D 模型上传：把整个文件夹写进应用内部目录 ──────────
     单文件 8MB、整包 30MB 上限。桥那个「保存指定文件」原本是给图片用的
     （一次几百 KB），几十兆的二进制一次塞进去很可能被原生层拒掉或者直接 OOM，
     所以先卡住上限、超了就把话说清楚，而不是闷头写一半。 */
  const L2_MAX_FILE = 8 * 1024 * 1024;
  const L2_MAX_TOTAL = 30 * 1024 * 1024;

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(new Error("读取失败：" + (file && file.name)));
      fr.readAsDataURL(file);
    });
  }

  async function uploadLive2dFiles(files, say) {
    const first = files[0];
    const rel0 = String((first && first.webkitRelativePath) || (first && first.name) || "");
    const folder = (rel0.split("/")[0] || "model").replace(/[\\/:*?"<>|]/g, "_");
    /* 入口文件只认 Cubism 2.1 的 .model.json —— 本项目的运行时是 live2d.min.js（2.1），
       它读不了 Cubism 3 的 .model3.json。以前优先挑 model3，等于把「看起来上传成功」的
       3.x 模型填进去，真机一测必失败。 */
    const entry = files.filter((f) => /\.model\.json$/i.test(f.name))[0];
    const entry3 = files.filter((f) => /\.model3\.json$/i.test(f.name))[0];
    if (!entry && entry3) {
      say("这套是 Cubism 3 模型（" + entry3.name + "），当前用的是 Cubism 2.1 运行时，读不了。" +
        "请换 2.1 格式的模型（.model.json + .moc + 贴图）。");
      return;
    }
    if (!entry) { say("这个文件夹里没找到 .model.json，可能不是 Cubism 2.1 的模型目录。"); return; }

    let total = 0;
    for (const f of files) {
      if (f.size > L2_MAX_FILE) {
        say("「" + f.name + "」有 " + (f.size / 1048576).toFixed(1) + " MB，超过单文件 8 MB 上限。");
        return;
      }
      total += f.size;
    }
    if (total > L2_MAX_TOTAL) {
      say("这套模型一共 " + (total / 1048576).toFixed(1) + " MB，超过 30 MB 上限。");
      return;
    }

    /* 内部私有目录优先，拿不到再退外部私有目录（同 store.js 的 imgDir 口径） */
    let root = "";
    try { root = String(window.webapp["获取内部文件目录"]() || ""); } catch (e) { root = ""; }
    if (!root) {
      try {
        if (typeof window.webapp["获取外部文件目录"] === "function") root = String(window.webapp["获取外部文件目录"]() || "");
      } catch (e) { root = ""; }
    }
    root = root.replace(/\/+$/, "");
    if (!root) { say("拿不到应用的私有目录，无法保存模型（原生接口没返回路径）。"); return; }
    const dir = root + "/live2d/" + folder;

    /* 先单独写入口文件：一是探「原生层能不能建子目录」，二是模型 JSON 本身就小，
       失败能立刻停手。平铺到根目录不行 —— 模型里的贴图路径带子目录，摊平就对不上了。 */
    const relOf = (f) => String(f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name;
    let probeW = null;
    try {
      probeW = window.webapp["保存指定文件"](dir + "/" + relOf(entry), await readAsDataUrl(entry));
    } catch (e) { probeW = false; }
    if (probeW === false) {
      say("写入失败：「" + relOf(entry) + "」。这台设备的原生接口可能不支持建子目录，或者没有存储权限。");
      return;
    }

    let done = 0;
    const failed = [];
    say("正在写入 " + done + "/" + files.length + " …");
    for (const f of files) {
      if (f === entry) { done++; say("正在写入 " + done + "/" + files.length + " …"); continue; }
      const rel = relOf(f);
      const path = dir + "/" + rel;
      let w = null;
      try { w = window.webapp["保存指定文件"](path, await readAsDataUrl(f)); }
      catch (e) { w = false; }
      /* 写完复核：有「判断指定文件」就查一遍，没写成的不算成功（否则会填一个读不到的路径） */
      let ok = w !== false;
      if (ok && Store.hasBridge("判断指定文件")) {
        try { if (Store.callBridge("判断指定文件", path) === false) ok = false; } catch (e) { /* 复核抛错不当失败 */ }
      }
      if (ok) done++; else failed.push(rel);
      say("正在写入 " + (done + failed.length) + "/" + files.length + " …");
    }
    if (failed.length) {
      say("有 " + failed.length + " 个文件没写成（" + failed.slice(0, 3).join("、") +
        (failed.length > 3 ? " 等" : "") + "）。模型不完整，路径没有填，请重试。");
      return;
    }

    /* 记一份清单，以后做成下拉直接选 */
    const list = (state.settings.live2dSets || []).slice();
    const item = { name: folder, dir: dir, entry: entry.name, files: done, bytes: total, ts: Date.now() };
    const at = list.findIndex((x) => x && x.name === folder);
    if (at >= 0) list[at] = item; else list.push(item);
    const next = Store.saveSettings({ live2dSets: list });
    if (state.settings) state.settings.live2dSets = next.live2dSets;

    setVal("#setLive2dModel", dir + "/" + entry.name);
    say("已存好「" + folder + "」：" + done + " 个文件，" + (total / 1048576).toFixed(1) +
      " MB。模型路径已填好，点「测试模型」验一下。");
  }

  function bind() {
    /* 元素缺失也不能让后面的绑定中断（曾导致顶栏按钮全部失效） */
    /* 滚轮式日期 / 时间（10-18 用户要求，替代系统原生控件）：
       所有标了 data-wheel 的输入框，点开就弹自研选择器，选完写回 value 并抛 change。 */
    document.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!t || t.tagName !== "INPUT" || !t.getAttribute) return;
      const mode = t.getAttribute("data-wheel");
      if (!mode || !window.WheelPicker) return;
      ev.preventDefault();
      window.WheelPicker.open({
        mode: mode,
        value: t.value,
        onOk: (v) => {
          t.value = v;
          try { t.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) { /* ignore */ }
        }
      });
    });
    on("#menuBtn", "click", openSidebar);
    on("#scrim", "click", closeSidebar);
    on("#newChatBtn", "click", () => { newSession(); closeSidebar(); });
    on("#openSearchBtn", "click", () => { openSearchModal(); closeSidebar(); });
    on("#newGroupBtn", "click", () => { openGroupModal(); closeSidebar(); });
    on("#groupCancel", "click", () => UI.closeModal("groupModal"));
    on("#groupOk", "click", createGroup);

    on("#sendBtn", "click", send);
    on("#stopBtn", "click", stop);

    /* 这里原先直接 $("#input").addEventListener：元素缺失会抛错，
       而 bind() 没有 try —— 会把它后面 450+ 行绑定全带崩。统一走 on()。 */
    on("#input", "input", autoResize);
    on("#input", "keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.shiftKey) return;
      if (isTouch()) return;
      e.preventDefault();
      send();
    });

    on("#plusFile", "click", () => { popoverClose(); const f = $("#fileInput"); if (f) f.click(); });
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

    /* ── 自定义背景：全局 / 会话两处共用一个文件选择器，靠 bgTarget 区分 ── */
    let bgTarget = "settings";
    on("#setBgPick", "click", () => { bgTarget = "settings"; const i = $("#bgInput"); if (i) i.click(); });
    on("#setSessionBgPick", "click", () => { bgTarget = "session"; const i = $("#bgInput"); if (i) i.click(); });
    /* AI 生成背景：全局 / 本对话各一个入口（结果先进草稿，保存才落库） */
    on("#setBgAi", "click", () => { genBgByAi("settings", "#setBgPreview"); });
    on("#setSessionBgAi", "click", () => { genBgByAi("session", "#setSessionBgPreview"); });
    on("#setBgClear", "click", () => { bgDraft.settings = ""; renderBgPreview("#setBgPreview", ""); });
    /* 手机背景：同一个文件选择器，靠 bgTarget 区分 */
    on("#setPhoneBgPick", "click", () => { bgTarget = "phone"; const i = $("#bgInput"); if (i) i.click(); });
    on("#setPhoneBgClear", "click", () => { bgDraft.phone = ""; renderBgPreview("#setPhoneBgPreview", ""); });
    on("#setPhoneBgBlur", "input", syncBgLabels);
    on("#setPhoneBgBright", "input", syncBgLabels);
    on("#setSessionBgClear", "click", () => {
      bgDraft.session = "";
      renderBgPreview("#setSessionBgPreview", "");
      setChecked("#setSessionBgFollow", false);
    });
    on("#bgInput", "change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const url = await readBgFile(file);
        bgDraft[bgTarget] = url;
        const prevSel = bgTarget === "session" ? "#setSessionBgPreview"
          : (bgTarget === "phone" ? "#setPhoneBgPreview" : "#setBgPreview");
        renderBgPreview(prevSel, url);
        if (bgTarget === "session") setChecked("#setSessionBgFollow", false);
      } catch (err) {
        UI.toast(err.message || "背景图读取失败", true);
      }
    });
    on("#setBgBlur", "input", syncBgLabels);
    on("#setBgBright", "input", syncBgLabels);
    /* 清零用量统计 */
    on("#resetUsageBtn", "click", async () => {
      const ok = await UI.confirmDialog("清零用量统计", "把用量统计（含按类型）归零？此操作不可恢复。");
      if (!ok) return;
      Store.saveUsage({ prompt: 0, completion: 0, total: 0, cacheHit: 0, cacheMiss: 0, calls: 0 });
      Store.saveUsageCats({});
      const list = Store.getSessions();
      list.forEach((s) => { s.usage = null; });
      Store.saveSessions(list);
      const cs = Store.getCharacters();
      cs.forEach((c) => { c.usage = null; });
      Store.saveCharacters(cs);
      UI.toast("已清零用量统计");
      try { window.DL.renderUsageStats(); } catch (e) { /* ignore */ }
    });

    /* ── 群聊：对彼此的认知 + 同步到各自线（10-18）────────────────
       更新认知是手动触发的（用户口径：不做自动），一次非流式请求；
       同步把群聊记忆与各自的印象写进各自那条线，跟着那条线一起压缩。 */
    on("#setPeerCogOn", "change", () => {
      const cur = session();
      if (!cur) return;
      const on = !!($("#setPeerCogOn") && $("#setPeerCogOn").checked);
      Store.updateSession(cur.id, { peerCogOn: on });
      UI.toast(on ? "认知会带进对话（下次发言生效）" : "已关掉：认知还在，只是不告诉 AI");
    });
    on("#peerCogUpdate", "click", async () => {
      const cur = session();
      if (!cur || !cur.isGroup) { UI.toast("这不是群聊", true); return; }
      const btn = $("#peerCogUpdate");
      if (btn && btn.disabled) return;
      if (btn) btn.disabled = true;
      setText("#peerCogState", "正在按最近的对话整理…");
      try {
        const r = await window.DL.updatePeerCog(cur.id);
        if (r && r.ok) {
          setText("#peerCogState", "已更新 " + r.count + " 条");
          const now = sessionById(cur.id);
          if (window.DL.renderGroupCog) window.DL.renderGroupCog(now);
          setText("#peerCogState", "已更新 " + r.count + " 条");
        } else {
          setText("#peerCogState", (r && r.why) || "没更新成功");
        }
      } catch (e) {
        setText("#peerCogState", "更新失败：" + ((e && e.message) || e));
      }
      if (btn) btn.disabled = false;
    });
    on("#groupSyncBtn", "click", async () => {
      const cur = session();
      if (!cur || !cur.isGroup) { UI.toast("这不是群聊", true); return; }
      const btn = $("#groupSyncBtn");
      if (btn && btn.disabled) return;
      if (btn) btn.disabled = true;
      setText("#groupSyncState", "正在写入…");
      try {
        const r = await window.DL.syncGroupToLines(cur.id);
        if (r && r.ok) {
          let msg = "已写入 " + r.done.length + " 条线：" + r.done.join("、");
          if (r.skipped && r.skipped.length) msg += "；没写成的：" + r.skipped.join("、");
          setText("#groupSyncState", msg);
          UI.toast("已同步到 " + r.done.length + " 条线");
        } else {
          setText("#groupSyncState", (r && r.why) || "没同步成功");
        }
      } catch (e) {
        setText("#groupSyncState", "同步失败：" + ((e && e.message) || e));
      }
      if (btn) btn.disabled = false;
    });

    /* live2D 测试：拿设置里填的模型路径试加载一次，把结果写进提示行（真机上看得见成败） */
    /* ── Live2D 模型上传（10-18 用户要求）────────────────────
       模型是一整个文件夹（moc3 + 贴图 + 动作），浏览器只能「选中」、存不住，
       所以走原生桥的「保存指定文件」写到应用内部目录。
       没有桥（浏览器预览 / 无头测试）就直说，不假装成功。 */
    on("#live2dUploadBtn", "click", () => {
      const inp = $("#live2dFolderInput");
      if (!inp) return;
      if (!(window.webapp && typeof window.webapp["保存指定文件"] === "function")) {
        setText("#live2dUploadState", "这个环境没有原生桥（浏览器预览），上传只在手机上可用。");
        return;
      }
      inp.value = "";
      inp.click();
    });
    on("#live2dFolderInput", "change", async (e) => {
      const files = Array.from((e.target && e.target.files) || []);
      const say = (t) => setText("#live2dUploadState", t);
      if (!files.length) return;
      try {
        await uploadLive2dFiles(files, say);
      } catch (err) {
        say("上传失败：" + ((err && err.message) || err));
      }
    });

    on("#live2dTestBtn", "click", async () => {
      const out = $("#live2dTestOut");
      const L2 = window.DL && window.DL.live2d;
      if (out) out.textContent = "正在测试…";
      if (!L2 || !L2.attach) { if (out) out.textContent = "live2D 模块没加载（检查 live2d.js 是否随包发出）。"; return; }
      if (!L2.capable()) { if (out) out.textContent = "当前内核没有可用的 WebGL，live2D 跑不了（会退回首帧静态图）。"; return; }
      const url = ($v("#setLive2dModel") || "").trim() || L2.defaultModel;
      let cv = document.getElementById("live2dTestCanvas");
      if (!cv) {
        cv = document.createElement("canvas");
        cv.id = "live2dTestCanvas";
        cv.width = 240; cv.height = 320;
        cv.style.cssText = "display:block;margin-top:8px;background-color:var(--panel-2);border:1px solid var(--border);border-radius:10px;";
        if (out && out.parentNode) out.parentNode.insertBefore(cv, out);
      }
      /* 先跑一次环境探测：真机上「失败：Failed to fetch」光看提示分不清是
         「模型没进包」还是「file:// 下 fetch 被拒」—— 把探测结果一并贴在提示里，
         一趟真机就能定性（贴图能不能用 <img> 拿到、能不能上传 WebGL、XHR 能不能读）。 */
      let envInfo = "";
      if (L2.probe) {
        try { envInfo = await L2.probe(); } catch (e) { envInfo = ""; }
        if (out) out.textContent = (envInfo || "（环境探测没出结果）") + "\n\n正在尝试正式加载…";
      }
      try {
        await L2.attach(cv, url);
        const ch = (L2.channel && L2.channel()) || "";
        if (out) out.textContent = (envInfo ? envInfo + "\n\n" : "") + "成功：模型已渲染（" + url + "）" +
          (ch ? "，取数通道：" + ch : "") + "。若这里看得见人物，手机视频通话就能用。";
      } catch (e) {
        const ch = (L2.channel && L2.channel()) || "";
        if (out) out.textContent = (envInfo ? envInfo + "\n\n" : "") + "失败：" + (e && e.message ? e.message : e) +
          (ch ? "（取数通道：" + ch + "）" : "") + "（手机视频通话会自动退回首帧静态图）。";
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
    /* 侧栏三栏：助手 / 现实扮演角色 / 手机角色（点标题切栏）。
       用事件委派挂在容器上 —— 不依赖绑定时那三个按钮是否已就位。 */
    const sbTabs = $("#sideTabs");
    if (sbTabs) {
      sbTabs.addEventListener("click", (e) => {
        const b = (e.target && e.target.closest) ? e.target.closest(".side-tab") : null;
        if (!b) return;
        state.sideTab = b.getAttribute("data-side") || "role";
        renderSessionList();
      });
    }

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

    on("#sessionBtn", "click", (e) => {
      e.preventDefault();
      /* 双击 = 冻结 / 解冻时间（用户要求）；单击仍是弹那个两栏小浮窗。
         做法：单击延后 260ms 再执行，双击窗口内来了第二下就把单击吞掉。 */
      const s = session();
      if (s && Memory && Memory.hasTimeline && Memory.hasTimeline(s)) {
        const now = Date.now();
        if (now - (state.__clockTap || 0) < 320) {
          state.__clockTap = 0;
          if (clockTapTimer) { clearTimeout(clockTapTimer); clockTapTimer = null; }
          toggleClockFreeze(s);
          return;
        }
        state.__clockTap = now;
        if (clockTapTimer) clearTimeout(clockTapTimer);
        clockTapTimer = setTimeout(() => {
          clockTapTimer = null;
          popoverToggle("#headMenu", $("#sessionBtn"), false);
        }, 260);
        return;
      }
      popoverToggle("#headMenu", $("#sessionBtn"), false);
    });
    on("#headMenuSet", "click", () => {
      popoverClose();
      fillSessionForm(session());
      UI.openModal("sessionModal");
    });
    /* 退出前的「要不要冻结时间」弹窗（双击返回键触发） */
    on("#freezeAskStay", "click", () => UI.closeModal("freezeAskModal"));
    on("#freezeAskGo", "click", confirmExit);
    /* 离线原因（会话里的选择 + 锁定 + 按此退出） */
    on("#setSessionReason", "change", saveSessionReason);
    on("#setReasonLock", "change", saveReasonLock);
    on("#sessionReasonExit", "click", exitWithReason);
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
      /* 记忆类字段（场景/关系/共同经历/认知/采用格式/自动备份/状态量化）只在「角色会话」里可编辑：
         roleplay.js fillSessionForm 对这些字段有 role 守卫（非角色不填）。若这里无条件回写，
         群聊 / 无角色卡会话打开设置再点保存，就会把已有的 scene/shared/adoptFormat 等【清空】。 */
      const isRole = !!(s.characterId || "");
      const patch = {
        title: $v("#setSessionTitle").trim() || "新对话",
        systemPrompt: $v("#setSessionPrompt").trim(),
        alias: $v("#setSessionAlias").trim(),
        temperature: follow ? null : Number($v("#setSessionTemperature")),
        topP: follow ? null : Number($v("#setSessionTopP")),
        avatarUser: avatarDraft.sessionUser,
        avatarAi: avatarDraft.sessionAi,
        bgImage: bgDraft.session,
        bgFollow: checkedOf("#setSessionBgFollow")
      };
      if (isRole) {
        patch.adoptFormat = $v("#setSessionFormat").trim();
        /* 本线音色：留空 = 跟随全局 */
        patch.ttsVoice = $v("#setSessionTtsVoice").trim();
        patch.scene = $v("#setSessionScene");
        patch.sceneEvery = Number($v("#setSessionSceneEvery")) || 10;
        patch.relation = $v("#setSessionRelation");
        patch.shared = $v("#setSessionShared");
        patch.cognition = $v("#setSessionCognition");
        patch.autoBackup = checkedOf("#setSessionAutoBackup");
        patch.statusQuant = checkedOf("#setSessionStatusQuant");
        /* 主动发消息：'' = 跟随全局（写 null，让计时器回落到全局开关），on/off = 本条线说了算 */
        const am = $v("#setSessionAutoMsg");
        patch.autoMsgOn = (am === "on") ? true : ((am === "off") ? false : null);
      }
      Store.updateSession(s.id, patch);
      renderAll();
      syncPlaceholder();
      UI.closeModal("sessionModal");
      UI.toast("已保存");
    });
    on("#saveSettingsBtn", "click", () => {
      const patch = readSettingsForm();
      /* 背景这几项在 app.js 手里（草稿 + 滑杆在同一处），readSettingsForm 不覆盖它们 */
      patch.bgImage = bgDraft.settings;
      patch.bgBlur = Number($v("#setBgBlur")) || 0;
      patch.bgBright = Number($v("#setBgBright")) || 100;
      /* 启动动画：index.html 的启动脚本会直接读这几项，所以改完【下次启动】才生效 */
      patch.splashAnim = String($v("#setSplashAnim") || "1");
      patch.splashText = String($v("#setSplashText") || "").trim();
      patch.splashSub = String($v("#setSplashSub") || "").trim();
      patch.splashImage = String($v("#setSplashImage") || "").trim();
      patch.splashAvatar = String($v("#setSplashAvatar") || "");
      /* 手机页背景（跟聊天背景分开存） */
      patch.phoneBgImage = bgDraft.phone;
      patch.phoneBgBlur = Number($v("#setPhoneBgBlur")) || 0;
      patch.phoneBgBright = Number($v("#setPhoneBgBright")) || 100;
      state.settings = Store.saveSettings(patch);
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
    on("#updateCheckBtn", "click", () => { checkUpdate(true).catch(() => { /* 已在界面上报过 */ }); });
    on("#characterBtn", "click", openCharacterModal);
    on("#charNewBtn", "click", newCharacter);
    on("#charPresetBtn", "click", openPresetPicker);
    on("#charImportBtn", "click", () => { const i = $("#charImportInput"); if (i) i.click(); });
    on("#charImportInput", "change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) await importTavernCard(f);
    });
    on("#charSave", "click", saveCharacter);
    /* 纯手机角色升级为完整角色（10-17） */
    on("#charUpgradeBtn", "click", () => { if (window.DL.openUpgrade) window.DL.openUpgrade(); });
    on("#upgradeCancel", "click", () => UI.closeModal("upgradeModal"));
    on("#upgradeOk", "click", () => { if (window.DL.doUpgrade) window.DL.doUpgrade(); });
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
      /* 以前只有一句「已清理」，而提示条层级 80 低于设置页 88 → 整个被盖住，
         用户点完毫无反馈。现在先报「正在清理」，再把结果报出来，两段都看得见。 */
      UI.toast("正在清理页面缓存…");
      const r = Store.callBridge("设置清空缓存");
      setTimeout(function () {
        if (r === false) UI.toast("清理失败：原生接口返回失败，请重试", true);
        else UI.toast("已清理页面缓存，下次启动会重新加载");
      }, 280);
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
    /* 用户口径：凡是「选一个」的地方一律用自绘弹窗（系统原生下拉太丑）。
       下面这 5 个是最后一批；选项是动态填的，填完要 pickRefreshAll 才会刷新按钮文字。 */
    UI.pickBind($("#setUsagePriceMode"), "估算方式");
    UI.pickBind($("#setSplashAnim"), "启动动画");
    UI.pickBind($("#setSplashAvatar"), "启动头像");
    UI.pickBind($("#setSessionAutoMsg"), "角色主动发消息");
    UI.pickBind($("#groupImport"), "导入哪条线的记忆");
    UI.pickBind($("#setSessionReason"), "离线原因");
    on("#charSplitBtn", "click", () => { setHidden("#charSplitHint", true); setHidden("#charSplitPanel", false); });
    on("#charSplitHelp", "click", () => { const el = $("#charSplitHint"); if (el) el.hidden = !el.hidden; });
    on("#charSplitHint", "click", () => setHidden("#charSplitPanel", false));
    on("#charSplitCancel", "click", () => setHidden("#charSplitPanel", true));
    /* 注意：这里必须包一层箭头函数。直接把 runCharSplit 交给 on() 的话，
       事件对象会成为第一个实参（truthy），runCharSplit 会被当成「再次拆分」走错分支。 */
    on("#charSplitRun", "click", () => runCharSplit(false));
    on("#charSplitAgain", "click", () => runCharSplit(true));
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
    on("#sessionDiarySave", "click", sessionDiarySave);
    on("#sessionDiaryClear", "click", sessionDiaryClear);
    on("#sessionSummaryRun", "click", runAssistantSummary);
    on("#worldSkip", "click", worldSkip);
    on("#worldRegen", "click", worldRegen);
    on("#worldAdopt", "click", worldAdopt);
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
    bindQuickReply();
    bindWorldView();
    bindPopovers();
    /* 故事时钟：挂在顶层「对话设置」按钮上，每 20 秒自己走一格
       （故事时间是按现实 1:1 流动的，分钟一跳就够）。 */
    setInterval(() => { try { if (!document.hidden) syncChatClock(); } catch (e) { /* ignore */ } }, 20000);
    /* 退出 / 切后台：按秒记下离开那一刻 */
    window.addEventListener("pagehide", rememberLeave);
    document.addEventListener("visibilitychange", () => { if (document.hidden) rememberLeave(); });
    /* 对话设置里的时间：应用 / 设为此刻 / 关掉；勾上「与现实同步」直接同步到此刻 */
    on("#sessionTimeApply", "click", sessionTimeApply);
    on("#sessionTimeNow", "click", () => { sessionTimeSet(Date.now(), "已设为此刻"); });
    on("#sessionTimeClear", "click", sessionTimeClear);
    on("#setSessionTimeSync", "change", () => {
      if (!checkedOf("#setSessionTimeSync")) return;
      if (!sessionTimeSet(Date.now(), "已与现实时间同步")) setChecked("#setSessionTimeSync", false);
    });
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
        openExternal(link.getAttribute("href"));
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
    /* 明暗变了，背景那层半透明罩的颜色也要跟着换 */
    try { applyChatBackground(); } catch (e) { /* ignore */ }
    try { applyPhoneBackground(); } catch (e) { /* ignore */ }
    modeCache = null;   /* 本轮用完就释放：下次真的切主题时再问一次系统 */
  }

  /* 当前实际生效的明暗：mode 可以是 light / dark / auto（auto = 读系统，注意接口返回 true=浅色）。
     auto 下要问原生桥，而一次切主题会连带 applyChatBackground / applyPhoneBackground 各问一次
     （= 3 次桥调用）。桥是同步的，这里缓存一次，applyThemeAll 收尾时释放。 */
  let modeCache = null;
  function resolvedMode() {
    const m = state.settings.mode;
    if (m === "auto") {
      if (modeCache) return modeCache;
      const isDefault = Store.callBridge("判断深色模式状态");
      modeCache = (isDefault === true) ? "light" : "dark";
      return modeCache;
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

  /* 读工作区。返回 true = 读成功（可以渲染）；false = 这次没读到（别渲染成「没有数据」） */
  /* ── 听澜：内置助手身份（一次性迁移）──────────────────
     1）没有这个角色就按预设建一个（固定 id，不随机）
     2）把老的「无角色会话」挂到它名下 —— 只改归属，消息 / 记忆 / 摘要一律不动
     用户要是把听澜删了，不再重建（删了就是删了），会话自然回落到「助手」显示。
     群聊的 characterId 也是空串，但成员在 members 里，绝不能挂。 */
  function ensureTinglan() {
    try {
      if (state.settings.tlAsstDone) return;
      const preset = (CONFIG && CONFIG.BUILTIN_ASSISTANT) || null;
      if (!preset) return;
      const list = Store.getCharacters();
      if (!list.some((c) => c.id === TINGLAN_ID)) {
        const now = Date.now();
        const ch = {
          id: TINGLAN_ID,
          name: preset.name || "听澜",
          avatar: preset.avatar || "",
          fields: {},
          ctxFilter: { rule: "", every: 10 },
          usage: null,
          pinned: false,
          builtin: true,
          createdAt: now,
          updatedAt: now
        };
        Object.keys(preset.fields || {}).forEach((k) => {
          if (k.indexOf("my") === 0) return;   /* 我自己那半边，预设一律不写 */
          ch.fields[k] = preset.fields[k];
        });
        list.push(ch);
        Store.saveCharacters(list);
      }
      const ss = Store.getSessions();
      let moved = 0;
      ss.forEach((s) => {
        if ((s.characterId || "") === "" && !s.isGroup) { s.characterId = TINGLAN_ID; moved++; }
      });
      if (moved) Store.saveSessions(ss);
      /* ⚠️ 不写成 `state.settings = Store.saveSettings(...)`：那会把 state.settings
         整个换成一个新对象，凡是之前拿过引用的人（模块里的闭包、流式生成中的快照）
         都会继续读旧对象 —— 表现为「刚设好的东西突然不生效了」。原地打标记最安全。 */
      Store.saveSettings({ tlAsstDone: true });
      if (state.settings) state.settings.tlAsstDone = true;
      /* 迁移发生在启动早期（渲染之前），这里不用再刷界面 —— 后面 renderAll 会带上 */
    } catch (e) { /* 迁移出错也不能挡住启动：大不了继续显示「助手」 */ }
  }

  function loadWorkspace() {
    state.settings = Store.getSettings();
    /* ⚠️ 读失败时什么都别做：既不能按「空」渲染，更不能 newSession() ——
       那条新会话一旦存下去就会盖掉真正历史。这是真机「对话历史全空」的直接放大器。 */
    if (Store.readFailed()) return false;
    /* 听澜的迁移放在这里同步做完，**不能**推到首屏之后：
       异步做的话，启动完成到迁移执行之间有一个「角色还不存在」的中间态，
       用户这时候建角色 / 新建会话 / 建群都会撞上（角色列表被后来改写、会话归属错位）。
       增量很小（一次建角色 + 一次改归属），同步做掉最干净。 */
    ensureTinglan();
    const sessions = Store.getSessions();
    if (!sessions.length) {
      if (Store.readFailed()) return false;   /* 读的过程中又失败：同上 */
      newSession();
    } else {
      const cur = Store.getCurrentId();
      state.sessionId = sessions.some((s) => s.id === cur) ? cur : sessions[0].id;
      Store.setCurrentId(state.sessionId);
    }
    return true;
  }

  /* 读失败时在列表位置放一句提示，别让用户对着一片空白以为数据没了 */
  function showReadingHint() {
    const box = $("#sessionList");
    if (!box) return;
    box.innerHTML = "";
    const d = document.createElement("div");
    d.className = "session-empty";
    d.textContent = "正在读取本地数据…";
    box.appendChild(d);
  }

  /* 启动时读本地存储失败（原生桥 / 存储还没就绪这类偶发）→ **带退避重试**。
     ⚠️ 原来只给一次机会：1200ms 后再看还是失败就直接 toast「请重启 App」并放弃，
     表现正是用户真机实测的「对话历史全空，重走一遍启动动画还是一样，退出重进才好」。
     两个关键点：
       ① 每次重试前必须 `resetReadError()` —— 不清的话 `readFailed()` 恒为真，重试等于空转；
       ② 读到数据才算「首屏就绪」：置 __deeplinkReady + 撤启动页，别再让自愈脚本重载。 */
  const WS_RETRY_DELAYS = [400, 900, 1800, 3200, 5000];
  let wsTries = 0;
  function reloadWorkspace() {
    Store.resetReadError();
    if (loadWorkspace()) {
      wsTries = 0;
      try { applyThemeAll(false); } catch (e) { /* ignore */ }
      try { syncToggles(); } catch (e) { /* ignore */ }
      try { renderAll(); } catch (e) { /* ignore */ }
      window.__deeplinkReady = true;
      try { sessionStorage.removeItem("deeplink.bootTry"); } catch (e) { /* ignore */ }
      requestSplashHide(false);
      return;
    }
    if (wsTries < WS_RETRY_DELAYS.length) {
      const d = WS_RETRY_DELAYS[wsTries++];
      console.warn("[DeepLink] 本地存储读取失败，第 " + wsTries + " 次重试将在 " + d + "ms 后");
      showReadingHint();
      setTimeout(reloadWorkspace, d);
      return;
    }
    UI.toast("本地存储一直读不出来，请重启 App（你的历史没有被覆盖）", true);
  }

  /* ── 版本变更清缓存（必须在启动收尾、且「清完就重载」）──────────────
     真机反馈（6.0.0）：「更新后首次打开」出现半渲染 —— 图标没渲染 / 对话历史不见 /
     主题回归默认，点一下才重走一次启动动画。根因就是这里原来夹在**启动主链的中段**：
     原生「设置清空缓存」是 IO 操作，会搅动 WebView 正在用的资源，
     后面的 applyIcons / applyThemeAll / renderAll 就在「资源正在变」的状态下跑。
     ⚠️ 这段在无桥环境（浏览器 / 容器 / 无头测试）根本不执行 ——
     所以 17 套回归全绿也测不出它，只有真机才现。
     防重入：启动真正走完时清掉计数；同一个会话最多清 2 次
     （万一设置没存住，也不会陷入「清缓存 → 重载」的死循环）。 */
  function clearCacheIfVersionChanged() {
    const appVer = CONFIG.APP_VERSION || "";
    if (!appVer) return false;
    if (state.settings.lastRunVersion === appVer) return false;
    state.settings = Store.saveSettings({ lastRunVersion: appVer });
    if (!Store.hasBridge("设置清空缓存")) return false;
    let n = 0;
    try { n = +(sessionStorage.getItem("deeplink.cacheClearTries") || 0); } catch (e) { n = 0; }
    if (!(n < 2)) { console.warn("[DeepLink] 清缓存已尝试 " + n + " 次仍未成功，放弃本次清理"); return false; }
    try { sessionStorage.setItem("deeplink.cacheClearTries", n + 1); } catch (e) { /* ignore */ }
    console.warn("[DeepLink] 版本变化 → " + appVer + "：清理页面缓存并重载一次");
    Store.callBridge("设置清空缓存");
    /* 启动页此刻还挂着 —— 用户只会觉得「动画多转了一会儿」，
       而不是停在半渲染的界面上。留 300ms 让原生那一下 IO 先落地。 */
    setTimeout(function () { try { location.reload(); } catch (e) { /* ignore */ } }, 300);
    return true;
  }

  async function init() {
    /* 启动分段计时（10-18：用户反馈启动从 80ms 涨到 230ms，需要知道花在哪一步）。
       只在内存里攒一个数组，设置页「连接自检」会把它和首屏耗时一起打出来 ——
       不写盘、不发请求，真机跑一趟就能定位，比猜快。 */
    const bootT0 = Number(window.__dlBootT0) || Date.now();
    const bootMark = (k) => {
      try {
        (window.__dlBootMarks = window.__dlBootMarks || []).push([k, Date.now() - bootT0]);
      } catch (e) { /* ignore */ }
    };
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
      bootMark("解锁记忆");
      /* 给自动化（截图 / 端到端）一个「存储已就绪」的信号：
         在这之前 getCharacters() 会是空的（角色卡还在解密），
         此时往存储里灌种子数据会被随后的解锁覆盖掉。 */
      window.__dlReady = true;
      loadWorkspace();
      bootMark("读工作区");
      /* 版本变了（更新过）→ 清一次页面缓存，避免还在用旧页面。
         注意：这一步是「清完就重载」的（见 clearCacheIfVersionChanged 的注释），
         返回 true 说明马上要 reload —— 后面的渲染没必要再跑，直接收工。 */
      if (clearCacheIfVersionChanged()) return;
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
      bootMark("数据迁移");
      UI.applyIcons(document);
      applyThemeAll(false);
      bootMark("图标 + 主题");

      UI.setAvatarResolver(effectiveAvatar);
      UI.setSpeakerResolver(speakerAvatar);
      bindBackKey();   /* B1：把原生返回键全部接管过来（无桥环境自动空转） */
      bind();
      syncToggles();
      bootMark("事件绑定");
      renderAll();
      bootMark("首屏渲染");
      /* D2：启动流程到这儿算跑完了 —— 锁屏层这时才允许收（已经解锁的话） */
      try { if (window.DL.lockAppReady) window.DL.lockAppReady(); } catch (e) { /* ignore */ }

      /* B3：后台常驻（默认关）。启动时静默同步，不弹权限对话框 */
      if (state.settings.bgKeep) applyBgKeep(true);

      /* 可选功能统一挪到「启动收尾之后」再启动（见本函数末尾）。
         它们走的都是跨模块转发壳，某个模块没注册就会抛错；原来放在这个位置，
         一旦抛错就会把后面的 inited / __deeplinkReady / 撤启动页一起带崩 ——
         表现成启动页空等 15 秒、还会被启动自愈脚本自动重载。 */

      setText("#guideTree", CONFIG.FEATURE_TREE || "");
      setText("#introTree", CONFIG.FEATURE_TREE || "");
      if (!state.settings.onboarded) setTimeout(openIntro, 2800);

      if (Store.readFailed()) {
        /* 读失败：**别把「空」当结果**——列表位置给提示，然后退避重试（见 reloadWorkspace） */
        showReadingHint();
        UI.toast("正在读取本地数据…（不会覆盖你的历史）");
        setTimeout(reloadWorkspace, 600);
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
      bootMark("就绪");
      try { sessionStorage.removeItem("deeplink.bootTry"); } catch (e) { /* ignore */ }
      /* 启动真的走完了 → 清掉「清缓存重试计数」，下次版本变更重新开始计数 */
      try { sessionStorage.removeItem("deeplink.cacheClearTries"); } catch (e) { /* ignore */ }
      /* 首屏渲染完成 → 撤启动页（requestSplashHide 会再确认「动画已跑满」） */
      requestSplashHide(false);

      /* ── 可选功能：各自独立 try ──
         它们走的是跨模块转发壳，某个模块没注册就会抛错。放在启动收尾之后 + 逐个兜住，
         任何一个失败都只丢它自己，不会再把 inited / __deeplinkReady / 撤启动页带崩。 */
      try { maybeAutoCompress(); } catch (e) { console.warn("[DeepLink] 自动压缩未启动", e); }
      /* 世界生成（可关）：久没上线 → 问一句要不要补一段空档剧情；顺带更新「上次见面」时间 */
      try { setTimeout(openWorldCheck, 1500); } catch (e) { console.warn("[DeepLink] 世界生成未启动", e); }
      /* 自动发信息（默认关）：后台时角色按性格主动找你 */
      try { startAutoMessage(); } catch (e) { console.warn("[DeepLink] 自动发信息未启动", e); }
      /* 更新检查（一天一次；没配 UPDATE_URL 时什么都不做，不打扰） */
      try { maybeCheckUpdate(); } catch (e) { console.warn("[DeepLink] 更新检查未启动", e); }
      /* 日更：这次打开时，把「当前这条角色线」今天的场景/关系/经历补一次 */
      try {
        const cur = session();
        if (cur) maybeDailyRefresh(cur, characterFor(cur));
      } catch (e) { console.warn("[DeepLink] 日更未启动", e); }
      try { Store.getSessions().forEach((s) => maybeAutoBackup(s, "load")); } catch (e) { console.warn("[DeepLink] 自动备份未启动", e); }
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
    /* 建群时把某条线的记忆导进群聊（口径见函数注释）；挂出来便于回归测试与后续复用 */
    importLineMemoryToGroup: importLineMemoryToGroup,
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
    renderAll: renderAll, isTouch: isTouch, syncChatClock: syncChatClock,
    popoverClose: popoverClose, rememberLeave: rememberLeave,
    autoMessageTick: autoMessageTick,
    toast: UI.toast, err: function (t) { UI.toast(t, true); },
    session: session, sessionById: sessionById, agentId: agentId, characterFor: characterFor, activeCharacter: activeCharacter, voiceSettingsFor: voiceSettingsFor,
    saveSession: saveSession, setMainLine: setMainLine,
    newSession: newSession, appendMessage: appendMessage, renderSessionList: renderSessionList,
    deleteSessionWithGuard: deleteSessionWithGuard, groupsUsingLine: groupsUsingLine,
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
    avatarDraft: avatarDraft, renderAvatarPreview: renderAvatarPreview, readAvatarFile: readAvatarFile,
    /* 6.0.0：自定义背景（全局 / 会话共用同一份草稿与渲染），供 settings.js / roleplay.js 用 */
    bgDraft: bgDraft, renderBgPreview: renderBgPreview, syncBgLabels: syncBgLabels,
    applyPhoneBackground: applyPhoneBackground,
    applyChatBackground: applyChatBackground,
    /* 世界生成的「触发判定」：init 里 1500ms 会自动调一次，这里也挂出来以便测试确定性触发 */
    openWorldCheck: openWorldCheck,
    /* settings.js（阶段④）自检要用、仍留在 app.js 的：交付元素自检清单。 */
    missingIds: missingIds
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
