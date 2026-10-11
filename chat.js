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
  function boot() {
  var D = window.DL;
  if (!D) return false;   /* 尚未就绪，由文件末尾安排重试 */

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
  var maybeAutoWash, maybeAutoBackup, maybeAutoScene, recordUsage;
  function syncModules() {
    UI = D.UI || window.UI; Store = D.Store || window.Store; Memory = D.Memory || window.Memory;
    Api = D.Api || window.Api; Files = D.Files || window.Files; Media = D.Media || window.Media;
    Search = D.Search || window.Search;
    maybeAutoWash = D.maybeAutoWash || window.maybeAutoWash;
    maybeAutoBackup = D.maybeAutoBackup || window.maybeAutoBackup;
    maybeAutoScene = D.maybeAutoScene || window.maybeAutoScene;
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
      if (m.image) { delete m.image; changed = true; }
      if (m.attachments && m.attachments.length) {
        /* 图片可能是内联 dataUrl，也可能是文件引用（imgRef）——两种都要清，
           外置的那种还要把文件删掉（同一张图别处还在用时会自动保留，见 Store.dropImage） */
        m.attachments.forEach((a) => { if (Store.hasImage(a)) { Store.dropImage(a); changed = true; } });
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
          if (out.usage) recordUsage(null, out.usage, (snap.characterId || ""));
          mutateSession(sid, (msgs) => {
            const mm = msgs[job.i];
            if (!mm) return;
            if (job.img) mm.imageDesc = out.text.trim();
            else if (mm.attachments && mm.attachments[job.j]) mm.attachments[job.j].desc = out.text.trim();
          });
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

  function renderMessages() {
    syncModules();
    const box = $("#messages");
    box.innerHTML = "";
    const s = session();
    if (!s) { state.msgWin = null; return; }
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
    UI.scrollToBottom();
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
      const url = await Media.speak(t, state.settings);
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
    return content ? content.innerText.trim() : "";
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
    appendMessage(sid, userMsg, s.messages.some((m) => m.role === "user") ? "" : prompt.slice(0, 20));
    setVal("#input", "");
    autoResize();
    $("#messages").appendChild(UI.msgEl(userMsg, s));

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
      else if (holder.parentNode) holder.replaceWith(UI.msgEl(msg, s));
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

  async function buildModelMessages(s, upto) {
    const msgs = [];
    if (s && sweepImageExpiry(s)) Store.saveSessions(Store.getSessions());
    const ch = characterFor(s);
    let coveredUntil = 0;
    let systemText = "";
    let washedFrom = 0, washedUntil = 0, washedTurns = null;
    if (ch) {
      /* 角色扮演：角色卡 + 我的设定 + 关系/场景/认知/记忆（都按当前会话） */
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
        const mt = Memory.memoryText(s && s.memory);
        if (mt) systemText += "\n\n【记忆摘要】\n" + mt;
        coveredUntil = (s && s.memory && s.memory.coveredUntil) || 0;
      }
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
        if (c) msgs.push({ role: "assistant", content: c });
      }
    }
    return msgs;
  }

  /* 「只出了思考、没出正文」时补问一次的纠正语。只加在**请求里**，不写进会话记录。 */
  const EMPTY_NUDGE = "（上一轮你只输出了思考过程，没有输出回答正文。请直接给出回答正文。）";

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
          msgs.push({ role: "assistant", ts: Date.now(), variants: [variant], vi: 0 });
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
      if (finish === "length") fin.truncated = true;
      const el = commit(fin, null);
      if (result && result.usage && typeof recordUsage === "function") recordUsage(sid, result.usage, snap.characterId);
      const cs = sessionById(sid);
      if (cs) {
        const cx = cs.characterId ? Store.getCharacters().find((x) => x.id === cs.characterId) : null;
        /* 这三个在 roleplay.js / settings.js 里注册，脚本顺序不保证 —— 没就绪就跳过，
           别让「生成完顺手做的事」把整条回答拖进 catch。 */
        if (cx && typeof maybeAutoWash === "function") maybeAutoWash(cs, cx);
        if (cx && typeof maybeAutoScene === "function") maybeAutoScene(cs, cx);
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

    if (!state.settings.apiKey) {
      UI.toast("请先在「设置」里填写 API Key", true);
      UI.openModal("settingsModal");
      return;
    }

    let s = session();
    if (!s) { newSession(); s = session(); }
    const sid = s.id;

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
    const title = s.messages.some((m) => m.role === "user")
      ? ""
      : (text || (userMsg.attachments[0] && userMsg.attachments[0].name) || "新对话").slice(0, 20);
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
      view = { role: "assistant", content: v.content, reasoning: v.reasoning, sources: v.sources, error: v.error, trunc: v.trunc, image: m.image, imageDesc: m.imageDesc };
    }
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
    UI.copyText(text).then((ok) => UI.toast(ok ? "已复制" : "复制失败", !ok));
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
  function handleMessageAction(action, i) {
    const s = session();
    if (!s) return;
    const msg = s.messages[i];
    if (!msg) return;
    if (action === "copy") { copyMsgText(msg); return; }
    if (action === "edit") { openEdit(i); return; }
    if (action === "resend") { resendAt(i); return; }
    if (action === "search") { searchMessage(i); return; }
    if (action === "regen") { regenerateAt(i); return; }
    if (action === "delete") { openDeleteDialog([i]); return; }
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
    if (c) c.innerHTML = UI.renderMarkdown(val);
    else renderMessages();
  }

  function copySelected() {
    if (!state.selected || !state.selected.size) return;
    const s = session();
    if (!s) return;
    const idx = Array.from(state.selected).sort((a, b) => a - b);
    const text = idx.map((i) => (s.messages[i] ? activeText(s.messages[i]) : "")).filter(Boolean).join("\n\n");
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
    mutateMessages((msgs) => {
      const kept = msgs.filter((m, idx) => !del[idx]);
      msgs.length = 0;
      kept.forEach((m) => msgs.push(m));
    });
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
      }, 500);
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

  function runHistorySearch() {
    const mode = state.histMode;
    const kw = $v("#histKeyword").trim();
    const from = parseDateStart($v("#histFrom"));
    const to = parseDateEnd($v("#histTo"));
    if ((mode === "content" || mode === "both") && !kw) { UI.toast("请输入关键词", true); return; }
    if ((mode === "time" || mode === "both") && from === null && to === null) { UI.toast("请选择时间范围", true); return; }

    const out = [];
    Store.getSessions().forEach((s) => {
      s.messages.forEach((m, i) => {
        if (!activeText(m)) return;
        if (mode !== "content") {
          if (typeof m.ts !== "number") return;
          if (from !== null && m.ts < from) return;
          if (to !== null && m.ts > to) return;
        }
        if ((mode === "content" || mode === "both") && activeText(m).toLowerCase().indexOf(kw.toLowerCase()) < 0) return;
        out.push({ sessionId: s.id, title: s.title || "新对话", index: i, role: m.role, ts: m.ts, content: activeText(m) });
      });
    });
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
    $("#histResults").innerHTML = "";
    UI.openModal("searchModal");
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
    runHistorySearch: runHistorySearch, openSearchModal: openSearchModal
  });

  window.__dlScripts.push("chat.js");
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
