/* phone.js —— 手机（类微信）：和角色用手机聊天 / 转账 / 位置 / 图片 / 语音 / 伪电话
 *
 * 为什么这么写：
 *  - 本文件在 index.html 里排在 app.js 之后 —— 执行时 window.DL 一定已存在。
 *  - 手机对话单独存 session.phone.msgs，【不混进主消息列表】：主聊天里大量按
 *    下标定位的操作（多选删除 / 编辑 / 重新生成 / 定位）都假设下标空间是主消息，
 *    把手机消息插进去会把它们全部错位。所以这里另起一条线。
 *  - 但记忆是共用的：手机聊天用的就是这条会话的「三层记忆」（认知 / 场景 /
 *    关系 / 共同经历 / 分层摘要），memory.js 的日更与压缩会把手机消息一并纳入
 *    （见 memory.js 的 allMsgs）。
 *  - 用量按类型记在 "phone" 名下，走设置里的「手机花费预警」。
 *
 * 本文件不新增依赖、不改动其它模块行为（只往 window.DL 挂入口）。
 */
(function () {
  /* 内置助手的对外名字（10-22 用户口径：不再出现「助手」三个字，就叫听澜）。
     取 CONFIG.BUILTIN_ASSISTANT.name，取不到才退回「听澜」这个兜底。 */
  function aiName() {
    var c = window.CONFIG && window.CONFIG.BUILTIN_ASSISTANT;
    return (c && c.name) || "听澜";
  }

  /* 打包工具不一定按 index.html 的顺序执行脚本：app.js 有可能晚于本文件。
     那时 window.DL 还不存在 —— 等它就绪后再初始化一次。返回 false = 还没就绪。 */
  var booted = false;  /* boot 幂等：DOMContentLoaded 与补拍 retry 各会调一次，别重复绑事件 / 分裂状态 */
  function boot() {
    if (booted) return true;
  var D = window.DL;
  if (!D) return false;
  booted = true;   /* 已真正初始化过，后续再被调用直接返回 */

  var $ = D.$, state = D.state;
  var setText = D.setText, setHidden = D.setHidden, setDisabled = D.setDisabled, on = D.on;
  var UI, Store, Memory, Api, Media;
  var session, sessionById, characterFor, activeCharacter, renderAll;
  var toast, recordUsage, maybeDailyRefresh;

  /* ⚠️ 一律不在加载时快照「模块」与「别的子模块提供的入口」：
     打包工具顺序不保证，快照会把它们永久钉死在 undefined（真机踩过）。 */
  function syncModules() {
    UI = D.UI || window.UI; Store = D.Store || window.Store;
    Memory = D.Memory || window.Memory; Api = D.Api || window.Api;
    Media = D.Media || window.Media;
    session = D.session; sessionById = D.sessionById;
    characterFor = D.characterFor; activeCharacter = D.activeCharacter;
    renderAll = D.renderAll;
    toast = D.toast;
    recordUsage = D.recordUsage || window.recordUsage;
    maybeDailyRefresh = D.maybeDailyRefresh || window.maybeDailyRefresh;
  }
  syncModules();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncModules);
  else setTimeout(syncModules, 0);

  function esc(t) { return UI && UI.escapeHtml ? UI.escapeHtml(t) : String(t == null ? "" : t); }
  function show(el, on2) { if (el) el.hidden = !on2; }

  /* ── 模块状态 ────────────────────────────────────── */
  var ps = {
    view: "list",       /* list | chat */
    sid: "",            /* 当前正在聊的那条会话 */
    busy: false,        /* 生成中 */
    abort: null,
    recActive: false,   /* 录音中 */
    sending: false,     /* 手机发送闸门（防并行） */
    /* 用 null 而不是 ""：没有角色卡的会话（助手）分组键就是空串，
       若这里也用 ""，`expandChar === charId` 恒为真 → 助手那组一进列表就是展开态，
       点它又把 expandChar 设回 ""，等于没变化 → 永远收不起来（真机反馈）。 */
    expandChar: null,   /* 列表里正在展开的角色（按角色分组：点角色就地展开它名下的线） */
    closeTimer: null,   /* 退出手机页的动画计时器（180ms 后才真正隐藏，连点要能取消） */
    enterAnim: false,   /* 进手机页时给列表播一次入场动画（播完自动关，免得每次重渲染都闪） */
    pick: null          /* 多选转发（10-20）：null = 不在多选；{} = {消息id: true} */
  };

  function pad2n(n) { return (n < 10 ? "0" : "") + n; }

  /* ── 手机上的时间一律走「故事时间」──────────────────────────────
     开时间系统时 = 现实时间 + 一个常数偏移（见 memory.js 的 storyAt / nowOf）；
     没开就是现实时间。这样手机里的时钟、消息分隔、列表预览和主对话是同一套时间。 */
  function storyMs(ts, sid) {
    /* sid 是「这条时间属于哪条线」。列表里每行要传自己的，否则全按最后打开那条线的
       故事时间偏移算，多线时列表时间全是错的。 */
    var s = sessionById(sid || ps.sid) || session();
    if (Memory && Memory.storyAt && s) {
      try { return Memory.storyAt(s, typeof ts === "number" ? ts : Date.now()); } catch (e) { /* ignore */ }
    }
    return typeof ts === "number" ? ts : Date.now();
  }

  function nowHM() {
    var d = new Date(storyMs(Date.now()));
    return pad2n(d.getHours()) + ":" + pad2n(d.getMinutes());
  }
  function fmtDur(sec) {
    var m = Math.floor((sec || 0) / 60), s = (sec || 0) % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ── 数据读写（session.phone.msgs）─────────────────── */
  function phoneOf(s) {
    if (!s) return null;
    if (!s.phone || typeof s.phone !== "object") s.phone = { msgs: [] };
    if (!Array.isArray(s.phone.msgs)) s.phone.msgs = [];
    return s.phone;
  }
  function phoneMsgsOf(s) {
    var ph = phoneOf(s);
    return ph ? ph.msgs : [];
  }
  function lastPhoneMsg(s) {
    var m = phoneMsgsOf(s);
    return m.length ? m[m.length - 1] : null;
  }
  /* 按会话 id 写入手机消息（流式期间切换会话也不会写错地方） */
  function pushMsg(sid, msg) {
    var list = Store.getSessions();
    var i = -1;
    for (var k = 0; k < list.length; k++) { if (list[k].id === sid) { i = k; break; } }
    if (i < 0) return null;
    var ph = phoneOf(list[i]);
    if (!msg.ts) msg.ts = Date.now();
    ph.msgs.push(msg);
    list[i].updatedAt = Date.now();
    Store.saveSessions(list);
    return list[i];
  }

  /* 删一条手机消息（10-18 用户要求）。
     如果它绑了主聊天那条「线下」消息，一起删掉 —— 两边是同一次对话的两面，
     只删一边会留下孤儿。 */
  /* 删除单条（10-20 用户口径：**连带删主聊天里绑定的那条**，和原来一样） */
  function deletePhoneMsgOne(msg) {
    return deletePhoneMsg(ps.sid, msg);
  }
  function deletePhoneMsgs(arr) {
    var n = 0;
    (arr || []).forEach(function (m) { if (deletePhoneMsg(ps.sid, m)) n++; });
    return n;
  }

  function deletePhoneMsg(sid, msg) {
    var list = Store.getSessions();
    var i = -1;
    for (var k = 0; k < list.length; k++) { if (list[k].id === sid) { i = k; break; } }
    if (i < 0 || !msg) return false;
    var rec = list[i];
    var ph = phoneOf(rec);
    var at = ph.msgs.indexOf(msg);
    if (at < 0) return false;
    ph.msgs.splice(at, 1);
    /* 连带删主聊天里绑定的那条 */
    var key = msg.id || "";
    if (key && Array.isArray(rec.messages)) {
      for (var j = rec.messages.length - 1; j >= 0; j--) {
        if (rec.messages[j] && rec.messages[j].phoneMsgId === key) rec.messages.splice(j, 1);
      }
    }
    rec.updatedAt = Date.now();
    Store.saveSessions(list);
    return true;
  }

  /* 表情翻译（10-19）：主聊天那边走 memory.js 的 msgText（带 emojiReadable），
     手机这边原来只有自己这一份，模型收到的是 [[s:stabc123]] 这种原始标记。
     统一在这里过一道，两套 msgText 的口径就一致了。 */
  function readableText(t) {
    var x = String(t || "");
    if (!x) return x;
    try {
      var M = (typeof Memory !== "undefined" && Memory) || window.Memory;
      if (M && M.emojiReadable) return M.emojiReadable(x);
    } catch (e) { /* 翻译失败就按原文，不能因此断消息 */ }
    return x;
  }

  /* 一条手机消息 → 给模型看的文本 */
  function msgText(m) {
    if (!m) return "";
    /* 撤回（10-18 用户要求）：角色要知道「你撤回了」这个动作，连原文一起给，
       它才接得住「他刚才说了什么又收回去」这种情绪。 */
    if (m.kind === "recalled") {
      var who = m.role === "user" ? "对方" : "你";
      var orig = m.origText ? "，撤回前写的是「" + m.origText + "」" : "";
      return "（" + who + "撤回了一条消息" + orig + "）";
    }
    if (m.kind === "transfer") return "（" + (m.role === "user" ? "我" : "你") + "转账 " + fmtMoney(m.amount) + (m.note ? "，备注：" + m.note : "") + "）";
    if (m.kind === "location") return "（" + (m.role === "user" ? "我" : "你") + "发送了位置：" + (m.place || "未知地点") + "）";
    if (m.kind === "image") {
      var d = m.desc ? "，画面：" + m.desc : "";
      return "（" + (m.role === "user" ? "我" : "你") + "发了一张图片" + d + "）";
    }
    if (m.kind === "voice") return "（" + (m.role === "user" ? "我" : "你") + "发来一条语音，说的是：" + readableText(m.text) + "）";
    if (m.kind === "call") return "（" + (m.role === "user" ? "我们" : "我们") + "通了一次电话" + (m.text ? "，内容：" + readableText(m.text) : "") + "）";
    /* 合并转发（10-20）：给模型看时要带说话人，不然分不清谁是谁 */
    if (m.kind === "fwdmerge") {
      var its = Array.isArray(m.items) ? m.items : [];
      if (!its.length) return "（转发了一段聊天记录）";
      return "（下面是一段转发的聊天记录，不是此刻正在说的话；每条前面的名字是当时的说话人）\n" +
        its.map(function (x) { return "　" + (x.name || "某人") + "：" + String(x.text || x.snippet || ""); }).join("\n");
    }
    if (m.kind === "sys") return "（系统提示：" + (m.text || "") + "）";
    return readableText(m.text);
  }
  /* 列表里的一行预览 */
  function previewOf(m) {
    if (!m) return "";
    if (m.kind === "recalled") return "[已撤回]";
    if (m.kind === "transfer") return "[转账] " + fmtMoney(m.amount);
    if (m.kind === "location") return "[位置] " + (m.place || "");
    if (m.kind === "image") return "[图片]";
    if (m.kind === "voice") return "[语音] " + (m.text || "");
    if (m.kind === "call") return "[通话]";
    if (m.kind === "fwdmerge") return "[聊天记录] " + ((m.items && m.items.length) || 0) + " 条";
    /* 列表预览别把 [[s:xxx]] / [表情:名字] 原样露出来（10-19） */
    return String(m.text || "").replace(/\[\[s:[a-z0-9]+\]\]/g, "[表情]").replace(/\[表情:[^\]]+\]/g, "[表情]");
  }
  function fmtMoney(v) {
    var n = Number(v);
    if (!isFinite(n)) return "¥0.00";
    return "¥" + n.toFixed(2);
  }

  /* ── 头像 / 名称 ─────────────────────────────────── */
  function avatarOf(ch, s) {
    if (s && typeof s === "object") {
      /* 手机页头像自成一套：这条线单独设过就用它（phoneAvatar）→
         否则回落到角色自己的头像 → 再回落到全局助手头像。
         刻意不再借 s.avatarAi：那是「聊天界面」的会话头像，手机里想用另一张是常见需求
         （用户 10-17 定的口径：默认按角色，各线可单独设）。 */
      var own = s.phoneAvatar || "";
      if (own) return own;
    }
    /* 角色卡上的「默认手机头像」（10-19 用户要求）：这张线专用，没设就回落到角色头像 */
    if (ch && ch.phoneAvatar) return ch.phoneAvatar;
    if (ch && ch.avatar) return ch.avatar;
    /* 10-22：角色存在但没设头像 → 返回空串，让 UI 画占位人像。
       以前这里回落到全局 avatarAi（现在是听澜的头像），结果没设头像的角色
       全顶着听澜的脸出现在手机里 —— 看着像「听澜又变成了别人」。
       只有 ch 为空（助手身份本身）才用全局那张。 */
    if (ch) return "";
    return state.settings.avatarAi || "";
  }
  /* 这条线可以单独起昵称（「这条线」设置里设的）；没设就用角色卡的名字 */
  function nameOf(ch, s) {
    var own = s && typeof s === "object" ? String(s.nickChar || "").trim() : "";
    if (own) return own;
    return ch ? (ch.name || "角色") : aiName();
  }

  /* 朗读用的设置：这条线单独设过音色就用它的（见「对话设置 → 本线音色」） */
  function voiceSet() {
    var s = sessionById(ps.sid);
    return (D.voiceSettingsFor ? D.voiceSettingsFor(s) : state.settings);
  }

  function avatarEl(url, role) {
    var box = document.createElement("div");
    box.className = "ph-av";
    if (url) {
      var im = document.createElement("img");
      im.src = (window.DL && window.DL.avatarUrl) ? window.DL.avatarUrl(url) : url;
      im.alt = "";
      box.appendChild(im);
    } else {
      box.innerHTML = UI.iconSvg(role === "user" ? "account" : "creation");
    }
    return box;
  }

  /* ── 手机头像（这条线可单独设，默认跟随角色）──────────────
     用户口径：默认按角色，各线可单独设。所以写的是 session.phoneAvatar，
     空串 = 没单独设 = 回落到角色头像。刻意不复用 avatarAi（那是聊天界面那张）。 */
  var phAvInput = null;
  function phoneAvatarInput() {
    if (phAvInput) return phAvInput;
    phAvInput = document.createElement("input");
    phAvInput.type = "file";
    phAvInput.accept = "image/*";
    phAvInput.style.display = "none";
    document.body.appendChild(phAvInput);
    return phAvInput;
  }
  function setPhoneAvatar(sid, url) {
    if (!sid) return;
    Store.updateSession(sid, { phoneAvatar: url || "" });
    /* 列表和当前聊天都重画一遍：同一张头像会出现在列表项、气泡、通话页 */
    renderList();
    renderChat();
  }

  function openPhoneLineSheet() {
    var sid = ps.sid;
    if (!sid) return;
    var s = sessionById(sid);
    if (!s) return;
    var ch = characterFor(s);

    var box = document.createElement("div");
    box.className = "ph-avset";

    var pv = document.createElement("div");
    pv.className = "ph-avset-pv";
    function paint() {
      var cur = sessionById(sid) || s;
      pv.innerHTML = "";
      pv.appendChild(avatarEl(avatarOf(ch, cur), "assistant"));
    }
    paint();

    var row = document.createElement("div");
    row.className = "ph-avset-row";
    var pick = document.createElement("button");
    pick.type = "button"; pick.className = "btn"; pick.textContent = "选择图片";
    var reset = document.createElement("button");
    reset.type = "button"; reset.className = "btn ghost"; reset.textContent = "用角色头像";
    row.appendChild(pick); row.appendChild(reset);

    var hint = document.createElement("p");
    hint.className = "ph-avset-hint";
    hint.textContent = "不单独设置时，手机里显示角色自己的头像。";

    pick.addEventListener("click", function () {
      var inp = phoneAvatarInput();
      inp.value = "";
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        Promise.resolve(D.readAvatarFile(f)).then(function (url) {
          setPhoneAvatar(sid, url);
          paint();
          toast("已换好");
        }).catch(function (e) { toast((e && e.message) || "图片读取失败", true); });
      };
      inp.click();
    });
    reset.addEventListener("click", function () {
      setPhoneAvatar(sid, "");
      paint();
      toast("已改回角色头像");
    });

    box.appendChild(pv); box.appendChild(row); box.appendChild(hint);

    /* ── 这条线的昵称（10-18 用户口径：和头像一样，是这条线自己的）──
       两个都留空 = TA 用角色卡的名字、我用全局「我的昵称」。 */
    function nickField(label, key, ph) {
      var w = document.createElement("label");
      w.className = "ph-set-field";
      var sp = document.createElement("span");
      sp.textContent = label;
      var inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = ph;
      inp.value = String((sessionById(sid) || {})[key] || "");
      inp.addEventListener("change", function () {
        var patch = {};
        patch[key] = inp.value.trim();
        patchLine(sid, patch);
        if (key === "nickChar") { try { renderList(); renderChat(); } catch (e) { /* ignore */ } }
        toast("昵称已存");
      });
      w.appendChild(sp); w.appendChild(inp);
      return w;
    }
    /* 语义纠正：nickChar 改的是「TA 在手机里叫什么」（nameOf 用它当角色名），
       nickMe 是「TA 怎么称呼我」。原来的标签写反了，按字面填会把角色改名。 */
    box.appendChild(nickField("TA 的昵称", "nickChar", "留空 = 用角色卡的名字"));
    box.appendChild(nickField("TA 怎么称呼我", "nickMe", "留空 = 用全局的「你对我的称呼」"));

    /* ── 备忘录入口 ──────────────────────────────
       写在这儿，内容归听澜那边；约定型到点会在侧栏「助手」上冒红点。 */
    var remRow = document.createElement("div");
    remRow.className = "ph-set-field";
    var remBtn = document.createElement("button");
    remBtn.type = "button"; remBtn.className = "btn ghost"; remBtn.textContent = "备忘录";
    remBtn.addEventListener("click", function () {
      closeSheet();
      /* 带上手机自己的 sid：不传会退回主聊天当前那条线，故事时间偏移就错位了 */
      if (D.reminder && D.reminder.open) D.reminder.open(ps.sid);
    });
    var remHint = document.createElement("p");
    remHint.className = "ph-avset-hint";
    remHint.textContent = "备忘写在听澜那边；约定型的到点会在侧栏冒红点。";
    remRow.appendChild(remBtn); remRow.appendChild(remHint);
    box.appendChild(remRow);

    /* ── 这条线的背景 ──────────────────────────────
       写 session.phoneBg；空 = 跟随全局手机背景（app.js 的 applyPhoneBackground 会先问这里）。 */
    var bgWrap = document.createElement("div");
    bgWrap.className = "ph-set-field";
    var bgLabel = document.createElement("span");
    bgLabel.textContent = "这条线的聊天背景（留空跟随全局）";
    var bgRow = document.createElement("div");
    bgRow.className = "ph-set-row";
    var bgPick = document.createElement("button");
    bgPick.type = "button"; bgPick.className = "btn"; bgPick.textContent = "选择图片";
    var bgClr = document.createElement("button");
    bgClr.type = "button"; bgClr.className = "btn ghost"; bgClr.textContent = "跟随全局";
    bgRow.appendChild(bgPick); bgRow.appendChild(bgClr);
    bgWrap.appendChild(bgLabel); bgWrap.appendChild(bgRow);
    box.appendChild(bgWrap);

    bgPick.addEventListener("click", function () {
      var inp = phBgFileInput();
      inp.value = "";
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        readBgFile(f).then(function (url) {
          /* 走取景面板：这里以前直接落图，所以手机背景只能显示原图、不能缩放裁剪 */
          if (D.openBgCrop) {
            D.openBgCrop(url, "phone", function (out) {
              patchLine(sid, { phoneBg: out });
              try { if (D.applyPhoneBackground) D.applyPhoneBackground(); } catch (e) { /* ignore */ }
              toast("背景已换");
            });
          } else {
            patchLine(sid, { phoneBg: url });
            try { if (D.applyPhoneBackground) D.applyPhoneBackground(); } catch (e) { /* ignore */ }
            toast("背景已换");
          }
        }).catch(function (e) { toast((e && e.message) || "图片读取失败", true); });
      };
      inp.click();
    });
    bgClr.addEventListener("click", function () {
      patchLine(sid, { phoneBg: "" });
      try { if (D.applyPhoneBackground) D.applyPhoneBackground(); } catch (e) { /* ignore */ }
      toast("已改回全局背景");
    });

    /* ── 这条线的音色 ──────────────────────────────
       写的是 session.ttsVoice（和主聊天「对话设置 → 本线音色」是同一个字段，
       两边改一处、另一处跟着变，不会出现两套值）。 */
    var voiceWrap = document.createElement("label");
    voiceWrap.className = "ph-set-field";
    var vLabel = document.createElement("span");
    vLabel.textContent = "这条线的音色（留空跟随全局）";
    var vInput = document.createElement("input");
    vInput.type = "text";
    vInput.placeholder = "例：FunAudioLLM/CosyVoice2-0.5B:alex";
    vInput.value = String((sessionById(sid) || {}).ttsVoice || "");
    vInput.addEventListener("change", function () {
      patchLine(sid, { ttsVoice: vInput.value.trim() });
      toast("音色已存");
    });
    voiceWrap.appendChild(vLabel); voiceWrap.appendChild(vInput);
    box.appendChild(voiceWrap);

    /* ── 这条线的 live2D 模型 ──────────────────────
       选项来自「设置 → live2D」里上传过的模型；没上传过就只有内置那一套。
       存的是 session.live2dModel，空 = 跟随全局。 */
    var modelWrap = document.createElement("label");
    modelWrap.className = "ph-set-field";
    var mLabel = document.createElement("span");
    mLabel.textContent = "这条线的 live2D 模型";
    var sel = document.createElement("select");
    var optAuto = document.createElement("option");
    optAuto.value = "";
    optAuto.textContent = "跟随全局设置";
    sel.appendChild(optAuto);
    var sets = (state.settings.live2dSets || []).slice();
    sets.forEach(function (it) {
      if (!it || !it.name) return;
      var o = document.createElement("option");
      o.value = String(it.dir || "") + "/" + String(it.entry || "");
      o.textContent = it.name;
      sel.appendChild(o);
    });
    if (!sets.length) {
      var o2 = document.createElement("option");
      o2.value = "live2d/model/shizuku.model.json";
      o2.textContent = "内置模型（shizuku）";
      sel.appendChild(o2);
    }
    sel.value = String((sessionById(sid) || {}).live2dModel || "");
    sel.addEventListener("change", function () {
      patchLine(sid, { live2dModel: sel.value });
      toast("模型已存");
    });
    modelWrap.appendChild(mLabel); modelWrap.appendChild(sel);
    box.appendChild(modelWrap);

    var hint2 = document.createElement("p");
    hint2.className = "ph-avset-hint";
    hint2.textContent = "模型要先在「设置 → live2D」里上传过，才会出现在上面的列表里。";
    box.appendChild(hint2);

    openSheet("这条线", box, closeSheet);
  }

  /* 改这条线的某个字段（原地合并，别整条覆盖，否则会把消息冲掉） */
  function patchLine(sid, patch) {
    var s = sessionById(sid);
    if (!s) return;
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    Store.saveSessions(Store.getSessions());
  }

  /* ── 手机设置（加号左边那个齿轮）────────────────────────────
     背景图 / 模糊 / 亮度以前藏在「设置 → 手机背景」，手机上根本找不到（真机反馈）。
     现在就地能改，改完立刻生效。 */
  var phBgInput = null;
  function phBgFileInput() {
    if (phBgInput) return phBgInput;
    phBgInput = document.createElement("input");
    phBgInput.type = "file";
    phBgInput.accept = "image/*";
    phBgInput.style.display = "none";
    document.body.appendChild(phBgInput);
    return phBgInput;
  }
  /* 背景图比头像大：头像缩 192，背景最长边缩到 1280，不然铺满手机屏会糊。
     统一转 jpeg 0.82，一张大概 200~400KB。 */
  function readBgFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || "")) { reject(new Error("请选择图片文件")); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          var max = 1280;
          var sc = Math.min(1, max / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * sc));
          var h = Math.max(1, Math.round(img.height * sc));
          var cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          try {
            cv.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(cv.toDataURL("image/jpeg", 0.82));
          } catch (e) { resolve(String(fr.result || "")); }
        };
        img.onerror = function () { reject(new Error("图片读取失败")); };
        img.src = String(fr.result || "");
      };
      fr.onerror = function () { reject(new Error("图片读取失败")); };
      fr.readAsDataURL(file);
    });
  }
  /* ⚠️ 不写 `state.settings = Store.saveSettings(...)`：那会换掉整个对象，
     凡是早先拿过引用的地方都会继续读旧值（今晚已经踩过一次）。原地改最安全。 */
  function patchPhoneBg(patch) {
    var next = Store.saveSettings(patch);
    if (state.settings) { Object.keys(patch).forEach(function (k) { state.settings[k] = next[k]; }); }
    try { if (D.applyPhoneBackground) D.applyPhoneBackground(); } catch (e) { /* ignore */ }
  }

  function openPhoneSettings() {
    var box = document.createElement("div");
    box.className = "ph-set";

    var pv = document.createElement("div");
    pv.className = "ph-set-pv";
    function paint() {
      var cur = state.settings.phoneBgImage || "";
      pv.style.backgroundImage = cur ? "url(" + cur + ")" : "";
      if (cur) pv.textContent = ""; else pv.textContent = "还没有背景图";
    }
    paint();

    var row = document.createElement("div");
    row.className = "ph-set-row";
    var pick = document.createElement("button");
    pick.type = "button"; pick.className = "btn"; pick.textContent = "选择图片";
    var clr = document.createElement("button");
    clr.type = "button"; clr.className = "btn ghost"; clr.textContent = "清除背景";
    row.appendChild(pick); row.appendChild(clr);

    pick.addEventListener("click", function () {
      var inp = phBgFileInput();
      inp.value = "";
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        readBgFile(f).then(function (url) {
          patchPhoneBg({ phoneBgImage: url });
          paint();
          toast("背景已换");
        }).catch(function (e) { toast((e && e.message) || "图片读取失败", true); });
      };
      inp.click();
    });
    clr.addEventListener("click", function () {
      patchPhoneBg({ phoneBgImage: "" });
      paint();
      toast("背景已清除");
    });

    /* 滑块：拖动实时生效，不用点确定 */
    function slider(label, min, max, step, value, onInput) {
      var wrap = document.createElement("label");
      wrap.className = "ph-set-slider";
      var top = document.createElement("span");
      top.className = "ph-set-slider-top";
      var nm = document.createElement("b");
      nm.textContent = label;
      var val = document.createElement("i");
      val.textContent = String(value);
      top.appendChild(nm); top.appendChild(val);
      var r = document.createElement("input");
      r.type = "range";
      r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(value);
      r.addEventListener("input", function () {
        var v = Number(r.value) || 0;
        val.textContent = String(v);
        onInput(v);
      });
      wrap.appendChild(top); wrap.appendChild(r);
      return wrap;
    }

    var blurBox = slider("背景模糊", 0, 100, 1, Number(state.settings.phoneBgBlur) || 0, function (v) {
      patchPhoneBg({ phoneBgBlur: v });
    });
    var brightBox = slider("背景亮度", 0, 200, 2, Number(state.settings.phoneBgBright) || 100, function (v) {
      patchPhoneBg({ phoneBgBright: v });
    });

    /* 「这条线」入口放在这里（10-24 用户口径）：它属于设置，不该占着聊天页的动作格子。
       只在聊天视图里能进来才有意义，所以 ps.sid 有名才显示。 */
    var lineBtn = document.createElement("button");
    lineBtn.className = "btn block";
    lineBtn.type = "button";
    lineBtn.textContent = "这条线（头像 / 昵称 / 本线背景 / 音色）";
    lineBtn.addEventListener("click", function () {
      closeSheet();
      openPhoneLineSheet();
    });

    var hint = document.createElement("p");
    hint.className = "ph-set-hint";
    hint.textContent = "背景只作用于手机页。某一条线想单独换头像 / 昵称 / 背景，点上面那一项。";

    box.appendChild(pv);
    box.appendChild(row);
    if (ps.sid) box.appendChild(lineBtn);
    box.appendChild(blurBox);
    box.appendChild(brightBox);
    box.appendChild(hint);
    openSheet("手机设置", box, closeSheet);
  }

  /* ── 打开 / 关闭 ─────────────────────────────────── */
  function isOpen() { var el = $("#phoneModal"); return !!(el && !el.hidden); }
  /* 手机页的独立背景由 app.js 的 applyPhoneBackground 统管（值存在设置的 phoneBg* 里） */
  function applyPhoneBg() {
    try { if (D.applyPhoneBackground) D.applyPhoneBackground(); } catch (e) { /* 背景出错不影响进手机 */ }
  }

  /* 进手机页的入场动画：给外壳播一次「从右侧滑入 + 淡入」，列表项再按序跟一小步。
     连续进出时要先移除类 + 强制重排，否则第二次不会重播（浏览器认为动画已经跑过）。 */
  function playEnter(el) {
    var sh = el ? el.querySelector(".phone-shell") : null;
    if (!sh) return;
    sh.classList.remove("phone-enter", "phone-leave");
    try { void sh.offsetWidth; } catch (e) { /* ignore */ }
    sh.classList.add("phone-enter");
  }

  /* 视图之间的切换（列表 ↔ 聊天 ↔ 动态）。
     10-18 改成真正的转场：三个视图是叠层（CSS 绝对定位），
     前进时新页从右侧整页推进来、底下那页同步左移一点；返回时当前页右移退出，
     露出下面一直留着的列表。用户口径：进角色消息界面不能「一下就换掉」。 */
  var VIEW_MS = 275;
  var viewTimer = null;

  /* 把所有视图的过场类清干净；keepUnder 里的保持可见（当背景），其余藏起来 */
  function viewSettle(keepUnder) {
    var keep = keepUnder || [];
    [$("#phoneListView"), $("#phoneChatView"), $("#phoneMomentsView")].forEach(function (el) {
      if (!el) return;
      el.classList.remove("ph-in-right", "ph-in-left", "ph-out-left", "ph-out-right");
      if (keep.indexOf(el) < 0) el.hidden = true;
    });
  }

  /* next = 要显示的那个视图；dir > 0 前进，dir < 0 返回，0 = 直接切（不播） */
  function switchView(next, dir) {
    if (!next) return;
    if (viewTimer) { clearTimeout(viewTimer); viewTimer = null; }
    var all = [$("#phoneListView"), $("#phoneChatView"), $("#phoneMomentsView")].filter(Boolean);
    var under = all.filter(function (el) { return !el.hidden && el !== next; });
    /* 上一次动画没播完就又切：先结算，避免两个视图各带一个平移、叠出怪画面 */
    all.forEach(function (el) {
      el.classList.remove("ph-in-right", "ph-in-left", "ph-out-left", "ph-out-right");
    });
    if (!dir) { viewSettle([next]); next.hidden = false; return; }

    next.hidden = false;
    if (dir > 0) {
      void next.offsetWidth;                      /* 强制重排，否则第二次不播 */
      next.classList.add("ph-in-right");
      under.forEach(function (el) { el.classList.add("ph-out-left"); });
    } else {
      /* 返回：底下的列表原地不动，当前页整页右移把它露出来 */
      under.forEach(function (el) { el.classList.add("ph-out-right"); });
    }
    viewTimer = setTimeout(function () {
      viewTimer = null;
      under.forEach(function (el) {
        el.hidden = true;
        el.classList.remove("ph-out-left", "ph-out-right");
      });
      next.classList.remove("ph-in-right", "ph-in-left");
    }, VIEW_MS);
  }

  function openPhone() {
    syncModules();
    var el = $("#phoneModal");
    if (!el) return;
    /* 上一次退出还在 180ms 动画里就被重新打开：取消那个定时器，否则它会把刚开的页面藏起来 */
    if (ps.closeTimer) { clearTimeout(ps.closeTimer); ps.closeTimer = null; }
    setText("#phoneClock", nowHM());
    if (!Store.getSessions().length) { toast("还没有对话，先新建一条", true); return; }
    ps.expandChar = null;
    ps.enterAnim = true;      /* 让列表跟着外壳一起入场 */
    goList();
    applyPhoneBg();
    /* 打开前校准一次视口高度：--app-h 可能还停在键盘弹起时的旧值
       （部分 WebView 收起键盘不派发 resize），不校准就是「手机页只占上半屏」。 */
    try { window.dispatchEvent(new Event("resize")); } catch (e) { /* 老内核没有 Event 构造器就算了 */ }
    el.hidden = false;
    document.body.classList.add("phone-open");
    playEnter(el);
  }
  /* 直接进某条会话的手机聊天（会话页顶栏按钮走这条） */
  function openPhoneFor(sid) {
    syncModules();
    var s = sessionById(sid || (session() ? session().id : ""));
    if (!s) { openPhone(); return; }
    var el = $("#phoneModal");
    if (!el) return;
    if (ps.closeTimer) { clearTimeout(ps.closeTimer); ps.closeTimer = null; }
    setText("#phoneClock", nowHM());
    applyPhoneBg();
    try { window.dispatchEvent(new Event("resize")); } catch (e) { /* 同上 */ }
    el.hidden = false;
    document.body.classList.add("phone-open");
    /* 外壳正在播入场，视图这一层就别再叠一次滑动（否则两层动画打架） */
    ps.enterAnim = true;
    playEnter(el);
    openChat(s.id);
    /* 这条路径不走 renderList，没人帮我们清标志 —— 自己收尾，否则下次从列表点进聊天不播转场 */
    setTimeout(function () { ps.enterAnim = false; }, 700);
  }
  function closePhone() {
    hangUp(true);
    closeSheet();
    showAddSheet(false);
    var el = $("#phoneModal");
    var shell = el ? el.querySelector(".phone-shell") : null;
    if (el) {
      /* 退场动画（用户口径：退出也要有过渡，不能一下就没了）。
         外壳轻右移 + 淡出，播完再真正隐藏；期间禁点击，避免连点重复触发。 */
      if (shell && !el.hidden) {
        shell.classList.remove("phone-enter");
        shell.classList.add("phone-leave");
        if (ps.closeTimer) clearTimeout(ps.closeTimer);
        ps.closeTimer = setTimeout(function () {
          ps.closeTimer = null;
          el.hidden = true;
          if (shell) { shell.classList.remove("phone-leave"); }
        }, 180);
      } else {
        el.hidden = true;
      }
    }
    document.body.classList.remove("phone-open");
    /* 关掉手机就把录音收干净：以前只挂电话、关弹层，麦克风一直开着。
       只收手机自己那一路（ps.recActive），主聊天的录音不受影响。 */
    if (ps.recActive) {
      ps.recActive = false;
      try { if (window.Media && Media.recorder && Media.recorder.recording) Media.recorder.cancel(); } catch (e) { /* ignore */ }
    }
    ps.busy = false; ps.sending = false;
    ps.busySid = "";
    if (ps.abort) { try { ps.abort.abort(); } catch (e) { /* ignore */ } }
    ps.abort = null;
  }

  /* ── 新建联系人（纯手机角色）────────────────────────
     「纯手机角色」= 只活在手机里的联系人：character 与它的会话都带 phoneOnly 标记，
     主对话的角色 / 会话列表会把它们挑出来、单独归到侧栏「手机角色」那一栏；
     记忆 / 压缩照常走（用户口径）。 */
  function showAddSheet(v) {
    var el = $("#phoneAddSheet");
    if (el) el.hidden = !v;
  }
  function newPhoneContact() {
    var body = document.createElement("div");
    var lb = document.createElement("label");
    lb.className = "field";
    var sp = document.createElement("span");
    sp.textContent = "联系人名称";
    var inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = "如：楼下花店老板";
    lb.appendChild(sp); lb.appendChild(inp);
    body.appendChild(lb);
    var hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "纯手机角色：只活在手机里，不出现在主对话的角色列表；记忆 / 压缩照常，之后可以升级成完整角色。";
    body.appendChild(hint);
    openSheet("新建联系人", body, function () {
      var name = String(inp.value || "").trim();
      if (!name) { toast("先填个名字", true); return; }
      closeSheet();
      createPhoneContact(name);
    });
  }
  function createPhoneContact(name) {
    var now = Date.now();
    var ch = {
      id: "c_" + now.toString(36) + Math.random().toString(36).slice(2, 6),
      name: name, avatar: "", fields: { aiName: name },
      ctxFilter: { rule: "", every: 10 }, usage: null, pinned: false, phoneOnly: true,
      createdAt: now, updatedAt: now
    };
    var list = Store.getCharacters();
    list.push(ch);
    if (Store.saveCharacters(list) === false) { toast("写入失败（存储只读或被锁定）", true); return; }
    var s = Store.createSession(ch.id, true);   /* true = 别顶掉当前主对话 */
    if (s && s.id) Store.updateSession(s.id, { phoneOnly: true, title: name });
    goList();
    toast("已建联系人「" + name + "」");
    if (s && s.id) openChat(s.id);
  }

  function goList() {
    ps.view = "list";
    /* 回列表就丢掉「正在看哪条线」：否则列表时间和背景会继续按刚才那条线算，
       表现是别的线的行也带上这条线的故事时间偏移 / 背景图。 */
    ps.sid = "";
    var lv = $("#phoneListView");
    /* 从聊天 / 动态退回列表：当前页整页右移退出，把底下一直留着的列表露出来。
       刚进手机页时整页外壳已经在播入场，这时直接切，不叠一层视图动画。 */
    switchView(lv, ps.enterAnim ? 0 : -1);
    renderList();
  }

  /* ── 列表视图（类微信：按角色 / 线）────────────────── */
  function renderList() {
    var box = $("#phoneList");
    if (!box) return;
    box.innerHTML = "";
    var chs = Store.getCharacters();
    var sess = Store.getSessions();
    var rows = [];
    var seen = {};
    /* 群聊：只有「手机群」能进手机列表，现实群不进来（口径 A，10-23 拍板）。
       原因：现实群的消息在 messages 里，手机这边读写的却是 phone.msgs ——
       放进来会变成「能进、能聊，但主聊天和成员线都看不到这段」的黑洞，两套记录各存一份。 */
    sess.forEach(function (s) {
      if (!s || !s.isGroup || !s.phoneGroup) return;
      var gm = lastPhoneMsg(s);
      /* 没有手机消息的群不该靠「会话更新时间」窜到最前 —— 只有真有消息才参与排序 */
      rows.push({ isGroup: true, s: s, ch: null, lines: [s], last: gm, lastTs: (gm && gm.ts) || 0, avLine: s });
    });
    function addRow(charId) {
      if (seen[charId]) return;
      /* 听澜是内置助手，不进手机联系人：它不是能"打电话、发表情"的角色（10-21 用户口径，
         以前漏了这条，助手直接变成手机里一个普通联系人）。
         10-22 补：没挂角色的会话（characterId 为空 = 助手身份）同样不进 —— 用户截图里
         手机列表上那行「助手」就是它，名字还是旧的兜底文案。 */
      if (!charId) return;
      if (charId === ((window.DL && window.DL.tinglanId) || "c_tinglan")) return;
      seen[charId] = 1;
      var lines = [];
      for (var i = 0; i < sess.length; i++) { if (!sess[i].isGroup && (sess[i].characterId || "") === charId) lines.push(sess[i]); }
      if (!lines.length) return;
      var ch = null;
      for (var j = 0; j < chs.length; j++) { if (chs[j].id === charId) { ch = chs[j]; break; } }
      var last = null, lastTs = -1, avLine = null;
      lines.forEach(function (s) {
        var m = lastPhoneMsg(s);
        if (m && (m.ts || 0) > lastTs) { lastTs = m.ts || 0; last = m; avLine = s; }
      });
      rows.push({ charId: charId, ch: ch, lines: lines, last: last, lastTs: lastTs, avLine: avLine });
    }
    chs.forEach(function (c) { addRow(c.id); });
    var extra = {};
    sess.forEach(function (s) { if (s && s.isGroup) return; var k = s.characterId || ""; if (!seen[k]) extra[k] = 1; });
    Object.keys(extra).forEach(function (k) { addRow(k); });
    rows.sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0); });

    /* 「动态」入口已挪进右上角「+」浮窗（10-17 用户要求去掉这个置顶行）——
       列表从真正的联系人开始，不再铺那一行。 */

    if (!rows.length) {
      var empty = document.createElement("div");
      empty.className = "phone-empty";
      empty.textContent = "还没有可以聊天的角色。先开启角色扮演、建一条线再来。";
      box.appendChild(empty);
      return;
    }
    rows.forEach(function (r, idx) {
      var item = document.createElement("div");
      item.className = "phone-item";
      if (ps.enterAnim) { item.className += " ph-item-enter"; item.style.animationDelay = Math.min(idx, 8) * 26 + "ms"; }
      if (r.isGroup) item.appendChild(groupAvatarEl());
      else item.appendChild(avatarEl(avatarOf(r.ch, r.avLine), "assistant"));
      var mid = document.createElement("div");
      mid.className = "phone-item-mid";
      var nm = document.createElement("div");
      nm.className = "phone-item-name";
      nm.textContent = r.isGroup
        ? (r.s.title || "群聊")
        : (nameOf(r.ch, r.avLine) + (r.lines.length > 1 ? "（" + r.lines.length + " 条线）" : ""));
      mid.appendChild(nm);
      var pv = document.createElement("div");
      pv.className = "phone-item-pv";
      pv.textContent = r.last ? previewOf(r.last) : "还没有手机消息";
      mid.appendChild(pv);
      item.appendChild(mid);
      var right = document.createElement("div");
      right.className = "phone-item-right";
      if (r.last) { var tm = document.createElement("div"); tm.className = "phone-item-time"; tm.textContent = hmOf(r.last.ts, (r.avLine && r.avLine.id) || (r.s && r.s.id) || ""); right.appendChild(tm); }
      /* 一个角色有多条线 → 右侧给个箭头，示意「点开里面有东西」（按角色分组） */
      var multi = !r.isGroup && r.lines.length > 1;
      var opened = !!(multi && ps.expandChar === r.charId);
      if (multi) {
        var caret = document.createElement("span");
        caret.className = "phone-item-caret" + (opened ? " open" : "");
        caret.innerHTML = UI.iconSvg("chevron-down");
        right.appendChild(caret);
      }
      item.appendChild(right);
      if (opened) item.className += " open";
      /* 点整行切展开/收起。收起时写回 null（不是 ""）—— 见 expandChar 的注释。 */
      var toggleChar = function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        ps.expandChar = opened ? null : r.charId;
        renderList();
      };
      item.addEventListener("click", function (ev) {
        if (r.isGroup) { openChat(r.s.id); return; }
        /* 按角色分组：点角色 → 就地展开它名下的线；只有一条线就直接进聊天 */
        if (multi) { toggleChar(ev); return; }
        openChat(r.lines[0].id);
      });
      /* 右侧箭头本身也绑一次：它有时候会先吃掉点击（子元素），单独兜一层 */
      if (caret) {
        caret.addEventListener("click", function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          toggleChar(ev);
        });
      }
      box.appendChild(item);
      if (opened) box.appendChild(lineSubEl(r));
    });
    /* 入场动画只播一次：这一次渲染已经带上了延迟，清掉标志，之后重渲染不再闪 */
    if (ps.enterAnim) setTimeout(function () { ps.enterAnim = false; }, 700);
  }
  /* 展开区：把某个角色名下的几条线铺在角色行下面（点角色就地展开，不再弹「选择和哪条线」） */
  function lineSubEl(r) {
    var sub = document.createElement("div");
    sub.className = "phone-sub";
    var sorted = r.lines.slice().sort(function (a, b) {
      return (b.mainLine ? 1 : 0) - (a.mainLine ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    sorted.forEach(function (s, i) {
      var row = document.createElement("div");
      row.className = "phone-sub-item";
      if (ps.enterAnim) { row.className += " ph-item-enter"; row.style.animationDelay = Math.min(i + 2, 9) * 26 + "ms"; }
      var dot = document.createElement("span");
      dot.className = "phone-sub-dot";
      var t = document.createElement("span");
      t.className = "phone-sub-title";
      t.textContent = s.title || "新对话";
      row.appendChild(dot); row.appendChild(t);
      if (s.mainLine) {
        var tag = document.createElement("span");
        tag.className = "phone-sub-tag";
        tag.textContent = "主线";
        row.appendChild(tag);
      }
      var cnt = (s.phone && s.phone.msgs) ? s.phone.msgs.length : 0;
      if (cnt) {
        var c = document.createElement("span");
        c.className = "phone-sub-count";
        c.textContent = cnt + " 条";
        row.appendChild(c);
      }
      row.addEventListener("click", function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        openChat(s.id);
      });
      sub.appendChild(row);
    });
    return sub;
  }
  function groupAvatarEl() {
    var box = document.createElement("div");
    box.className = "ph-av";
    box.innerHTML = UI.iconSvg("account-group");
    return box;
  }
  function hmOf(ts, sid) {
    if (!ts) return "";
    var d = new Date(storyMs(ts, sid));
    return pad2n(d.getHours()) + ":" + pad2n(d.getMinutes());
  }
  /* 一个角色有多条线时，原来是弹「选择和哪条线聊天」——
     现在改成在列表里就地展开（见 lineSubEl），少一次弹层、少一次选择。 */

  /* ── 聊天视图 ─────────────────────────────────────── */
  /* 每次进聊天页把计数归零：这样刚打开时整屏消息不会集体播一遍入场动画 */
  function resetEnterAnim() { prevCount = 0; }

  function openChat(sid) {
    var s = sessionById(sid);
    if (!s) { toast("这条对话已经不在了", true); goList(); return; }
    ps.sid = sid;
    ps.view = "chat";
    /* 多选态与「查看更早」的条数都是上一条线残留的：不复位的话，
       新线一进来就带着上次的多选条、并按上一条线展开过的条数渲染。
       注意别清 ps.busy —— 别的线可能还在生成（提示文案靠 busySid 认归属）。 */
    ps.pick = null;
    ps.phoneLimit = 0;
    var ch = characterFor(s);
    setText("#phoneTitle", s.isGroup
      ? (s.title || "群聊")
      : (nameOf(ch, s) + (s.title && s.title !== "新对话" ? " · " + s.title : "")));
    /* 10-18：进角色消息界面要有转场 —— 聊天页从右侧整页推进来，
       下面的列表同步左移一点（视差），推完再藏。用户点名说的就是这一处。 */
    switchView($("#phoneChatView"), ps.enterAnim ? 0 : 1);
    resetEnterAnim();   /* 刚进来不播入场，直接到位 */
    renderChat();
    setTimeout(scrollPhoneBottom, 20);
  }

  /* 开场白按钮：只有「空对话 + 还没生成过」才出现（跟主聊天同一套判定）。 */
  function syncPhoneOpening() {
    var btn = $("#phoneOpeningBtn");
    if (!btn) return;
    if (!btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", function () {
        /* 必须走手机自己的生成链：DL.startOpening 内部是 continueLast() → session()，
           取的是主聊天当前线，从手机点下去会写进别的会话，手机页毫无变化。
           genReply(sid) 全程按 sid 写回，不会串线。 */
        if (ps.busy || ps.sending || !ps.sid) return;
        var s0 = sessionById(ps.sid);
        if (!s0) return;
        var ms0 = (phoneOf(s0) || {}).msgs || [];
        if (ms0.some(function (m) { return m && m.role === "user" && m.kind !== "recalled"; })) return;
        genReply(ps.sid);
      });
    }
    var s = ps.sid ? sessionById(ps.sid) : null;
    /* 判定要看「当前这一页」的消息：手机页看 phone.msgs，主聊天才看 messages。
       以前只查 messages —— 手机里明明聊过，按钮还挂在气泡上方挡着（10-21 修）。
       撤回的不算说过话。 */
    var msgs = [];
    if (s) msgs = (ps.view === "chat") ? ((phoneOf(s) || {}).msgs || []) : (s.messages || []);
    var live = msgs.filter(function (m) { return m && m.kind !== "recalled"; });
    var mine = live.some(function (m) { return m.role === "user"; });
    var said = live.some(function (m) { return m.role === "assistant"; });
    var show = !!(s && ps.view === "chat" && !mine && !ps.busy);
    var label = btn.querySelector("span:last-child");
    if (label) label.textContent = said ? "再说一次" : "生成第一句话";
    btn.hidden = !show;
  }

  function renderChat() {
    var box = $("#phoneMsgs");
    if (!box) return;
    renderAtBtn();                    /* 群聊才有 @（10-20） */
    syncPhoneOpening();               /* 空消息时下面会提前 return，这里必须先定一次显隐 */
    if (ps.pick) renderPickBar();     /* 多选态保留操作条 */
    /* 重建 DOM 会把 scrollTop 打回顶上，之后再也判断不出「刚才贴不贴底」——
       所以先记一笔，供后面的 scrollPhoneBottom() 决定要不要滚。 */
    wasAtBottom = atPhoneBottom();
    var s = sessionById(ps.sid);
    box.innerHTML = "";
    var ph = phoneOf(s);
    if (!ph || !ph.msgs.length) {
      var tip = document.createElement("div");
      tip.className = "phone-tip";
      tip.textContent = "这里是你和对方的手机聊天。可以发消息、转账、发位置 / 图片 / 语音，也可以打一通电话。";
      box.appendChild(tip);
      return;
    }
    /* 新来的消息才播「从下方弹入」——整块重渲时旧消息不重放，否则每次都闪一片。
       prevCount 为 0 表示这是首次渲染（刚进聊天页），一律不播。 */
    var total = ph.msgs.length;
    /* 只画最近 N 条：以前一次把全部消息建进 DOM，两三百条后每次操作都要重画整屏。
       数据一条不少，「查看更早」点一次往前加 80 条。 */
    var PH_PAGE = 80;
    var shown = Math.min(total, ps.phoneLimit || PH_PAGE);
    var start = total - shown;
    if (start > 0) {
      var more = document.createElement("button");
      more.type = "button";
      more.className = "earlier-msg";
      more.textContent = "↑ 还有 " + start + " 条更早的消息";
      more.addEventListener("click", function () {
        ps.phoneLimit = (ps.phoneLimit || PH_PAGE) + PH_PAGE;
        renderChat();
        scrollPhoneBottom(true);
      });
      box.appendChild(more);
    }
    var prevTs = 0;
    ph.msgs.forEach(function (m, i) {
      if (i < start) return;
      /* 和上一条隔了 3 分钟以上（或这是第一条）→ 插一条居中的时分。
         **自己发的、对方发的都算**（用户口径）。 */
      if (!prevTs || (m.ts && (m.ts - prevTs) > PH_TIME_GAP)) box.appendChild(phTimeEl(m.ts));
      if (m.ts) prevTs = m.ts;
      var el = msgEl(m);
      if (prevCount > 0 && i >= prevCount) el.className += " ph-enter";
      box.appendChild(el);
    });
    prevCount = total;
    syncPhoneOpening();
    if (window.DL && window.DL.bindEmojiPanel) window.DL.bindEmojiPanel();
  }

  /* 居中的时间分隔（走故事时间） */
  function phTimeEl(ts) {
    var d = document.createElement("div");
    d.className = "ph-time";
    var ms = storyMs(typeof ts === "number" ? ts : Date.now());
    d.textContent = (Memory && Memory.fmtStoryShort) ? Memory.fmtStoryShort(ms) : hmOf(ts);
    return d;
  }

  /* 长按（520ms）：手机上没有右键，删除只能靠长按。
     触摸和鼠标都绑 —— 真机走 touch，无头测试 / 桌面预览走 mouse。 */
  var lpTimer = null;
  function bindLongPress(el, fn) {
    var start = function () {
      clearTimeout(lpTimer);
      lpTimer = setTimeout(function () { lpTimer = null; try { fn(); } catch (e) { /* ignore */ } }, 520);
    };
    var stop = function () { clearTimeout(lpTimer); lpTimer = null; };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchend", stop);
    el.addEventListener("touchmove", stop);
    el.addEventListener("mousedown", start);
    el.addEventListener("mouseup", stop);
    el.addEventListener("mouseleave", stop);
  }

  /* 气泡旁的浮层菜单（10-20 用户口径：不要那个大弹窗，改成贴着我长按的那条气泡）。
     定位用 getBoundingClientRect + fixed；上方放不下就翻到下方。 */
  function closeBubbleMenu() {
    var el = document.querySelector(".ph-bubmenu");
    if (el) el.parentNode.removeChild(el);
    document.removeEventListener("click", closeBubbleMenu, true);
  }
  function showBubbleMenu(anchor, items) {
    closeBubbleMenu();
    if (!anchor || !items || !items.length) return;
    var box = document.createElement("div");
    box.className = "ph-bubmenu";
    items.forEach(function (it) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ph-bubmenu-item" + (it.danger ? " danger" : "");
      b.textContent = it.label;
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        closeBubbleMenu();
        try { it.fn(); } catch (e) { /* ignore */ }
      });
      box.appendChild(b);
    });
    document.body.appendChild(box);
    var r = anchor.getBoundingClientRect();
    var bw = box.offsetWidth || 140, bh = box.offsetHeight || 120;
    var top = r.top - bh - 8;
    if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - bh - 8);
    var left = r.left + r.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    box.style.top = top + "px";
    box.style.left = left + "px";
    setTimeout(function () { document.addEventListener("click", closeBubbleMenu, true); }, 0);
  }

  /* 朗读 / 搜索 / 复制（10-20：手机用户菜单要对齐主聊天那套） */
  function speakPhoneMsg(m) {
    try {
      if (!Media || !Media.speak) { toast("朗读不可用", true); return; }
      var t = msgText(m);
      if (!t) { toast("这条没有可读的文字", true); return; }
      Media.speak(t, voiceSet());
    } catch (e) { toast("朗读失败", true); }
  }
  function searchPhoneText(m) {
    var t = msgText(m);
    if (!t) return;
    try {
      if (D.openSearchModal) D.openSearchModal();
      var kw = $("#histKeyword");
      if (kw) kw.value = String(t).slice(0, 40);
      var mod = $("#histModule");
      if (mod) mod.value = "phone";
      if (D.fillHistScope) D.fillHistScope();
      var sc = $("#histScope");
      if (sc) sc.value = "line:" + ps.sid;
    } catch (e) { /* ignore */ }
  }

  /* 删之前问一句：手机消息删了两边一起没，得让人有反悔的机会 */
  function confirmDeletePhoneMsg(msg) {
    UI.confirmDialog("删除消息", "这条消息会一起从主聊天那边删掉，删了没法恢复。确定吗？").then(function (ok) {
      if (!ok) return;
      if (deletePhoneMsg(ps.sid, msg)) { renderChat(); toast("已删除"); }
    });
  }

  /* 长按气泡弹出的操作（10-18 用户要求）：
     对方的消息 → 重说 / 修改 / 删除；我自己的 → 撤回。 */
  function openMsgMenu(msg) {
    var isUser = msg.role === "user";
    var box = document.createElement("div");
    box.className = "ph-set";
    function item(label, fn, danger) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn" + (danger ? "" : " ghost");
      b.textContent = label;
      b.style.display = "block";
      b.style.width = "100%";
      b.style.marginTop = "8px";
      b.addEventListener("click", function () { closeSheet(); fn(); });
      return b;
    }
    /* 多选放第一项（10-20：两种消息都能多选，用户消息长按弹的就是这个菜单） */
    box.appendChild(item("多选（转发 / 合并转发）", function () { enterPick(msg); }));
    if (isUser) {
      box.appendChild(item("撤回这条", function () { recallPhoneMsg(msg); }, true));
    } else {
      box.appendChild(item("重说（重新生成）", function () { regenPhoneMsg(msg); }));
      box.appendChild(item("修改这条", function () { editPhoneMsg(msg); }));
      box.appendChild(item("删除", function () { confirmDeletePhoneMsg(msg); }, true));
    }
    openSheet("这条消息", box, closeSheet);
  }

  /* 撤回：不真删，改成一条「已撤回」的占位 ——
     角色要能看见这个动作（msgText 会把原文一并交代），上下文里也留痕。
     10-20 增强（用户口径）：
       ① 还在生成 → 直接中断请求，本轮不再落库；
       ② 已经生成出的对应回复 → 一起撤回（两分钟内紧跟的那条）； */
  function recallPhoneMsg(msg) {
    var list = Store.getSessions();
    var i = -1;
    for (var k = 0; k < list.length; k++) { if (list[k].id === ps.sid) { i = k; break; } }
    if (i < 0) return;
    var ph = phoneOf(list[i]);
    var at = ph.msgs.indexOf(msg);
    if (at < 0) return;

    /* ① 生成中：中断 + 让旧回调作废（seq 加一，finally 里就不会再动新状态）。
       只中断「本线」的请求：ps.abort 是单例，以前在 B 线撤回会把 A 线正在跑的请求打断。 */
    if (ps.busy && ps.abort && (!ps.busySid || ps.busySid === ps.sid)) {
      try { ps.abort.abort(); } catch (e) { /* ignore */ }
      ps.seq = (ps.seq || 0) + 1;
      ps.busy = false;
      ps.busySid = "";
      ps.abort = null;
      try { hideTyping(); } catch (e) { /* ignore */ }
      try { setDisabled("#phoneSend", false); } catch (e) { /* ignore */ }
    }

    /* ② 这一轮 AI 说的话全部一起撤回：长回复会被拆成 2-6 条（splitPhoneReply），
       以前只处理 at+1，剩下几条原样留着 —— 用户看到的是「撤了一半」。 */
    var killed = [];
    for (var j = at + 1; j < ph.msgs.length; j++) {
      var nx = ph.msgs[j];
      if (!nx || nx.role !== "assistant") break;
      if (nx.kind === "recalled") continue;
      if ((nx.ts || 0) - (msg.ts || 0) >= 180000) break;
      if (nx.id) killed.push(nx.id);
      ph.msgs[j] = {
        id: nx.id || ("pm_" + Date.now().toString(36)),
        role: "assistant",
        kind: "recalled",
        text: "",
        origText: String(nx.text || ""),
        ts: nx.ts || Date.now()
      };
    }
    /* 主聊天里挂在这些消息上的「线下侧写」也要撤 —— 删除路径已经这么做了，撤回漏了。
       不然手机里撤干净了，主聊天还留着同一句话。 */
    if (killed.length && Array.isArray(list[i].messages)) {
      list[i].messages = list[i].messages.filter(function (m) {
        return !(m && killed.indexOf(m.phoneMsgId) >= 0);
      });
    }

    ph.msgs[at] = {
      id: msg.id || ("pm_" + Date.now().toString(36)),
      role: "user",
      kind: "recalled",
      text: "",
      origText: String(msg.text || ""),
      ts: msg.ts || Date.now()
    };
    list[i].updatedAt = Date.now();
    Store.saveSessions(list);
    renderChat();
    toast("已撤回");
  }

  /* ── 转发 / 合并转发 / 多选（10-20 用户要求）────────────────
     转发对象：每个角色一行（进它的主线）、每个群一行；可多选。
     合并转发：勾选多条 → 生成一张「聊天记录」卡片，点开看列表。
     AI 要分得清谁是谁 —— 合并转发的每条都写成「名字：内容」，提示词里注明这是转发记录。 */
  function fwdTargets() {
    var out = [];
    var chs = Store.getCharacters() || [];
    var sess = Store.getSessions() || [];
    var seen = {};
    sess.forEach(function (s) {
      if (!s || s.isGroup) return;
      var cid = s.characterId || "";
      if (!cid || seen[cid]) return;
      seen[cid] = 1;
      var ch = chs.filter(function (c) { return c && c.id === cid; })[0];
      out.push({
        kind: "char", id: cid,
        name: (ch && ((ch.fields && ch.fields.aiName) || ch.name)) || "角色"
      });
    });
    sess.forEach(function (s) {
      /* 转发目标与手机列表同一口径：只列手机群。转进现实群会写进主群的 phone.msgs，
         而主群读的是 messages —— 转过去等于扔进看不见的地方。 */
      if (!s || !s.isGroup || !s.phoneGroup) return;
      out.push({ kind: "group", id: s.id, name: s.title || "群聊" });
    });
    return out;
  }

  function lineOfTarget(t) {
    var sess = Store.getSessions() || [];
    if (t.kind === "group") return sess.filter(function (s) { return s.id === t.id; })[0] || null;
    var mine = sess.filter(function (s) { return !s.isGroup && (s.characterId || "") === t.id; });
    return mine.filter(function (s) { return s.mainLine; })[0] || mine[0] || null;
  }

  function curPh() {
    var s = sessionById(ps.sid);
    return s ? phoneOf(s) : null;
  }

  /* 进入多选：给没有 id 的消息补一个，后面就靠 id 记选中 */
  function enterPick(startMsg) {
    var s = sessionById(ps.sid);
    if (!s) return;
    var ph = phoneOf(s);
    ph.msgs.forEach(function (m, i) {
      if (!m.id) m.id = "pm_" + Date.now().toString(36) + "_" + i;
    });
    Store.saveSessions(Store.getSessions());
    ps.pick = {};
    if (startMsg && startMsg.id) ps.pick[startMsg.id] = true;
    renderChat();
    renderPickBar();
  }
  function exitPick() {
    ps.pick = null;
    renderChat();
    renderPickBar();
  }
  function pickCount() { return ps.pick ? Object.keys(ps.pick).length : 0; }
  function pickedMsgs() {
    var ph = curPh();
    if (!ph || !ps.pick) return [];
    return ph.msgs.filter(function (m) { return m.id && ps.pick[m.id]; });
  }

  /* 底部操作条：只在多选时出现 */
  function renderPickBar() {
    var host = $("#phoneChatView");
    if (!host) return;
    var bar = host.querySelector(".ph-pickbar");
    if (!ps.pick) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "ph-pickbar";
      /* 插在输入框**之前**：多选条要顶在输入框的位置上（原来 appendChild 会跑到输入框下面） */
      var comp = host.querySelector(".phone-composer");
      if (comp) host.insertBefore(bar, comp); else host.appendChild(bar);
    }
    bar.innerHTML = "";
    var n = pickCount();
    var info = document.createElement("span");
    info.className = "ph-pick-n";
    info.textContent = "已选 " + n + " 条";
    bar.appendChild(info);
    function btn(label, fn, primary) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn " + (primary ? "primary" : "ghost");
      b.textContent = label;
      b.addEventListener("click", fn);
      bar.appendChild(b);
    }
    btn("转发", function () { if (!n) { toast("先选几条", true); return; } pickTargets(function (ts) { doForward(pickedMsgs(), ts); }); });
    btn("合并转发", function () { if (!n) { toast("先选几条", true); return; } pickTargets(function (ts) { doMergeForward(pickedMsgs(), ts); }); });
    btn("删除", function () {
      if (!n) { toast("先选几条", true); return; }
      UI.confirmDialog("删除消息", "选中的 " + n + " 条会从手机聊天里删掉，删了没法恢复。确定吗？").then(function (ok) {
        if (!ok) return;
        var c = deletePhoneMsgs(pickedMsgs());
        exitPick();
        toast(c ? ("已删除 " + c + " 条") : "没删掉");
      });
    }, true);
    btn("取消", exitPick);
  }

  /* @ 提醒（10-20）：只有群聊显示；点了选成员，把「@名字」插进输入框 */
  function renderAtBtn() {
    var comp = document.querySelector(".phone-composer");
    if (!comp) return;
    var s = sessionById(ps.sid);
    var btn = comp.querySelector(".ph-at-btn");
    if (!s || !s.isGroup) { if (btn) btn.remove(); return; }
    if (btn) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn ph-at-btn";
    btn.setAttribute("aria-label", "提醒谁看");
    btn.textContent = "@";
    btn.addEventListener("click", openAtPicker);
    comp.insertBefore(btn, comp.firstChild);
  }

  function openAtPicker() {
    var s = sessionById(ps.sid);
    if (!s || !s.isGroup) return;
    var members = phoneGroupMembers(s);
    if (!members.length) { toast("这个群还没有成员", true); return; }
    var box = document.createElement("div");
    box.className = "ph-set";
    members.forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn ghost";
      b.style.display = "block";
      b.style.width = "100%";
      b.style.marginTop = "8px";
      b.textContent = "@" + m.name;
      b.addEventListener("click", function () {
        var inp = $("#phoneInput");
        if (inp) {
          var cur = String(inp.value || "").replace(/\s+$/, "");
          inp.value = (cur ? cur + " " : "") + "@" + m.name + " ";
          try { inp.focus(); } catch (e) { /* ignore */ }
        }
        closeSheet();
      });
      box.appendChild(b);
    });
    openSheet("提醒谁看", box, closeSheet);
  }

  /* 选转发对象（可多选） */
  function pickTargets(done) {
    var ts = fwdTargets();
    if (!ts.length) { toast("还没有可以转发的对象", true); return; }
    var box = document.createElement("div");
    box.className = "ph-set";
    var chosen = {};
    ts.forEach(function (t) {
      var lab = document.createElement("label");
      lab.className = "check-field";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.addEventListener("change", function () {
        if (cb.checked) chosen[t.kind + ":" + t.id] = t; else delete chosen[t.kind + ":" + t.id];
      });
      var sp = document.createElement("span");
      sp.textContent = (t.kind === "group" ? "群 · " : "") + t.name;
      lab.appendChild(cb); lab.appendChild(sp);
      box.appendChild(lab);
    });
    openSheet("转发给", box, function () {
      var list = Object.keys(chosen).map(function (k) { return chosen[k]; });
      if (!list.length) { toast("至少选一个对象", true); return; }
      done(list);
    });
  }

  function speakerLabel(m, ph) {
    if (m.role === "user") return "我";
    if (m.speakerName) return String(m.speakerName);
    var s = sessionById(ps.sid);
    var ch = s ? characterFor(s) : null;
    return (ch && ((ch.fields && ch.fields.aiName) || ch.name)) || "对方";
  }

  function doForward(msgs, targets) {
    var ph = curPh();
    var rows = (msgs || []).map(function (m) {
      return { name: speakerLabel(m, ph), text: msgText(m) || previewOf(m) };
    }).filter(function (x) { return x.text; });
    if (!rows.length) { toast("没有可转发的内容", true); return; }
    var n = 0;
    targets.forEach(function (t) {
      var line = lineOfTarget(t);
      if (!line) return;
      rows.forEach(function (x) {
        pushMsg(line.id, { role: "user", kind: "text", text: (x.name === "我" ? "" : x.name + "：") + x.text, fwd: true });
      });
      n++;
    });
    exitPick();
    toast(n ? ("已转发给 " + n + " 个对象") : "没转出去", !n);
  }

  function doMergeForward(msgs, targets) {
    var ph = curPh();
    var items = (msgs || []).map(function (m) {
      return { name: speakerLabel(m, ph), text: msgText(m) || previewOf(m) };
    }).filter(function (x) { return x.text; });
    if (!items.length) { toast("没有可转发的内容", true); return; }
    /* 来源（10-20）：卡片上写清楚是从谁那儿转来的，AI 和人都好分辨 */
    var srcName = "";
    try {
      var s0 = sessionById(ps.sid);
      if (s0) {
        if (s0.isGroup) srcName = s0.title || "群聊";
        else {
          var c0 = characterFor(s0);
          srcName = (c0 && ((c0.fields && c0.fields.aiName) || c0.name)) || "";
        }
      }
    } catch (e) { srcName = ""; }
    var n = 0;
    targets.forEach(function (t) {
      var line = lineOfTarget(t);
      if (!line) return;
      pushMsg(line.id, { role: "user", kind: "fwdmerge", items: items, text: "", from: srcName });
      n++;
    });
    exitPick();
    toast(n ? ("已合并转发给 " + n + " 个对象") : "没转出去", !n);
  }

  function editPhoneMsg(msg) {
    var box = document.createElement("div");
    box.className = "ph-set";
    var ta = document.createElement("textarea");
    ta.rows = 3;
    ta.value = String(msg.text || "");
    ta.style.width = "100%";
    box.appendChild(ta);
    openSheet("修改这条消息", box, function () {
      var t = String(ta.value || "").trim();
      if (!t) { toast("不能改成空的", true); return; }
      var list = Store.getSessions();
      var i = -1;
      for (var k = 0; k < list.length; k++) { if (list[k].id === ps.sid) { i = k; break; } }
      if (i < 0) return;
      var ph = phoneOf(list[i]);
      var at = ph.msgs.indexOf(msg);
      if (at < 0) return;
      ph.msgs[at].text = t;
      list[i].updatedAt = Date.now();
      Store.saveSessions(list);
      closeSheet();
      renderChat();
      toast("已改");
      /* 10-18 用户要求：改过的消息，主聊天里绑定的那段「线下」也要跟着变 ——
         否则会出现「手机里说的是 A，主聊天里她还对着 B 的状态」这种前后对不上的情况。 */
      if (msg && msg.id) regenOfflineFor(ps.sid, msg.id);
    });
  }

  /* 只重画「此刻的样子」那一段（改完手机消息后调用）。
     不重新生成对话，只让模型按改过之后的聊天内容重写一遍〖线下〗，
     然后替换掉原来绑定的那条 —— 保持一一对应，不会留下前后矛盾的旧侧写。 */
  async function regenOfflineFor(sid, phoneMsgId) {
    var s = sessionById(sid);
    if (!s || !phoneMsgId) return;
    if (!state.settings.apiKey) return;
    var ch = characterFor(s);
    try {
      var msgs = buildPhoneMessages(s, ch);
      /* 附在最后的是一条「系统指令」，不是角色台词，不会被当成人说的话 */
      msgs.push({
        role: "user",
        content: "（系统指令，不是角色台词：刚才那条消息改过了，请只按现在的聊天内容，" +
          "重新写一遍你此刻在现实里的样子，格式 〖线下〗内容〖/线下〗，不要写任何对话。）"
      });
      var result = await Api.run({
        settings: phoneSettings(s),
        messages: msgs,
        thinking: false,
        effort: "low",
        signal: null,
        search: null
      }, { onContent: function () {} });
      var txt = cleanReply((result && result.content) || "");
      var off = splitOffline(txt);
      var body = String(off.offline || txt || "").trim();
      if (!body) return;
      var list = Store.getSessions();
      var i = -1;
      for (var k = 0; k < list.length; k++) { if (list[k].id === sid) { i = k; break; } }
      if (i < 0) return;
      var rec = list[i];
      if (!Array.isArray(rec.messages)) rec.messages = [];
      rec.messages = rec.messages.filter(function (m) { return !m || m.phoneMsgId !== phoneMsgId; });
      rec.messages.push({
        role: "assistant",
        ts: Date.now(),
        content: body,
        offline: true,
        phoneMsgId: phoneMsgId,
        variants: [{ content: body, q: 0 }],
        vi: 0
      });
      rec.updatedAt = Date.now();
      Store.saveSessions(list);
      if (sid === state.sessionId) { try { D.renderMessages && D.renderMessages(); } catch (e) { /* ignore */ } }
    } catch (e) { /* 侧写重画失败不影响消息本身已经改好 */ }
  }

  /* 重说：把这条删掉，重新生成一轮（生成结果可能是一条也可能是几条短消息） */
  function regenPhoneMsg(msg) {
    var list = Store.getSessions();
    var i = -1;
    for (var k = 0; k < list.length; k++) { if (list[k].id === ps.sid) { i = k; break; } }
    if (i < 0) return;
    var ph = phoneOf(list[i]);
    var at = ph.msgs.indexOf(msg);
    if (at >= 0) ph.msgs.splice(at, 1);
    /* 绑定的那条线下侧写一起清掉，免得重新生成后留下两条 */
    var key = msg.id || "";
    if (key && Array.isArray(list[i].messages)) {
      list[i].messages = list[i].messages.filter(function (m) { return !m || m.phoneMsgId !== key; });
    }
    list[i].updatedAt = Date.now();
    Store.saveSessions(list);
    renderChat();
    genReply(ps.sid);
  }

  function msgEl(m) {
    var wrap = document.createElement("div");
    wrap.className = "ph-row " + (m.role === "user" ? "me" : "ta") + (m.kind === "sys" ? " sys" : "");
    var s = sessionById(ps.sid);
    var ch = characterFor(s);
    var avUrl;
    if (m.role === "user") avUrl = state.settings.phoneAvatarUser || state.settings.avatarUser || "";
    else if (m.speaker) avUrl = avatarOf(charById(m.speaker) || ch, s);
    else avUrl = avatarOf(ch, s);
    wrap.appendChild(avatarEl(avUrl, m.role === "user" ? "user" : "assistant"));
    var col = document.createElement("div");
    col.className = "ph-col";
    /* 群聊：谁说的，标在气泡上方 */
    if (m.role !== "user" && m.speakerName) {
      var who = document.createElement("div");
      who.className = "ph-name";
      who.textContent = m.speakerName;
      col.appendChild(who);
    }
    var bubble;
    if (m.kind === "transfer") bubble = transferCard(m);
    else if (m.kind === "location") bubble = locationCard(m);
    else if (m.kind === "image") bubble = imageBubble(m);
    else if (m.kind === "voice") bubble = voiceBubble(m);
    else if (m.kind === "call") bubble = callBubble(m);
    else if (m.kind === "fwdmerge") bubble = fwdMergeCard(m);
    else {
      bubble = document.createElement("div");
      bubble.className = "ph-bubble";
      bubble.textContent = String(m.text || "");
      /* （…）里的旁白/动作染灰，和正话分开（与主聊天同一套处理） */
      if (UI && UI.grayParens) UI.grayParens(bubble);
    }
    if (m.kind === "sys") {
      wrap.innerHTML = "";
      var sysEl = document.createElement("div");
      sysEl.className = "ph-sys";
      sysEl.textContent = String(m.text || "");
      wrap.appendChild(sysEl);
      return wrap;
    }
    /* 撤回的占位：居中的一行小灰字，不带头像 */
    if (m.kind === "recalled") {
      wrap.innerHTML = "";
      var rc = document.createElement("div");
      rc.className = "ph-recalled";
      rc.textContent = (m.role === "user" ? "你" : "对方") + "撤回了一条消息";
      wrap.appendChild(rc);
      return wrap;
    }
    col.appendChild(bubble);
    wrap.appendChild(col);
    try { if (UI.stickerize) UI.stickerize(col); } catch (e) { /* ignore */ }
    /* 多选（10-20）：多选态下点一下切换选中，长按菜单让位。
       用**捕获阶段**：先于气泡内部的点击（合并转发卡片 / 图片放大 / 语音播放）执行，
       stopPropagation 才能真的把它们拦下来 —— 挂冒泡阶段会「既打开又取消选中」。 */
    if (ps.pick) {
      wrap.classList.add("ph-pickable");
      if (m.id && ps.pick[m.id]) wrap.classList.add("ph-picked");
      wrap.addEventListener("click", function (ev) {
        if (!ps.pick) return;
        ev.preventDefault(); ev.stopPropagation();
        if (!m.id) return;
        if (ps.pick[m.id]) delete ps.pick[m.id]; else ps.pick[m.id] = true;
        renderChat(); renderPickBar();
      }, true);
      return wrap;
    }
    /* 长按（10-20 用户口径，对齐主聊天）：
       AI 消息 → 直接进多选（在里面选删除 / 转发 / 合并转发）
       我的消息 → 气泡旁浮出菜单：撤回 / 多选 / 删除本条（删除要确认，撤回不要） */
    if (m.kind !== "sys" && m.kind !== "recalled") {
      bindLongPress(bubble, function () {
        if (m.role !== "user") { enterPick(m); return; }
        showBubbleMenu(bubble, [
          { label: "修改", fn: function () { editPhoneMsg(m); } },
          { label: "朗读", fn: function () { speakPhoneMsg(m); } },
          { label: "搜索", fn: function () { searchPhoneText(m); } },
          { label: "复制", fn: function () { UI.copyText(msgText(m)).then(function (ok) { toast(ok ? "已复制" : "复制失败", !ok); }); } },
          { label: "撤回", fn: function () { recallPhoneMsg(m); } },
          { label: "多选", fn: function () { enterPick(m); } },
          {
            label: "删除本条", danger: true,
            fn: function () {
              /* 文案必须和行为一致：这条路径会连主聊天里绑定的那条线下侧写一起删
                 （见 deletePhoneMsg）。想只删手机里这一条，用「撤回」。 */
              UI.confirmDialog("删除这条消息", "会一起删掉主聊天里对应的那条线下描写，删了没法恢复。只想删手机里这条？取消后用「撤回」。").then(function (ok) {
                if (!ok) return;
                if (deletePhoneMsgOne(m)) { renderChat(); toast("已删除"); }
              });
            }
          }
        ]);
      });
    }
    return wrap;
  }

  /* 微信转账样式卡 */
  function transferCard(m) {
    var card = document.createElement("div");
    card.className = "ph-transfer";
    var top = document.createElement("div");
    top.className = "ph-transfer-top";
    var ic = document.createElement("div");
    ic.className = "ph-transfer-ic";
    ic.innerHTML = UI.iconSvg("cash");
    var amt = document.createElement("div");
    amt.className = "ph-transfer-amt";
    amt.textContent = fmtMoney(m.amount);
    var note = document.createElement("div");
    note.className = "ph-transfer-note";
    note.textContent = m.note ? String(m.note) : "转账";
    var main = document.createElement("div");
    main.className = "ph-transfer-main";
    main.appendChild(amt); main.appendChild(note);
    top.appendChild(ic); top.appendChild(main);
    card.appendChild(top);
    var foot = document.createElement("div");
    foot.className = "ph-transfer-foot";
    foot.textContent = "微信转账";
    card.appendChild(foot);
    return card;
  }

  /* 位置概览卡：名字 + 一张程序化生成的「地图」（每次随机换一张） */
  function locationCard(m) {
    var card = document.createElement("div");
    card.className = "ph-loc";
    var cv = document.createElement("canvas");
    cv.className = "ph-loc-map";
    cv.width = 480; cv.height = 300;
    card.appendChild(cv);
    var info = document.createElement("div");
    info.className = "ph-loc-info";
    var nm = document.createElement("div");
    nm.className = "ph-loc-name";
    nm.textContent = String(m.place || "未知地点");
    var sub = document.createElement("div");
    sub.className = "ph-loc-sub";
    sub.textContent = (m.sub || "位置已发送");
    info.appendChild(nm); info.appendChild(sub);
    card.appendChild(info);
    setTimeout(function () { drawMap(cv, m.seed || hashStr(String(m.place || ""))); }, 0);
    return card;
  }
  function hashStr(t) {
    var h = 2166136261;
    for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h;
  }
  /* 程序化画一张「地图」：底色 + 街区 + 道路 + 定位点。seed 不同 → 图不同 */
  function drawMap(cv, seed) {
    try {
      var ctx = cv.getContext("2d");
      if (!ctx) return;
      var W = cv.width, H = cv.height;
    var rnd = mulberry(seed >>> 0);
    var hue = Math.floor(rnd() * 360);
    ctx.fillStyle = "hsl(" + hue + ",28%,88%)";
    ctx.fillRect(0, 0, W, H);
    /* 街区 */
    for (var i = 0; i < 22; i++) {
      var bw = 30 + rnd() * 90, bh = 24 + rnd() * 80;
      var bx = rnd() * (W - bw), by = rnd() * (H - bh);
      ctx.fillStyle = "hsla(" + ((hue + 12) % 360) + ",22%," + (72 + Math.floor(rnd() * 12)) + "%,0.85)";
      roundRect(ctx, bx, by, bw, bh, 6);
      ctx.fill();
    }
    /* 道路 */
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 10 + rnd() * 6;
    for (var r = 0; r < 2; r++) {
      ctx.beginPath();
      var y = 40 + rnd() * (H - 80);
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(W * 0.3, y - 30 + rnd() * 60, W * 0.6, y + 30 - rnd() * 60, W, y - 20 + rnd() * 40);
      ctx.stroke();
    }
    for (var c = 0; c < 2; c++) {
      ctx.beginPath();
      var x = 40 + rnd() * (W - 80);
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + 30 - rnd() * 60, H * 0.3, x - 30 + rnd() * 60, H * 0.6, x + 20 - rnd() * 40, H);
      ctx.stroke();
    }
    /* 定位点 */
    var px = W * (0.3 + rnd() * 0.4), py = H * (0.3 + rnd() * 0.4);
    ctx.beginPath();
    ctx.arc(px, py, 22, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(58,150,255,0.22)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fillStyle = "#3a96ff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    } catch (e) { /* 画不出来就空着，不影响聊天 */ }
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  /* 线性同余伪随机，保证同一 seed 每次画出同一张 */
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function imageBubble(m) {
    var box = document.createElement("div");
    box.className = "ph-image";
    var att = (m.attachments && m.attachments[0]) || null;
    var url = att ? Store.imageURL(att) : (m.dataUrl || "");
    if (url) {
      var im = document.createElement("img");
      im.src = url; im.alt = (m.desc || "");
      box.appendChild(im);
    } else {
      box.textContent = "[图片已过期]";
    }
    return box;
  }
  function voiceBubble(m) {
    var b = document.createElement("div");
    b.className = "ph-voice";
    var waves = document.createElement("span");
    waves.className = "ph-voice-wave";
    var n = Math.min(5, Math.max(2, Math.round((m.dur || 2) / 2)));
    for (var i = 0; i < n; i++) { var s = document.createElement("i"); waves.appendChild(s); }
    var txt = document.createElement("span");
    txt.className = "ph-voice-txt";
    txt.textContent = String(m.text || "") || "[语音]";
    var dur = document.createElement("span");
    dur.className = "ph-voice-dur";
    dur.textContent = (m.dur || Math.max(1, Math.round((m.text || "").length / 4))) + "″";
    /* 顺序：对方（AI）→ 波纹 文字 时长；自己 → 时长 文字 波纹 */
    if (m.role === "user") { b.appendChild(dur); b.appendChild(txt); b.appendChild(waves); }
    else { b.appendChild(waves); b.appendChild(txt); b.appendChild(dur); }
    /* 对方（AI）的语音：点一下用 TTS 播出来 */
    if (m.role !== "user" && m.text) {
      b.classList.add("playable");
      b.addEventListener("click", function () {
        if (!Media || !Media.capable || !Media.capable("tts", state.settings)) return;
        if (m._audio) { try { m._audio.pause(); } catch (e) { /* ignore */ } }
        Media.speak(m.text, voiceSet()).then(function (u) {
          var a = new Audio(u); m._audio = a;
          var rel = function () {
            try { if (String(u).indexOf("blob:") === 0 && window.URL && URL.revokeObjectURL) URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
          };
          a.onended = rel; a.onerror = rel;   /* 播完就回收 blob，别一直占内存 */
          a.play();
        }).catch(function () { /* 静默 */ });
      });
    }
    return b;
  }
  /* 合并转发卡片（10-20）：像微信的「聊天记录」，点开看列表（只读） */
  function fwdMergeCard(m) {
    var card = document.createElement("div");
    card.className = "ph-fwd-merge";
    var t = document.createElement("div");
    t.className = "ph-fwd-title";
    t.textContent = m.from ? ("与「" + m.from + "」的聊天记录") : "聊天记录";
    card.appendChild(t);
    var sub = document.createElement("div");
    sub.className = "ph-fwd-sub";
    sub.textContent = "共 " + ((m.items && m.items.length) || 0) + " 条";
    card.appendChild(sub);
    var foot = document.createElement("div");
    foot.className = "ph-fwd-foot";
    foot.textContent = "聊天记录";
    card.appendChild(foot);
    card.addEventListener("click", function () {
      /* 多选态：这一下是「选中 / 取消选中这条」，不该顺带打开列表 */
      if (ps.pick) return;
      var box = document.createElement("div");
      box.className = "ph-set";
      (m.items || []).forEach(function (x) {
        var row = document.createElement("div");
        row.className = "ph-fwd-row";
        var nm = document.createElement("b");
        nm.textContent = (x.name || "某人") + "：";
        row.appendChild(nm);
        row.appendChild(document.createTextNode(String(x.text || "")));
        box.appendChild(row);
      });
      openSheet("聊天记录", box, closeSheet);
    });
    return card;
  }

  function callBubble(m) {
    var b = document.createElement("div");
    b.className = "ph-callb";
    var ic = document.createElement("span");
    ic.innerHTML = UI.iconSvg("phone-outline");
    var t = document.createElement("span");
    t.textContent = "通话 " + fmtDur(m.dur || 0) + (m.text ? "：" + m.text : "");
    b.appendChild(ic); b.appendChild(t);
    return b;
  }

  var wasAtBottom = true;
  /* 上一次渲染时的消息条数：用来判断哪几条是「新来的」，只给它们播入场动画 */
  var prevCount = 0;
  /* 当前是否贴在消息栏底部（离底 40px 以内都算「在底部」）。
     新消息要不要把聊天框顶上去，就看这个 —— 用户正在翻旧消息时不该被拽走。 */
  function atPhoneBottom() {
    var box = $("#phoneMsgs");
    if (!box) return true;
    return (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
  }

  /* 平滑滚到底：手写 rAF 动画，**不用 CSS 的 scroll-behavior** ——
     一是 jsdom 解析那个属性会去读一个被安全策略拦住的包（测试直接崩），
     二是手写能控时长和缓动，更像微信/QQ 那种「新消息把聊天框顶上去」的观感。 */
  var scrollRaf = 0;
  function smoothScrollBottom(box, dur) {
    if (!box) return;
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    var to = box.scrollHeight - box.clientHeight;
    var from = box.scrollTop;
    if (!(to > from)) { box.scrollTop = to < 0 ? 0 : to; return; }
    var t0 = Date.now();
    var total = dur || 260;
    var step = function () {
      var p = Math.min(1, (Date.now() - t0) / total);
      var e = 1 - Math.pow(1 - p, 3);          /* ease-out：先快后慢，落底不弹 */
      box.scrollTop = from + (to - from) * e;
      scrollRaf = p < 1 ? requestAnimationFrame(step) : 0;
    };
    scrollRaf = requestAnimationFrame(step);
  }

  /* 默认一律滚到底：调用它的都是「用户自己的操作」（发消息/转账/发图/发语音/挂断），
     自己做的事必须看得见。
     只有传 false 时才先看一眼「重渲染前贴不贴底」—— 那是**对方主动发消息**的场景，
     用户正在翻旧消息时不该被拽走。 */
  function scrollPhoneBottom(force) {
    var box = $("#phoneMsgs");
    if (!box) return;
    if (force === false && !wasAtBottom) return;
    smoothScrollBottom(box, 260);
  }

  /* 生成中：把顶部标题临时换成「角色名 正在输入…」。
     用户口径（10-18）：不要单独挂一条横条，直接把聊天界面的名字替换掉才像真手机。
     原来那条 #phoneTypingBar 保留但不再显示（怕以后想要），改标题比加条更干净。 */
  function showTyping() {
    var s = sessionById(ps.sid);
    var ch = characterFor(s);
    var t = $("#phoneTitle");
    if (t) {
      if (t.__typingBase == null) t.__typingBase = t.textContent || "";
      t.textContent = (nameOf(ch, sessionById(ps.sid)) || "对方") + " 正在输入…";
      t.classList.add("typing");
    }
  }
  function updateTyping() {
    /* 保留这个入口：调用方仍在逐字回调里调它，但手机端刻意不显示流式内容。
       这里只保证标题还停在「正在输入…」上。 */
    var t = $("#phoneTitle");
    if (t && t.__typingBase == null) showTyping();
  }
  function hideTyping() {
    var t = $("#phoneTitle");
    if (t && t.__typingBase != null) {
      t.textContent = t.__typingBase;
      t.__typingBase = null;
      t.classList.remove("typing");
    }
  }

  /* ── 上下文与生成 ─────────────────────────────────── */
  function phoneSettings(s) {
    var st = Object.assign({}, state.settings);
    if (s && typeof s.temperature === "number") st.temperature = s.temperature;
    if (s && typeof s.topP === "number") st.topP = s.topP;
    st.searchEnabled = false;
    return st;
  }
  /* ── 群聊（手机端）───────────────────────────────── */
  function charById(id) {
    var chars = Store.getCharacters();
    for (var i = 0; i < chars.length; i++) { if (chars[i].id === id) return chars[i]; }
    return null;
  }
  function phoneGroupMembers(s) {
    var ids = (s && Array.isArray(s.members)) ? s.members : [];
    var out = [];
    ids.forEach(function (id) {
      var c = charById(id);
      if (c) out.push({ id: c.id, name: c.name || "角色" });
    });
    return out;
  }
  /* 群成员绑的那条线（10-22：手机群也绑线了，和主群一样）。
     绑定写在自己这份 memberLine 里，主群那份不受影响；老数据没绑就退回他最近的一条线。 */
  function boundLineOf(s, charId) {
    /* 统一走 chat.js 的 lineOfMember：它优先「主线」，这里以前按 updatedAt 取。
       老群（memberLine 没绑）会出现「提示词读的是 X 线，群里的事写进 Y 线」，
       两处兜底必须同一口径，否则记忆会写进不相干的支线。 */
    if (window.DL && typeof window.DL.lineOfMember === "function") {
      return window.DL.lineOfMember(s, charId);
    }
    var bind = (s && s.memberLine) || {};
    var id = bind[charId];
    var hit = id ? sessionById(id) : null;
    if (hit) return hit;
    var list = Store.getSessions().filter(function (x) {
      return !x.isGroup && (x.characterId || "") === charId;
    });
    if (!list.length) return null;
    list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return list[0];
  }

  function buildGroupSysPhone(s) {
    var members = phoneGroupMembers(s);
    if (!members.length) return "这是一个手机群聊，但还没有选成员。";
    var t = "【群聊】这是你和他们在手机上的一个群聊，成员有：" + members.map(function (m) { return m.name; }).join("、") + "。\n";
    members.forEach(function (m) {
      var c = charById(m.id);
      var p = Memory.personaText ? Memory.personaText(c) : "";
      t += "\n—— " + m.name + " ——\n" + (p || "（没有更多设定）") + "\n";
      /* 记忆互通（10-22 用户要求）：读他绑定的那条线 —— 手机单聊和现实扮演用的是同一条线，
         所以这里读到的是「他本人在那条线上经历过的全部」。必须标明只有本人知道，
         否则模型会把 A 的私聊内容当成全群共有的。 */
      var line = boundLineOf(s, m.id);
      if (line) {
        /* 与主群同一个入口（10-23）：关系 / 共同经历 / 场景 / 认知 / 摘要 /
           最近原话 / TA 的思绪 / 图库里的样子，一次读全。 */
        var dz = (Memory.lineDossier) ? Memory.lineDossier(line, c, { budget: 900, talk: 4 }) : "";
        if (dz) {
          t += "（下面这些只是" + m.name + "自己知道的事，不是全群共有的）\n" + dz + "\n";
        }
      }
    });
    /* 表情包不再写进提示词（10-22）：改成双段式——先出正文，再单独问一次「挑不挑表情」。
       提示词里教它写 [表情:…] 会跟正文混在一起，也容易在句子中间乱插。 */
    if (s && s.scene) t += "\n【当前情境】\n" + s.scene + "\n";
    if (s && s.shared) t += "\n【共同经历】\n" + s.shared + "\n";
    var mt = (Memory.memoryForPrompt || Memory.memoryText) ? (Memory.memoryForPrompt || Memory.memoryText)(s && s.memory) : "";
    if (mt) t += "\n【群聊记忆】\n" + mt + "\n";
    /* @ 提醒（10-20）：用户在最后一条里 @ 了谁，就让谁先说话 */
    try {
      var arr0 = (s && s.phone && s.phone.msgs) || [];
      var lastU = "";
      for (var i0 = arr0.length - 1; i0 >= 0; i0--) {
        if (arr0[i0] && arr0[i0].role === "user" && arr0[i0].kind !== "recalled") {
          lastU = String(arr0[i0].text || "");
          break;
        }
      }
      var at = [];
      members.forEach(function (m) { if (lastU && lastU.indexOf("@" + m.name) >= 0) at.push(m.name); });
      if (at.length) t += "\n【有人被 @】用户在最后一条里 @" + at.join("、") + "，意思是「这条是提醒 " + at.join("、") +
        " 看的」，**不是点名让他先发言**。谁接话按各自性格来：被提醒的人通常会回应（毕竟是在叫他），" +
        "但别写成「被点到名就站起来回答」那种生硬感。\n";
    } catch (e) { /* ignore */ }
    t += "\n【规则】像真人发微信：口语、简短。每次让 1~3 位成员发言（谁说话、说几句由你按各自性格决定，可以有人不说话），" +
      "每条发言单独一行、用「名字：内容」开头，例如：\n小明：在啊\n小红：刚下课。\n" +
      "名字必须是上面列出的成员名。不要旁白、不要括号动作、不要替用户说话、不要用 Markdown。\n" +
      "不要自己插表情标记 —— 表情会在你写完之后单独挑，正文里只写话。\n" + PH_STYLE_RULE;
    return t;
  }
  /* 把「名字：内容」拆成 [{id,name,text}]；不足两人就说不上是群聊发言，返回 null */
  function splitPhoneSpeakers(text, s) {
    var members = phoneGroupMembers(s);
    if (members.length < 2) return null;
    var byName = {};
    members.forEach(function (m) { byName[m.name] = m; });
    var lines = String(text || "").split(/\r?\n/);
    var segs = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var mm = /^\s*([^\s：:]{1,20})\s*[：:]\s*([\s\S]*)$/.exec(ln);
      var hit = mm ? byName[mm[1]] : null;
      if (hit) {
        if (cur) segs.push(cur);
        cur = { id: hit.id, name: hit.name, text: mm[2] };
      } else if (cur) {
        cur.text += (cur.text ? "\n" : "") + ln;
      } else if (String(ln).trim()) {
        cur = { id: members[0].id, name: members[0].name, text: ln };
      }
    }
    if (cur) segs.push(cur);
    segs.forEach(function (x) { x.text = String(x.text || "").trim(); });
    var kept = segs.filter(function (x) { return x.text; });
    return kept.length >= 2 ? kept : null;
  }

  /* ── 手机里「一条消息」的拆分 ──────────────────────────────────
     真人发微信不会一条塞一大段，多数是一两句一条。模型被要求「在换行处分行」，
     这里把回复按行拆成几条；单行仍然太长就按句末标点再切一刀。
     几条硬规矩：
       · 整体很短（不到 1.5 个 CHUNK）就原样返回，别把一句正常的话拆碎
       · 太碎的（< 5 字）并回上一条，避免「嗯。」「好。」各占一个气泡
       · 最多 MAX 条，多出来的并进最后一条（宁可最后一条长点，也别刷屏）
     群聊的「谁说话」由 splitPhoneSpeakers 先分好，这里只负责把每个人说的话再拆短。 */
  var PH_CHUNK = 90;
  var PH_MAX = 6;
  /* 相邻两条手机消息隔多久就插一条居中的时分（用户口径：3 分钟；两边都算） */
  var PH_TIME_GAP = 3 * 60000;
  function splitPhoneReply(text) {
    var t = String(text == null ? "" : text).trim();
    if (!t) return [t];
    var lines = t.split(/\r?\n/).map(function (x) { return String(x).trim(); }).filter(Boolean);
    /* 分几种情况进：
       · 已经分成好几行 → **一行一条**。这是**常态**（提示词就是让 AI 分行写的），
         ⚠️ 这一步不能被长度门槛挡着 —— 否则「3 行、一共 60 字」这种最常见的回复
         会因为「不够长」被整块塞进同一个气泡，等于白拆。
       · 就一整段、而且确实很长 → 按句末标点硬切（AI 没听话时的兜底）。
       · 就一整段、也不长 → 原样发。 */
    var src;
    if (lines.length >= 2) src = lines;
    else if (t.length > PH_CHUNK * 1.5) src = [t];
    else return [t];
    var parts = [];
    src.forEach(function (line) {
      if (line.length <= PH_CHUNK) { parts.push(line); return; }
      var buf = "";
      for (var i = 0; i < line.length; i++) {
        var ch = line.charAt(i);
        buf += ch;
        if ("。！？!?".indexOf(ch) >= 0 && buf.length >= PH_CHUNK * 0.6) { parts.push(buf); buf = ""; }
      }
      if (buf) parts.push(buf);
    });
    var merged = [];
    parts.forEach(function (p) {
      if (merged.length && p.length < 5) merged[merged.length - 1] += p;
      else merged.push(p);
    });
    if (merged.length <= 1) return [t];
    if (merged.length > PH_MAX) {
      /* 以前把超出部分整个 join 进最后一个气泡 —— 15 行的回复会变成 5 条短气泡
         加一大坨（气泡是 textContent，换行不生效，视觉上还是一条长的）。
         现在每次合并 3 行、循环收敛，代价是多一两个气泡，但每条都还是「短消息」的样子。 */
      var over = merged.splice(PH_MAX - 1);
      var tail = [];
      for (var m2 = 0; m2 < over.length; m2 += 3) tail.push(over.slice(m2, m2 + 3).join("\n"));
      merged = merged.concat(tail);
    }
    return merged;
  }

  /* 「怎么发消息」这条规矩，单聊 / 群聊共用 */
  var PH_STYLE_RULE = "【怎么发】像真人发微信：口语、简短，**一次就发一两句**，别一条塞进一大段。" +
    "要分几条就把它们【分行写】，每一行会单独发成一条消息；" +
    "只有在你认真讲清一件事、或者情绪上来一口气说了很多的时候，才允许一条长一点。";

  function buildPhoneMessages(s, ch) {
    var sys = "";
    if (s && s.isGroup) {
      sys = buildGroupSysPhone(s);
    } else {
      /* noEmoji：手机走双段式（第二段单独挑表情），第一段提示词里不列表情清单 */
      try { if (ch) sys = Memory.buildSystemText(ch, s, state.settings, { noEmoji: true }); } catch (e) { sys = ""; }
      /* 「TA 怎么称呼我」以前只是个存了没人读的字段（写进会话、从不进提示词）。
         这里补上：留空就什么都不加，不改变现有行为。 */
      if (s && s.nickMe) sys += "\n【称呼】你在手机里叫他「" + String(s.nickMe).trim() + "」。";
      if (!ch) sys = "你是 DeepLink 的助手。现在用户改用手机聊天软件找你，回复要像发消息一样。";
      var head = "【场景】你和对方正在用手机聊天软件发消息。回复要像真人发微信：口语、简短、" +
        "别写小说旁白、别用（动作）括号、不要用 Markdown 标题，不要自称 AI。\n" + PH_STYLE_RULE;
      sys = (sys ? sys + "\n\n" : "") + head;
      /* 当面（10-18 用户要求）：如果你们此刻就在同一个空间，就不该像发微信，
         而是抬头直接说话 —— 那条回复按「当面说话」写，带动作神态。
         判断依据交给模型自己看「当前场景」，我们不猜。 */
      sys += "\n\n【当面】如果「当前场景」里你和对方就在同一个空间（挨着、同屋、面对面），" +
        "那么这次回复**不要用发消息的口吻**，直接写成当面说话，可以带动作和神态，" +
        "例如「（回完消息抬头看你）这么近发什么消息？」。这种情况在回复开头单独标一行〖当面〗。" +
        "如果你们不在一起（隔着屏幕、异地），就照常按发微信写，不要加〖当面〗。";
      /* 双线（10-18 用户要求）：除了发出去的短消息，再额外给一段「你此刻线下的样子」。
         目的是模拟「人在线上聊天的同时，现实里是什么状态」。这一段不进手机聊天，
         只出现在对方的另一个界面上。 */
      sys += "\n\n【线下】在你这次回复的最末尾，另起一行，写一段你此刻在现实里的样子（80 字以内）：" +
        "姿势、表情、手上的动作、周围的光线或声音。用第三人称旁白写，像镜头看着你，不要用第一人称。" +
        "格式严格写成：〖线下〗内容〖/线下〗。这一段不会出现在手机聊天里，正文照常按发消息的口吻写。";
    }
    /* 采用格式：三层取值统一走 chat.js 的 adoptFormatFor（会话 > 角色 > 全局） */
    var fmt = (window.DL && window.DL.adoptFormatFor) ? window.DL.adoptFormatFor(s)
      : String((s && s.adoptFormat) || (ch && ch.format) || (state.settings.adoptFormat || "") || "").trim();
    if (fmt) sys += "\n\n【采用格式】\n" + fmt;
    /* 手机也读同一套故事时间（没开时间系统时 timeLine 回空串，等于不加） */
    var tline = (Memory && Memory.timeLine) ? Memory.timeLine(ch, s) : "";
    if (tline) sys += "\n\n" + tline;
    var msgs = [{ role: "system", content: sys }];
    var list = phoneMsgsOf(s).slice(-40);
    list.forEach(function (m) {
      if (m.kind === "sys") return;
      var txt = msgText(m);
      if (!txt) return;
      /* 群聊：把「谁说的」带回去，模型才接得住 */
      if (s && s.isGroup && m.role !== "user" && m.speakerName) txt = m.speakerName + "：" + txt;
      msgs.push({ role: m.role === "user" ? "user" : "assistant", content: txt });
    });
    return msgs;
  }

  function cleanReply(t) {
    var s = String(t || "").trim();
    return s;
  }

  /* ── 双段式的第二段：挑表情（10-22 用户口径）────────────────────
     第一段只写正文（不显示、也不提表情），这一轮把「刚写的正文 + 他的性格」再喂一次，
     让它从可用清单里挑**一个**最贴的，或者干脆不发。
     清单上限 50 个（Memory.stickerNamesFor 里定的），范围按上传时设的「可用范围」走。
     返回 "" = 不发表情。 */
  async function pickSticker(s, text, who) {
    if (!text) return "";
    var names = (Memory.stickerNamesFor) ? Memory.stickerNamesFor(s, state.settings) : [];
    if (!names.length) return "";
    var ch = who ? charById(who.id) : characterFor(s);
    var persona = "";
    try {
      persona = (ch && Memory.personaText) ? String(Memory.personaText(ch) || "").slice(0, 500) : "";
    } catch (e) { persona = ""; }
    var sys = "你在手机聊天里刚发完话。现在只做一件事：判断要不要再补一个表情包。\n" +
      "要就挑最贴的那一个，不想发就回「不发」。不要解释，不要写别的字，不要重复正文。";
    var user = "【你刚才发的】\n" + String(text).slice(0, 600) +
      (persona ? "\n\n【你的性格】\n" + persona : "") +
      "\n\n【可选表情】\n" + names.join("、") +
      "\n\n只回一个表情名（必须是上面列出的之一），或者回「不发」。";
    var r = await Api.run({
      settings: phoneSettings(s),
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      thinking: false,
      effort: "low"
    });
    if (r && r.usage && typeof recordUsage === "function") recordUsage(s.id, r.usage, s.characterId || "", "phone");
    var t = String((r && r.content) || "").trim().replace(/[「」“”"'《》]/g, "");
    if (!t || t.indexOf("不发") >= 0) return "";
    /* 先找完全相等的，再找包含的（模型常写成「表情：无语」或带一句解释） */
    var exact = names.filter(function (n) { return t === n; })[0];
    if (exact) return exact;
    var loose = names.filter(function (n) { return t.indexOf(n) >= 0; })[0];
    return loose || "";
  }

  /* ── 双线：手机那一轮，主聊天那边也要有「她此刻线下的样子」──────
     模型按〖线下〗…〖/线下〗单独给一段，这里把它剥出来：
     正文继续按手机消息发出去，这一段落成主聊天里的一条消息，并和手机那条绑定
     （删任何一边，另一边跟着没 —— 见 deletePhoneMsg / chat.js 的删除逻辑）。 */
  function splitOffline(text) {
    var src = String(text || "");
    var m = /[〖【\[]\s*线下\s*[〗】\]]?\s*([\s\S]*?)\s*[〖【\[]\s*\/\s*线下\s*[〗】\]]/.exec(src);
    if (!m) return { body: src, offline: "" };
    var off = String(m[1] || "").trim();
    var body = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim();
    return { body: body, offline: off };
  }

  function insertOfflineMsg(sid, text, phoneMsgId) {
    if (!sid || !text || !phoneMsgId) return;
    var list = Store.getSessions();
    var i = -1;
    for (var k = 0; k < list.length; k++) { if (list[k].id === sid) { i = k; break; } }
    if (i < 0) return;
    var rec = list[i];
    if (!Array.isArray(rec.messages)) rec.messages = [];
    var content = String(text).trim();
    if (!content) return;
    rec.messages.push({
      role: "assistant",
      ts: Date.now(),
      content: content,
      offline: true,
      phoneMsgId: phoneMsgId,
      variants: [{ content: content, q: 0 }],
      vi: 0
    });
    rec.updatedAt = Date.now();
    Store.saveSessions(list);
  }

  async function genReply(sid) {
    syncModules();
    if (ps.busy || ps.sending) return;
    var s = sessionById(sid);
    if (!s) return;
    var ch = characterFor(s);
    if (!state.settings.apiKey) { toast("请先在「设置」里填写 API Key", true); return; }
    ps.busy = true;
    ps.busySid = sid;      /* 记归属：撤回 / 发送闸门 / 提示文案都要用它区分「谁在跑」 */
    /* 本轮序号：关掉手机再重开重发时，上一轮的回调靠它认出「我已经过期了」，
       不再去复位新请求的 busy / abort（否则新请求中止不了、还能被重复触发）。 */
    ps.seq = (ps.seq || 0) + 1;
    var mySeq = ps.seq;
    setDisabled("#phoneSend", true);
    showTyping();
    ps.abort = new AbortController();
    var acc = "";
    try {
      var messages = buildPhoneMessages(s, ch);
      if (!Api || typeof Api.run !== "function") throw new Error("接口模块 api.js 没有加载成功");
      /* 手机这边也挂工具（10-23）：角色可以自己决定去翻记忆 / 找旧原话。
         端点不认 tools 时 api.js 会自动去掉重试，这里不用写兜底。 */
      var toolsOn = !!(window.Tools && state.settings.toolUse !== false);
      var result = await Api.run({
        settings: phoneSettings(s),
        messages: messages,
        thinking: false,
        effort: "low",
        signal: ps.abort.signal,
        search: null,
        extraTools: toolsOn ? Tools.defs() : null,
        runTool: toolsOn ? function (name, args) {
          return Tools.run(name, args, { line: s, ch: characterFor(s) });
        } : null
      }, {
        /* 逐字回调：只累加，**不刷界面**（手机端不做流式，见 showTyping 的注释） */
        onContent: function (t) { acc += t; updateTyping(); }
      });
      hideTyping();
      var finalText = cleanReply((result && result.content) || acc);
      /* 注意：这里**不显示流式过程**（上面 onContent 只累加不刷字），
         下面一次性把消息推出去，再让聊天框平滑顶上去。 */
      if (result && result.reasoning && !finalText) {
        var sp = Api.splitReasoning ? Api.splitReasoning("", result.reasoning) : null;
        if (sp && sp.content) finalText = cleanReply(sp.content);
      }
      if (!finalText) finalText = "（对方这次没说话）";
      /* 双线：先把「她此刻线下的样子」那段剥出来，正文照常按手机消息发 */
      finalText = String(finalText || "").replace(/[〖【\[［]\s*当面\s*[〗】\]］]/g, "").trim();
      var off = splitOffline(finalText);
      finalText = off.body || "（对方这次没说话）";
      var offId = off.offline
        ? ("pm_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5))
        : "";
      var usedId = false;
      function pushOne(part, extra) {
        var o = Object.assign({ role: "assistant", kind: "text", text: part }, extra || {});
        /* 只有本轮第一条挂上绑定 id —— 删它才连带删主聊天那条 */
        if (!usedId && offId) { o.id = offId; usedId = true; }
        pushMsg(sid, o);
      }
      /* 双段式（10-22 用户口径）：先把正文排好但**不落库**，
         等第二段挑完表情，再和表情一起发出去 —— 否则表情会晚半秒追在正文后面。 */
      var segs = splitPhoneSpeakers(finalText, s);
      var queue = [];
      var lastWho = null;
      if (segs) {
        segs.forEach(function (sg) {
          lastWho = sg;
          splitPhoneReply(sg.text).forEach(function (part) {
            queue.push({ text: part, speaker: sg.id, speakerName: sg.name });
          });
        });
      } else {
        /* 单聊：把一大段拆成「像真人连发的几条短消息」 */
        splitPhoneReply(finalText).forEach(function (part) { queue.push({ text: part }); });
      }
      /* 第二段：带着刚写好的正文和他的性格，从可用表情里挑一个（也可以一个都不挑）。
         挑表情是另一次请求，abort 管不到它 —— 所以重新转圈，并在回来之后验一次归属。 */
      showTyping();
      var stkName = "";
      try { stkName = await pickSticker(s, finalText, lastWho); } catch (e) { stkName = ""; }
      /* 这两三秒里用户可能撤回了、也可能关掉手机换了线：整轮作废，一个字都不许落库。
         以前缺这一步，abort 之后正文照样发出去（用户以为撤回了）。 */
      if (mySeq !== ps.seq) return;
      hideTyping();
      if (stkName) {
        /* 表情单独一条消息、单独一个气泡（用户明确要求不要挤在同一个气泡里） */
        queue.push({
          text: "[表情:" + stkName + "]",
          speaker: lastWho ? lastWho.id : "",
          speakerName: lastWho ? lastWho.name : ""
        });
      }
      queue.forEach(function (q) {
        var extra = {};
        if (q.speaker) { extra.speaker = q.speaker; extra.speakerName = q.speakerName; }
        pushOne(q.text, extra);
      });
      /* 线下那段落到主聊天里（和上面第一条手机消息绑定） */
      if (off.offline && offId) insertOfflineMsg(sid, off.offline, offId);
      if (result && result.usage && typeof recordUsage === "function") recordUsage(sid, result.usage, s.characterId, "phone");
      renderChat();
      if (ps.view === "list") renderList();
      /* 对方主动发来的：只有用户本来就贴着底才滚（传 false），
         正在翻旧消息就不打扰他 */
      scrollPhoneBottom(false);
      afterExchange(s);
      /* 记忆互通（10-22）：手机群这一轮也写回各成员绑定的那条线。
         手机线就是那条会话本身（phone.msgs 挂在同一个 session 上），
         所以写回之后，主聊天和手机单聊立刻都能看到群里发生的事。 */
      if (s.isGroup && window.DL && DL.syncGroupToLines) {
        try {
          DL.syncGroupToLines(sid).catch(function () { /* 同步失败不影响这轮对话 */ });
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      hideTyping();
      var aborted = e && e.name === "AbortError";
      if (!aborted) toast("手机消息发送失败：" + (e && e.message ? e.message : e), true);
    } finally {
      hideTyping();   /* 顶部提示条一定收掉（正常/出错/中止都一样） */
      /* 只在「本轮仍是当前轮」时复位 —— 关掉手机再重开重发时新请求已经把 seq 加一，
         这里若还去清 busy / abort，会把新请求的状态一起清掉。 */
      if (mySeq === ps.seq) {
        ps.busy = false;
        ps.busySid = "";
        setDisabled("#phoneSend", false);
        ps.abort = null;
      }
    }
  }

  /* 一次手机交流之后：顺手推进这条线的日更（场景 / 关系 / 经历），
     用的是同一份三层记忆，所以手机里聊到的内容也会进角色的记忆。 */
  function afterExchange(s) {
    try {
      /* 群聊没有「单个角色」，日更怎么归属成员还没定 —— 先跳过（不影响发消息） */
      if (s && !s.isGroup && typeof maybeDailyRefresh === "function") maybeDailyRefresh(s, characterFor(s));
    } catch (e) { /* ignore */ }
  }

  /* ── 「自动发信息 · 手机模式」的投递 ────────────────────────────
     把 roleplay.js 产出的 { text, image } 投进手机：先推文字气泡（用户马上看得到），
     再按需生成图片、登记进角色个人图库、推图片气泡。
     生成图片前【先看一眼角色图库】：把「以前画过什么」写进提示词，开着图生图时
     再拿最近一张当参考图 —— 长相 / 发型 / 常穿的衣服才不会前后对不上。 */
  function urlToDataUrl(url) {
    if (!url) return Promise.resolve("");
    if (String(url).slice(0, 5) === "data:") return Promise.resolve(String(url));
    /* 远程链接先转成 dataUrl 再外置；转不动就原样留着（消息照常显示） */
    return fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
      return new Promise(function (resolve) {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || "")); };
        fr.onerror = function () { resolve(""); };
        fr.readAsDataURL(b);
      });
    }).catch(function () { return ""; });
  }

  /* 生成一张「分享用」的图。失败回空串（调用方就不推图片气泡）。 */
  async function buildShareImage(s, spec) {
    syncModules();
    if (!Media || !Media.capable || !Media.capable("img", state.settings)) return "";
    var idx = (window.CONFIG && window.CONFIG.IMAGE_STYLE_INDEX) || {};
    var catalog = idx[spec.style] || null;
    var ch = characterFor(s);
    var parts = [catalog ? catalog.prompt : "写实摄影感"];
    if (spec.self && ch) {
      var f = ch.fields || {};
      var look = [];
      if (f.aiName || ch.name) look.push("人物：" + (f.aiName || ch.name));
      if (f.age) look.push("年龄：" + f.age);
      if (f.aiAppearance) look.push("外貌：" + f.aiAppearance);
      if (f.aiPersona) look.push("气质：" + f.aiPersona);
      if (look.length) parts.push("【人物设定（必须一致）】\n" + look.join("\n"));
      var digest = (ch.id && Store.charImageDigest) ? Store.charImageDigest(ch.id, 6) : "";
      if (digest) parts.push("【以前画过的同一个人，保持长相 / 发型 / 衣着一致】\n" + digest);
    }
    parts.push("具体画面：" + String(spec.subject || ""));
    var opts = {};
    if (spec.self && ch && state.settings.imgToImg) {
      var ref = (ch.id && Store.charImageLatestURL) ? Store.charImageLatestURL(ch.id) : "";
      if (ref) opts.ref = ref;   /* 有旧图就拿它当参考，走图生图（失败 media.js 会自动回落） */
    }
    return await Media.image(parts.join("\n\n"), state.settings, opts);
  }

  /* 手机正开着、且正是这条会话 → 立刻重渲并（在贴底时）平滑滚到底 */
  function refreshPhoneIfOpen(sid) {
    if (!isOpen()) return;
    if (ps.view === "chat" && ps.sid === sid) { renderChat(); scrollPhoneBottom(false); }
    else if (ps.view === "list") renderList();
  }

  /* 投递一条「手机模式」的主动分享。返回是否真的投出去了。 */
  async function applyAutoShare(sid, obj) {
    syncModules();
    var s = sessionById(sid);
    if (!s) return false;
    var text = String((obj && obj.text) || "").trim();
    var spec = (obj && obj.image) || null;
    if (!text && !spec) return false;
    if (text) splitPhoneReply(text).forEach(function (part) {
      pushMsg(sid, { role: "assistant", kind: "text", text: part });
    });
    refreshPhoneIfOpen(sid);
    if (!spec) return true;
    var url = "";
    try { url = await buildShareImage(s, spec); } catch (e) { url = ""; }
    if (!url) return true;                 /* 只出了文字，也算投出去了 */
    var dataUrl = await urlToDataUrl(url);
    var att = { kind: "image", name: "share.png", mime: "image/png", desc: String(spec.subject || "") };
    if (dataUrl) att.dataUrl = dataUrl; else att.url = url;
    try { if (dataUrl && Store.hoistImage) Store.hoistImage(att); } catch (e) { /* ignore */ }
    pushMsg(sid, { role: "assistant", kind: "image", attachments: [att], desc: String(spec.subject || "") });
    /* 登记进角色个人图库：只登记「含角色本人」那类，且要能读回图 */
    try {
      var ch = characterFor(s);
      if (spec.self && ch && ch.id && Store.saveCharImage && Store.imageURL) {
        var forLib = Store.imageURL(att);
        if (forLib) {
          Store.saveCharImage(ch.id, forLib, {
            style: spec.style, styleName: spec.styleName, subject: spec.subject, mime: "image/png"
          });
        }
      }
    } catch (e) { /* 图库登记失败不影响消息 */ }
    refreshPhoneIfOpen(sid);
    /* 主动发过消息 = 这段空白已有「动作」对应 → 以此刻为新基准重新起算 */
    try {
      var lst = Store.getSessions();
      var k = lst.findIndex(function (x) { return x.id === sid; });
      if (k >= 0 && Memory && Memory.rebaseTime) { Memory.rebaseTime(lst[k], "auto"); Store.saveSessions(lst); }
    } catch (e2) { /* ignore */ }
    return true;
  }

  /* ── 发文本 ───────────────────────────────────────── */
  function sendText() {
    syncModules();
    /* 忙闲要带归属。ps.busy 是全局的、手机只有一个 typing 指示条和一个 abort，
       所以不开并发；但「别的线在生成」必须说清楚 —— 以前直接 return，
       用户看到的是「消息没发出去也没提示」，像是卡死了。 */
    if (ps.busy || ps.sending) {
      if (ps.busySid && ps.busySid !== ps.sid) {
        var bs = sessionById(ps.busySid);
        var bn = (bs && (bs.title || (characterFor(bs) || {}).name)) || "另一条会话";
        toast("「" + bn + "」还在回复，等它说完再发", true);
      }
      return;
    }
    var input = $("#phoneInput");
    if (!input) return;
    var text = String(input.value || "").trim();
    if (!text) return;
    var sid = ps.sid;
    if (!sid) return;
    /* 万一这条线的角色设定还没填齐 → 手机这边也不让发（与主对话同一口径） */
    var ses = sessionById(sid);
    var missF = (window.DL && window.DL.charMissingFields) ? window.DL.charMissingFields(ses) : [];
    if (missF.length) {
      /* 手机页没有填设定的入口（10-19：「相熟型」角色会走到这里），
         所以提示里必须写清去哪儿补，否则用户只知道被拦住、不知道怎么办。 */
      var how = (ses && ses.phoneOnly)
        ? "。补设定：侧栏 → 角色 → 选中这个联系人，或在角色卡里把「手机角色类型」改回功能型"
        : "。补设定：侧栏 → 角色 → 选中这个角色";
      toast("这个角色还差 " + missF.length + " 栏设定才能开始对话：" + missF.slice(0, 3).join("、") +
        (missF.length > 3 ? "…" : "") + how, true);
      return;
    }
    /* 混搭模式（10-20）：手机里发第一条消息也算「上线」，同样解冻 */
    try {
      var mm = (window.Memory || Memory);
      if (ses && ses.autoFreeze && mm && mm.isFrozen && mm.isFrozen(ses)) {
        mm.unfreezeTime(ses);
        Store.saveSessions(Store.getSessions());
      }
    } catch (e) { /* ignore */ }
    pushMsg(sid, { role: "user", kind: "text", text: text });
    input.value = "";
    renderChat(); scrollPhoneBottom();
    genReply(sid);
  }

  /* ── 底部弹层（转账 / 位置 / 线选择共用）──────────── */
  function openSheet(title, bodyEl, onOk) {
    setText("#phoneSheetTitle", title);
    var body = $("#phoneSheetBody");
    if (!body) return;
    body.innerHTML = "";
    body.appendChild(bodyEl);
    ps.sheetOk = onOk || null;
    show($("#phoneSheet"), true);
  }
  function closeSheet() {
    show($("#phoneSheet"), false);
    var body = $("#phoneSheetBody");
    if (body) body.innerHTML = "";
    ps.sheetOk = null;
  }
  function field(label, type, value, placeholder) {
    var wrap = document.createElement("label");
    wrap.className = "ph-field";
    var sp = document.createElement("span");
    sp.textContent = label;
    var inp = document.createElement("input");
    inp.type = type || "text";
    inp.value = value || "";
    if (placeholder) inp.placeholder = placeholder;
    wrap.appendChild(sp); wrap.appendChild(inp);
    return { wrap: wrap, input: inp };
  }

  /* ── 转账 ─────────────────────────────────────────── */
  function doTransfer() {
    var sid = ps.sid;
    if (!sid) return;
    var box = document.createElement("div");
    var money = field("金额（元）", "number", "", "例：52");
    var note = field("备注（可留空）", "text", "", "例：奶茶钱");
    box.appendChild(money.wrap); box.appendChild(note.wrap);
    setTimeout(function () { money.input.focus(); }, 60);
    openSheet("转账", box, function () {
      var amt = Number(money.input.value);
      if (!isFinite(amt) || amt <= 0) { toast("请输入正确的金额", true); return; }
      closeSheet();
      pushMsg(sid, { role: "user", kind: "transfer", amount: amt, note: String(note.input.value || "").trim() });
      renderChat(); scrollPhoneBottom();
      genReply(sid);
    });
  }

  /* ── 位置 ─────────────────────────────────────────── */
  function doLocation() {
    var sid = ps.sid;
    if (!sid) return;
    var box = document.createElement("div");
    var place = field("地点名称", "text", "", "例：青岩古镇");
    var sub = field("一句话（可留空）", "text", "", "例：今天人好多");
    box.appendChild(place.wrap); box.appendChild(sub.wrap);
    setTimeout(function () { place.input.focus(); }, 60);
    openSheet("发送位置", box, function () {
      var p = String(place.input.value || "").trim();
      if (!p) { toast("先填个地点名", true); return; }
      closeSheet();
      pushMsg(sid, { role: "user", kind: "location", place: p, sub: String(sub.input.value || "").trim(), seed: (Math.random() * 1e9) >>> 0 });
      renderChat(); scrollPhoneBottom();
      genReply(sid);
    });
  }

  /* ── 图片 ─────────────────────────────────────────── */
  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || "")) { reject(new Error("请选择图片")); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var raw = String(fr.result || "");
        var img = new Image();
        img.onload = function () {
          var max = 1024;
          var sc = Math.min(1, max / Math.max(1, Math.max(img.width, img.height)));
          var w = Math.max(1, Math.round(img.width * sc)), h = Math.max(1, Math.round(img.height * sc));
          try {
            var cv = document.createElement("canvas");
            cv.width = w; cv.height = h;
            cv.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve({ dataUrl: cv.toDataURL("image/jpeg", 0.82), name: file.name || "photo.jpg" });
          } catch (e) { resolve({ dataUrl: raw, name: file.name || "photo.jpg" }); }
        };
        img.onerror = function () { reject(new Error("图片读取失败")); };
        img.src = raw;
      };
      fr.onerror = function () { reject(new Error("图片读取失败")); };
      fr.readAsDataURL(file);
    });
  }
  async function handleImageFile(file) {
    var sid = ps.sid;
    if (!sid || !file) return;
    var got;
    try { got = await readImageFile(file); }
    catch (e) { toast(e.message || "图片读取失败", true); return; }
    var att = { kind: "image", dataUrl: got.dataUrl, name: got.name, mime: "image/jpeg" };
    /* 立刻外置（有原生文件接口时）：别把大图塞进 localStorage */
    try { if (Store.hoistImage) Store.hoistImage(att); } catch (e) { /* ignore */ }
    var msg = { role: "user", kind: "image", attachments: [att], desc: "" };
    pushMsg(sid, msg);
    renderChat(); scrollPhoneBottom();
    /* 先让角色「看图」：多模态描述一次（走视觉模型 / 主模型），再据此回复 */
    try {
      var url = Store.imageURL(att);
      if (url && Api && typeof Api.describe === "function") {
        var d = await Api.describe(state.settings, url, 300);
        if (d && d.text) {
          var list = Store.getSessions();
          for (var i = 0; i < list.length; i++) {
            if (list[i].id !== sid) continue;
            var m = phoneOf(list[i]).msgs;
            for (var j = m.length - 1; j >= 0; j--) { if (m[j] === msg || (m[j].kind === "image" && !m[j].desc)) { m[j].desc = String(d.text).trim(); break; } }
          }
          Store.saveSessions(list);
        }
        if (d && d.usage && typeof recordUsage === "function") recordUsage(sid, d.usage, null, "phone");
      }
    } catch (e) { /* 描述失败也能继续聊 */ }
    genReply(sid);
  }

  /* ── 语音 ─────────────────────────────────────────── */
  async function toggleVoice() {
    syncModules();
    if (!Media || !Media.recorder) { toast("当前环境不支持录音", true); return; }
    if (ps.recActive) {
      ps.recActive = false;
      setText("#phoneActVoiceLabel", "语音");
      var blob = await Media.recorder.stop();
      if (!blob) return;
      try {
        var text = await Media.transcribe(blob, state.settings, "voice." + (Media.extOf ? Media.extOf(blob.type || "audio/webm") : "webm"));
        var sid = ps.sid;
        if (!sid) return;
        pushMsg(sid, { role: "user", kind: "voice", text: text, dur: Math.max(1, Math.round(text.length / 4)) });
        renderChat(); scrollPhoneBottom();
        genReply(sid);
      } catch (e) {
        toast("语音转写失败：" + (e && e.message ? e.message : e), true);
      }
      return;
    }
    try {
      await Media.recorder.start();
      ps.recActive = true;
      setText("#phoneActVoiceLabel", "停止");
    } catch (e) {
      toast("无法开始录音：" + (e && e.message ? e.message : e), true);
    }
  }

  /* ── 伪电话：拨过去 → 角色接 → 自动持续「说话即识别」 ──────────
     交互：点「电话」= 拨出；2 秒后角色接起；接通后【麦克风一直开着】，
     你说一句（能量检测到讲完），自动转文字 → 喂 AI → TTS 念出来；
     念完继续听下一句。不需要按住说话。
     说话段切分靠 Web Audio 的能量阈值（VAD），Chrome 83 WebView 可用。 */
  var TH_VOICE = 0.045;     /* 判定「有人在说话」的波形能量阈值 */
  var SIL_MS = 950;         /* 静音超过这么久 → 认为这句说完了 */
  var MIN_SPEAK_MS = 380;   /* 一句里至少要有这么久的声音才值得提交（滤掉咳嗽/杂音） */
  var MAX_SEG_MS = 20000;   /* 单段录音上限，防止一直不静音 */
  var TICK = 100;           /* VAD 轮询间隔 */

  var callState = null;

  function startCall(video) {
    if (callState) return;   /* 已在通话中：重复触发会覆盖 callState，旧定时器会驱动新通话、旧麦克风也不释放 */
    var sid = ps.sid;
    if (!sid) return;
    var s = sessionById(sid);
    var ch = characterFor(s);
    if (!ch) { toast("先选一个有角色卡的线，电话才有人接", true); return; }
    callState = { sec: 0, timer: null, lines: [], connected: false, engine: null, micP: null, micErr: "", video: !!video };
    var av = $("#phoneCallAvatar");
    if (av) {
      av.innerHTML = "";
      var url = avatarOf(ch, s);
      /* 头像外置之后是文件路径，直接用会 404（通话页空白）——统一过一道 avatarUrl */
      if (url && window.DL && DL.avatarUrl) url = DL.avatarUrl(url);
      if (url) { var im = document.createElement("img"); im.src = url; av.appendChild(im); }
      else av.innerHTML = UI.iconSvg("creation");
    }
    setText("#phoneCallName", nameOf(ch, s));
    setText("#phoneCallState", "正在呼叫…");
    setText("#phoneCallTimer", "00:00");
    setText("#phoneCallSaid", "");
    setText("#phoneCallTalkLabel", "静音");
    callAcquireMic();   /* 在手势里就申请麦克风，接通后直接用 */
    show($("#phoneCall"), true);
    /* ⚠️ 必须在「通话层显示之后」再量画布尺寸：#phoneCall 初始 hidden（display:none），
       量它里面 canvas 的宽高会得到 0 → 画布被设成 1×1，live2D 就等于画进一个像素里，
       视频通话看着是空的。 */
    callApplyVideoMode();
    callState.timer = setInterval(function () {
      if (!callState) return;
      callState.sec++;
      if (!callState.connected && callState.sec >= 2) {
        callState.connected = true;
        setText("#phoneCallState", callState.video ? "正在通话中 · 你直接说就好" : "通话中 · 你直接说就好");
        callBeginListen(callState);
      }
      /* ⚠️ sec 必须【每 tick 都自增】：早先写成「只在 connected 时才自增」，而 connected 又要求
         sec>=2 —— 两边互相等，永远接不通（会一直卡在「正在呼叫…」，ASR/AI/TTS 全都不会发生）。 */
      if (callState.connected) setText("#phoneCallTimer", fmtDur(callState.sec - 2));
    }, 1000);
  }

  /* 视频通话的虚化底色：优先「当前生效的聊天背景」（会话覆盖 → 全局），
     没有就用角色图（跟聊天气泡取头像同口径）；都没有就返回空、保持面板底色。 */
  function callBackdropUrl(s, ch) {
    var bgv = "";
    if (s && s.bgFollow === false) bgv = s.bgImage || "";
    if (!bgv) bgv = (state.settings && state.settings.bgImage) || "";
    if (bgv) {
      if (String(bgv).slice(0, 5) === "data:") return String(bgv);
      try { return Store.imageURL({ imgRef: bgv }) || ""; } catch (e) { /* ignore */ }
    }
    return avatarOf(ch, s) || "";
  }

  /* 视频开关：把画面层亮出来。live2D 能跑就跑，跑不起来退回首帧静态图，绝不白屏。 */
  function callApplyVideoMode() {
    var st = callState;
    if (!st) return;
    var on = !!st.video;
    var stage = $("#phoneCallStage");
    var layer = $("#phoneCall");
    if (layer) { if (on) layer.classList.add("video"); else layer.classList.remove("video"); }
    show(stage, on);
    setText("#phoneCallCamLabel", on ? "关视频" : "视频");
    if (!on) {
      detachLive2d();
      var bgOff = $("#phoneCallBg");
      if (bgOff) bgOff.style.backgroundImage = "";   /* 关视频就把底图撤掉，别一直占着那张 dataURL */
      return;
    }
    var s = sessionById(ps.sid);
    var ch = characterFor(s);
    /* ① 虚化背景图铺底（上面压一层暗罩，保证白字读得清） */
    var bgEl = $("#phoneCallBg");
    if (bgEl) {
      var burl = callBackdropUrl(s, ch);
      bgEl.style.backgroundImage = burl
        ? ("linear-gradient(rgba(0,0,0,.30), rgba(0,0,0,.52)), url(" + burl + ")")
        : "";
    }
    /* ② 静态兜底：居中一枚角色圆头像（live2D 成功后再把它藏掉） */
    var fb = $("#phoneCallFallback");
    if (fb) {
      fb.innerHTML = "";
      var url = avatarOf(ch, s);
      if (url) { var im = document.createElement("img"); im.src = url; fb.appendChild(im); }
      else fb.innerHTML = UI.iconSvg("creation");
      show(fb, true);
    }
    var canvas = $("#phoneCallCanvas");
    if (canvas) show(canvas, false);
    /* 开了 live2D 才尝试；任何失败都静默退回静态图 */
    var L2 = window.DL && window.DL.live2d;
    if (!L2 || !L2.attach || !state.settings.live2dEnabled || !L2.capable()) return;
    sizeCallCanvas(canvas);
    /* 这条线在「这条线」设置里单独选过模型就用它的，否则跟全局 */
    var lineModel = String((sessionById(ps.sid) || {}).live2dModel || "") || state.settings.live2dModel;
    /* 渲染坏了（色块 / 碎片）就退回静态头像，并说清原因 ——：
       硬画一团乱码比不画更糟，用户只会以为整个功能废了。 */
    if (typeof L2.onBroken === "function") {
      L2.onBroken(function () {
        if (!callState || callState !== st) return;
        try { L2.detach(); } catch (e) { /* ignore */ }
        if (canvas) show(canvas, false);
        if (fb) show(fb, true);
        toast("这台设备的 WebGL 画不出这个模型，已换成静态头像", true);
      });
    }
    L2.attach(canvas, lineModel).then(function () {
      if (!callState || callState !== st || !callState.video) { L2.detach(); return; }
      show(canvas, true);
      if (fb) show(fb, false);
    }).catch(function () { /* 退回静态图，不打扰 */ });
  }
  function sizeCallCanvas(cv) {
    if (!cv) return;
    var w = 0, h = 0;
    try { var r = cv.getBoundingClientRect(); w = Math.round(r.width); h = Math.round(r.height); } catch (e) { /* ignore */ }
    if (!w || w < 20 || !h || h < 20) {
      /* 此刻画布可能还被 hidden 藏着（量到 0）——退一步量它所在的舞台层，比例才对得上，
         否则会退到 320×480 再被 CSS 拉成 100%×100%，画面被压扁 / 拉长。 */
      try {
        var st = $("#phoneCallStage");
        var rs = st ? st.getBoundingClientRect() : null;
        if (rs && rs.width >= 20 && rs.height >= 20) { w = Math.round(rs.width); h = Math.round(rs.height); }
      } catch (e) { /* ignore */ }
    }
    /* 量不到（层还没显示 / display:none）就退到稳妥值，别给出 1×1 的画布 */
    if (!w || w < 20) w = 320;
    if (!h || h < 20) h = 480;
    /* 【2026-10-25 修复】画布的 backing store 要吃 DPR。
       以前直接 cv.width = 量到的 CSS 像素：DPR 2 的机器上，1280×1380 的模型被画进
       240×320 的缓冲，再由合成器拉大 2 倍 —— 头发丝、瞳孔、睫毛这类一两像素宽的东西
       直接被抹掉，看起来像「糊成一团 / 碎渣」。CSS 那边仍是 100%×100%，所以显示尺寸不变。
       DPR 封顶 2：3x 屏上按 3 倍画，像素数是 9 倍，安卓 WebView 顶不住。
       矩阵自己会读 canvas.width/height，所以这里改了它自动跟着变，不用另算。 */
    var dpr = 1;
    try { dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1)); } catch (e) { dpr = 1; }
    var bw = Math.max(1, Math.round(w * dpr));
    var bh = Math.max(1, Math.round(h * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
  }
  /* 画布在 attach 之后尺寸若变了，矩阵会失配 —— 所以 attach 前必须量准；
     挂断 / 关视频时把画布收回到兜底尺寸，避免残留上一通的大画布。 */
  function resetCallCanvas() {
    var cv = $("#phoneCallCanvas");
    if (!cv) return;
    try { cv.width = 320; cv.height = 480; } catch (e) { /* ignore */ }
  }
  function detachLive2d() {
    var L2 = window.DL && window.DL.live2d;
    if (L2 && L2.detach) { try { L2.detach(); } catch (e) { /* ignore */ } }
    resetCallCanvas();
  }
  function callToggleVideo() {
    if (!callState) return;
    callState.video = !callState.video;
    callApplyVideoMode();
    if (callState.connected) {
      setText("#phoneCallState", callState.video ? "正在通话中 · 你直接说就好" : "通话中 · 你直接说就好");
    }
  }

  /* 手势内申请麦克风；失败也要兜住，别让通话整个卡住 */
  function callAcquireMic() {
    var st = callState;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { st.micErr = "当前环境不支持麦克风"; return; }
    st.micP = navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      return stream;
    }).catch(function (e) {
      st.micErr = "麦克风打不开：" + (e && e.message ? e.message : e);
      return null;
    });
  }

  function callBeginListen(st) {
    if (!st || st.engine) return;
    if (!st.micP) { setText("#phoneCallState", st.micErr || "无法启用语音"); return; }
    st.micP.then(function (stream) {
      /* 通话可能已经被挂断了 */
      if (!callState || callState !== st || !stream) {
        if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ } }
        if (callState === st) setText("#phoneCallState", st.micErr || "无法启用语音");
        return;
      }
      var eng = { stream: stream, ctx: null, an: null, buf: null, rec: null, chunks: [], mime: "",
        tick: null, spokeMs: 0, silMs: 0, segMs: 0, speaking: false, muted: false, busy: false };
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        eng.ctx = new AC();
        if (eng.ctx.resume) { try { eng.ctx.resume(); } catch (e) { /* ignore */ } }
        var src = eng.ctx.createMediaStreamSource(stream);
        eng.an = eng.ctx.createAnalyser();
        eng.an.fftSize = 1024;
        src.connect(eng.an);
        eng.buf = new Uint8Array(eng.an.fftSize);
      } catch (e) { eng.an = null; /* 没有分析器就退化成「每段最长自动切」 */ }
      eng.mime = Media && Media.pickMime ? Media.pickMime() : "";
      st.engine = eng;
      callSegBegin(eng);
      eng.tick = setInterval(function () { callTick(st); }, TICK);
    });
  }

  /* 开一段新录音（一段 = 一句） */
  function callSegBegin(eng) {
    if (!eng || eng.busy || eng.muted || !eng.stream) return;
    try {
      eng.chunks = [];
      eng.rec = eng.mime ? new MediaRecorder(eng.stream, { mimeType: eng.mime }) : new MediaRecorder(eng.stream);
    } catch (e) { eng.rec = null; return; }
    eng.rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) eng.chunks.push(ev.data); };
    try { eng.rec.start(); } catch (e) { eng.rec = null; return; }
    eng.spokeMs = 0; eng.silMs = 0; eng.segMs = 0; eng.speaking = false;
  }

  /* 收一段：够长就送去识别，太短（纯静音/杂音）直接丢掉再开下一段 */
  function callSegEnd(st, eng) {
    if (!eng || eng.busy) return;
    var rec = eng.rec; eng.rec = null;
    var spoke = eng.spokeMs;
    eng.busy = true;
    var done = function (blob) {
      if (blob && spoke >= MIN_SPEAK_MS) {
        callHandleSpeech(st, blob);
      } else {
        eng.busy = false;
        if (callState === st) callSegBegin(eng);
      }
    };
    if (!rec || rec.state === "inactive") { done(null); return; }
    rec.onstop = function () {
      var type = eng.mime ? eng.mime.split(";")[0] : "audio/webm";
      var blob = null;
      try { blob = new Blob(eng.chunks, { type: type }); } catch (e) { blob = null; }
      eng.chunks = [];
      if (blob && !blob.size) blob = null;
      done(blob);
    };
    rec.onerror = function () { done(null); };
    try { rec.stop(); } catch (e) { done(null); }
  }

  /* VAD：每 100ms 看一眼音量，判断「在说 / 说完了」 */
  function callTick(st) {
    var eng = st && st.engine;
    if (!eng || eng.busy || eng.muted || !eng.rec) return;
    var rms = 0;
    if (eng.an) {
      eng.an.getByteTimeDomainData(eng.buf);
      var sum = 0;
      for (var i = 0; i < eng.buf.length; i++) { var d = (eng.buf[i] - 128) / 128; sum += d * d; }
      rms = Math.sqrt(sum / eng.buf.length);
    } else {
      /* 没有分析器：无法判断静音，只能靠「单段最长」来切 */
      rms = 1;
    }
    eng.segMs += TICK;
    if (rms > TH_VOICE) { eng.speaking = true; eng.spokeMs += TICK; eng.silMs = 0; }
    else if (eng.speaking) { eng.silMs += TICK; }
    if (eng.speaking) setText("#phoneCallState", "听着呢…");
    else if (!eng.busy) setText("#phoneCallState", "通话中 · 你直接说就好");
    var spokeEnough = eng.spokeMs >= MIN_SPEAK_MS;
    if ((eng.speaking && spokeEnough && eng.silMs >= SIL_MS) || eng.segMs >= MAX_SEG_MS) {
      if (eng.rec && eng.rec.state !== "inactive") {
        try { eng.rec.requestData && eng.rec.requestData(); } catch (e) { /* ignore */ }
      }
      callSegEnd(st, eng);
    }
  }

  /* 一句识别出来之后：转写 → AI → TTS 念出来 → 继续听 */
  async function callHandleSpeech(st, blob) {
    var eng = st.engine;
    var sid = ps.sid;
    setText("#phoneCallState", "正在转写…");
    var said = "";
    try {
      var ext = Media && Media.extOf ? Media.extOf(blob.type || "audio/webm") : "webm";
      said = await Media.transcribe(blob, state.settings, "call." + ext);
    } catch (e) {
      if (callState !== st) return;
      setText("#phoneCallState", "没听清，你说就好");
      eng.busy = false;
      if (callState === st) callSegBegin(eng);
      return;
    }
    if (callState !== st) return;
    said = String(said || "").trim();
    if (!said) {
      eng.busy = false;
      if (callState === st) { setText("#phoneCallState", "通话中 · 你直接说就好"); callSegBegin(eng); }
      return;
    }
    st.lines.push("我说：" + said);
    setText("#phoneCallSaid", "我说：" + said);
    setText("#phoneCallState", "对方在想…");
    /* AI 回一句（走同一份三层记忆，带上「正在打电话」的限定） */
    var s = sessionById(sid);
    var ch = characterFor(s);
    var reply = "";
    try {
      var msgs = [];
      var sys = "";
      try { sys = Memory.buildSystemText(ch, s, state.settings); } catch (e) { sys = ""; }
      sys = (sys ? sys + "\n\n" : "") + "【场景】你和对方正在打电话（语音，不是发消息）。你的这句话会被转成语音念出来，所以：口语、简短、" +
        "像真的在打电话，一两句就好，不要 Markdown、不要旁白、不要括号动作。";
      var hist = phoneMsgsOf(s).slice(-20);
      msgs.push({ role: "system", content: sys });
      hist.forEach(function (m) {
        if (m.kind === "sys") return;
        /* 多人在同一个群里时，给每条带说话人（和发消息那条路径口径一致） */
        var body = (s.isGroup && m.role !== "user" && m.speakerName) ? (m.speakerName + "：" + msgText(m)) : msgText(m);
        msgs.push({ role: m.role === "user" ? "user" : "assistant", content: body });
      });
      msgs.push({ role: "user", content: "（电话里）" + said });
      var result = await Api.run({ settings: phoneSettings(s), messages: msgs, thinking: false, effort: "low", search: null }, {
        onContent: function () { /* 电话不逐字显示 */ }
      });
      reply = cleanReply((result && result.content) || "");
      if (result && result.usage && typeof recordUsage === "function") recordUsage(sid, result.usage, s.characterId, "phone");
    } catch (e) { /* 电话不回也不致命 */ }
    if (callState !== st) return;
    if (reply) {
      st.lines.push("对方：" + reply);
      setText("#phoneCallSaid", "对方：" + reply);
    }
    /* 念出来（念的时候不收音，免得把自己念的又听进去） */
    setText("#phoneCallState", "对方在说…");
    if (reply) await callSpeak(reply);
    if (callState !== st) return;
    setText("#phoneCallState", "通话中 · 你直接说就好");
    eng.busy = false;
    if (callState === st) callSegBegin(eng);
  }

  /* 把一句话念出来；播完才 resolve。TTS 不可用就直接返回 */
  function callSpeak(text) {
    return new Promise(function (resolve) {
      if (!Media || !Media.capable || !Media.capable("tts", state.settings)) { resolve(); return; }
      var guard = setTimeout(resolve, 1500 + String(text || "").length * 260);
      Media.speak(text, voiceSet()).then(function (u) {
        try {
          var a = new Audio(u);
          if (callState) callState.audio = a;   /* 挂到通话状态上：挂断时能立刻停掉，不然会念完 */
          var fin = function () {
            clearTimeout(guard);
            if (callState && callState.audio === a) callState.audio = null;
            try { if (u && String(u).indexOf("blob:") === 0 && window.URL && URL.revokeObjectURL) URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
            resolve();
          };
          a.onended = fin;
          a.onerror = fin;
          var pr = a.play();
          if (pr && pr.catch) pr.catch(fin);
        } catch (e) { clearTimeout(guard); resolve(); }
      }).catch(function () { clearTimeout(guard); resolve(); });
    });
  }

  /* 静音：暂时不收音（不想让对方听见时点一下） */
  function callToggleMute() {
    var st = callState;
    var eng = st && st.engine;
    if (!eng) return;
    eng.muted = !eng.muted;
    if (eng.muted) {
      setText("#phoneCallTalkLabel", "继续听");
      setText("#phoneCallState", "已静音");
      if (eng.rec && eng.rec.state !== "inactive") { try { eng.rec.onstop = null; eng.rec.stop(); } catch (e) { /* ignore */ } }
      eng.rec = null;
    } else {
      setText("#phoneCallTalkLabel", "静音");
      setText("#phoneCallState", "通话中 · 你直接说就好");
      eng.busy = false;
      callSegBegin(eng);
    }
  }

  /* 停掉麦克风 / 分析器 / 定时器（挂断或关手机层都走这里） */
  function callEngineStop() {
    var st = callState;
    var eng = st && st.engine;
    /* 先把正在念的 TTS 停掉：挂断后还继续念对方最后那句话，很出戏 */
    if (st && st.audio) { try { st.audio.pause(); st.audio.currentTime = 0; } catch (e) { /* ignore */ } st.audio = null; }
    /* 麦克风申请到了、但 engine 还没建起来就挂断（拨号 2 秒内挂断会走到这里）——
       这时也必须把流关掉，否则麦克风会一直亮着、没人回收。 */
    if (st && st.micP) {
      st.micP.then(function (stream) {
        if (stream && stream.getTracks) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      }).catch(function () { /* 申请失败，无需处理 */ });
      st.micP = null;
    }
    if (!eng) return;
    if (eng.tick) { clearInterval(eng.tick); eng.tick = null; }
    if (eng.rec && eng.rec.state !== "inactive") { try { eng.rec.onstop = null; eng.rec.stop(); } catch (e) { /* ignore */ } }
    eng.rec = null;
    if (eng.stream) { try { eng.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ } }
    eng.stream = null;
    if (eng.ctx && eng.ctx.close) { try { eng.ctx.close(); } catch (e) { /* ignore */ } }
    eng.ctx = null; eng.an = null;
  }

  function hangUp(silent) {
    if (!callState) return;
    if (callState.timer) clearInterval(callState.timer);
    callEngineStop();
    detachLive2d();
    show($("#phoneCallStage"), false);
    var secs = Math.max(0, callState.sec - 2);
    var lines = callState.lines.slice();
    var sid = ps.sid;
    callState = null;
    show($("#phoneCall"), false);
    if (!silent && sid && secs > 0) {
      pushMsg(sid, { role: "user", kind: "call", dur: secs, text: lines.join("；") });
      renderChat(); scrollPhoneBottom();
    }
  }

  /* ── 动态（朋友圈）────────────────────────────────
     纯文字或图文，发布时选「给哪几条线看」（至少一条）。
     另有 AI 筛选框：写一条标准（如「和我一起看电影的」），AI 在这些线里模糊检索、
     挑出相符的线并顺手总结「那天发生了什么」，供预览后确认。 */
  function openMoments() {
    ps.view = "moments";
    switchView($("#phoneMomentsView"), ps.enterAnim ? 0 : 1);
    renderMoments();
  }
  function closeMoments() {
    goList();
  }
  function momentLineName(s) {
    if (!s) return "";
    if (s.isGroup) return s.title || "群聊";
    var c = characterFor(s);
    return (c ? (c.name || "角色") : aiName()) + (s.title && s.title !== "新对话" ? " · " + s.title : "");
  }
  function renderMoments() {
    var box = $("#phoneMoments");
    if (!box) return;
    box.innerHTML = "";
    var list = Store.getMoments().slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (!list.length) {
      var tip = document.createElement("div");
      tip.className = "phone-tip";
      tip.textContent = "还没有发过动态。点右上角「+」发一条，然后选给哪几条线看。";
      box.appendChild(tip);
      return;
    }
    list.forEach(function (m) { box.appendChild(momentEl(m)); });
  }
  function momentEl(m) {
    var wrap = document.createElement("div");
    wrap.className = "ph-moment";
    var head = document.createElement("div");
    head.className = "ph-moment-head";
    head.appendChild(avatarEl(state.settings.phoneAvatarUser || state.settings.avatarUser || "", "user"));
    var meta = document.createElement("div");
    meta.className = "ph-moment-meta";
    var nm = document.createElement("div");
    nm.className = "ph-moment-name";
    nm.textContent = "我";
    var tm = document.createElement("div");
    tm.className = "ph-moment-time";
    tm.textContent = fmtWhen(m.ts);
    meta.appendChild(nm); meta.appendChild(tm);
    head.appendChild(meta);
    var del = document.createElement("button");
    del.className = "ph-moment-del";
    del.type = "button";
    del.textContent = "删除";
    del.addEventListener("click", function () {
      Store.saveMoments(Store.getMoments().filter(function (x) { return x.id !== m.id; }));
      renderMoments();
    });
    head.appendChild(del);
    wrap.appendChild(head);
    if (m.text) {
      var t = document.createElement("div");
      t.className = "ph-moment-text";
      t.textContent = String(m.text);
      wrap.appendChild(t);
    }
    if (m.image) {
      var url = Store.imageURL ? Store.imageURL(m.image) : (m.image.dataUrl || "");
      if (url) {
        var iw = document.createElement("div");
        iw.className = "ph-moment-img";
        var im = document.createElement("img");
        im.src = url; im.alt = "";
        iw.appendChild(im);
        wrap.appendChild(iw);
      }
    }
    var vis = document.createElement("div");
    vis.className = "ph-moment-vis";
    var names = [];
    (m.lines || []).forEach(function (sid) {
      var s = sessionById(sid);
      if (s) names.push(momentLineName(s));
    });
    vis.textContent = names.length ? "可见：" + names.join("、") : "（没有可见的线）";
    wrap.appendChild(vis);
    return wrap;
  }
  function fmtWhen(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* 发布动态的底部弹层 */
  var postDraft = null;
  function openPostSheet() {
    var box = document.createElement("div");
    postDraft = { text: "", image: null, lines: [], previewEl: null, linesBox: null };

    var ta = document.createElement("textarea");
    ta.className = "ph-post-text";
    ta.rows = 3;
    ta.placeholder = "说点什么…";
    ta.addEventListener("input", function () { postDraft.text = ta.value; });
    box.appendChild(ta);

    var imgRow = document.createElement("div");
    imgRow.className = "ph-post-imgrow";
    var pick = document.createElement("button");
    pick.type = "button"; pick.className = "btn ghost"; pick.textContent = "选图片";
    var preview = document.createElement("div");
    preview.className = "ph-post-preview";
    pick.addEventListener("click", function () { var i = $("#phoneMomentImg"); if (i) i.click(); });
    imgRow.appendChild(pick); imgRow.appendChild(preview);
    box.appendChild(imgRow);
    postDraft.previewEl = preview;

    var aiWrap = document.createElement("div");
    aiWrap.className = "ph-post-ai";
    var aiIn = document.createElement("input");
    aiIn.type = "text";
    aiIn.placeholder = "AI 选线：例如「和我一起看电影的」";
    var aiBtn = document.createElement("button");
    aiBtn.type = "button"; aiBtn.className = "btn primary"; aiBtn.textContent = "帮我挑";
    var aiNote = document.createElement("div");
    aiNote.className = "ph-post-ainote";
    aiBtn.addEventListener("click", function () {
      var q = String(aiIn.value || "").trim();
      if (!q) { toast("先写一条标准", true); return; }
      aiPickLines(q, aiNote, aiBtn);
    });
    aiWrap.appendChild(aiIn); aiWrap.appendChild(aiBtn); aiWrap.appendChild(aiNote);
    box.appendChild(aiWrap);

    var lab = document.createElement("div");
    lab.className = "ph-post-label";
    lab.textContent = "给哪几条线看（至少一条）";
    box.appendChild(lab);
    var linesBox = document.createElement("div");
    linesBox.className = "ph-line-list";
    var sess = Store.getSessions();
    if (!sess.length) {
      var p = document.createElement("p");
      p.className = "hint";
      p.textContent = "还没有对话，先去建一条线。";
      linesBox.appendChild(p);
    }
    sess.forEach(function (s) {
      var row = document.createElement("label");
      row.className = "ph-line";
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.value = s.id;
      cb.addEventListener("change", function () {
        var k = postDraft.lines.indexOf(s.id);
        if (cb.checked) { if (k < 0) postDraft.lines.push(s.id); }
        else if (k >= 0) postDraft.lines.splice(k, 1);
      });
      var t = document.createElement("span");
      t.className = "ph-line-title";
      t.textContent = momentLineName(s);
      row.appendChild(cb); row.appendChild(t);
      linesBox.appendChild(row);
    });
    box.appendChild(linesBox);
    postDraft.linesBox = linesBox;

    setTimeout(function () { ta.focus(); }, 60);
    openSheet("发布动态", box, doPost);
  }

  function doPost() {
    var d = postDraft;
    if (!d) { closeSheet(); return; }
    var text = String(d.text || "").trim();
    if (!text && !d.image) { toast("写点什么，或者发张图", true); return; }
    if (!d.lines.length) { toast("至少选一条线，不然没人看得到", true); return; }
    if (d.image && Store.hoistImage) { try { Store.hoistImage(d.image); } catch (e) { /* ignore */ } }
    var list = Store.getMoments();
    list.push({
      id: "mo_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      text: text,
      lines: d.lines.slice(),
      image: d.image || null
    });
    Store.saveMoments(list);
    postDraft = null;
    closeSheet();
    renderMoments();
    toast("动态已发布，选中的线都看得到");
  }

  function handleMomentImage(file) {
    if (!postDraft || !file) return;
    readImageFile(file).then(function (got) {
      if (!postDraft) return;
      postDraft.image = { kind: "image", dataUrl: got.dataUrl, name: got.name, mime: "image/jpeg" };
      var pv = postDraft.previewEl;
      if (pv) {
        pv.innerHTML = "";
        var im = document.createElement("img");
        im.src = got.dataUrl;
        pv.appendChild(im);
      }
    }).catch(function (e) { toast(e.message || "图片读取失败", true); });
  }

  function parseJsonLoose(text) {
    var s = String(text || "");
    var a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }

  /* AI 选线：把每条线的近况给模型，让它挑出与标准相符的，并总结那天的经过 */
  async function aiPickLines(query, noteEl, btn) {
    syncModules();
    if (!state.settings.apiKey) { toast("请先在「设置」里填写 API Key", true); return; }
    var sess = Store.getSessions();
    if (!sess.length) { toast("还没有可选的线", true); return; }
    if (btn) btn.disabled = true;
    if (noteEl) noteEl.textContent = "正在检索…";
    try {
      var digest = sess.slice(0, 20).map(function (s) {
        var all = (s.messages || []).concat((s.phone && s.phone.msgs) || []);
        var recent = all.slice(-20).map(function (x) {
          /* 主聊天的助手消息正文在 variants[vi].content（不是顶层 content），
             只读 x.content 会把角色的回复整段读丢，选线依据就只剩我方发言。 */
          var body = "";
          if (Array.isArray(x.variants) && x.variants.length) {
            var vi = (typeof x.vi === "number" && x.variants[x.vi] != null) ? x.vi : 0;
            var v = x.variants[vi];
            body = (v && typeof v === "object") ? String(v.content || "") : String(v == null ? "" : v);
          } else if (x.text != null) body = String(x.text);
          else if (x.content != null) body = String(x.content);
          return (x.role === "user" ? "我：" : "对方：") + body.replace(/\s+/g, " ").slice(0, 120);
        }).filter(function (x) { return x.length > 3; }).join("\n");
        return "【线 id=" + s.id + "】" + momentLineName(s) + "\n" + (recent || "（没有聊过）");
      }).join("\n\n");
      var sys = "你是检索助手。用户给你一条筛选标准和若干条对话线，请挑出与标准相符的线，" +
        "并简要总结「那天发生了什么」（一两句话）。只输出 JSON，不要任何多余文字：" +
        "{\"picks\":[\"线id\", ...],\"summary\":\"…\"}。都不相符时 picks 给空数组，summary 说明没找到。";
      var out = await Api.summarize(phoneSettings(null), [
        { role: "system", content: sys },
        { role: "user", content: "筛选标准：" + query + "\n\n候选线：\n" + digest }
      ], { maxTokens: 800 });
      if (out && out.usage && typeof recordUsage === "function") recordUsage(null, out.usage, null, "moment");
      var obj = parseJsonLoose(out && out.text);
      var picks = (obj && Array.isArray(obj.picks)) ? obj.picks.map(String) : [];
      var box = postDraft && postDraft.linesBox;
      if (box) {
        var cbs = box.querySelectorAll("input[type=checkbox]");
        for (var i = 0; i < cbs.length; i++) {
          if (picks.indexOf(cbs[i].value) >= 0 && !cbs[i].checked) {
            cbs[i].checked = true;
            postDraft.lines.push(cbs[i].value);
          }
        }
      }
      if (noteEl) noteEl.textContent = (obj && obj.summary) ? ("筛选结果：" + obj.summary) : "AI 没给出可用的结果";
    } catch (e) {
      if (noteEl) noteEl.textContent = "筛选失败：" + (e && e.message ? e.message : e);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ── 事件绑定（本模块自己绑，app.js 不重复绑）──────── */
  var bound = false;
  function bindEvents() {
    if (bound) return;
    bound = true;
    on("#phoneBtn", "click", function () { openPhone(); window.DL.closeSidebar && window.DL.closeSidebar(); });
    on("#phoneTopBtn", "click", function () { openPhoneFor(session() ? session().id : ""); });
    on("#phoneCloseBtn", "click", closePhone);
    on("#phoneCloseBtn2", "click", closePhone);
    /* 列表页右上角加号 → 浮窗：发布动态 / 新建联系人（纯手机角色） */
    on("#phoneAddBtn", "click", function () { showAddSheet(true); });
    on("#phoneAddCancel", "click", function () { showAddSheet(false); });
    on("#phAddMoment", "click", function () { showAddSheet(false); openMoments(); });
    on("#phAddContact", "click", function () { showAddSheet(false); newPhoneContact(); });
    /* 手机群聊：走主群聊那个建群弹窗，但模式是 phone（不绑线、不导记忆） */
    on("#phAddGroup", "click", function () {
      showAddSheet(false);
      if (window.DL && DL.openGroupModal) DL.openGroupModal("phone");
    });
    on("#phoneBack", "click", function () { hangUp(true); goList(); });
    on("#phoneMomentsBack", "click", closeMoments);
    on("#phoneMomentsClose", "click", closePhone);
    on("#phoneMomentsPost", "click", openPostSheet);
    on("#phoneMomentImg", "change", function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) handleMomentImage(f);
    });
    on("#phoneSend", "click", sendText);
    on("#phoneInput", "keydown", function (e) {
      /* 输入法组字中按回车是在「上屏选词」，不是要发送 —— 不判 isComposing 会把半截拼音发出去 */
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") { e.preventDefault(); sendText(); }
    });
    on("#phoneSetBtn", "click", function () { openPhoneSettings(); });
    on("#phoneMore", "click", function () {
      var row = document.querySelector("#phoneChatView .phone-actions");
      if (row) {
        row.hidden = !row.hidden;
        /* 图标补注入：这一块在启动那次 applyIcons 之后没再刷新过，
           真机上出现过「方块是空的」—— 展开时补一遍最省事，也不影响别的区域 */
        if (!row.hidden && UI.applyIcons) UI.applyIcons(row);
      }
    });
    on("#phoneActTransfer", "click", doTransfer);
    on("#phoneActLoc", "click", doLocation);
    on("#phoneActImg", "click", function () { var i = $("#phoneImgInput"); if (i) i.click(); });
    on("#phoneActVoice", "click", toggleVoice);
    on("#phoneActCall", "click", function () { startCall(false); });
    on("#phoneActVideo", "click", function () { startCall(true); });
    on("#phoneImgInput", "change", function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) handleImageFile(f);
    });
    on("#phoneSheetCancel", "click", closeSheet);
    on("#phoneSheetOk", "click", function () { if (typeof ps.sheetOk === "function") ps.sheetOk(); else closeSheet(); });
    /* 电话：不再「按住说话」。接通后自动一直听；这个按钮变成「静音 / 继续听」开关 */
    on("#phoneCallTalk", "click", callToggleMute);
    /* 视频开关：通话中随时切（静态图 ↔ live2D） */
    on("#phoneCallCam", "click", callToggleVideo);
    /* 点一下画面：让角色做个动作（live2D 没跑起来就什么都不做，不报错） */
    on("#phoneCallStage", "click", function () {
      var L2 = window.DL && window.DL.live2d;
      if (L2 && L2.tap) L2.tap();
    });
    on("#phoneCallHang", "click", function () { hangUp(false); });
  }

  /* ── 暴露给 app.js（返回键用）与转发入口 ───────────── */
  var api = {
    openPhone: openPhone,
    openPhoneFor: openPhoneFor,
    closePhone: closePhone,
    /* 手机页开着的时候，外部（比如刚建完群）需要它重画列表 —— renderAll 不管这块 */
    refreshList: function () { try { if (!$("#phoneModal") || $("#phoneModal").hidden) return; if (ps.view === "list") renderList(); } catch (e) { /* ignore */ } },
    /* 当前手机页这条线的独立背景（没设过返回空 → app.js 回落到全局手机背景） */
    phoneLineBg: function () {
      var s = sessionById(ps.sid);
      return s && s.phoneBg ? String(s.phoneBg) : "";
    },
    /* 开关顶部「对方正在输入…」条（生成期间亮着；回归测试也用它） */
    typing: function (show) { if (show) showTyping(); else hideTyping(); return !!show; },
    /* 重渲消息区（AI 回复走的就是 renderChat，不经过 openPhoneFor 的重置） */
    renderChat: function () { renderChat(); return true; },
    /* 新消息要不要把聊天框顶上去：贴底才滚，翻旧消息时不打扰 */
    atBottom: function () { return atPhoneBottom(); },
    /* 「手机模式」的主动分享投递（文字 + 可选配图）——app.js 的自动发信息计时器用它 */
    applyAutoShare: applyAutoShare,
    /* 长回复拆成多条短消息（回归测试直接测它） */
    splitReply: function (t) { return splitPhoneReply(t); },
    /* 手机群的系统提示词（回归测试用：验证绑线的记忆与表情包真的进了提示词） */
    groupSys: function (s) { return buildGroupSysPhone(s); },
    groupMembers: function (s) { return phoneGroupMembers(s); },
    /* 双线：从模型回复里剥出「线下」那段（测试与调试用） */
    splitOffline: function (t) { return splitOffline(t); },
    /* 删一条手机消息（连同绑定的主聊天那条）。名字带 Phone 前缀，
       免得以后主聊天那边也挂一个 deleteMsg 撞名。 */
    deletePhoneMessage: function (msg) { return deletePhoneMsg(ps.sid, msg); },
    splitSpeakers: function (t, s) { return splitPhoneSpeakers(t, s); },
    syncPhoneOpening: function () { return syncPhoneOpening(); },
    /* 回归测试 / 调试：直接跑一轮手机生成，不经过输入框与发送键
       （双段式：正文一段、挑表情一段，两条都在这里验证） */
    reply: function (sid) { return genReply(sid || ps.sid); },
    pickSticker: function (s, text, who) { return pickSticker(s, text, who); }
  };
  Object.keys(api).forEach(function (k) {
    /* 同上（roleplay.js）：只转发现有函数，undefined 成员会让调用点抛
       「Cannot read property 'apply' of undefined」，看着像框架问题。 */
    if (typeof api[k] !== "function") return;
    D[k] = function () { syncModules(); return api[k].apply(null, arguments); };
  });
  /* 返回键：app.js 的 onBackKey 会先问这里（和相机层同一套约定） */
  window.DL.phone = {
    /* 回归测试 / 别处复用（10-20）：转发、合并转发、撤回、@ 的入口 */
    open: function (sid) { ps.sid = sid; ps.view = "chat"; ps.pick = null; renderChat(); },
    /* 直接进某条会话的手机聊天（历史搜索点到手机结果时用这个，别用 #phoneBtn 那个只会进列表的） */
    openLine: function (sid) { return openPhoneFor(sid); },
    targets: function () { return fwdTargets(); },
    msgText: function (m) { return msgText(m); },
    recall: function (m) { return recallPhoneMsg(m); },
    forward: function (msgs, ts) { return doForward(msgs, ts); },
    mergeForward: function (msgs, ts) { return doMergeForward(msgs, ts); },
    groupSys: function (sid) { var s = sessionById(sid); return s ? buildGroupSysPhone(s) : ""; },
    isOpen: function () {
      if (callState) return true;      /* 通话中：返回键先挂断 */
      var el = $("#phoneModal"); return !!(el && !el.hidden);
    },
    /* 返回键逐级退（10-24 用户要求：手机页的返回键必须是「返回上一级」）：
       顺序 = 浮层 → 通话 → 动态 → 聊天页里的动作条 / 多选 → 列表。
       返回 true 表示「吃掉了这次返回」，false 交给上层（关手机）。 */
    back: function () {
      var el = $("#phoneModal");
      if (!el || el.hidden) return false;
      /* 1) 两个浮层都压在聊天页上面，先收 */
      var sheet = $("#phoneSheet");
      if (sheet && !sheet.hidden) { closeSheet(); return true; }
      var addSheet = $("#phoneAddSheet");
      if (addSheet && !addSheet.hidden) { show(addSheet, false); return true; }
      /* 2) 通话中 → 挂断 */
      if (callState) { hangUp(true); return true; }
      /* 3) 动态页 → 列表 */
      if (ps.view === "moments") { closeMoments(); return true; }
      /* 4) 聊天页：功能条 → 多选 → 列表 */
      if (ps.view === "chat") {
        var row = document.querySelector("#phoneChatView .phone-actions");
        if (row && !row.hidden) { row.hidden = true; return true; }
        if (ps.pick) { exitPick(); return true; }
        goList();
        return true;
      }
      /* 5) 已在列表：不自作主张关手机，交回上层 */
      return false;
    },
    close: function () {
      if (callState) { hangUp(false); return; }
      /* 动态页：返回键先退回列表 */
      if (ps.view === "moments") { closeMoments(); return; }
      if (ps.view === "chat") { hangUp(true); goList(); return; }
      var el = $("#phoneModal");
      if (el && !el.hidden) closePhone();
    }
  };

  bindEvents();
  (window.__dlScripts = window.__dlScripts || []).push("phone.js");
  return true;
  }

  /* 正常情况（app.js 先执行）这里第一次就成功；app.js 还没到位时等 DOM 就绪 + 再补拍几次 */
  if (!boot()) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    var tries = 0;
    var retry = function () { if (boot()) return; if (++tries < 20) setTimeout(retry, 150); };
    setTimeout(retry, 150);
  }
})();
