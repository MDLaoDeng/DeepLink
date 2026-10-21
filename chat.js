/* chat.js —— 消息渲染 / 附件 / 语音 / 朗读 / 文生图 / 发送 / 消息版本 / 多选 / 历史搜索 / 输入框
 * 从 app.js 拆出（见 HANDOFF.md 4.9 拆分计划）。
 *
 * 为什么这么写：
 *  - 本文件在 index.html 里排在 app.js 之后 —— 执行时 window.DL 一定已存在。
 *  - 搬运时【没有改函数体】，只在下面把 DL 里的同名成员解构成局部变量，
 *    所以搬过来的代码与在 app.js 里逐字一致。
 *  - 末尾自注册并登记 window.__dlScripts（连接自检的「附加脚本」会显示）。
 *
 * 本文件不新增依赖、不改行为、不动版号。
 */
(function () {
  /* 打包工具不一定按 index.html 的顺序执行脚本：app.js 有可能晚于本文件。
     那时 window.DL 还不存在 —— 这里不直接放弃，而是等它就绪后再初始化一次。
     boot() 返回 false 表示「还没就绪」。 */
  var booted = false;  /* boot 幂等：DOMContentLoaded 与补拍 retry 各会调一次，别重复绑事件 / 分裂状态 */
  function boot() {
    if (booted) return true;
  var D = window.DL;
  if (!D) return false;   /* 尚未就绪，由文件末尾安排重试 */
  booted = true;   /* 已真正初始化过，后续再被调用直接返回 */

  /* 共享件解构（名字与 app.js 内保持一致，保证搬来的代码不用改一个字） */
  var $ = D.$, $v = D.$v, state = D.state;
  /* ⚠️ 模块类共享件【不在加载时快照】。app.js 里 window.DL 的这几个键是 getter（惰性），
     但这里若写成 `var Api = D.Api` 就等于把「加载那一刻的值」钉死：打包工具只要把
     api.js 排到 app.js 之后执行，这里就永远是 undefined，症状是发消息报
     「Cannot read property 'run' of undefined」（真机上踩过，浏览器/无头里都复现不出来）。
     所以改成每次进入公开入口都重新取一遍。 */
  var UI, Store, Memory, Api, Files, Media, Search;
  /* 阶段③的 roleplay.js、阶段④的 settings.js 都排在 chat.js 之后加载，它们注册的
     maybeAutoWash / maybeAutoBackup / recordUsage 在这里执行时还不存在。
     一律改成惰性重取 —— 否则「生成后自动清洗 / 自动备份 / 用量记账」会静默失效
     （不报错，只是不生效，最难查）。 */
  var maybeAutoWash, maybeAutoBackup, maybeAutoScene, maybeDailyRefresh, recordUsage;
  function syncModules() {
    UI = D.UI || window.UI; Store = D.Store || window.Store; Memory = D.Memory || window.Memory;
    Api = D.Api || window.Api; Files = D.Files || window.Files; Media = D.Media || window.Media;
    Search = D.Search || window.Search;
    maybeAutoWash = D.maybeAutoWash || window.maybeAutoWash;
    maybeAutoBackup = D.maybeAutoBackup || window.maybeAutoBackup;
    maybeAutoScene = D.maybeAutoScene || window.maybeAutoScene;
    maybeDailyRefresh = D.maybeDailyRefresh || window.maybeDailyRefresh;
    recordUsage = D.recordUsage || window.recordUsage;
  }
  syncModules();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncModules);
  else setTimeout(syncModules, 0);
  var session = D.session, sessionById = D.sessionById, newSession = D.newSession;
  var appendMessage = D.appendMessage, characterFor = D.characterFor;
  var renderSessionList = D.renderSessionList, renderAll = D.renderAll, setBusy = D.setBusy;
  var audioState = D.audioState;
  var setVal = D.setVal, setText = D.setText, setDisplay = D.setDisplay, checkedOf = D.checkedOf;
  var setDisabled = D.setDisabled;
  var closeSidebar = D.closeSidebar;

  let audioEl = null;

  let audioUrl = "";

  let audioBtn = null;

  /* ── 图片：轮数到期后删原图、只留文字描述 ─────────── */
  function userTurns(s) { return ((s && s.messages) || []).filter((m) => m.role === "user").length; }

  function sweepImageExpiry(s) {
    if (!s || !state.settings.imgToText) return false;
    const n = typeof state.settings.imgExpireTurns === "number" ? state.settings.imgExpireTurns : 10;
    if (n < 1) return false;
    const total = userTurns(s);
    let changed = false;
    (s.messages || []).forEach((m) => {
      if (typeof m.atTurn !== "number") return;
      if (total - m.atTurn < n) return;
      /* ⚠️ 只有「拿到了文字描述」才敢删原图：需求是「删原图、只留文字描述」，
         描述还没生成 / 生成失败时若照删，这条图承载的信息就彻底没了（不可恢复）。 */
      if (m.image && m.imageDesc) { delete m.image; changed = true; }
      if (m.attachments && m.attachments.length) {
        /* 图片可能是内联 dataUrl，也可能是文件引用（imgRef）——两种都要清，
           外置的那种还要把文件删掉（同一张图别处还在用时会自动保留，见 Store.dropImage） */
        m.attachments.forEach((a) => {
          if (a && a.desc && Store.hasImage(a)) { Store.dropImage(a); changed = true; }
        });
      }
    });
    return changed;
  }

  const describing = {};

  /* 发图后后台给每张图生成文字描述（失败就算了；不在这里刷新界面） */
  async function describePendingImages(sid) {
    if (!state.settings.imgToText || !state.settings.apiKey) return;
    const snap = sessionById(sid);
    if (!snap) return;
    const jobs = [];
    (snap.messages || []).forEach((m, i) => {
      if (m.role === "user" && m.attachments) {
        m.attachments.forEach((a, j) => {
          if (a.kind !== "image" || a.desc) return;
          const u = Store.imageURL(a);          /* 内联或文件引用都能拿到地址 */
          if (u) jobs.push({ i: i, j: j, url: u, img: false });
        });
      } else if (m.role === "assistant" && m.image && !m.imageDesc) {
        jobs.push({ i: i, j: -1, url: m.image, img: true });
      }
    });
    for (const job of jobs) {
      const key = sid + ":" + job.i + ":" + job.j;
      if (describing[key]) continue;
      describing[key] = true;
      try {
        const out = await Api.describe(state.settings, job.url, 300);
        if (out.text && out.text.trim()) {
          /* 先把描述落库、再记账：记账若抛错（跨模块未就绪）会被下面的 catch 吞掉，
             那时描述还没写进去就白丢了。记账也补 typeof 守卫（本文件其它调用点都有）。 */
          mutateSession(sid, (msgs) => {
            const mm = msgs[job.i];
            if (!mm) return;
            if (job.img) mm.imageDesc = out.text.trim();
            else if (mm.attachments && mm.attachments[job.j]) mm.attachments[job.j].desc = out.text.trim();
          });
          if (out.usage && typeof recordUsage === "function") recordUsage(null, out.usage, (snap.characterId || ""));
        }
      } catch (e) { /* 描述失败忽略 */ } finally { delete describing[key]; }
    }
  }

  /* 「模型兼容」关闭时，图片不内联给主模型，必须先有文字描述才发得出去。
     所以发送前**等**一遍（describePendingImages 是后台跑、不等人，这里要等人）。
     单张描述失败就跳过，绝不因为描述不出来把整条消息卡死。 */
  async function ensureImageDescriptions(sid) {
    if (state.settings.mainCompat) return;
    if (!state.settings.apiKey && !state.settings.visionKey) return;
    const snap = sessionById(sid);
    if (!snap) return;
    const jobs = [];
    (snap.messages || []).forEach((m, mi) => {
      if (m.role !== "user" || !m.attachments) return;
      m.attachments.forEach((a, ai) => {
        if (a.kind !== "image" || a.desc) return;
        const u = Store.imageURL(a);
        if (u) jobs.push({ a: a, url: u, key: sid + ":" + mi + ":" + ai });
      });
    });
    let changed = false;
    for (const job of jobs) {
      const key = "pending:" + job.key;
      if (describing[key]) continue;
      describing[key] = true;
      try {
        const out = await Api.describe(state.settings, job.url, 300);
        if (out.text && out.text.trim()) {
          job.a.desc = out.text.trim();
          changed = true;
          if (out.usage) recordUsage(null, out.usage, (snap.characterId || ""));
        }
      } catch (e) { /* 描述失败不阻塞发送 */ } finally { delete describing[key]; }
    }
    if (changed) Store.saveSessions(Store.getSessions());
  }

  /* ── 消息渲染（超长会话只渲染最近 MSG_WINDOW 条，向上滑加载）── */
  const MSG_WINDOW = 20;

  /* 开场白落到会话里（只做一次）：
     酒馆卡的第一句话本来就该在聊天界面出现，而不是被当成「共同经历」的设定文本。
     只在「这条线一句话都还没有」时插入 —— 已经有对话的线一律不碰。
     保留原文（可能是富文本），显示时由 UI.renderMarkdown 走富文本分支渲染。 */
  function ensureIntroMsg(s) {
    try {
      if (!s || !s.characterId || s.introDone) return;
      if (s.messages && s.messages.length) return;
      const list = (Store && Store.getCharacters) ? Store.getCharacters() : [];
      const ch = (list || []).filter((c) => c.id === s.characterId)[0];
      const intro = ch && ch.intro ? String(ch.intro) : "";
      if (!intro.trim()) return;
      const msg = { role: "assistant", content: intro, ts: Date.now(), intro: true };
      s.messages = [msg];
      s.introDone = true;
      s.updatedAt = Date.now();
      /* ⚠️ 这里用「原地改 + 落库」，不用 Store.updateSession ——
         那个方法会 Object.assign 出一个**新对象**替换掉数组里的元素，
         于是调用方手里持有的 s 立刻变成旧的（消息、设置全部读不到），
         表现为「刚渲染完，紧接着的操作却按旧数据走」。 */
      Store.saveSessions(Store.getSessions());
    } catch (e) { /* 开场白落不下来也不能挡住聊天 */ }
  }

  function renderMessages() {
    syncModules();
    const box = $("#messages");
    box.innerHTML = "";
    const s = session();
    if (!s) { state.msgWin = null; return; }
    ensureIntroMsg(s);
    const total = s.messages.length;
    let start = Math.max(0, total - MSG_WINDOW);
    if (typeof state.msgAnchor === "number" && state.msgAnchor >= 0 && state.msgAnchor < total && state.msgAnchor < start) {
      start = Math.max(0, state.msgAnchor - 2);
    }
    state.msgAnchor = null;
    state.msgWin = { start: start, total: total };
    if (start > 0) box.appendChild(earlierEl(start));
    appendMsgRange(s, start, total);
    /* 正在流式的那条不归本函数管：整列重建会把它一起抹掉，之后 runGeneration 的
       replaceWith 就变成空操作（父节点已经没了）—— 整条回复连思考一起凭空消失。
       这就是「思考被吞」的根源：生成期间任意 renderAll()（保存设置、切角色、删消息…）
       都会走到这里。重建完把流式节点原样挂回末尾。 */
    if (state.streamEl && state.streamSid === state.sessionId && state.streamEl.parentNode !== box) box.appendChild(state.streamEl);
    /* 换了会话就把快捷回复收掉：面板里装的还是上一条会话的台词 */
    if (quick.open && s && quick.sid && quick.sid !== s.id) quickClose();
    syncContinueRow();
    syncOpeningBtn();
    bindEmojiPanel();
    syncRegenRow();     /* 群聊：只有最后一条角色消息保留「重新说」 */
    syncQuickBtn();     /* 快捷回复按钮的置灰状态跟着当前这条会话的记忆走 */
    UI.scrollToBottom();
  }

  /* 群聊里把「重新说」收到只剩最后一条（10-18 用户要求）。
     翻旧消息时每条都挂着刷新按钮，很容易误点：那等于把那一段上下文整段重新生成一遍，
     后面跟着的一串消息就全对不上了。所以只留最后一条。 */
  function syncRegenRow() {
    const box = $("#messages");
    if (!box) return;
    const s = session();
    if (!s || !s.isGroup) return;
    const msgs = s.messages || [];
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === "assistant") { last = i; break; }
    }
    const nodes = box.querySelectorAll(".msg");
    for (let k = 0; k < nodes.length; k++) {
      const el = nodes[k];
      if (typeof el.__idx !== "number" || el.__idx === last) continue;
      const btn = el.querySelector('.act-btn[data-act="regen"]');
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    }
  }

  function earlierEl(n) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "earlier-msg";
    b.textContent = "↑ 还有 " + n + " 条更早的消息";
    b.addEventListener("click", loadEarlier);
    return b;
  }

  function appendMsgRange(s, a, b) {
    const box = $("#messages");
    for (let i = a; i < b; i++) {
      const el = UI.msgEl(toView(s.messages[i]), s);
      el.__idx = i;
      if (state.selecting && state.selected && state.selected.has(i)) el.classList.add("selected");
      box.appendChild(el);
    }
  }

  function loadEarlier() {
    const box = $("#messages");
    const s = session();
    if (!s || !state.msgWin) return;
    const cur = state.msgWin.start;
    if (cur <= 0) return;
    const from = Math.max(0, cur - MSG_WINDOW);
    const prevH = box.scrollHeight, prevTop = box.scrollTop;
    const frag = document.createDocumentFragment();
    if (from > 0) frag.appendChild(earlierEl(from));
    for (let i = from; i < cur; i++) {
      const el = UI.msgEl(toView(s.messages[i]), s);
      el.__idx = i;
      frag.appendChild(el);
    }
    const anchorEl = box.querySelector(".earlier-msg");
    if (anchorEl) anchorEl.remove();
    box.insertBefore(frag, box.firstChild);
    state.msgWin.start = from;
    box.scrollTop = prevTop + (box.scrollHeight - prevH);
  }

  function syncPlaceholder() {
    const input = $("#input");
    if (checkedOf("#imgToggle")) { input.placeholder = "描述要生成的画面…"; return; }
    const s = session();
    const ch = characterFor(s);
    if (ch) { input.placeholder = "对「" + (ch.name || "角色") + "」说…"; return; }
    const alias = s && s.alias ? String(s.alias).trim() : "";
    input.placeholder = alias ? "给 " + alias + " 发消息" : "给 DeepLink 发送消息…";
  }

  /* ── 附件 ──────────────────────────────────────── */
  function renderAttachments() {
    const bar = $("#attachmentBar");
    bar.innerHTML = "";
    state.attachments.forEach((a, i) => {
      const el = document.createElement("div");
      el.className = "att";
      /* 缩略图：图片可能还没搬家（内联）或已搬进文件（imgRef），统一问 Store 要地址。
         拿不到就是原图没了 → 退化成占位样式，别留一个坏掉的 img。 */
      const thumb = a.kind === "image" ? Store.imageURL(a) : "";
      if (thumb) {
        const img = document.createElement("img");
        img.src = thumb;
        el.appendChild(img);
      } else if (a.kind === "image") {
        el.classList.add("att-expired");
        el.innerHTML = UI.iconSvg("image-outline");
      }
      const name = document.createElement("span");
      name.className = "a-name";
      name.textContent = a.name;
      el.appendChild(name);
      const x = document.createElement("button");
      x.className = "a-x";
      x.type = "button";
      x.innerHTML = UI.iconSvg("close");
      x.addEventListener("click", () => { state.attachments.splice(i, 1); renderAttachments(); });
      el.appendChild(x);
      bar.appendChild(el);
    });
  }

  async function addFiles(fileList) {
    for (const file of fileList) {
      try {
        const a = await Files.read(file);
        state.attachments.push(a);
      } catch (e) {
        UI.toast(e.message || "文件读取失败", true);
      }
    }
    renderAttachments();
  }

  /* ── 语音输入 ──────────────────────────────────── */
  async function toggleMic() {
    if (!Media.capable("asr", state.settings)) {
      UI.toast("请先在设置里启用并配置听觉模型", true);
      return;
    }
    const btn = $("#micBtn");
    if (audioState.recording) {
      audioState.recording = false;
      btn.classList.remove("recording");
      const blob = await Media.recorder.stop();
      if (!blob || !blob.size) { UI.toast("没录到声音", true); return; }
      await doTranscribe(blob, "audio." + Media.extOf(blob.type));
      return;
    }
    try {
      await Media.recorder.start();
      audioState.recording = true;
      btn.classList.add("recording");
      UI.toast("正在录音，再点一次结束");
    } catch (e) {
      audioState.recording = false;
      btn.classList.remove("recording");
      Media.recorder.cancel();
      UI.toast("麦克风不可用（" + ((e && (e.message || e.name)) || "未知") + "），改用选择音频文件", true);
      $("#audioInput").click();
    }
  }

  async function doTranscribe(blob, filename) {
    if (!Media.capable("asr", state.settings)) { UI.toast("请先配置听觉模型", true); return; }
    UI.toast("正在转写…");
    try {
      const text = await Media.transcribe(blob, state.settings, filename);
      const input = $("#input");
      const cur = input.value.trim();
      input.value = cur ? cur + " " + text : text;
      autoResize();
      input.focus();
    } catch (e) {
      UI.toast("转写失败：" + (e.message || e), true);
    }
  }

  /* ── 朗读 ──────────────────────────────────────── */
  function stopRead() {
    if (audioEl) { audioEl.pause(); audioEl = null; }
    if (audioUrl && audioUrl.indexOf("blob:") === 0) URL.revokeObjectURL(audioUrl);
    audioUrl = "";
    if (audioBtn) {
      audioBtn.classList.remove("playing");
      audioBtn.innerHTML = UI.iconSvg("volume-high");
      audioBtn = null;
    }
  }

  /* 按给定文本朗读；再点同一个按钮则停止 */
  async function readText(btn, text) {
    const t = (text || "").trim();
    if (audioBtn === btn) { stopRead(); return; }
    stopRead();
    if (!Media.capable("tts", state.settings)) { UI.toast("请先在设置里启用并配置语音合成", true); return; }
    if (!t) return;

    btn.classList.add("playing");
    btn.innerHTML = UI.iconSvg("volume-off");
    audioBtn = btn;
    try {
      const url = await Media.speak(t, D.voiceSettingsFor ? D.voiceSettingsFor(session()) : state.settings);
      const audio = new Audio(url);
      audioEl = audio;
      audioUrl = url;
      audio.onended = stopRead;
      audio.onerror = () => { stopRead(); UI.toast("音频播放失败", true); };
      await audio.play();
    } catch (e) {
      stopRead();
      UI.toast("朗读失败：" + (e.message || e), true);
    }
  }

  function bubbleText(btn) {
    const box = btn.closest ? btn.closest(".bubble") : null;
    const content = box ? box.querySelector(".content") : null;
    if (!content) return "";
    /* .code-head / .copy-btn / .a-save 这类按钮就嵌在 .content 里，直接取 innerText
       会把「复制」「保存」也念出来。克隆一份、剔掉按钮节点再取文本。
       注意：游离节点没有布局，innerText 会退化成 textContent（丢掉换行）——
       所以临时挂到屏幕外的容器上再读。 */
    const clone = content.cloneNode(true);
    const junk = clone.querySelectorAll(".code-head, .copy-btn, .a-save, .att-expired");
    for (let i = 0; i < junk.length; i++) if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    const holder = document.createElement("div");
    holder.style.position = "absolute";
    holder.style.left = "-9999px";
    holder.style.top = "0";
    holder.style.whiteSpace = "pre-wrap";
    holder.appendChild(clone);
    document.body.appendChild(holder);
    const txt = (clone.innerText || clone.textContent || "").trim();
    document.body.removeChild(holder);
    return txt;
  }

  function toggleRead(btn) {
    return readText(btn, bubbleText(btn));
  }

  /* ── 文生图 ────────────────────────────────────── */
  async function sendImage(prompt) {
    if (!Media.capable("img", state.settings)) {
      UI.toast("请先在设置里启用并配置文生图", true);
      return;
    }
    let s = session();
    if (!s) { newSession(); s = session(); }
    const sid = s.id;

    const userMsg = { role: "user", content: prompt };
    appendMessage(sid, userMsg, (s.isGroup || s.messages.some((m) => m.role === "user")) ? "" : prompt.slice(0, 20));
    setVal("#input", "");
    autoResize();
    /* 必须走 toView() 并补 __idx：否则这两个节点没有索引，
       长按 / 右键 / 多选菜单（都靠 el.__idx 定位）对它们完全点不出来。 */
    const uEl = UI.msgEl(toView(userMsg), s);
    uEl.__idx = sessionById(sid).messages.length - 1;
    $("#messages").appendChild(uEl);

    const holder = document.createElement("div");
    holder.className = "msg ai";
    holder.innerHTML = '<div class="avatar">' + UI.iconSvg("creation") + '</div>' +
      '<div class="bubble"><div class="img-loading">正在生成图片…</div></div>';
    $("#messages").appendChild(holder);
    UI.scrollToBottom();
    setBusy(true);
    $("#stopBtn").hidden = true;

    try {
      const url = await Media.image(prompt, state.settings);
      const msg = { role: "assistant", content: "", image: url, atTurn: userTurns(sessionById(sid)) || 1 };
      appendMessage(sid, msg);
      /* 占位块也可能被别处的重渲染抹掉（同「思考被吞」）——那时 replaceWith 是空操作，
         重建整列兜底，别让刚生成的图凭空消失。 */
      if (sid !== state.sessionId) holder.remove();
      else if (holder.parentNode) {
        const aEl = UI.msgEl(toView(msg), s);
        aEl.__idx = sessionById(sid).messages.length - 1;
        holder.replaceWith(aEl);
      }
      else renderMessages();
      renderSessionList();
      UI.scrollToBottom();
      describePendingImages(sid);
    } catch (e) {
      const msg = { role: "assistant", content: "", error: "生成失败：" + (e.message || e) };
      appendMessage(sid, msg);
      if (sid !== state.sessionId) holder.remove();
      else if (holder.parentNode) holder.replaceWith(UI.msgEl(msg, s));
      else renderMessages();
      UI.toast("生成失败：" + (e.message || e), true);
    } finally {
      setBusy(false);
    }
  }

  /* ── 发送 ──────────────────────────────────────── */

  /* 思考语言要跟用户走。DeepSeek 的思考很容易被系统提示词 / 前文带成英文，
     中文用户读一长串英文思考很费劲。判据：这条消息里汉字数 ≥ 拉丁字母数，且有汉字。 */
  const THINK_CN_HINT = "【思考语言】用户这条消息以中文为主：你的思考过程必须全程使用中文，不要用英文思考。";
  function chineseDominant(text) {
    const t = String(text || "");
    const cjk = (t.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    if (!cjk) return false;
    const latin = (t.match(/[A-Za-z]/g) || []).length;
    return cjk >= latin;
  }

  /* memory.js 有可能被排到本文件之后执行（打包工具不保证脚本顺序）。加载那一刻 window.Memory
     还是 undefined，syncModules 取到的就是「钉死的 undefined」—— 症状是发消息时回答位置出现
     红字「Cannot read property buildSystemText of undefined」（真机上踩过，浏览器/无头里复现不出来）。
     真正要用记忆前再等一次（有上限）；仍拿不到就给一句能看懂的话，而不是那句没法定位的错。 */
  async function ensureMemoryReady(ms) {
    syncModules();
    if (Memory && typeof Memory.buildSystemText === "function") return Memory;
    const deadline = Date.now() + (typeof ms === "number" ? ms : 4000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      syncModules();
      if (Memory && typeof Memory.buildSystemText === "function") return Memory;
    }
    throw new Error("记忆模块 memory.js 没有加载成功，请重新打包（打包前先退出重进封装软件）");
  }

  /* ── 对彼此的认知（10-18 用户要求）─────────────────
     session.peerCog = { 角色A的id: { 角色B的id: "A 眼里的 B" } }
     session.peerCogOn = 开关（默认关：打开后才会注入对话上下文）
     只有「写在前面的那个人」的看法，注入时逐条标主语 —— 否则 AI 会把它当全群公认，
     甚至把「小明觉得小红话少」说成「小红觉得自己话少」。 */
  function peerCogOf(s) {
    const raw = (s && s.peerCog) || {};
    return (raw && typeof raw === "object") ? raw : {};
  }
  function peerCogOn(s) { return !!(s && s.peerCogOn); }

  function peerCogText(s) {
    const members = groupMembers(s);
    if (members.length < 2) return "";
    const cog = peerCogOf(s);
    const rows = [];
    members.forEach((a) => {
      const to = cog[a.id] || {};
      members.forEach((b) => {
        if (b.id === a.id) return;
        const t = String(to[b.id] || "").trim();
        if (t) rows.push("「" + a.name + "」眼中的「" + b.name + "」：" + t);
      });
    });
    if (!rows.length) return "";
    return "\n【彼此之间的认知】下面每一条都只是**写在前面的那个人**的看法，不是事实，也不能互换主语。" +
      "提到的时候必须说清是谁觉得谁（例如「小明觉得小红话少」），不要写成全群公认，也不要替被说的人承认。\n" +
      rows.join("\n") + "\n";
  }

  /* 从模型回包里抠出 JSON（允许前后带解释 / ```json 围栏） */
  function parseJsonLoose(text) {
    const t = String(text || "");
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }

  /* 手动更新「彼此认知」：拿最近 30 条对话让模型总结，按名字映射回 id 落库。
     只在用户点按钮时跑（用户口径：不做自动），失败只报错、不动已有内容。 */
  async function updatePeerCog(sid) {
    const s = sessionById(sid);
    if (!s || !s.isGroup) return { ok: false, why: "这不是群聊" };
    const members = groupMembers(s);
    if (members.length < 2) return { ok: false, why: "群成员不足两个" };
    if (!state.settings || !state.settings.apiKey) return { ok: false, why: "还没填 API Key" };
    const msgs = (s.messages || []).slice(-30);
    const lines = msgs.map((m) => {
      const t = String(activeText(m) || "").replace(/\s+/g, " ").slice(0, 300);
      if (!t) return "";
      if (m.role === "user") return "我：" + t;
      return (m.speakerName || "某人") + "：" + t;
    }).filter(Boolean);
    if (!lines.length) return { ok: false, why: "还没有可以分析的对话" };

    const names = members.map((m) => m.name);
    const sys = "你在整理一场多人群聊里「成员之间对彼此的印象」。只输出 JSON，不要解释、不要 Markdown。";
    const ask = "群成员（严格用这些名字）：" + names.join("、") + "\n\n最近的对话：\n" + lines.join("\n") +
      "\n\n请输出每个人对**其他每个人**的印象，格式（两层对象，键都是成员名字）：\n" +
      '{"' + names[0] + '":{"' + (names[1] || "另一人") + '":"不超过 40 字"}}\n' +
      "规则：\n" +
      "1) 只写从对话里看得出来的：态度、称呼、亲疏、在意什么、有没有误会或别扭；\n" +
      "2) 不要编造没出现过的信息，没有依据就给空字符串；\n" +
      "3) 每一条都要站在**前面那个名字**的立场上写，不能写成客观事实；\n" +
      "4) 不要写自己对「我（用户）」的印象，只写成员之间。";

    const r = await Api.summarize(applySessionParams(state.settings, s),
      [{ role: "system", content: sys }, { role: "user", content: ask }], { maxTokens: 900 });
    const obj = parseJsonLoose(r && r.text);
    if (!obj) return { ok: false, why: "模型返回的不是 JSON，没敢写进去" };
    /* 名字 → id；只认名单里的名字，别让多出来的键混进库 */
    const idOf = {};
    members.forEach((m) => { idOf[m.name] = m.id; });
    const next = {};
    let n = 0;
    Object.keys(obj).forEach((fromName) => {
      const fromId = idOf[fromName];
      if (!fromId || !obj[fromName] || typeof obj[fromName] !== "object") return;
      const row = {};
      Object.keys(obj[fromName]).forEach((toName) => {
        const toId = idOf[toName];
        if (!toId || toId === fromId) return;
        const t = String(obj[fromName][toName] || "").trim().slice(0, 120);
        if (t) { row[toId] = t; n++; }
      });
      if (Object.keys(row).length) next[fromId] = row;
    });
    if (!n) return { ok: false, why: "模型没给出任何有依据的印象" };
    /* 合并写入，不是整表覆盖：模型这次漏掉某个人时，那个人上次的印象得以保留。
       （原来的写法是 `peerCog: next`，一次不完整的返回就等于把旧印象全删了。） */
    const merged = {};
    const old = peerCogOf(s);
    Object.keys(old).forEach((fromId) => {
      if (old[fromId] && typeof old[fromId] === "object") merged[fromId] = Object.assign({}, old[fromId]);
    });
    Object.keys(next).forEach((fromId) => {
      merged[fromId] = Object.assign({}, merged[fromId] || {}, next[fromId]);
    });
    Store.updateSession(sid, { peerCog: merged, peerCogTs: Date.now() });
    /* 记账：这次是一次实打实的非流式请求，用量统计里要看得见（归到「群聊」） */
    if (r && r.usage && typeof recordUsage === "function") {
      try { recordUsage(null, r.usage, "", "group"); } catch (e) { /* ignore */ }
    }
    return { ok: true, count: n };
  }

  /* 建议的「成员 → 线」：优先建群时记下的绑定，其次该角色的主线，最后是最近更新的一条线。
     找不到返回空串（同步时跳过并汇报，绝不凭空建线）。 */
  function lineOfMember(g, charId) {
    const bind = (g && g.memberLine) || {};
    if (bind[charId] && sessionById(bind[charId])) return bind[charId];
    const list = Store.getSessions().filter((x) => !x.isGroup && (x.characterId || "") === charId);
    if (!list.length) return "";
    const main = list.filter((x) => x.mainLine)[0];
    if (main) return main.id;
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list[0].id;
  }

  /* ── 同步到各自线（10-18 用户要求）──────────────
     把「群聊自己的记忆」+「某角色对群里其他人的认知」写进那个角色名下那条线的记忆里。
     写进 memory.days（而不是塞进 cognition 字段）：这样它跟这条线自己的日记一起
     参与后续的周 / 月压缩，不会成为一段永远浮在外面的孤立文本。
     每条都带主语（谁对谁），并注明来自哪个群 —— 否则压缩时会分不清是谁的经历。 */
  async function syncGroupToLines(sid) {
    const g = sessionById(sid);
    if (!g || !g.isGroup) return { ok: false, why: "这不是群聊" };
    const members = groupMembers(g);
    if (!members.length) return { ok: false, why: "群成员是空的" };
    const groupName = g.title || "群聊";
    const groupMem = String((Memory.memoryText && Memory.memoryText(g.memory)) || "").trim();
    const gShared = String(g.shared || "").trim();
    const gScene = String(g.scene || "").trim();
    if (!groupMem && !gShared && !gScene && !Object.keys(peerCogOf(g)).length) {
      return { ok: false, why: "这个群还没有可同步的记忆（先聊几轮、或点一次「更新认知」）" };
    }
    const cog = peerCogOf(g);
    /* 本地日期（和 memory.js 的日摘要同一个口径：YYYY-MM-DD） */
    const nd = new Date();
    const today = nd.getFullYear() + "-" + String(nd.getMonth() + 1).padStart(2, "0") + "-" + String(nd.getDate()).padStart(2, "0");
    const done = [];
    const skipped = [];
    members.forEach((m) => {
      const lineId = lineOfMember(g, m.id);
      const line = lineId ? sessionById(lineId) : null;
      if (!line) { skipped.push(m.name); return; }
      const parts = [];
      if (groupMem) parts.push("群聊里发生的事：" + groupMem);
      if (gShared) parts.push("大家共同经历的：" + gShared);
      if (gScene) parts.push("群聊的当前情境：" + gScene);
      /* 这个角色对其它成员的看法：逐条写主语，绝不打散融成一段 */
      const row = cog[m.id] || {};
      const views = [];
      members.forEach((o) => {
        if (o.id === m.id) return;
        const t = String(row[o.id] || "").trim();
        if (t) views.push("他觉得「" + o.name + "」：" + t);
      });
      if (views.length) parts.push(m.name + "在群里的印象：" + views.join("；"));
      if (!parts.length) { skipped.push(m.name); return; }
      /* 这一块用「开始/结束」两个标记裹起来 —— 再点一次「同步」时按标记【替换】而不是追加，
         否则同一天的摘要里会堆出两份一模一样的群聊记忆（实测连点两次就写两遍），
         之后每次对话都多喂一份重复内容，周/月压缩还会把它当两件事。 */
      const START = "【来自群聊「" + groupName + "」的记忆】";
      const END = "【群聊同步结束】";
      const text = START + parts.join("\n") + "\n" + END;

      const mem = line.memory ? JSON.parse(JSON.stringify(line.memory)) : { days: [], weeks: [], months: [], coveredUntil: 0 };
      if (!Array.isArray(mem.days)) mem.days = [];
      const hit = mem.days.find((d) => d && d.date === today);
      if (hit) {
        const cur = String(hit.summary || "");
        const a = cur.indexOf(START);
        if (a >= 0) {
          /* 旧块（含昨晚没有结束标记的那版）一律按「从这里到结尾」算：
             我们的同步永远是追加在当天摘要末尾的，最后一块之后不该有别的内容。 */
          const b = cur.indexOf(END, a);
          const tail = b >= 0 ? cur.slice(b + END.length) : "";
          hit.summary = cur.slice(0, a) + text + tail;
        } else {
          hit.summary = cur + "\n" + text;
        }
      } else mem.days.push({ date: today, summary: text });
      /* coveredUntil 不动：群聊这段不是这条线的原文，压低水位线会让它把原文再压一遍 */
      Store.updateSession(line.id, { memory: mem });
      done.push(m.name);
    });
    return { ok: done.length > 0, done: done, skipped: skipped };
  }

  /* ── 群聊 ─────────────────────────────────────────
     一个会话可以是「群」：characterId 留空，成员放在 members。AI 每次回 1~3 位成员的话，
     用「名字：内容」逐行输出，再由 splitSpeakerLines 拆成多条消息落库、分条渲染。 */
  function groupMembers(s) {
    const ids = (s && Array.isArray(s.members)) ? s.members : [];
    if (!ids.length) return [];
    const chars = Store.getCharacters();
    const out = [];
    ids.forEach((id) => {
      const c = chars.find((x) => x.id === id);
      if (c) out.push({ id: c.id, name: c.name || "角色" });
    });
    return out;
  }

  function buildGroupSystemText(s) {
    const members = groupMembers(s);
    if (!members.length) return "这是一场群聊，但还没有选成员。";
    const chars = Store.getCharacters();
    let t = "【群聊】你在一场多人群聊里，成员有：" + members.map((m) => m.name).join("、") + "。\n";
    members.forEach((m) => {
      const c = chars.find((x) => x.id === m.id);
      const p = Memory.personaText ? Memory.personaText(c) : "";
      t += "\n—— " + m.name + " ——\n" + (p || "（没有更多设定）") + "\n";
    });
    /* 各成员「自己记得的事」：建群时从某条线导进来的（见 app.js importLineMemoryToGroup）。
       必须**分别标注、并说明只是本人知道** —— 否则 AI 会把 A 线的事当成全群共有的，
       或者把别人的经历安到自己头上。 */
    const mm = (s && s.memberMem) || null;
    if (mm) {
      const blocks = [];
      Object.keys(mm).forEach(function (k) {
        const rec = mm[k];
        if (!rec) return;
        const hit = chars.find(function (x) { return x.id === k; });
        /* 标签优先用角色名；来源不是某个角色（助手会话 / 多人群）时改用来源线的标题 ——
           否则会出现「助手（来自「周末局」）」这种自相矛盾的读法。 */
        const nm = (hit && hit.name) || (rec.fromTitle || (k === "__assistant__" ? "助手" : "角色"));
        const parts = [];
        if (rec.relation) parts.push("和用户的关系：" + rec.relation);
        if (rec.shared) parts.push("共同经历：" + rec.shared);
        if (rec.scene) parts.push("最近的情境：" + rec.scene);
        if (rec.cognition) parts.push("对用户的认知：" + rec.cognition);
        /* 导入时还存了那条线自己的「日/周/月记忆摘要」（memberMem[k].memory）。
           以前只注入了上面四项，摘要存下来却从没用上 —— 实测发现的（这位成员记得的
           细节全丢了）。补进来，并按 400 字截断：多人同桌时别把 system 撑爆。 */
        try {
          const mt = (rec.memory && Memory.memoryText) ? String(Memory.memoryText(rec.memory) || "") : "";
          if (mt) parts.push("还记得的细节（这条线自己的记忆摘要）：\n" + mt.slice(0, 400));
        } catch (e) { /* 摘要读不出来不影响其它四项 */ }
        if (parts.length) {
          blocks.push("—— " + nm + "（来自「" + (rec.fromTitle || "另一条线") + "」）——\n" + parts.join("\n"));
        }
      });
      if (blocks.length) {
        t += "\n【各人自己记得的事】下面每一条都只是**那位成员自己**知道的私下经历，不是全群共有的；" +
          "谁的事只能由谁提起，不要安到别人头上，也不要当成大家都经历过。\n" + blocks.join("\n") + "\n";
      }
    }
    if (s && s.scene) t += "\n【当前情境】\n" + s.scene + "\n";
    if (s && s.shared) t += "\n【共同经历】\n" + s.shared + "\n";
    const mt = Memory.memoryText ? Memory.memoryText(s && s.memory) : "";
    if (mt) t += "\n【群聊记忆】\n" + mt + "\n";
    /* 彼此认知（默认关，设置里打开才注入）：逐条带主语，见 peerCogText 的注释 */
    if (peerCogOn(s)) {
      const pc = peerCogText(s);
      if (pc) t += pc;
    }
    t += "\n【发言规则】每次回复让 1~3 位成员发言（谁说话、说几句，由你按各自性格决定，可以有人不说话）。" +
      "每条发言单独一行、用「名字：内容」开头，例如：\n小明：在啊\n小红：刚下课。\n" +
      "名字必须是上面列出的成员名。不要写旁白、不要括号动作、不要替用户说话、不要用 Markdown。" +
      "\n【转述别人】要提到不在群里的人（老师、店员、路人…），**不要单独起一行写他的名字** —— " +
      "那样我们只能当引述处理、并进后面那位成员的话里。请直接写进你自己那行，例如「小明：老师让我先安静点」。";
    return t;
  }

  /* 把「名字：内容」拆成 [{id,name,text}]。规则（10-17 用户拍板）：
     ① 群里完全可以只有一个人说话（提示词里明写「可以有人不说话」）。这种时候只要
        **第一行确实写了某个成员的名字**，也照样拆 —— 否则气泡里是「阿杰：就一句」这种
        原文，既没有说话人标签、也和其它气泡不是一个样式。
        但第一行压根没按格式来（模型直接写了段旁白）→ 整条保持原样，
        别把一整段硬挂到某个人头上。
     ② 冒出不在名单里的名字（「老师：你们安静点」）当**引述**处理：它不是发言，
        并进**后面**那位成员的话里（用户口径：引述本质上还是那个人在引述），
        并改写成「（引述「老师」：你们安静点）」—— 带上标记，模型才不会当成他本人说的。
        已经有人开口之后又冒出陌生名字 → 并进上一位发言人的话里，同一规则。 */
  function quoteLine(ln, byName) {
    const q = /^\s*[（(【\[]?\s*([^\s：:）)】\]]{1,20})\s*[：:]\s*([\s\S]+?)\s*[）)】\]]?\s*$/.exec(ln);
    if (q && !byName[q[1]]) return "（引述「" + q[1] + "」：" + q[2] + "）";
    return ln;   /* 没有「名字：」那种结构的普通旁白：原文留着 */
  }

  function splitSpeakerLines(text, members) {
    if (!members || members.length < 2) return null;
    const byName = {};
    members.forEach((m) => { byName[m.name] = m; });
    const lines = String(text || "").split(/\r?\n/);
    const segs = [];
    let cur = null;
    let namedFirst = false;   /* 第一行是不是就写了成员名 */
    let pre = "";             /* 还没人开口时先冒出来的引述，等下一位发言人认领 */

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const m = /^\s*([^\s：:]{1,20})\s*[：:]\s*([\s\S]*)$/.exec(ln);
      const hit = m ? byName[m[1]] : null;
      if (hit) {
        if (!cur) namedFirst = true;
        else segs.push(cur);
        cur = { id: hit.id, name: hit.name, text: m[2] };
        /* 开场就出现的引述：并进这位发言人的话里 */
        if (pre) { cur.text = pre + "\n" + cur.text; pre = ""; }
      } else if (cur) {
        cur.text += (cur.text ? "\n" : "") + quoteLine(ln, byName);
      } else if (String(ln).trim()) {
        pre += (pre ? "\n" : "") + quoteLine(ln, byName);
      }
    }
    if (cur) segs.push(cur);
    /* 一路都没出现任何成员名 → 整段兜底记在第一位成员名下，别把这段话弄丢 */
    if (!cur && pre) segs.push({ id: members[0].id, name: members[0].name, text: pre });
    segs.forEach((x) => { x.text = String(x.text || "").trim(); });
    const kept = segs.filter((x) => x.text);
    if (kept.length >= 2) return kept;
    if (kept.length === 1 && namedFirst) return kept;   /* 只有一人说话：也拆，挂上说话人 */
    return null;
  }

  async function buildModelMessages(s, upto) {
    const msgs = [];
    if (s && sweepImageExpiry(s)) Store.saveSessions(Store.getSessions());
    const ch = characterFor(s);
    let coveredUntil = 0;
    let systemText = "";
    let washedFrom = 0, washedUntil = 0, washedTurns = null;
    if (s && s.isGroup) {
      /* 群聊：没有「单个角色」，system 由全体成员设定 + 群记忆拼出来 */
      await ensureMemoryReady();
      systemText = buildGroupSystemText(s);
      const extra2 = s && typeof s.systemPrompt === "string" ? s.systemPrompt.trim() : "";
      if (extra2) systemText += "\n\n【补充指令】\n" + extra2;
      coveredUntil = (s && s.memory && s.memory.coveredUntil) || 0;
    } else if (ch) {
      /* 角色扮演：角色卡 + 我的设定 + 关系/场景/认知/记忆（都按当前会话） */
      await ensureMemoryReady();
      systemText = Memory.buildSystemText(ch, s, state.settings);
      const extra = s && typeof s.systemPrompt === "string" ? s.systemPrompt.trim() : "";
      if (extra) systemText += "\n\n【补充指令】\n" + extra;
      const memCovered = (s && s.memory && s.memory.coveredUntil) || 0;
      const cf = ch.ctxFilter || {};
      const cw = (s && s.ctxWash) || {};
      if (cf.rule && Array.isArray(cw.turns) && cw.turns.length && cw.washedFrom > memCovered && cw.washedUntil > cw.washedFrom) {
        washedFrom = cw.washedFrom; washedUntil = cw.washedUntil; washedTurns = cw.turns;
      }
      coveredUntil = memCovered;
    } else {
      /* 本对话自己设了提示词就用它，否则用全局 */
      const own = s && typeof s.systemPrompt === "string" ? s.systemPrompt.trim() : "";
      systemText = own || state.settings.systemPrompt;
      if (state.settings.assistantCompress) {
        await ensureMemoryReady();
        const mt = Memory.memoryText(s && s.memory);
        if (mt) systemText += "\n\n【记忆摘要】\n" + mt;
        coveredUntil = (s && s.memory && s.memory.coveredUntil) || 0;
      }
    }
    /* 情绪日记（用户主动写过才生效）：当作「希望角色往哪儿靠」的软引导，附在设定之后。
       只喂最近 3 条，且明确要求别把日记内容说出来。 */
    if (ch && s && Array.isArray(s.diary) && s.diary.length) {
      const dj = s.diary.slice(-3).map((d) => String((d && d.text) || "").trim()).filter(Boolean).join("；");
      if (dj) systemText += "\n\n【我的情绪日记（只供你体会氛围，请自然地朝这个方向靠，别直接提起日记本身）】\n" + dj;
    }

    /* 状态量化：让模型在末尾附一行状态，本地解析出来后收进折叠框（不显示在正文里）。
       开关关掉时一个字都不加 —— 不花多余 token。 */
    if (ch && statusOn(s)) {
      systemText += "\n\n【状态】在本次回复的最后单独一行输出你的状态，格式：" +
        "〖状态 开心:72 低落:12 生气:5 害羞:40 兴奋:60〗（每项是 0~100 的整数，按此刻真实情况给，" +
        "可增删项）。这一行会被单独解析出来、以状态条展示，请务必不要写进正文里。" +
        "括号就用这对方头括号〖〗，别换成【】或 []；键和值之间用英文冒号，各项之间用空格。";
    }

    /* 「采用格式」：本会话单独设了就用它，否则用「设置」里的全局。追加到最后，
       让模型把它当输出格式约束（它不是角色设定的一部分，放在末尾更醒目）。 */
    const fmt = ((s && typeof s.adoptFormat === "string" && s.adoptFormat.trim()) || (state.settings.adoptFormat || "")).trim();
    if (fmt) systemText += (systemText && systemText.trim() ? "\n\n" : "") + "【采用格式】\n" + fmt;

    /* 这条线单独起的昵称（手机页「这条线」里设的）：告诉模型该怎么称呼用户。
       留空就什么都不加，用角色卡里写的称呼方式。 */
    const nickMe = (s && typeof s.nickMe === "string") ? s.nickMe.trim() : "";
    if (nickMe) {
      systemText += (systemText && systemText.trim() ? "\n\n" : "") +
        "【称呼】在这条对话里，用户希望你叫他「" + nickMe + "」。";
    }

    /* 用户以中文为主 → 要求思考也说中文。查「最后一条用户消息」，
       注意只用它判定语言，不改变任何已存内容。 */
    const _all = (s && s.messages) || [];
    const _end = typeof upto === "number" ? Math.min(upto, _all.length) : _all.length;
    let _newest = "";
    for (let i = _end - 1; i >= 0; i--) {
      const m = _all[i];
      if (m && m.role === "user") { _newest = activeText(m) || ""; break; }
    }
    if (_newest && chineseDominant(_newest)) {
      systemText += (systemText && systemText.trim() ? "\n\n" : "") + THINK_CN_HINT;
    }
    if (systemText && systemText.trim()) msgs.push({ role: "system", content: systemText });

    const list = s.messages;
    const end = typeof upto === "number" ? Math.min(upto, list.length) : list.length;
    /* 已摘要覆盖的旧原文不喂；被「上下文筛选」洗过的区间（washedFrom~washedUntil）用精简逐轮替换，两头原文照喂 */
    let turnsPushed = false;
    for (let i = 0; i < end; i++) {
      const m = list[i];
      if (coveredUntil && (!m.ts || m.ts <= coveredUntil)) continue;
      if (washedTurns && m.ts && m.ts >= washedFrom && m.ts <= washedUntil) {
        if (!turnsPushed) {
          turnsPushed = true;
          washedTurns.forEach((t) => msgs.push({ role: t.role === "user" ? "user" : "assistant", content: t.content }));
        }
        continue;
      }
      const isLast = (i === end - 1) && m.role === "user";
      if (m.role === "user") {
        if (isLast && m.attachments && m.attachments.length) {
          const built = await Files.toMessageParts(m.attachments, { inlineImage: !!state.settings.mainCompat });
          let text = activeText(m);
          if (built.notes.length) text += (text ? "\n\n" : "") + built.notes.join("\n\n");
          if (built.parts.length) {
            msgs.push({ role: "user", content: [{ type: "text", text: text || "请查看我上传的内容" }].concat(built.parts) });
          } else {
            msgs.push({ role: "user", content: text || "[空消息]" });
          }
        } else {
          /* 历史消息（不是正在发的这条）：原图不重发——一是没必要，二是几十张 base64 会把它撑爆。
             但**文字描述要带上**：原图过期后聊天里就只剩这段描述了，「之后喂给模型也只用这段文字」
             这句承诺必须由这里兜住，否则模型对被问到的老图是完全瞎的。 */
          let text = activeText(m);
          const notes = [];
          (m.attachments || []).forEach((a) => {
            if (a.kind === "image") {
              if (a.desc) notes.push("【图片" + (a.name ? "：" + a.name : "") + "（文字描述）】\n" + a.desc);
              else notes.push("[图片：" + (a.name || "附件") + "]");
            } else {
              notes.push("[附件：" + (a.name || "附件") + "]");
            }
          });
          if (notes.length) text += (text ? "\n" : "") + notes.join("\n");
          msgs.push({ role: "user", content: text || "[空消息]" });
        }
      } else if (m.role === "assistant") {
        const c = (activeVariant(m) || {}).content;
        if (c) {
          /* 群聊：把「谁说的」带回上下文，模型才接得住话 */
          const sp = m.speakerName ? m.speakerName + "：" : "";
          msgs.push({ role: "assistant", content: sp + c });
        }
      }
    }
    return msgs;
  }

  /* 「只出了思考、没出正文」时补问一次的纠正语。只加在**请求里**，不写进会话记录。 */
  const EMPTY_NUDGE = "（上一轮你只输出了思考过程，没有输出回答正文。请直接给出回答正文。）";

  /* 状态量化：本会话单独设了就用它，否则跟全局（默认开）。关掉时一个 token 都不多花。 */
  function statusOn(s) {
    if (typeof (s && s.statusQuant) === "boolean") return s.statusQuant;
    return state.settings.statusQuant !== false;
  }
  /* 从正文里抽出状态行。没写 / 解析不出来 → 原样返回。
     容错（10-18 真机反馈「大部分时候失灵」）：模型不一定老老实实用〖〗，
     还会写成【状态】、【状态】、[状态]、［状态］，或者干脆只在行首写「状态：」，
     键值之间也可能用 = 而不是冒号、数值后面带 %。这几种全认。 */
  function extractStatus(text) {
    const src = String(text || "");
    const m = /[〖【\[［]\s*状态\s*[：:]?\s*([^〗】\]］]*)[〗】\]］]/.exec(src)
      || /(?:^|\n)[ \t]*状态[ \t]*[：:][ \t]*([^\n]+)/.exec(src);
    if (!m) return { content: src, status: null };
    const st = {};
    m[1].split(/[\s,，;；|/、]+/).filter(Boolean).forEach((seg) => {
      const kv = /^([^:：=]+)[:：=]\s*(-?\d+(?:\.\d+)?)\s*%?$/.exec(seg);
      if (!kv) return;
      st[kv[1].trim()] = Math.max(0, Math.min(100, Math.round(Number(kv[2]))));
    });
    if (!Object.keys(st).length) return { content: src, status: null };
    const content = src.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
    return { content: content, status: st };
  }

  /* 转向 api.js 的切分（把思考里混着的正文提出来）。api.js 没就绪时退化成「不切」，
     绝不能因为一个工具函数把整条回答拖进 catch。 */
  function splitReasoning(content, reasoning) {
    if (Api && typeof Api.splitReasoning === "function") return Api.splitReasoning(content, reasoning);
    return { content: content || "", reasoning: reasoning || "", split: false };
  }

  /* 合并两次请求的用量（形状同 api.js normUsage 的输出） */
  function addUsage(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return {
      prompt: (a.prompt || 0) + (b.prompt || 0),
      completion: (a.completion || 0) + (b.completion || 0),
      total: (a.total || 0) + (b.total || 0),
      cacheHit: (a.cacheHit || 0) + (b.cacheHit || 0),
      cacheMiss: (a.cacheMiss || 0) + (b.cacheMiss || 0),
      calls: (a.calls || 0) + (b.calls || 0)
    };
  }

  /* 群聊回复拆条：把刚生成、位于末尾的那条助手消息按「名字：内容」拆成多条。
     只处理「新生成 + 末尾」这一种，其它情况原样返回 —— 拆分不影响任何已有消息的下标。
     返回拆完后最后一条节点（后面朗读之类要用）。 */
  function splitGroupReply(sid, el, opts) {
    try {
      const s = sessionById(sid);
      if (!s || !s.isGroup || !el) return el;
      if (opts && typeof opts.variantIndex === "number") return el;   /* 重生成不拆，保持一条 */
      const idx = el.__idx;
      if (typeof idx !== "number") return el;
      const members = groupMembers(s);
      if (members.length < 2) return el;
      const msg = s.messages[idx];
      if (!msg || msg.role !== "assistant") return el;
      const segs = splitSpeakerLines((activeVariant(msg) || {}).content, members);
      if (!segs) return el;                                            /* 没拆出多人 → 保持一条 */
      const list = Store.getSessions();
      const si = list.findIndex((x) => x.id === sid);
      if (si < 0) return el;
      const msgs = list[si].messages;
      if (idx !== msgs.length - 1) return el;                          /* 只拆末尾那条 */
      const base = msg.ts || Date.now();
      const q = opts && typeof opts.q === "number" ? opts.q : 0;
      const repl = segs.map((sg, i) => ({
        role: "assistant",
        ts: base + i,
        speaker: sg.id,
        speakerName: sg.name,
        content: sg.text,
        variants: [{ content: sg.text, q: q }],
        vi: 0
      }));
      msgs.splice(idx, 1);
      for (let i = 0; i < repl.length; i++) msgs.push(repl[i]);
      Store.saveSessions(list);
      if (sid !== state.sessionId) { el.remove(); return null; }
      /* 就地换掉那一条 → 变成好几条（不整列重建，避免打断别的东西） */
      const box = $("#messages");
      const s2 = sessionById(sid);
      const anchor = el.nextSibling;
      const nodes = repl.map((m, i) => {
        const n = UI.msgEl(toView(m), s2);
        n.__idx = idx + i;
        return n;
      });
      nodes.forEach((n) => box.insertBefore(n, anchor));
      el.remove();
      return nodes[nodes.length - 1] || el;
    } catch (e) { return el; }
  }

  /* 生成一个 AI 回答版本。opts: { variantIndex?, upto?, q? }
     - variantIndex：新版本追加到这条助手消息上（不传则追加一条新助手消息）
     - upto：构建上下文时只取到第 upto 条（不含）
     - q：这条回答对应第几个提问版本 */
  async function runGeneration(sid, opts) {
    syncModules();
    const o = opts || {};
    const view = UI.createStreamView(sessionById(sid));
    const targetEl = typeof o.variantIndex === "number" ? msgElAt(o.variantIndex) : null;
    if (targetEl && targetEl.parentNode) targetEl.replaceWith(view.el);
    else $("#messages").appendChild(view.el);
    /* 登记到共享状态：生成期间别的模块触发 renderMessages()（保存设置、切角色、删消息…）
       会把整列重建，靠这个引用把流式节点挂回来，否则这条回复会彻底消失。 */
    state.streamEl = view.el;
    state.streamSid = sid;
    view.showTyping();
    UI.scrollToBottom();

    setBusy(true);
    syncContinueRow();          /* 生成中把「继续说」收掉，免得点第二遍 */
    state.abort = new AbortController();
    const snap = sessionById(sid);
    if (!snap) {
      view.el.remove();
      if (state.streamEl === view.el) { state.streamEl = null; state.streamSid = ""; }
      setBusy(false);
      state.abort = null;
      return;
    }
    const settings = applySessionParams(state.settings, snap);
    const searchOn = settings.searchEnabled && settings.searchProvider !== "off";
    let committed = false;

    const commit = (final, errorText) => {
      /* 提交只能有一次。提交之后若还有别的语句抛错（用量记账、自动清洗…），
         会落到 catch 再 commit 一回 —— 那就给同一条消息塞了两个版本。 */
      if (committed) return null;
      committed = true;
      let idx = -1;
      mutateSession(sid, (msgs) => {
        const variant = {
          content: final.content,
          reasoning: final.reasoning,
          sources: final.sources,
          status: final.status || null,
          q: typeof o.q === "number" ? o.q : 0
        };
        if (errorText) variant.error = errorText;
        /* 是被长度上限截断还是正常结束，渲染时要分开说 */
        if (final.truncated) variant.trunc = true;
        if (typeof o.variantIndex === "number" && msgs[o.variantIndex]) {
          const m = msgs[o.variantIndex];
          ensureVariants(m);
          m.variants.push(variant);
          m.vi = m.variants.length - 1;
          idx = o.variantIndex;
        } else {
          const nm = { role: "assistant", ts: Date.now(), variants: [variant], vi: 0 };
          /* 指定某人继续说：直接挂到他名下，气泡才带名字标签；
             模型多半仍按「名字：内容」输出，落库前把前缀剥掉（名字已经在 speakerName 里）。 */
          if (o.forceSpeaker && o.forceSpeaker.name) {
            nm.speaker = o.forceSpeaker.id || "";
            nm.speakerName = o.forceSpeaker.name;
            variant.content = stripSpeakerPrefix(variant.content, o.forceSpeaker.name);
          }
          msgs.push(nm);
          idx = msgs.length - 1;
        }
      });
      const list = sessionById(sid);
      if (!list || !list.messages[idx]) { view.el.remove(); return null; }
      const box = $("#messages");
      /* 提交前先问一句：用户是不是还贴着底部看。
         贴着就继续跟到底（比如末尾新多出来的「来源」块他得看得见）；
         没贴着（翻上去看旧消息了）就**什么都不动**，别把他拽回来。 */
      const stick = UI.isNearBottom();
      let el = UI.msgEl(toView(list.messages[idx]), list);
      el.__idx = idx;
      if (sid === state.sessionId) {
        if (view.el.parentNode) view.el.replaceWith(el);
        else {
          /* 流式节点被别处的重渲染抹掉了 —— 整列重建兜底，绝不让这条回复凭空消失。
             重建【之前】先把登记清掉：否则 renderMessages 会把这条还没提交的流式节点
             又 append 到末尾，同一条回答就渲染成了两份（正式节点 + 残留的流式节点）。 */
          if (state.streamEl === view.el) { state.streamEl = null; state.streamSid = ""; }
          renderMessages();
          el = null;
        }
      } else {
        view.el.remove();
      }
      renderSessionList();
      if (sid === state.sessionId && stick) UI.scrollToBottom();
      return el;
    };

    try {
      const messages = await buildModelMessages(snap, o.upto);
      /* 「继续说」：临时补一句指令，让模型接着上一句往下讲。
         **只加在这一次请求里**，不落库 —— 历史里不会多出一条假消息。
         群聊里带 forceSpeaker 时，指令换成「只由他一个人说」。 */
      if (o.cont) {
        const fs2 = o.forceSpeaker;
        messages.push({ role: "user", content: (fs2 && fs2.name) ? continueNudgeOne(fs2.name) : CONTINUE_NUDGE });
      }
      /* 兜底：接口模块真的没加载（打包漏了 api.js）时给一句能看懂的话，
         而不是抛出「Cannot read property 'run' of undefined」这种没法定位的错。 */
      if (!Api || typeof Api.run !== "function") {
        throw new Error("接口模块 api.js 没有加载成功，请重新打包（打包前先退出重进封装软件）");
      }
      const onEvent = {
        onReasoning: (t) => {
          const stick = UI.isNearBottom();
          view.setReasoning(t);
          if (stick) UI.scrollToBottom();
        },
        onContent: (t) => {
          const stick = UI.isNearBottom();
          view.setContent(t);
          if (stick) UI.scrollToBottom();
        },
        onToolCall: (name, query) => { if (query) UI.toast("正在联网搜索：" + query); }
      };
      const ask = (msgs) => Api.run({
        settings,
        messages: msgs,
        thinking: !!settings.thinkingEnabled,
        effort: settings.reasoning || "high",
        signal: state.abort.signal,
        search: searchOn ? (query) => Search.search(query, settings) : null
      }, onEvent);

      let result = await ask(messages);
      let finish = result && result.finishReason;

      /* 先试一次「从思考里剥正文」：有些模型会把正文也塞进思考字段（用行首 response 分界），
         那种情况 delta.content 一路为空 —— 但正文其实已经来了，只是站错了队伍。
         剥出来了就不算「没正文」，也就不必补问。 */
      const live = view.snapshot ? view.snapshot() : { content: "", reasoning: "" };
      const sp0 = splitReasoning(live.content, live.reasoning);

      /* 只出了思考、正文空的：模型常把话全写进思考里，然后就「以为已经答过了」。
         补一句纠正再问一次 —— **只补这一次**，还不行就交给下面那条提示，绝不反复烧钱。
         （用户中途点了停止的话不补：signal 已 abort，再问也只会立刻抛错。） */
      if (!String(sp0.content || "").trim() && !state.abort.signal.aborted) {
        const nudged = messages.slice();
        let li = -1;
        for (let i = nudged.length - 1; i >= 0; i--) { if (nudged[i].role === "user") { li = i; break; } }
        if (li >= 0) {
          const cur = nudged[li].content;
          /* 带附件时 content 是「文本 + 图片部件」的数组，直接 String() 会得到
             "[object Object]" —— 正文和图片全被抹掉，补问请求就废了。
             数组就追加一个 text 部件，别拼字符串。 */
          const next = Array.isArray(cur)
            ? cur.concat([{ type: "text", text: EMPTY_NUDGE }])
            : String(cur || "") + "\n\n" + EMPTY_NUDGE;
          nudged[li] = Object.assign({}, nudged[li], { content: next });
        } else nudged.push({ role: "user", content: EMPTY_NUDGE });
        UI.toast("这轮只出了思考，正在补一次正文…");
        const retry = await ask(nudged);
        finish = retry && retry.finishReason;
        /* 【判据①：作用要与承诺一致】补问这一路会把 result 整个换掉，
           漏带 sources 就等于「联网搜过、来源块却不显示」—— 与下面「不喂给它来源块恒空」
           的修复是同一件事，只是发生在补问分支。两次的来源都留着，优先补问那次。 */
        result = {
          content: (retry && retry.content) || "",
          sources: (retry && retry.sources && retry.sources.length ? retry.sources : (result && result.sources)) || [],
          usage: addUsage(result && result.usage, retry && retry.usage)
        };
      }

      /* 联网搜索的结果由 Api.run 从工具调用里收好了（result.sources），
         但流式视图不会自己拿到 —— 不喂给它，commit 时 final.sources 恒为空，
         生成时的「来源」块永远不显示（只有手动搜索那条路才看得见）。 */
      if (result && result.sources && result.sources.length && typeof view.setSources === "function") {
        view.setSources(result.sources);
      }

      const fin = view.finish();
      /* 落库前再切一次：把思考里混着的正文提到正文位（已有正文时是空操作）。
         生成过程中它先显示在思考框里，提交后回到正文区 —— 这才是它该待的地方。 */
      const sp = splitReasoning(fin.content, fin.reasoning);
      if (sp.split) { fin.content = sp.content; fin.reasoning = sp.reasoning; }
      /* 状态量化：把末尾那行状态抽出来交给折叠框，正文里不留痕迹 */
      if (statusOn(snap)) {
        const ex = extractStatus(fin.content);
        if (ex.status) { fin.status = ex.status; fin.content = ex.content; }
      }
      if (finish === "length") fin.truncated = true;
      let el = commit(fin, null);
      /* 群聊：AI 一次可能让好几个人说话，拆成多条气泡（非群聊是空操作）。
         指定某人继续说时不拆 —— 他已经挂在那个人名下了，再拆会把内容再分一遍。 */
      if (!o.forceSpeaker) el = splitGroupReply(sid, el, o);
      if (result && result.usage && typeof recordUsage === "function") recordUsage(sid, result.usage, snap.characterId);
      const cs = sessionById(sid);
      if (cs) {
        const cx = cs.characterId ? Store.getCharacters().find((x) => x.id === cs.characterId) : null;
        /* 这三个在 roleplay.js / settings.js 里注册，脚本顺序不保证 —— 没就绪就跳过，
           别让「生成完顺手做的事」把整条回答拖进 catch。 */
        if (cx && typeof maybeAutoWash === "function") maybeAutoWash(cs, cx);
        if (cx && typeof maybeAutoScene === "function") maybeAutoScene(cs, cx);
        if (cx && typeof maybeDailyRefresh === "function") maybeDailyRefresh(cs, cx);
        /* 「TA 的思考」（10-20）：记忆更新后补当天那条；攒够七个故事日就压一次并让角色读。
           世界生成已经写过的那天，这里不会重复写（见 think.js 的 genFor）。 */
        try {
          if (window.Think && window.Think.enabled && window.Think.enabled(cs)) {
            const td = window.Think.dayStr(window.Think.nowOf(cs));
            window.Think.genFor(sid, td, { src: "mem" }).then(function () {
              return window.Think.tick(sid);
            }).catch(function () { /* 思考写不出来不影响对话 */ });
          }
        } catch (e) { /* ignore */ }
        if (typeof maybeAutoBackup === "function") maybeAutoBackup(cs, "gen");
      }
      if (el && state.settings.ttsAutoRead && Media.capable("tts", state.settings)) {
        const rb = el.querySelector('.act-btn[data-act="read"]');
        if (rb) toggleRead(rb);
      }
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      const note = aborted ? "已停止生成" : (err && err.message ? err.message : "请求失败");
      commit(view.finish(), note);
      if (!aborted && /Failed to fetch|NetworkError|Load failed/i.test(String(err && err.message))) {
        /* 自动重试过还是挂了才走到这。别再把锅一口咬定给封装工具 —— 这条文案
           以前让用户以为是跨域没配好，反复折腾；其实多数是网络波动。 */
        UI.toast("网络请求失败：多半是网络波动，重发即可；若每次都失败，再检查封装工具的跨域设置", true);
      }
    } finally {
      setBusy(false);
      state.abort = null;
      if (state.streamEl === view.el) { state.streamEl = null; state.streamSid = ""; }
      syncContinueRow();        /* 生成结束，把「继续说」挂回最后一条角色消息下面 */
      syncRegenRow();           /* 生成结束后「最后一条」变了，「重新说」跟着挪过去 */
      /* 这里**不**再滚到底：提交那一刻已经按用户的位置决定过要不要跟了 */
    }
  }

  async function send() {
    syncModules();
    if (state.busy || state.sending) return;
    const input = $("#input");
    const text = input.value.trim();

    if (checkedOf("#imgToggle")) {
      if (!text) { UI.toast("先描述一下要画什么", true); return; }
      await sendImage(text);
      return;
    }

    if (!text && !state.attachments.length) return;

    /* 角色相关字段没填齐 → 先别发（用户口径：格式化 / 关于「我」的几栏 / AI 筛选规则 / 对话名称不参与）。
       拦在「发消息」这一步、而不是进对话时：否则字段不全的老对话会直接打不开。 */
    const curSes = (window.DL && window.DL.session) ? window.DL.session() : null;
    /* 混搭模式（10-20）：发第一条消息时解冻，离线那段不推进 */
    try {
      if (curSes && curSes.autoFreeze && Memory && Memory.isFrozen && Memory.isFrozen(curSes)) {
        Memory.unfreezeTime(curSes);
        Store.saveSessions(Store.getSessions());
      }
    } catch (e) { /* 解冻失败不影响发送 */ }
    const missF = (window.DL && window.DL.charMissingFields) ? window.DL.charMissingFields(curSes) : [];
    if (missF.length) {
      UI.toast("这个角色还差 " + missF.length + " 栏设定才能开始对话：" + missF.slice(0, 3).join("、") + (missF.length > 3 ? "…" : ""), true);
      setTimeout(function () { try { UI.openModal("characterModal"); } catch (e) { /* ignore */ } }, 80);
      return;
    }

    if (!state.settings.apiKey) {
      UI.toast("请先在「设置」里填写 API Key", true);
      UI.openModal("settingsModal");
      return;
    }

    let s = session();
    if (!s) { newSession(); s = session(); }
    const sid = s.id;

    /* 括号里的时间指令：（第二天）「（到了约定时间）」这种，先把故事时间推过去。
       越出角色设定（出生日期 + 年龄算出的时段）就**拒绝并说清原因**，绝不悄悄设成不可能的日期。 */
    try {
      const jr = (Memory && Memory.tryJumpTime) ? Memory.tryJumpTime(s, characterFor(s), text) : null;
      if (jr && jr.ok) {
        const tl = Store.getSessions();
        const k = tl.findIndex((x) => x.id === sid);
        if (k >= 0) { tl[k].time = { start: jr.ms, setAt: Date.now() }; Store.saveSessions(tl); }
        if (window.DL && window.DL.syncChatClock) window.DL.syncChatClock();
        UI.toast("时间推进到 " + Memory.fmtStory(jr.ms) + "（" + jr.label + "）");
      } else if (jr) {
        UI.toast("时间没动：这会超出角色设定的时段（只能在 " +
          Memory.fmtStory(jr.from).slice(0, 10) + " ~ " + Memory.fmtStory(jr.to).slice(0, 10) +
          " 之间）。想改就调整角色的年龄或出生日期。", true);
      }
    } catch (e) { /* 时间调整失败不影响发消息 */ }

    /* 关系剖析（10-21）：设置里那个按钮撤了，改成在助手线里说一句触发。
       命中的话：用户这句照常入库，然后直接把报告作为回复写进对话，不再走普通请求。 */
    try {
      const aid = (window.DL && window.DL.tinglanId) || "c_tinglan";
      const isAsst = (s.characterId || "") === aid;
      if (isAsst && /关系(剖析|分析)|剖析(一下)?关系|分析(一下)?关系|关系(怎么样|如何)/.test(String(text || ""))) {
        const tl = Store.getSessions();
        const k = tl.findIndex((x) => x.id === sid);
        if (k >= 0) {
          tl[k].messages = tl[k].messages || [];
          tl[k].messages.push({ role: "user", content: text, variants: [text], vi: 0, ts: Date.now() });
          tl[k].updatedAt = Date.now();
          Store.saveSessions(tl);
          renderMessages();
        }
        UI.toast("正在读这条线的记忆，写一份关系剖析…");
        await window.DL.runAssistantSummary(sid);
        return;
      }
    } catch (e) { /* 识别失败就当普通消息走 */ }

    const userMsg = {
      role: "user",
      content: text,
      variants: [text],
      vi: 0,
      attachments: state.attachments.slice()
    };
    if (userMsg.attachments.some((a) => Store.hasImage(a))) {
      userMsg.atTurn = s.messages.filter((m) => m.role === "user").length + 1;
    }
    if (userMsg.attachments.some((a) => a.kind === "image") && !state.settings.imgExpireNotified) {
      state.settings = Store.saveSettings({ imgExpireNotified: true });
      UI.toast("提示：图片会在 " + (state.settings.imgExpireTurns || 10) + " 轮后删除原图、只留文字描述（可在「设置 → 图片」里调整或关闭）");
    }
    /* 群聊不拿第一句话当标题 —— 群名是建群时定的，不能被一句消息顶掉 */
    const title = (s && s.isGroup)
      ? ""
      : (s.messages.some((m) => m.role === "user")
        ? ""
        : (text || (userMsg.attachments[0] && userMsg.attachments[0].name) || "新对话").slice(0, 20));
    appendMessage(sid, userMsg, title);
    input.value = "";
    autoResize();
    state.attachments = [];
    renderAttachments();

    const uEl = UI.msgEl(toView(userMsg), s);
    uEl.__idx = sessionById(sid).messages.length - 1;
    $("#messages").appendChild(uEl);
    UI.scrollToBottom();

    /* 顺序要紧：「模型兼容」关闭时图片不内联，必须先**等**描述拿到手才发得出去；
       等完再交给后台的 describePendingImages 收尾（那时用户图已有 desc，它只会去补
       还没描述的助手出图，不会和这里抢同一张）。 */
    /* 从这里到 runGeneration 之间要走网络（等图片描述，可能几秒），state.busy 还没置位。
       上这把锁，堵住「这段窗口里再点一次发送 → 开出第二条生成」的竞态。 */
    state.sending = true;
    try {
      await ensureImageDescriptions(sid);
      describePendingImages(sid);
      await runGeneration(sid, { q: 0 });
    } finally {
      state.sending = false;
    }
  }

  function stop() {
    if (state.abort) state.abort.abort();
  }

  /* ── 会话参数 ──────────────────────────────────── */
  function applySessionParams(base, s) {
    if (!s) return base;
    if (typeof s.temperature !== "number" && typeof s.topP !== "number") return base;
    const out = Object.assign({}, base);
    if (typeof s.temperature === "number") out.temperature = s.temperature;
    if (typeof s.topP === "number") out.topP = s.topP;
    return out;
  }

  function mutateMessages(fn) { mutateSession(state.sessionId, fn); }

  function mutateSession(sid, fn) {
    const list = Store.getSessions();
    const i = list.findIndex((x) => x.id === sid);
    if (i < 0) return;
    fn(list[i].messages);
    list[i].updatedAt = Date.now();
    Store.saveSessions(list);
  }

  function mutateInsert(index, msg) {
    if (!msg.ts) msg.ts = Date.now();
    mutateMessages((msgs) => { msgs.splice(index, 0, msg); });
  }

  /* ── 消息版本（提问/回答都可存多版）────────────────── */
  function variantsOf(m) {
    if (Array.isArray(m.variants) && m.variants.length) return m.variants;
    return m.role === "user"
      ? [m.content || ""]
      : [{ content: m.content || "", reasoning: m.reasoning, sources: m.sources, error: m.error, trunc: m.trunc }];
  }

  function activeOf(m) {
    const n = variantsOf(m).length;
    const i = typeof m.vi === "number" ? m.vi : 0;
    return Math.min(Math.max(i, 0), n - 1);
  }

  function ensureVariants(m) {
    if (!Array.isArray(m.variants) || !m.variants.length) m.variants = variantsOf(m);
    if (typeof m.vi !== "number" || m.vi >= m.variants.length) m.vi = 0;
  }

  function activeVariant(m) { return variantsOf(m)[activeOf(m)]; }

  function activeText(m) {
    const v = activeVariant(m);
    return m.role === "user" ? (v || "") : ((v && v.content) || "");
  }

  /* 渲染用视图：把多版本拍平成当前选中那条 + 版本计数 */
  function toView(m) {
    const vs = variantsOf(m);
    const vi = activeOf(m);
    let view;
    if (m.role === "user") {
      view = { role: "user", content: vs[vi], attachments: m.attachments };
    } else {
      const v = vs[vi] || {};
      view = { role: "assistant", content: v.content, reasoning: v.reasoning, sources: v.sources, error: v.error, trunc: v.trunc, image: m.image, imageDesc: m.imageDesc,
        /* 群聊：这条是谁说的（单聊会话里恒为空，等于没加） */
        speaker: m.speaker, speakerName: m.speakerName,
        /* 状态量化：本条的状态数值（没开 / 没解析出来时为 null） */
        status: v.status || null };
    }
    view.world = !!m.world;      /* 剧情卡：渲染成居中的卡片，不当气泡 */
    view.offline = !!m.offline;  /* 双线：手机那一轮对应的「线下侧写」，渲染成旁白 */
    view.variantCount = vs.length;
    view.variantIndex = vi;
    return view;
  }

  function msgElAt(index) {
    const kids = $("#messages").children;
    for (let i = 0; i < kids.length; i++) { if (kids[i].__idx === index) return kids[i]; }
    return null;
  }

  function copyMsgText(msg) {
    const text = activeText(msg);
    if (!text) { UI.toast("没有可复制的文字", true); return; }
    /* 复制给人看，别让人粘出去一串 [[s:stabc123]]（10-19）。
       渲染层画的是图，剪贴板里要的是能读的字。 */
    let out = text;
    try {
      if (Memory && Memory.emojiReadable) out = Memory.emojiReadable(text);
    } catch (e) { out = text; }
    UI.copyText(out).then((ok) => UI.toast(ok ? "已复制" : "复制失败", !ok));
  }

  /* ── 多选模式 ──────────────────────────────────── */
  function enterSelect(index) {
    if (typeof index !== "number" || index < 0) return;
    state.selecting = true;
    state.selected = new Set([index]);
    document.body.classList.add("selecting");
    $("#selectBar").hidden = false;
    const el = msgElAt(index);
    if (el) el.classList.add("selected");
    updateSelectBar();
  }

  function exitSelect() {
    if (!state.selecting) return;
    state.selecting = false;
    state.selected = null;
    document.body.classList.remove("selecting");
    $("#selectBar").hidden = true;
    const box = $("#messages");
    const kids = box ? box.children : [];
    for (let i = 0; i < kids.length; i++) kids[i].classList.remove("selected");
  }

  function toggleSelect(index) {
    if (!state.selected) return;
    const el = msgElAt(index);
    if (state.selected.has(index)) {
      state.selected.delete(index);
      if (el) el.classList.remove("selected");
    } else {
      state.selected.add(index);
      if (el) el.classList.add("selected");
    }
    if (!state.selected.size) { exitSelect(); return; }
    updateSelectBar();
  }

  function updateSelectBar() {
    const n = state.selected ? state.selected.size : 0;
    setText("#selectCount", "已选 " + n + " 条");
  }

  /* 定位用 DOM 索引：Store 走 JSON 序列化，对象引用不可靠 */
  /* 群聊里改/删消息不是「只影响我」—— 先弹一次强警告。单聊直接放行，不加无谓摩擦。 */
  async function groupDanger(kind) {
    const s = session();
    if (!s || !s.isGroup) return true;
    if (state.settings.groupWarnOff) return true;
    const r = await UI.confirmDanger(
      kind === "edit" ? "要改群里这条消息？" : "要删群里这条消息？",
      kind === "edit"
        ? "改完会立刻对所有参与者生效。之前已经读过这条的角色，记忆里可能还留着旧版本；要彻底纠正，改完再到「角色记忆」里说一句。"
        : "删除不可恢复。已经进过记忆的内容不会跟着删，需要的话到「对话设置 → 记忆」里纠正。",
      { delayMs: 5000, checkText: "以后不再提示（可在设置里恢复）" });
    if (r.dontAsk) state.settings = Store.saveSettings({ groupWarnOff: true });
    return r.ok;
  }

  async function handleMessageAction(action, i) {
    const s = session();
    if (!s) return;
    const msg = s.messages[i];
    if (!msg) return;
    if (action === "copy") { copyMsgText(msg); return; }
    if (action === "edit") {
      if (!(await groupDanger("edit"))) return;
      openEdit(i); return;
    }
    if (action === "resend") { resendAt(i); return; }
    if (action === "search") { searchMessage(i); return; }
    if (action === "regen") { regenerateAt(i); return; }
    if (action === "delete") {
      if (!(await groupDanger("delete"))) return;
      openDeleteDialog([i]); return;
    }
    if (action === "rollback") { rollbackTo(i); return; }
  }

  /* ── 回溯（10-20 改版：**不丢东西，改成开一条支线**）────────────
     以这条消息的时刻为界：
       · 新建一条支线（原名 + 数字），只带这条及之前的主聊天消息、以及之前发的手机消息
       · 记忆 / 认知 / 关系 / 共同经历 / 场景 **按「回溯点前 20 条」重新生成**
         （后 20 条只作比对材料：让 AI 知道哪些事发生在之后、必须排除）
       · 原线原封不动保留；新线是支线，用户想转正自己去点「设为主线」
     时间单位全程毫秒（消息 ts、手机消息 ts、故事时间都是 Date.now）。 */
  async function rollbackTo(i) {
    const s = session();
    if (!s) return;
    const msg = s.messages[i];
    if (!msg) return;
    const M = window.Memory;
    if (!M || !M.hasTimeline(s)) { UI.toast("这条对话没开时间系统，回溯用不了", true); return; }
    const t = s.time;
    const offset = t.start - t.setAt;
    const base = (typeof msg.ts === "number" && msg.ts > 0) ? msg.ts : Date.now();  /* 回溯点的现实毫秒 */
    const target = base + offset;                                                    /* 回溯点的故事毫秒 */
    const after = s.messages.length - (i + 1);
    const ok = await UI.confirmDialog("回溯到这里（新建支线）",
      "会新建一条支线，只保留这条及之前的 " + (i + 1) + " 条消息，故事时间回到 " + M.fmtStory(target) +
      "。原线" + (after ? "（后面那 " + after + " 条）" : "") + "原样保留，不动。确定吗？");
    if (!ok) return;

    /* 还在生成 → 直接中断（用户口径 5） */
    if (state.busy && state.abort) { try { state.abort.abort(); } catch (e) { /* ignore */ } }
    state.busy = false;

    const list = Store.getSessions();
    const baseTitle = String(s.title || "新对话").replace(/\s+\d+$/, "");
    const taken = {};
    list.forEach((x) => { if ((x.characterId || "") === (s.characterId || "")) taken[String(x.title || "")] = 1; });
    let n = 2, title = baseTitle + " " + n;
    while (taken[title]) { n++; title = baseTitle + " " + n; }

    const clone = JSON.parse(JSON.stringify(s));
    clone.id = "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    clone.title = title;
    clone.mainLine = false;          /* 支线：想转正自己点「设为主线」 */
    clone.pinned = false;
    clone.createdAt = Date.now();
    clone.updatedAt = Date.now();
    clone.introDone = true;
    clone.usage = null;
    clone.messages = clone.messages.slice(0, i + 1);
    /* 手机消息：截到回溯点之前（毫秒直接比；没有 ts 的留着） */
    if (clone.phone && Array.isArray(clone.phone.msgs)) {
      clone.phone.msgs = clone.phone.msgs.filter((m) => !m || typeof m.ts !== "number" || m.ts <= base);
    }
    /* TA 的思考：只留回溯日及之前的；压缩块越界就作废 */
    const cutDay = M.fmtStory(target).slice(0, 10);
    if (clone.think && typeof clone.think === "object") {
      if (Array.isArray(clone.think.days)) clone.think.days = clone.think.days.filter((d) => d && d.d && d.d <= cutDay);
      if (clone.think.digestTo && clone.think.digestTo > cutDay) {
        clone.think.digest = "";
        clone.think.digestTo = "";
        clone.think.readText = "";
        clone.think.readAt = 0;
        clone.think.digestAt = 0;
      }
    }
    /* 记忆先清空占位，水位线压到回溯点（否则压缩会跳过新内容）。
       认知 / 关系 / 共同经历 / 场景也一起清空：这些是从原线深拷贝来的，里面全是
       **回溯点之后**的内容，重建失败时留着它们比空着更糟（10-20 修）。 */
    clone.memory = { days: [], weeks: [], months: [], coveredUntil: target };
    clone.cognition = "";
    clone.relation = "";
    clone.shared = "";
    clone.scene = "";
    clone.time = { start: target, setAt: Date.now(), leftAt: Date.now() };
    list.push(clone);
    const okSaved = Store.saveSessions(list);
    if (okSaved === false) {
      UI.toast("支线已经在内存里建好了，但没写进本机存储（空间可能不够）—— 先导出备份，再清一次缓存", true);
    }

    state.sessionId = clone.id;
    Store.setCurrentId(clone.id);
    renderAll();
    UI.toast("已新建支线「" + title + "」，正在重建记忆…");

    try { await rebuildForked(clone.id, s.id, i, target); } catch (e) {
      UI.toast("记忆重建失败：" + (e && e.message ? e.message : e) + "（新线已经建好，记忆还是空的）", true);
    }
  }

  /* 按「回溯点前 20 条」重建新线的记忆 / 认知 / 关系 / 共同经历 / 场景。
     后 20 条只作比对材料，不进结果。花费记在「回溯重建」。 */
  async function rebuildForked(newSid, oldSid, i, target) {
    const list = Store.getSessions();
    const oldS = list.filter((x) => x.id === oldSid)[0];
    const newS = list.filter((x) => x.id === newSid)[0];
    if (!oldS || !newS || !state.settings.apiKey) return;
    const msgs = oldS.messages || [];
    const up = msgs.slice(Math.max(0, i - 19), i + 1);
    const down = msgs.slice(i + 1, i + 21);
    const fmt = (arr) => arr.map((m) => ((m.role === "user" ? "我" : "TA") + "：" + activeText(m))).join("\n");
    const oldFiles =
      "【旧记忆】\n" + (Memory.memoryText ? Memory.memoryText(oldS.memory) : "（空）") +
      "\n【旧认知】\n" + (oldS.cognition || "（空）") +
      "\n【旧关系】\n" + (oldS.relation || "（空）") +
      "\n【旧共同经历】\n" + (oldS.shared || "（空）") +
      "\n【旧场景】\n" + (oldS.scene || "（空）");

    const sys = "你在为一条「回溯出来的支线」重建记忆文件。\n" +
      "这条线只发生到【回溯点】为止：回溯点之后的事**都不存在**，绝不能写进任何一项。\n" +
      "输入会给你：回溯点之前的 20 条对话（真正要用的）、回溯点之后的 20 条（**只用来判断哪些事发生在之后、必须排除**）、以及原线的旧文件（可能混进了之后的内容）。\n" +
      "输出一个 JSON 对象，键固定为：memory / cognition / relation / shared / scene。\n" +
      "要求：\n" +
      "1. memory：第三人称、条目化的记忆摘要，只写回溯点之前的关键事件、情绪变化、设定与承诺，400 字内；\n" +
      "2. cognition：只写「用户这个人」的稳定特质（偏好、性格、雷点、习惯），不写剧情；\n" +
      "3. relation：一句话概括此刻的关系；shared：条目化列出共同经历（只到回溯点为止）；\n" +
      "4. scene：此刻在哪、在做什么、氛围，150 字内；\n" +
      "5. 旧文件只作参考：里面提到回溯点之后的事，一律删掉；没有依据的不要编；\n" +
      "6. 只输出这个 JSON 对象，不要解释、不要代码块。";

    const user = "【回溯点】" + Memory.fmtStory(target) +
      "\n\n【回溯点之前的对话】\n" + (fmt(up) || "（没有）") +
      "\n\n【回溯点之后的对话（只用于排除，不要写进结果）】\n" + (fmt(down) || "（没有）") +
      "\n\n" + oldFiles;

    const r = await Api.summarize(state.settings, [
      { role: "system", content: sys },
      { role: "user", content: user }
    ], { maxTokens: 1200 });
    if (r && r.usage) recordUsage(newSid, r.usage, newS.characterId, "fork");

    let obj = null;
    try {
      const raw = String((r && r.text) || "").replace(/```json/gi, "").replace(/```/g, "").trim();
      const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
      obj = JSON.parse(raw.slice(a, b + 1));
    } catch (e) { obj = null; }
    if (!obj) return;

    const list2 = Store.getSessions();
    const live = list2.filter((x) => x.id === newSid)[0];
    if (!live) return;
    const mem = Memory.ensureMemory(live);
    const day = Memory.fmtStory(target).slice(0, 10);
    if (obj.memory) mem.days = [{ d: day, t: String(obj.memory) }];
    mem.coveredUntil = target;
    if (obj.cognition) live.cognition = String(obj.cognition);
    if (obj.relation) live.relation = String(obj.relation);
    if (obj.shared) live.shared = String(obj.shared);
    if (obj.scene) live.scene = String(obj.scene);
    live.updatedAt = Date.now();
    Store.saveSessions(list2);
    if (live.id === state.sessionId) {
      try { fillSessionForm(session()); } catch (e) { /* ignore */ }
      renderAll();
    }
    UI.toast("支线记忆已重建");
  }

  function openMessageMenu(i) {
    const s = session();
    if (!s) return;
    const msg = s.messages[i];
    if (!msg) return;
    const box = $("#msgMenuList");
    box.innerHTML = "";
    UI.ACTIONS.user.forEach((a) => {
      const btn = UI.actionBtn(a[0], a[1], a[2], "menu-btn");
      btn.addEventListener("click", () => {
        if (a[0] === "read") { readText(btn, activeText(msg)); return; }
        UI.closeModal("msgMenuModal");
        if (a[0] === "multi") { enterSelect(i); return; }
        handleMessageAction(a[0], i);
      });
      box.appendChild(btn);
    });
    UI.openModal("msgMenuModal");
  }

  function openEdit(i) {
    const s = session();
    if (!s) return;
    const msg = s.messages[i];
    if (!msg) return;
    setText("#editTitle", msg.role === "user" ? "修改消息" : "修改回答");
    setVal("#editText", activeText(msg));
    state.editCtx = { index: i };
    UI.closeModal("msgMenuModal");
    UI.openModal("editModal");
  }

  /* 重新说（用户侧）：弹编辑框预填当前文字，不改也能直接确定 → 作为新提问版本重发 */
  function resendAt(i) {
    const s = session();
    if (!s) return;
    const msg = s.messages[i];
    if (!msg || msg.role !== "user") return;
    if (state.busy) { UI.toast("正在生成，请稍后再试", true); return; }
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    setText("#editTitle", "重新说");
    setVal("#editText", activeText(msg));
    state.editCtx = { index: i, resend: true };
    UI.closeModal("msgMenuModal");
    UI.openModal("editModal");
  }

  function saveEdit() {
    const ctx = state.editCtx;
    state.editCtx = null;
    UI.closeModal("editModal");
    if (!ctx) return;
    const s = session();
    if (!s) return;
    const msg = s.messages[ctx.index];
    if (!msg) return;
    const val = $v("#editText");
    exitSelect();

    if (msg.role === "user" && ctx.resend) {
      /* 追加一个新提问版本并重生成；旧提问、旧回答都留在版本里 */
      mutateMessages((msgs) => {
        const m = msgs[ctx.index];
        ensureVariants(m);
        m.variants.push(val);
        m.vi = m.variants.length - 1;
      });
      renderMessages();
      const next = s.messages[ctx.index + 1];
      const aiIdx = next && next.role === "assistant" ? ctx.index + 1 : undefined;
      const q = activeOf(session().messages[ctx.index]);
      runGeneration(s.id, { variantIndex: aiIdx, upto: ctx.index + 1, q });
      return;
    }

    if (msg.role === "user") {
      /* 修改消息：只改当前提问版本文字，不重发 */
      mutateMessages((msgs) => {
        const m = msgs[ctx.index];
        ensureVariants(m);
        m.variants[activeOf(m)] = val;
        m.content = val;
      });
    } else {
      /* 修改回答：只改当前回答版本文字 */
      mutateMessages((msgs) => {
        const m = msgs[ctx.index];
        ensureVariants(m);
        const vi = activeOf(m);
        m.variants[vi] = Object.assign({}, m.variants[vi], { content: val });
      });
    }
    const el = msgElAt(ctx.index);
    const c = el ? el.querySelector(".content") : null;
    if (c) {
      c.innerHTML = UI.renderMarkdown(val);
      /* 正常渲染路径会给「（…）」旁白染灰；这里是就地改 innerHTML，不补一次就会丢灰化，
         要等下次整列重建才恢复。 */
      try { UI.grayParens(c); } catch (e) { /* 灰化失败不影响正文 */ }
    }
    else renderMessages();
  }

  function copySelected() {
    if (!state.selected || !state.selected.size) return;
    const s = session();
    if (!s) return;
    const idx = Array.from(state.selected).sort((a, b) => a - b);
    let text = idx.map((i) => (s.messages[i] ? activeText(s.messages[i]) : "")).filter(Boolean).join("\n\n");
    /* 和单条复制同一口径：剪贴板里要可读的字，不要 [[s:xxx]] */
    try { if (Memory && Memory.emojiReadable) text = Memory.emojiReadable(text); } catch (e) { /* ignore */ }
    if (!text) { UI.toast("没有可复制的文字", true); return; }
    UI.copyText(text).then((ok) => UI.toast(ok ? "已复制 " + idx.length + " 条" : "复制失败", !ok));
  }

  async function searchMessage(i) {
    const s = session();
    if (!s) return;
    const msg = s.messages[i];
    if (!msg) return;
    const query = activeText(msg).trim();
    if (!query) { UI.toast("这条消息没有可搜索的文字", true); return; }
    if (state.busy) { UI.toast("正在生成，请稍后再试", true); return; }
    if (state.settings.searchProvider === "off") { UI.toast("请先在设置里开启联网搜索", true); return; }
    exitSelect();
    UI.toast("正在联网搜索…");
    setBusy(true, false);
    try {
      const out = await Search.search(query, state.settings);
      const results = out.results || [];
      const text = results.length
        ? "已用「" + query + "」联网搜索，来源：" + out.provider + "，共 " + results.length + " 条。"
        : "没有找到与「" + query + "」相关的结果。";
      mutateInsert(i + 1, { role: "assistant", content: text, sources: results });
      renderAll();
      UI.toast(results.length ? "搜索完成" : "没有结果", !results.length);
    } catch (e) {
      UI.toast("搜索失败：" + (e.message || e), true);
    } finally {
      setBusy(false);
    }
  }

  async function regenerateAt(i) {
    const s = session();
    if (!s) return;
    const msg = s.messages[i];
    if (!msg || msg.role !== "assistant") return;
    if (state.busy) { UI.toast("正在生成，请稍后再试", true); return; }
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    let j = -1;
    for (let k = i - 1; k >= 0; k--) { if (s.messages[k].role === "user") { j = k; break; } }
    if (j < 0) { UI.toast("找不到对应的提问", true); return; }
    const q = activeOf(s.messages[j]);
    exitSelect();
    /* 旧回答保留为历史版本，新回答追加进去 */
    mutateMessages((msgs) => { if (msgs[i]) ensureVariants(msgs[i]); });
    renderMessages();
    await runGeneration(s.id, { variantIndex: i, upto: i, q });
  }

  /* 切换某条消息的历史版本；提问与回答联动 */
  function stepVariant(i, delta) {
    const s = session();
    if (!s) return;
    const msg = s.messages[i];
    if (!msg) return;
    const vs = variantsOf(msg);
    if (vs.length < 2) return;
    const cur = activeOf(msg);
    const next = Math.min(vs.length - 1, Math.max(0, cur + delta));
    if (next === cur) return;
    mutateMessages((msgs) => {
      const m = msgs[i];
      m.vi = next;
      if (m.role === "user") {
        const ai = msgs[i + 1];
        if (ai && ai.role === "assistant") {
          const avs = variantsOf(ai);
          let best = 0;
          for (let k = 0; k < avs.length; k++) if ((avs[k].q || 0) === next) best = k;
          ai.vi = best;
        }
      } else {
        const u = msgs[i - 1];
        if (u && u.role === "user") {
          ensureVariants(u);
          u.vi = Math.min(vs[next].q || 0, u.variants.length - 1);
        }
      }
    });
    const box = $("#messages");
    const top = box ? box.scrollTop : 0;
    renderMessages();
    if (box) box.scrollTop = top;
  }

  function openDeleteDialog(indices) {
    const s = session();
    if (!s) return;
    exitSelect();
    const box = $("#deleteList");
    box.innerHTML = "";
    const marked = {};
    (indices || []).forEach((i) => { marked[i] = true; });
    s.messages.forEach((m, i) => {
      const item = document.createElement("label");
      item.className = "delete-item" + (marked[i] ? " on" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!marked[i];
      cb.addEventListener("change", () => item.classList.toggle("on", cb.checked));
      const role = document.createElement("span");
      role.className = "d-role";
      role.textContent = m.role === "user" ? "我" : "AI";
      const text = document.createElement("span");
      text.className = "d-text";
      const preview = (activeText(m) || (m.image ? "[图片]" : "") || "[空消息]").replace(/\s+/g, " ");
      text.textContent = preview.slice(0, 60);
      item.appendChild(cb);
      item.appendChild(role);
      item.appendChild(text);
      box.appendChild(item);
    });
    UI.closeModal("msgMenuModal");
    UI.openModal("deleteModal");
  }

  function confirmDelete() {
    const items = $("#deleteList").querySelectorAll(".delete-item");
    const del = {};
    let count = 0;
    items.forEach((el, idx) => {
      if (el.querySelector("input").checked) { del[idx] = true; count++; }
    });
    UI.closeModal("deleteModal");
    if (!count) { UI.toast("没有勾选任何消息"); return; }
    const gonePhone = [];   /* 被删的那些主聊天消息，有没有绑定手机消息 */
    mutateMessages((msgs) => {
      const kept = msgs.filter((m, idx) => {
        if (!del[idx]) return true;
        if (m && m.phoneMsgId) gonePhone.push(String(m.phoneMsgId));
        return false;
      });
      msgs.length = 0;
      kept.forEach((m) => msgs.push(m));
    });
    /* 两边是同一次对话的两面：主聊天这条删了，手机里那条也一起没（10-18 用户要求） */
    if (gonePhone.length) {
      const s = session();
      if (s && s.phone && Array.isArray(s.phone.msgs)) {
        s.phone.msgs = s.phone.msgs.filter((pm) => !pm || gonePhone.indexOf(String(pm.id || "")) < 0);
        Store.saveSessions(Store.getSessions());
      }
    }
    renderAll();
    UI.toast("已删除 " + count + " 条消息");
  }

  /* ── 长按 / 选择手势 ───────────────────────────── */
  function bindMessageGestures() {
    const box = $("#messages");
    let timer = null;
    let start = null;
    let fired = false;
    function clear() { if (timer) { clearTimeout(timer); timer = null; } start = null; fired = false; }

    box.addEventListener("touchstart", (e) => {
      clear();
      if (state.selecting) return;
      if (e.touches.length !== 1) return;
      const t = e.target;
      if (!t || !t.closest || t.closest("a, button")) return;
      const el = t.closest(".msg");
      if (!el || !el.__msg) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      timer = setTimeout(() => {
        timer = null;
        if (typeof el.__idx !== "number") return;
        fired = true;
        if (el.__msg.role === "assistant") enterSelect(el.__idx);
        else openMessageMenu(el.__idx);
      }, 480);   /* 与会话列表的长按阈值（ui.js 里的 480）统一，同一 App 不再两套手感 */
    }, { passive: true });

    box.addEventListener("touchmove", (e) => {
      if (!timer || !start) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (dx * dx + dy * dy > 100) clear();
    }, { passive: true });

    /* 长按后抬手，浏览器可能补发一个 click 把刚选中的消息反选掉；这里阻止掉 */
    box.addEventListener("touchend", (e) => {
      if (fired) e.preventDefault();
      clear();
    });
    box.addEventListener("touchcancel", clear);

    box.addEventListener("contextmenu", (e) => {
      if (state.selecting) return;
      const el = e.target.closest ? e.target.closest(".msg") : null;
      if (!el || !el.__msg) return;
      e.preventDefault();
      if (typeof el.__idx !== "number") return;
      if (el.__msg.role === "assistant") enterSelect(el.__idx);
      else openMessageMenu(el.__idx);
    });

    box.addEventListener("click", (e) => {
      if (state.selecting) {
        const el = e.target.closest ? e.target.closest(".msg") : null;
        if (el && typeof el.__idx === "number") {
          e.preventDefault();
          e.stopPropagation();
          toggleSelect(el.__idx);
        }
        return;
      }
      const wc = e.target.closest ? e.target.closest("[data-world-view]") : null;
      if (wc) {
        const wEl = wc.closest(".msg");
        if (wEl && typeof wEl.__idx === "number") { e.preventDefault(); openWorldView(wEl.__idx); }
        return;
      }
      const cbtn = e.target.closest ? e.target.closest('[data-act="cont"]') : null;
      if (cbtn) {
        e.preventDefault();
        const cEl = cbtn.closest(".msg");
        continueFrom(cEl && typeof cEl.__idx === "number" ? cEl.__idx : -1);
        return;
      }
      const vb = e.target.closest ? e.target.closest(".variant-btn") : null;
      if (vb) {
        const vEl = vb.closest(".msg");
        if (vEl && typeof vEl.__idx === "number") {
          e.preventDefault();
          stepVariant(vEl.__idx, Number(vb.getAttribute("data-vstep")) || 0);
        }
        return;
      }
      const btn = e.target.closest(".act-btn");
      if (!btn) return;
      const mEl = btn.closest(".msg");
      if (!mEl || typeof mEl.__idx !== "number") return;
      const act = btn.getAttribute("data-act");
      if (act === "read") toggleRead(btn);
      else handleMessageAction(act, mEl.__idx);
    });
  }

  /* ── 会话历史搜索 ──────────────────────────────── */
  const HIST_MODES = [
    { id: "time", name: "按时间" },
    { id: "content", name: "按内容" },
    { id: "both", name: "时间+内容" }
  ];

  function buildHistModes() {
    const box = $("#searchModeSwitch");
    box.innerHTML = "";
    HIST_MODES.forEach((m) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = m.id === state.histMode ? "on" : "";
      b.textContent = m.name;
      b.addEventListener("click", () => { state.histMode = m.id; buildHistModes(); syncHistFields(); });
      box.appendChild(b);
    });
  }

  function syncHistFields() {
    const m = state.histMode;
    setDisplay("#histKeywordField", m === "time" ? "none" : "");
    setDisplay("#histTimeField", m === "content" ? "none" : "");
  }

  function parseDateStart(v) {
    if (!v) return null;
    const d = new Date(v + "T00:00:00");
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  function parseDateEnd(v) {
    if (!v) return null;
    const d = new Date(v + "T23:59:59.999");
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  function formatTime(ts) {
    if (typeof ts !== "number") return "未知";
    const d = new Date(ts);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function snippetHtml(text, kw) {
    const raw = String(text || "").replace(/\s+/g, " ");
    let start = 0;
    if (kw) {
      const hit = raw.toLowerCase().indexOf(kw.toLowerCase());
      if (hit > 40) start = hit - 40;
    }
    let seg = raw.slice(start, start + 160);
    if (start > 0) seg = "…" + seg;
    if (start + 160 < raw.length) seg = seg + "…";
    if (!kw) return UI.escapeHtml(seg);
    const lower = seg.toLowerCase();
    const k = kw.toLowerCase();
    let out = "";
    let pos = 0;
    while (true) {
      const idx = lower.indexOf(k, pos);
      if (idx < 0) { out += UI.escapeHtml(seg.slice(pos)); break; }
      out += UI.escapeHtml(seg.slice(pos, idx)) + "<mark>" + UI.escapeHtml(seg.slice(idx, idx + kw.length)) + "</mark>";
      pos = idx + kw.length;
    }
    return out;
  }

  /* 搜索范围（10-20 用户要求）：主聊天 / 手机两个模块；再可选「全部 / 某个角色（全部线）/
     某条线 / 某个群」。角色卡过滤与时间、内容筛选保持原样。 */
  function fillHistScope() {
    const sel = $("#histScope");
    if (!sel) return;
    const module = ($v("#histModule") || "chat");
    const prev = sel.value || "all";
    const sess = Store.getSessions();
    const chs = Store.getCharacters();
    const rows = ['<option value="all">全部</option>'];
    const seenC = {};
    if (module === "chat") {
      sess.forEach((s) => {
        if (!s || s.isGroup || s.phoneOnly) return;
        const cid = s.characterId || "";
        if (!cid || seenC[cid]) return;
        seenC[cid] = 1;
        const c = chs.filter((x) => x && x.id === cid)[0];
        const nm = (c && ((c.fields && c.fields.aiName) || c.name)) || "角色";
        rows.push('<option value="char:' + cid + '">角色：' + UI.escapeHtml(nm) + "（全部线）</option>");
      });
      sess.forEach((s) => {
        if (!s) return;
        if (s.isGroup) rows.push('<option value="group:' + s.id + '">群聊：' + UI.escapeHtml(s.title || "群聊") + "</option>");
        else if (s.characterId) rows.push('<option value="line:' + s.id + '">线：' + UI.escapeHtml(s.title || "新对话") + "</option>");
      });
    } else {
      sess.forEach((s) => {
        if (!s || !(s.phone && s.phone.msgs && s.phone.msgs.length)) return;
        if (s.isGroup) rows.push('<option value="group:' + s.id + '">群：' + UI.escapeHtml(s.title || "群聊") + "</option>");
        else rows.push('<option value="line:' + s.id + '">联系人：' + UI.escapeHtml(s.title || "新对话") + "</option>");
      });
    }
    sel.innerHTML = rows.join("");
    const hit = Array.prototype.filter.call(sel.options, (o) => o.value === prev)[0];
    sel.value = hit ? prev : "all";
  }

  function matchHistScope(s, scope) {
    if (!scope || scope === "all") return true;
    if (scope.indexOf("char:") === 0) return (s.characterId || "") === scope.slice(5);
    if (scope.indexOf("line:") === 0) return s.id === scope.slice(5);
    if (scope.indexOf("group:") === 0) return !!s.isGroup && s.id === scope.slice(6);
    return true;
  }

  /* 手机消息 → 搜索用的文本（撤回 / 转账这些也照样能搜到） */
  function phoneTextOf(m) {
    try {
      if (window.DL && DL.phone && DL.phone.msgText) return DL.phone.msgText(m) || "";
    } catch (e) { /* 退回 text */ }
    return String((m && m.text) || "");
  }

  async function runHistorySearch() {
    const mode = state.histMode;
    const module = ($v("#histModule") || "chat");
    const scope = ($v("#histScope") || "all");
    const kw = $v("#histKeyword").trim();
    const from = parseDateStart($v("#histFrom"));
    const to = parseDateEnd($v("#histTo"));
    if ((mode === "content" || mode === "both") && !kw) { UI.toast("请输入关键词", true); return; }
    if ((mode === "time" || mode === "both") && from === null && to === null) { UI.toast("请选择时间范围", true); return; }

    const out = [];
    const kwLow = kw.toLowerCase();
    const sessions = Store.getSessions();
    const box = $("#histResults");
    if (box) box.innerHTML = '<div class="hist-empty">正在搜索…</div>';
    /* 分片扫描：原来是一次性同步遍历「所有会话的所有消息」，消息一多界面就卡住一下。
       现在每扫完 4 条会话就让出一次主线程（setTimeout 0），结果与原来完全一致，
       只是把长任务拆开跑。activeText(m) 也从「每条调两次」收敛成一次。 */
    for (let si = 0; si < sessions.length; si++) {
      const s = sessions[si];
      if (!s || !matchHistScope(s, scope)) continue;
      /* 模块（10-20）：主聊天看 messages，手机看 phone.msgs */
      const msgs = (module === "phone") ? ((s.phone && s.phone.msgs) || []) : (s.messages || []);
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const text = (module === "phone") ? phoneTextOf(m) : activeText(m);
        if (!text) continue;
        if (mode !== "content") {
          if (typeof m.ts !== "number") continue;
          if (from !== null && m.ts < from) continue;
          if (to !== null && m.ts > to) continue;
        }
        if ((mode === "content" || mode === "both") && text.toLowerCase().indexOf(kwLow) < 0) continue;
        out.push({ sessionId: s.id, title: s.title || "新对话", index: i, role: m.role, ts: m.ts, content: text, module: module });
      }
      if (si % 4 === 3) await new Promise(function (r) { setTimeout(r, 0); });
    }
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    renderHistResults(out, kw, mode);
  }

  function renderHistResults(items, kw, mode) {
    const box = $("#histResults");
    box.innerHTML = "";
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "hist-empty";
      e.textContent = "没有找到匹配的消息";
      box.appendChild(e);
      return;
    }
    items.slice(0, 100).forEach((it) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hist-item";
      const meta = document.createElement("div");
      meta.className = "hist-meta";
      const t = document.createElement("span");
      t.className = "h-title";
      t.textContent = it.title;
      const role = document.createElement("span");
      role.textContent = it.role === "user" ? "我" : "AI";
      const time = document.createElement("span");
      time.textContent = formatTime(it.ts);
      meta.appendChild(t);
      meta.appendChild(role);
      meta.appendChild(time);
      const snip = document.createElement("div");
      snip.className = "hist-snippet";
      snip.innerHTML = snippetHtml(it.content, mode === "time" ? "" : kw);
      btn.appendChild(meta);
      btn.appendChild(snip);
      btn.addEventListener("click", () => {
        UI.closeModal("searchModal");
        /* 手机的结果（10-20）：切到那条线再打开手机
           —— 10-20 修：原来点 #phoneBtn 只会停在联系人列表，这里直接进那条线的手机聊天 */
        if (it.module === "phone") {
          state.sessionId = it.sessionId;
          Store.setCurrentId(it.sessionId);
          renderAll();
          try {
            if (window.DL && DL.phone && DL.phone.openLine) { DL.phone.openLine(it.sessionId); return; }
          } catch (e) { /* 没有这个出口就退回列表页 */ }
          const pb = $("#phoneBtn");
          if (pb) pb.click();
          return;
        }
        jumpToMessage(it.sessionId, it.index);
      });
      box.appendChild(btn);
    });
  }

  function jumpToMessage(sessionId, index) {
    exitSelect();
    state.sessionId = sessionId;
    state.msgAnchor = index;
    Store.setCurrentId(sessionId);
    closeSidebar();
    const box = $("#messages");
    const prevBehavior = box ? box.style.scrollBehavior : "";
    if (box) box.style.scrollBehavior = "auto";
    renderAll();
    const el = msgElAt(index);
    if (el) {
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1500);
      if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
    }
    if (box) box.style.scrollBehavior = prevBehavior;
  }

  function openSearchModal() {
    exitSelect();
    buildHistModes();
    syncHistFields();
    fillHistScope();
    $("#histResults").innerHTML = "";
    UI.openModal("searchModal");
  }

  /* ── 快捷回复：AI 站在「我」的立场给出几条可回的话 ─────────────────
     面板与软键盘互斥（需求原文）：
       · 键盘在时点快捷回复 → 收键盘、弹面板（面板占住键盘原来的位置）
       · 面板在时点输入框   → 收面板、起键盘
     每批 4 条，一次打开最多换 5 批；每条左边的「修改」把它填进输入框并唤起键盘。 */
  var QUICK_MAX = 5;
  var QUICK_N = 4;
  var quick = { open: false, batch: 0, busy: false, items: [], sid: "" };

  function quickSysText(s) {
    const ch = characterFor(s);
    let sys = "";
    if (s && s.isGroup) sys = buildGroupSystemText(s);
    else if (ch) sys = Memory.buildSystemText(ch, s, state.settings);
    else sys = ((s && typeof s.systemPrompt === "string" && s.systemPrompt.trim()) || state.settings.systemPrompt || "");
    const fmt = ((s && typeof s.adoptFormat === "string" && s.adoptFormat.trim()) || (state.settings.adoptFormat || "")).trim();
    if (fmt) sys += "\n\n【采用格式】\n" + fmt;
    sys += "\n\n【现在的任务】换个身份：你是「我」（用户本人）的台词助手，不是角色。" +
      "请站在「我」的立场，写出 " + QUICK_N + " 条「我这时可以怎么回」的候选台词。硬性要求：" +
      "① 贴合「我」的设定，以及此刻关系的亲疏（别突然说越界的话，也别突然变得冷淡）；" +
      "② 必须接得住最后那条消息，前后逻辑与物理场景连贯（时间、地点、在场的人、手上的东西别对不上）；" +
      "③ 绝不 OOC、不替角色说话、不写旁白、不用括号动作、不用 Markdown、不自称 AI；" +
      "④ " + QUICK_N + " 条要有明显差异（态度、角度、情绪走向各不相同），不要只换几个词；" +
      "⑤ 口语、简短，一般一两句，长短也要拉开一点。\n" +
      "只输出 " + QUICK_N + " 行，每行以「- 」开头，不要编号、不要解释、不要任何其它文字。";
    return sys;
  }

  function quickContextText(s) {
    const covered = (s && s.memory && s.memory.coveredUntil) || 0;
    let t = "";
    const mt = Memory.memoryText ? Memory.memoryText(s && s.memory) : "";
    if (mt) t += "【记忆摘要】\n" + mt + "\n";
    const rt = Memory.recentTranscript ? Memory.recentTranscript((s && s.messages) || [], covered, 24, s) : "";
    if (rt) t += "\n【最近的对话】\n" + rt;
    return t || "（你们还没聊过什么）";
  }

  /* 一行一条；容忍「- 」「1. 」「1、」等前缀，空行与纯标点行丢掉 */
  function parseQuickLines(text) {
    const out = [];
    String(text || "").split(/\r?\n/).forEach((ln) => {
      let t = String(ln).trim();
      if (!t) return;
      t = t.replace(/^\s*[-*•]\s*/, "").replace(/^\s*\d+\s*[.、)）]\s*/, "").trim();
      if (!t) return;
      if (/^[（(【\[]/.test(t) && t.length <= 4) return;
      out.push(t);
    });
    return out.slice(0, QUICK_N);
  }

  function quickRender() {
    const box = $("#qpList");
    if (!box) return;
    box.innerHTML = "";
    if (quick.busy) {
      const d = document.createElement("div");
      d.className = "qp-hint";
      d.textContent = "正在想几条回复…";
      box.appendChild(d);
      setText("#qpCount", "");
      setDisabled("#qpRefresh", true);
      return;
    }
    if (!quick.items.length) {
      const d = document.createElement("div");
      d.className = "qp-hint";
      d.textContent = "没生成出内容，点「换一批」再试试。";
      box.appendChild(d);
    }
    quick.items.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "qp-item";
      const eb = document.createElement("button");
      eb.type = "button";
      eb.className = "qp-edit";
      eb.innerHTML = UI.iconSvg("pencil-outline");
      eb.setAttribute("aria-label", "改一下再发");
      eb.title = "改一下再发";
      eb.addEventListener("click", () => quickUse(i));
      const tx = document.createElement("div");
      tx.className = "qp-text";
      tx.textContent = t;
      tx.addEventListener("click", () => quickUse(i));   /* 点正文同样填进输入框（不自动发） */
      row.appendChild(eb);
      row.appendChild(tx);
      box.appendChild(row);
    });
    const left = Math.max(0, QUICK_MAX - quick.batch);
    setText("#qpCount", quick.batch ? ("已生成 " + quick.batch + " 批 · 还能换 " + left + " 次") : "");
    setDisabled("#qpRefresh", quick.batch >= QUICK_MAX);
  }

  async function quickGen() {
    if (quick.busy) return;
    /* 生成中不允许再开一批：本文件其它入口（resendAt / regenerateAt / searchMessage）
       都有这层守卫，这里以前漏了 —— 生成中点「换一批」会并发打第二次接口。 */
    if (state.busy) { UI.toast("正在生成中，等这轮结束再换一批", true); return; }
    const s = session();
    if (!s) { UI.toast("先打开一个对话", true); return; }
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    if (quick.batch >= QUICK_MAX) { UI.toast("这批已经换满 5 批了，先挑一条或关掉重开", true); return; }
    quick.busy = true;
    quick.items = [];
    quickRender();
    try {
      await ensureMemoryReady();
      if (!Api || typeof Api.summarize !== "function") throw new Error("接口模块 api.js 没有加载成功");
      const res = await Api.summarize(state.settings, [
        { role: "system", content: quickSysText(s) },
        { role: "user", content: quickContextText(s) }
      ], { maxTokens: 600 });
      if (res && res.usage && typeof recordUsage === "function") recordUsage(s.id, res.usage, s.characterId, "quickreply");
      quick.items = parseQuickLines((res && res.text) || "");
      if (quick.items.length) { quick.batch++; quick.sid = s.id; }
      else UI.toast("这次没生成出内容，再点一次「换一批」", true);
    } catch (e) {
      UI.toast("生成失败：" + (e && e.message ? e.message : e), true);
    } finally {
      quick.busy = false;
      quickRender();
    }
  }

  /* 这条线有没有记忆可用（日 / 周 / 月摘要任一非空）。
     用户口径：**没有记忆就不给点快捷回复** —— 它要站在「你们之间发生过什么」上
     才接得住话，空记忆生成出来的都是泛泛而谈的废话。 */
  function hasAnyMemory(s) {
    try {
      const m = (Memory && Memory.ensureMemory) ? Memory.ensureMemory(s) : (s && s.memory);
      if (!m) return false;
      return !!((m.days && m.days.length) || (m.weeks && m.weeks.length) || (m.months && m.months.length));
    } catch (e) { return false; }
  }

  function quickOpen() {
    const el = $("#quickPanel");
    if (!el) return;
    const s = session();
    if (!s) { UI.toast("先打开一个对话", true); return; }
    if (!hasAnyMemory(s)) { UI.toast("这条对话还没有记忆，聊几轮攒出记忆后再用", true); return; }
    /* 软键盘先收：面板要占它的位置，两个都在会把输入区挤没 */
    const inp = $("#input");
    if (inp && document.activeElement === inp) inp.blur();
    el.hidden = false;
    quick.open = true;
    const qb = $("#quickBtn"); if (qb) qb.classList.add("on");
    /* 换了会话就重新生成；同一会话再打开沿用上一批（省一次调用） */
    if (quick.sid !== s.id) { quick.batch = 0; quick.items = []; }
    if (!quick.items.length && !quick.busy) quickGen();
    else quickRender();
  }

  /* 按钮自身的置灰状态跟着会话走（切到没记忆的线就变灰，一眼看得出为什么点不动）。
     只改视觉，真正的拦截在 quickOpen 里 —— 那边有 toast 说明原因。 */
  function syncQuickBtn() {
    const qb = $("#quickBtn");
    if (!qb) return;
    const s = session();
    const ok = !!(s && hasAnyMemory(s));
    qb.classList.toggle("disabled", !ok);
    qb.setAttribute("aria-disabled", ok ? "false" : "true");
    qb.title = ok ? "快捷回复" : "这条对话还没有记忆";
  }

  function quickClose() {
    const el = $("#quickPanel");
    if (el) el.hidden = true;
    quick.open = false;
    const qb = $("#quickBtn"); if (qb) qb.classList.remove("on");
  }

  function quickUse(i) {
    const t = quick.items[i];
    if (!t) return;
    const inp = $("#input");
    if (!inp) return;
    quickClose();
    setVal("#input", t);
    autoResize();
    inp.focus();                                   /* 唤起软键盘 */
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* ignore */ }
  }

  function bindQuickReply() {
    const qb = $("#quickBtn");
    if (qb) {
      /* ⚠️ 这里**不能写成开关**（open ? close : open）。一旦这个绑定被跑了两遍
         （例如 app.js 的 bind() 被重复调用），一个点击会「先开、再立刻关」，
         表现为「按钮点了没反应」——极难查。就让它永远只做「打开」这一件事：
         收起有面板上的 ✕、点输入框、点某条回复这三条路，够了。 */
      qb.addEventListener("click", () => { quickOpen(); });
    }
    const rf = $("#qpRefresh");
    if (rf) rf.addEventListener("click", () => quickGen());
    const cl = $("#qpClose");
    if (cl) cl.addEventListener("click", () => quickClose());
    const inp = $("#input");
    /* 面板在时点输入框 → 收面板、把键盘叫回来（浏览器自己会 focus，这里只负责收面板） */
    if (inp) inp.addEventListener("focus", () => { if (quick.open) quickClose(); });
  }

  /* ── 继续说：接着最后一条角色消息往下讲 ──────────────────────────
     只挂在**最后一条**角色消息下面 —— 每条下面都挂一排按钮只会眼花。
     做法：把模型消息拼完后再补一句「继续说」的临时指令（不落库），
     所以真正发出去的上下文里没有这句，历史还是干净的。 */
  var CONTINUE_NUDGE = "（继续说：接着你刚才那条消息往下讲，别重复已经说过的内容，也别从头开始。"
    + "像真人接着往下发消息那样自然。）";
  /* 群聊里点某条消息的「继续说」= 指定那位角色发言（10-18 用户口径）。
     所以指令要明确「只由他一个人说」，并按「名字：内容」一行输出 —— 好让落库时剥前缀、
     直接挂到他名下，不再走「让 AI 自己决定谁说话」那条路。 */
  function continueNudgeOne(name) {
    return "（继续说：接着「" + name + "」刚才那条话往下说。这一次**只由「" + name + "」一个人**发言，"
      + "按「" + name + "：内容」一行的格式输出，别让别人插话，也别重复已经说过的内容。）";
  }
  /* 模型按「名字：内容」输出时把开头那截名字剥掉 —— 名字已经存在 speakerName 里了 */
  function stripSpeakerPrefix(text, name) {
    const n = String(name || "").trim();
    if (!n) return String(text || "");
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try { return String(text || "").replace(new RegExp("^\\s*" + esc + "\\s*[：:]\\s*"), ""); }
    catch (e) { return String(text || ""); }
  }

  function syncContinueRow() {
    const box = $("#messages");
    if (!box) return;
    const olds = box.querySelectorAll('[data-act="cont"]');
    for (let k = 0; k < olds.length; k++) olds[k].remove();
    const s = session();
    if (!s || state.busy) return;
    const msgs = s.messages || [];
    if (!msgs.length) return;
    const usable = (i) => {
      const m = msgs[i];
      return !!(m && m.role === "assistant" && !m.error && !m.world && String(activeText(m) || "").trim());
    };
    /* 群聊：每一条角色消息都挂（点谁就是让谁说）；
       单聊只有一个角色，「从这里继续说」和「继续说」是一回事，仍旧只挂最后一条。 */
    const targets = [];
    if (s.isGroup) {
      for (let i = 0; i < msgs.length; i++) if (usable(i)) targets.push(i);
    } else if (usable(msgs.length - 1)) {
      targets.push(msgs.length - 1);
    }
    targets.forEach((i) => {
      const el = msgElAt(i);
      const bar = el ? el.querySelector(".msg-actions") : null;
      if (!bar) return;
      const btn = UI.actionBtn("cont", "message-plus-outline", "继续说", "act-btn cont-act");
      bar.appendChild(btn);
    });
  }

  /* 开场白：空对话时让 AI 先说第一句。
     openingDone 一旦置真就永久失效（用户口径：生成完直接隐藏，不再出现）。
     复用「继续说」那条生成链路；点下去先置失效，避免连点重复生成。 */
  /* 我发过消息没有 —— 开场白的唯一消失条件（用户 10-19 口径）。 */
  function hasMyMessage(s) {
    return !!(s && (s.messages || []).some(function (m) { return m && m.role === "user"; }));
  }
  async function startOpening(sid) {
    syncModules();
    const s = sid ? sessionById(sid) : session();
    if (!s || state.busy) return false;
    if (hasMyMessage(s)) return false;
    /* 必须填了「当前场景」才能用（用户口径）。纯手机角色本来就没有线下场景，放行。 */
    if (!s.phoneOnly && !String(s.scene || "").trim()) {
      UI.toast("先在「对话设置 → 当前场景」里写一句现在的场景，再生成开场", true);
      /* 顺手把「对话设置」那个菜单点开，少一步找 */
      try { var b = $("#sessionBtn"); if (b) b.click(); } catch (e) { /* ignore */ }
      return false;
    }
    try { continueLast(); } catch (e) { /* ignore */ }
    return true;
  }
  /* 按钮显隐：有消息 / 已生成过 / 正在生成 → 藏起来 */
  function syncOpeningBtn() {
    const s = session();
    const btn = $("#openingBtn");
    if (btn) {
      if (!btn.dataset.bound) {
        btn.dataset.bound = "1";
        btn.addEventListener("click", function () { startOpening(); });
      }
      const show = !!(s && !hasMyMessage(s) && !state.busy);
      /* 已经有过 AI 的开场 → 换成「再说一次」（可反复重掷；我开口之后整块消失） */
      const said = !!(s && (s.messages || []).some(function (m) { return m && m.role === "assistant"; }));
      const label = btn.querySelector("span:last-child");
      if (label) label.textContent = said ? "再说一次" : "生成第一句话";
      btn.hidden = !show;
    }
    /* 手机页那个按钮由它自己的渲染流程同步（phone.js 的 renderChat 里调）——
       这里【不要】反手去调 DL.syncPhoneOpening：那条链路会 syncModules + 重渲染，
       在 renderMessages 里调用会绕回去，实测会把回归测试挂死。 */
  }

  /* ── 表情面板（10-19）──────────────────────────────────────────
     两栏：常规 = 内置 Fluent（点一下插进输入框）；
           自添加 = 自己传的图片表情包，带三档使用范围（都能用 / TA 用 / 自己用）。
     范围只属于图片表情包 —— 内置那套谁都能用，不需要分。
     自添加的图存在 settings.stickers：[{ id, src, name, means, scope }]，
     name / means 是上传时让 AI 看一遍写出来的，模型之后靠这两个字段认它。 */
  var emojiTab = "builtin";     /* builtin | custom */
  var emojiScope = "both";      /* 自添加区当前范围页签 */
  var stickerEditId = "";       /* 长按后待改范围的那个（空 = 不在编辑态） */

  function emojiPack() { return (window.CONFIG && CONFIG.EMOJI_PACK) || []; }
  function stickerList() { return (state.settings && state.settings.stickers) || []; }
  function saveStickers(list) {
    state.settings = Store.saveSettings({ stickers: list });
  }

  function renderBuiltinGrid() {
    var grid = $("#emojiGrid");
    if (!grid) return;
    grid.innerHTML = "";
    emojiPack().forEach(function (it) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "emoji-cell";
      b.title = it.n || "";
      if (it.src) {
        var im = document.createElement("img");
        im.src = it.src;
        im.alt = it.n || "";
        b.appendChild(im);
      } else {
        var sp = document.createElement("span");
        sp.className = "emoji-char";
        sp.textContent = it.e || "";
        b.appendChild(sp);
      }
      b.addEventListener("click", function () { insertAtCursor(it.e || ""); });
      grid.appendChild(b);
    });
  }

  function renderStickerGrid() {
    var grid = $("#stickerGrid");
    if (!grid) return;
    grid.innerHTML = "";
    var list = stickerList().filter(function (st) { return (st.scope || "both") === emojiScope; });
    if (!list.length) {
      var tip = document.createElement("div");
      tip.className = "emoji-empty";
      tip.textContent = "这个范围里还没有表情。点右上角「+」加一批，长按可改范围。";
      grid.appendChild(tip);
    }
    list.forEach(function (st) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "emoji-cell sticker-cell";
      b.title = st.name || "表情";
      var im = document.createElement("img");
      im.src = stickerSrc(st.src);
      im.alt = st.name || "";
      b.appendChild(im);
      var timer = null;
      b.addEventListener("pointerdown", function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          stickerEditId = st.id;
          var tipEl = document.querySelector("#emojiCustomPane .emoji-tip");
          if (tipEl) tipEl.textContent = "要给「" + (st.name || "这个") + "」设成谁用？点上面任一范围";
        }, 500);
      });
      ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
        b.addEventListener(ev, function () { clearTimeout(timer); });
      });
      b.addEventListener("click", function () {
        if (stickerEditId) {
          var next = stickerList().map(function (x) {
            return x.id === stickerEditId ? Object.assign({}, x, { scope: emojiScope }) : x;
          });
          saveStickers(next);
          stickerEditId = "";
          var tipEl = document.querySelector("#emojiCustomPane .emoji-tip");
          if (tipEl) tipEl.textContent = "长按可改范围；范围在选图页也能先定好";
          UI.toast("已改为「" + scopeLabel(emojiScope) + "」");
          renderStickerGrid();
          return;
        }
        insertAtCursor("[[s:" + st.id + "]]");
      });
      grid.appendChild(b);
    });
  }
  function scopeLabel(v) { return v === "ai" ? "TA 用" : v === "me" ? "自己用" : "都能用"; }

  /* 面板挂在哪个 composer 上，就往哪个输入框里插（10-19 修）。
     原来写死 $("#input")：表情面板搬到手机页之后，点的字符全进了主聊天那个隐藏的 textarea，
     手机输入框 #phoneInput 一个字符都不多 —— 表现就是「点了没反应」，切回主聊天还看到一堆表情。 */
  function emojiTargetInput() {
    var panel = $("#emojiPanel");
    var box = panel && panel.closest ? panel.closest(".phone-composer") : null;
    if (box) {
      var pi = box.querySelector("#phoneInput, input.phone-input, textarea");
      if (pi) return pi;
    }
    return $("#input");
  }
  /* 插到输入框光标处（没光标就接在末尾），并触发 input 让高度自适应 */
  function insertAtCursor(text) {
    var inp = emojiTargetInput();
    if (!inp) return;
    var v = String(inp.value || "");
    var at = typeof inp.selectionStart === "number" ? inp.selectionStart : v.length;
    inp.value = v.slice(0, at) + text + v.slice(inp.selectionEnd == null ? at : inp.selectionEnd);
    try { inp.selectionStart = inp.selectionEnd = at + text.length; } catch (e) { /* ignore */ }
    try { inp.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) { /* ignore */ }
    /* 手机页别抢焦点：一 focus 就弹软键盘，会把刚打开的表情面板顶掉。
       用户想继续打字时自己点输入框即可。 */
    if (inp.id !== "phoneInput") { try { inp.focus(); } catch (e) { /* ignore */ } }
  }

  function showEmojiTab(tab) {
    emojiTab = tab === "custom" ? "custom" : "builtin";
    /* 切页签就退出「长按改范围」态：否则长按了 A、切到别的范围页签再点 B，改的是 A */
    stickerEditId = "";
    var tabs = document.querySelectorAll(".emoji-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("on", tabs[i].getAttribute("data-tab") === emojiTab);
    }
    var bp = $("#emojiBuiltinPane"), cp = $("#emojiCustomPane");
    if (bp) bp.hidden = emojiTab !== "builtin";
    if (cp) cp.hidden = emojiTab !== "custom";
    if (emojiTab === "builtin") renderBuiltinGrid(); else renderStickerGrid();
  }

  function openEmojiPanel() {
    var p = $("#emojiPanel");
    if (!p) return;
    p.hidden = false;
    var btn = $("#emojiBtn");
    if (btn) btn.classList.add("on");
    showEmojiTab(emojiTab);
  }
  function closeEmojiPanel() {
    var p = $("#emojiPanel");
    if (p) p.hidden = true;
    var btn = $("#emojiBtn");
    if (btn) btn.classList.remove("on");
    stickerEditId = "";
  }
  function toggleEmojiPanel() {
    var p = $("#emojiPanel");
    if (!p) return;
    if (p.hidden) openEmojiPanel(); else closeEmojiPanel();
  }

  /* 选图 → 逐个压缩 → 让 AI 看一眼写名字/意思 → 入列。
     没配视觉模型也要能用：AI 不可用时用文件名当名字，意思先留空。 */
  /* ── 自研选图面板 ───────────────────────────────────────────────
     系统选择器只负责把文件交过来；挑哪几张、归哪个范围，都在这一层做。 */
  var siPending = [];   /* [{ src, on }] */
  var siScope = "both";

  /* 读一张表情图（10-19 修）：**不**复用 app.js 的 readAvatarFile。
     原因有两条：
       1. 那是 app.js 那个立即执行函数的私有件，chat.js 里裸名取不到（会 ReferenceError，
          表现是选完图永远提示「这些图读不出来」）；
       2. 它把头像是按正方形 cover 裁的，长条表情会被切掉两头 —— 表情要用 contain。
     输出：最大边 192、保持长宽比、透明底、PNG。 */
  function readStickerFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || "")) { reject(new Error("请选择图片文件")); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var raw = String(fr.result || "");
        var img = new Image();
        img.onload = function () {
          try {
            var box = 192;
            var w = img.width || box, h = img.height || box;
            var sc = Math.min(box / w, box / h, 1);
            var cw = Math.max(1, Math.round(w * sc));
            var chh = Math.max(1, Math.round(h * sc));
            var cv = document.createElement("canvas");
            cv.width = cw;
            cv.height = chh;
            var ctx = cv.getContext("2d");
            ctx.clearRect(0, 0, cw, chh);
            ctx.drawImage(img, 0, 0, cw, chh);
            resolve(cv.toDataURL("image/png"));
          } catch (e) { resolve(raw); }
        };
        img.onerror = function () { reject(new Error("图片读取失败")); };
        img.src = raw;
      };
      fr.onerror = function () { reject(new Error("图片读取失败")); };
      fr.readAsDataURL(file);
    });
  }

  /* 贴纸图尽量外置（10-19）：和背景、头像同一套底线 —— 有桥才落文件，写不成仍留 dataURL。
     不这么做的话，十来张贴纸就能把 settings 顶到 localStorage 配额，
     而 saveSettings 每次都整坨重写。 */
  function hoistSticker(val) {
    var v = String(val || "");
    if (v.slice(0, 5) !== "data:") return v;
    try {
      if (!Store.hasBridge || !Store.hasBridge("保存指定文件")) return v;
      return (Store.saveBgImage ? (Store.saveBgImage(v) || "") : "") || v;
    } catch (e) { return v; }
  }
  /* 存的是路径就换成能直接用的 URL；dataURL 原样返回 */
  function stickerSrc(val) {
    var v = String(val || "");
    if (!v || v.slice(0, 5) === "data:") return v;
    try { return (D.avatarUrl && D.avatarUrl(v)) || ""; } catch (e) { return ""; }
  }

  async function openStickerImport(files) {
    syncModules();
    var arr = Array.prototype.slice.call(files || []);
    if (!arr.length) return;
    siPending = [];
    for (var i = 0; i < arr.length; i++) {
      try {
        var src = await readStickerFile(arr[i]);
        if (src) siPending.push({ src: src, on: true });
      } catch (e) { /* 单张失败跳过 */ }
    }
    if (!siPending.length) { UI.toast("这些图读不出来，换几张试试", true); return; }
    siScope = emojiScope;
    var sheet = $("#stickerImport");
    if (!sheet) return;
    sheet.hidden = false;
    var scopes = sheet.querySelectorAll(".si-scope");
    for (var k = 0; k < scopes.length; k++) {
      scopes[k].classList.toggle("on", scopes[k].getAttribute("data-scope") === siScope);
    }
    renderSiGrid();
  }

  function closeStickerImport() {
    var sheet = $("#stickerImport");
    if (sheet) sheet.hidden = true;
    siPending = [];
  }

  function renderSiGrid() {
    var grid = $("#siGrid");
    if (!grid) return;
    grid.innerHTML = "";
    siPending.forEach(function (item, idx) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "si-cell" + (item.on ? " on" : "");
      var im = document.createElement("img");
      im.src = item.src;
      im.alt = "";
      b.appendChild(im);
      if (item.on) {
        var tick = document.createElement("span");
        tick.className = "si-tick";
        tick.textContent = "✓";
        b.appendChild(tick);
      }
      b.addEventListener("click", function () {
        siPending[idx].on = !siPending[idx].on;
        renderSiGrid();
      });
      grid.appendChild(b);
    });
    var cnt = $("#siCount");
    if (cnt) cnt.textContent = "已选 " + siPending.filter(function (x) { return x.on; }).length + " / " + siPending.length;
  }

  function bindStickerImport() {
    var sheet = $("#stickerImport");
    if (!sheet || sheet.dataset.bound) return;
    sheet.dataset.bound = "1";
    var mask = sheet.querySelector(".si-mask");
    if (mask) mask.addEventListener("click", closeStickerImport);
    var cancel = $("#siCancel");
    if (cancel) cancel.addEventListener("click", closeStickerImport);
    var scopes = sheet.querySelectorAll(".si-scope");
    for (var i = 0; i < scopes.length; i++) {
      (function (el) {
        el.addEventListener("click", function () {
          siScope = el.getAttribute("data-scope") || "both";
          for (var j = 0; j < scopes.length; j++) scopes[j].classList.toggle("on", scopes[j] === el);
        });
      })(scopes[i]);
    }
    var okBtn = $("#siOk");
    if (okBtn) okBtn.addEventListener("click", function () {
      var picked = siPending.filter(function (x) { return x.on; }).map(function (x) { return x.src; });
      closeStickerImport();
      if (picked.length) commitStickers(picked, siScope);
    });
  }

  /* 真正落库：逐张让视觉模型看一眼写名字/意思（没配就退化成「表情N」），再入列。
     10-19 修四处：
       1. Api.describe 返回 { text, usage }，直接 String() 会得到 "[object Obje" 当名字；
       2. 这里漏了用量记账（口径是「除对话外一切 AI 消耗都计入」）；
       3. 图先外置成文件，别把 settings 顶到配额；
       4. 一次导入只写一次盘（原来每张都全量写一遍）。 */
  async function commitStickers(srcs, scope) {
    syncModules();
    var list = stickerList().slice();
    var added = 0;
    var canSee = !!(Api && Api.describe && Media && Media.capable && Media.capable("vision", state.settings));
    for (var i = 0; i < srcs.length; i++) {
      var raw = srcs[i];
      var name = "表情" + (list.length + 1);
      var means = "";
      if (canSee) {
        var out = null;
        try { out = await Api.describe(state.settings, raw, 120); } catch (e) { out = null; }
        means = String((out && out.text) || "").trim();
        if (out && out.usage && typeof recordUsage === "function") recordUsage(null, out.usage, "", "sticker");
        var head = means.split(/[。！？\n]/)[0];
        if (head) name = head.slice(0, 12);
      }
      /* 名字撞了就加序号：模型只认名字，两张同名等于只有一张能用 */
      var nm = name, k = 2;
      while (list.some(function (x) { return x && x.name === nm; })) { nm = name + k; k++; }
      list.push({
        id: "st" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        src: hoistSticker(raw), name: nm, means: means, scope: scope
      });
      added++;
    }
    if (added) {
      saveStickers(list);
      UI.toast("已添加 " + added + " 个表情（" + scopeLabel(scope) + "）");
      renderStickerGrid();
    } else {
      UI.toast("没加成功，换张图试试", true);
    }
  }


  function bindEmojiPanel() {
    bindStickerImport();
    /* 点面板与按钮之外就收起（10-19）：原来只能再点一次笑脸才关，手机上手感很别扭 */
    if (!document.__dlEmojiOutside) {
      document.__dlEmojiOutside = true;
      document.addEventListener("click", function (e) {
        var p = $("#emojiPanel");
        if (!p || p.hidden) return;
        var t = e.target;
        if (t && t.closest && (t.closest("#emojiPanel") || t.closest("#emojiBtn"))) return;
        closeEmojiPanel();
      }, true);
    }
    var btn = $("#emojiBtn");
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", function (e) { e.preventDefault(); toggleEmojiPanel(); });
    }
    var tabs = document.querySelectorAll(".emoji-tab");
    for (var i = 0; i < tabs.length; i++) {
      (function (el) {
        if (el.dataset.bound) return;
        el.dataset.bound = "1";
        el.addEventListener("click", function () { showEmojiTab(el.getAttribute("data-tab")); });
      })(tabs[i]);
    }
    var scopes = document.querySelectorAll(".emoji-scope");
    for (var j = 0; j < scopes.length; j++) {
      (function (el) {
        if (el.dataset.bound) return;
        el.dataset.bound = "1";
        el.addEventListener("click", function () {
          emojiScope = el.getAttribute("data-scope") || "both";
          for (var k = 0; k < scopes.length; k++) scopes[k].classList.toggle("on", scopes[k] === el);
          renderStickerGrid();
        });
      })(scopes[j]);
    }
    var add = $("#stickerAddBtn"), inp = $("#stickerInput");
    if (add && inp && !add.dataset.bound) {
      add.dataset.bound = "1";
      add.addEventListener("click", function () { inp.click(); });
      inp.addEventListener("change", function (e) {
        var fs2 = e.target.files;
        e.target.value = "";
        openStickerImport(fs2);
      });
    }
  }

  function continueLast() {
    const s = session();
    if (!s || state.busy) return;
    runGeneration(s.id, { cont: true });
  }

  /* 从第 idx 条继续。群聊 = 指定该条说话人接着发；单聊退化成 continueLast。 */
  function continueFrom(idx) {
    const s = session();
    if (!s || state.busy) return;
    const msgs = s.messages || [];
    const m = (typeof idx === "number" && idx >= 0 && idx < msgs.length) ? msgs[idx] : null;
    if (!m || m.role !== "assistant") { continueLast(); return; }
    const who = s.isGroup && m.speakerName ? { id: m.speaker || "", name: m.speakerName } : null;
    runGeneration(s.id, { cont: true, forceSpeaker: who });
  }

  /* ── 剧情卡：点开铺满全屏看全文 ──────────────────────────────────
     详细版就是**灌给 AI 的那一份**，一个字都不截。
     左上角返回键退出；同一条再点开能接着上次读到的地方。 */
  var worldViewKey = "";
  var worldViewScroll = {};      /* { 这条剧情的 ts: 滚动位置 } —— 用 ts 做键，删消息后也不会串位 */

  function openWorldView(i) {
    const s = session();
    const m = s && (s.messages || [])[i];
    const box = $("#worldView");
    const body = $("#worldViewBody");
    if (!m || !box || !body) return;
    const t = String(activeText(m) || "").trim();
    if (!t) { UI.toast("这条没有可看的正文", true); return; }
    worldViewKey = String(m.ts || i);
    body.textContent = t;
    box.classList.add("show");
    /* 恢复上次读到的地方（首帧布局还没稳定，推到下一帧再设） */
    const keep = worldViewScroll[worldViewKey] || 0;
    body.scrollTop = keep;
    setTimeout(() => { try { body.scrollTop = keep; } catch (e) { /* ignore */ } }, 0);
  }

  function closeWorldView() {
    const box = $("#worldView");
    const body = $("#worldViewBody");
    if (body && worldViewKey) worldViewScroll[worldViewKey] = body.scrollTop;
    if (box) box.classList.remove("show");
    worldViewKey = "";
  }

  function bindWorldView() {
    const back = $("#worldViewBack");
    if (back) back.addEventListener("click", closeWorldView);
    /* ESC 只方便电脑上预览用；真机走左上角那个返回键 */
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const box = $("#worldView");
      if (box && box.classList.contains("show")) closeWorldView();
    });
  }

  /* ── 输入框 ────────────────────────────────────── */
  function autoResize() {
    const el = $("#input");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 132) + "px";
  }

  /* ── 自注册：把 app.js（及 camera.js 等其它模块）仍要调用的入口挂回 window.DL ──
     app.js 里这些名字已改成转发函数（见 app.js「转发到 chat.js」段），
     camera.js 则直接从 D 解构 send / renderAttachments / syncPlaceholder（见其文件头）。
     所以这几个必须挂上，缺一个就是运行时 undefined。 */
  Object.assign(D, {
    send: send, stop: stop, addFiles: addFiles, autoResize: autoResize,
    toggleMic: toggleMic, doTranscribe: doTranscribe, stopRead: stopRead,
    renderMessages: renderMessages, sweepImageExpiry: sweepImageExpiry,
    syncPlaceholder: syncPlaceholder, renderAttachments: renderAttachments,
    describePendingImages: describePendingImages,
    exitSelect: exitSelect, saveEdit: saveEdit, copySelected: copySelected,
    openDeleteDialog: openDeleteDialog, confirmDelete: confirmDelete,
    bindMessageGestures: bindMessageGestures,
    runHistorySearch: runHistorySearch, openSearchModal: openSearchModal, fillHistScope: fillHistScope,
    rollbackTo: rollbackTo,
    activeText: activeText, buildGroupSystemText: buildGroupSystemText,
    /* 本轮新增：快捷回复面板 + 继续说（continueFrom = 群聊里指定谁接着说） */
    bindQuickReply: bindQuickReply, continueLast: continueLast, continueFrom: continueFrom,
    syncContinueRow: syncContinueRow, syncRegenRow: syncRegenRow,
    /* 群聊：对彼此的认知 + 同步到各自线（对话设置里那两个按钮用） */
    peerCogOf: peerCogOf, peerCogText: peerCogText, peerCogOn: peerCogOn,
    updatePeerCog: updatePeerCog, syncGroupToLines: syncGroupToLines, lineOfMember: lineOfMember,
    groupMembers: groupMembers,
    openWorldView: openWorldView, closeWorldView: closeWorldView, bindWorldView: bindWorldView,
    startOpening: startOpening, syncOpeningBtn: syncOpeningBtn, bindEmojiPanel: bindEmojiPanel
  });

  (window.__dlScripts = window.__dlScripts || []).push("chat.js");
  return true;
  }

  /* 正常情况（app.js 先执行）这里第一次就成功。
     app.js 还没到位时（打包顺序不同）等 DOM 就绪 + 再补拍几次。 */
  if (!boot()) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    let tries = 0;
    const retry = () => { if (boot()) return; if (++tries < 20) setTimeout(retry, 150); };
    setTimeout(retry, 150);
  }
})();
