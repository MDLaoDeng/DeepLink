/* profile.js —— 角色资料页（7.1「还原微信」）
 *
 * 三页：
 *   ① 资料页：头像 / 备注名 / 昵称 / Sekulum 号 / 地区 + 朋友资料入口 + 朋友圈缩略 + 发消息 / 音视频
 *   ② 朋友资料：备注、电话、标签、备忘、照片、权限、共同群聊、签名、来源、添加时间
 *   ③ 朋友圈：封面 + 签名 + 该角色发过的动态（按日期倒序）
 *
 * 数据分两处存（这是刻意的）：
 *   · 角色的资料字段（号/电话/地区/签名/标签/备忘/备注/来源/添加时间）→ 角色对象的 social 子对象，
 *     跟着角色卡一起加密落盘，导出时一起走。
 *   · 好友申请队列（谁想加谁、通过没有）→ Store.getSocial()，是「关系事件」不是「角色属性」。
 *
 * 设计约束（沿用 desktop-agent-ui）：
 *   字号只用 var(--fs-*)，圆角只用 var(--r-*)，描边 0.5px，触控目标 ≥44px，不用中点分隔。
 */
(function () {
  var layer = null;          /* #profileLayer */
  var curId = "";            /* 当前看的角色 id */
  var view = "main";         /* main | detail | moments */
  var busy = false;

  function D() { return window.DL || {}; }
  function S() { return window.Store; }
  function U() { return window.UI; }

  /* ── 小工具 ───────────────────────────────────── */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name) {
    return (U() && U().iconSvg) ? U().iconSvg(name) : "";
  }
  function charById(id) {
    var list = S().getCharacters() || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function avatarUrl(v) {
    var d = D();
    return (d.avatarUrl && v) ? d.avatarUrl(v) : (v || "");
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  /* 动态里的图可能是「附件对象」（带 imgRef，外置成文件了），也可能只是字符串地址。
     统一解成能塞进 img.src 的东西 —— 否则外置之后这里会是个 [object Object]。 */
  function picUrl(x) {
    if (!x) return "";
    if (typeof x === "string") return x;
    return (S().imageURL ? S().imageURL(x) : (x.dataUrl || x.url || ""));
  }

  /* ── 资料字段（懒生成）─────────────────────────────
     存量角色没有这些字段：第一次打开资料页时才补，避免一次性重写全部加密角色卡。 */
  var REGIONS = ["贵州 贵阳", "四川 成都", "浙江 杭州", "广东 广州", "湖南 长沙",
    "江苏 南京", "湖北 武汉", "福建 厦门", "陕西 西安", "云南 昆明",
    "重庆", "上海", "北京", "天津", "辽宁 沈阳", "山东 青岛"];

  function rnd(n) { return Math.floor(Math.random() * n); }
  /* Sekulum 号：8 位数字，首位非 0（避免显示成 0 开头像被截断） */
  function newSid() {
    var s = String(1 + rnd(9));
    while (s.length < 8) s += String(rnd(10));
    return s;
  }
  /* 电话：13 位、1 开头（用户口径 10-28）。第二三位取常见号段，看着别太假。 */
  var PREFIX = ["30", "31", "32", "33", "35", "36", "37", "38", "39", "50", "51", "52", "55", "58", "59", "70", "76", "86", "88", "89"];
  function newTel() {
    var s = "1" + PREFIX[rnd(PREFIX.length)];
    while (s.length < 13) s += String(rnd(10));
    return s;
  }
  /* 号要唯一：撞了就重摇（8 位空间很大，实际几乎不会撞） */
  function uniqSid(list) {
    var used = {};
    (list || []).forEach(function (c) { if (c.social && c.social.sid) used[c.social.sid] = 1; });
    var s = newSid(), guard = 0;
    while (used[s] && guard++ < 50) s = newSid();
    return s;
  }

  function ensureSocial(ch) {
    if (!ch) return null;
    var changed = false;
    if (!ch.social || typeof ch.social !== "object") { ch.social = {}; changed = true; }
    var so = ch.social;
    if (!so.sid) { so.sid = uniqSid(S().getCharacters()); changed = true; }
    if (!so.tel) { so.tel = newTel(); changed = true; }
    if (!so.region) { so.region = REGIONS[rnd(REGIONS.length)]; changed = true; }
    if (typeof so.tags !== "string") { so.tags = ""; changed = true; }
    if (typeof so.memo !== "string") { so.memo = ""; changed = true; }
    if (typeof so.sign !== "string") { so.sign = ""; changed = true; }
    if (typeof so.remark !== "string") { so.remark = ""; changed = true; }
    if (typeof so.addedAt !== "number") { so.addedAt = ch.createdAt || Date.now(); changed = true; }
    if (typeof so.addedVia !== "string") { so.addedVia = "手动添加"; changed = true; }
    if (!Array.isArray(so.photos)) { so.photos = []; changed = true; }
    if (changed) saveChar(ch);
    return so;
  }
  function saveChar(ch) {
    var list = S().getCharacters();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === ch.id) { list[i] = ch; S().saveCharacters(list); return true; }
    }
    return false;
  }
  /* 显示名：备注优先，其次角色名 */
  function showName(ch) {
    if (!ch) return "未知";
    var so = ch.social || {};
    return (so.remark && String(so.remark).trim()) || ch.name || ch.fields && ch.fields.aiName || "未命名";
  }
  function nickName(ch) {
    if (!ch) return "";
    var f = ch.fields || {};
    return String(f.aiName || ch.name || "").trim();
  }

  /* ── 共同群聊 ─────────────────────────────────────
     现实群与手机群都算（两边成员都存在 session.members 上，只是消息位置不同）。 */
  function commonGroups(chId) {
    if (!chId) return [];
    var out = [];
    (S().getSessions() || []).forEach(function (s) {
      if (!s || !s.isGroup) return;
      var ms = s.members || [];
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        var mid = (m && typeof m === "object") ? (m.id || m.characterId || "") : m;
        if (mid === chId) { out.push(s); return; }
      }
    });
    return out;
  }

  /* ── 好友申请队列 ───────────────────────────────── */
  function reqs() { return (S().getSocial() || {}).reqs || []; }
  function pendingReqs() {
    return reqs().filter(function (r) { return r && r.status === "pending"; });
  }
  /* 发起一条申请。to 可以是角色 id 或 "me"。
     去重：同一对 (from,to) 已经有 pending 就不再加。 */
  function requestFriend(from, to, via, viaKind) {
    if (!from || !to || from === to) return null;
    var all = reqs();
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (r.from === from && r.to === to && r.status === "pending") return r;
    }
    var req = {
      id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      from: from, to: to,
      via: String(via || ""), viaKind: String(viaKind || "group"),
      status: "pending", at: Date.now()
    };
    all.unshift(req);
    /* 队列只留最近 200 条，避免无限长 */
    S().saveSocial({ reqs: all.slice(0, 200) });
    return req;
  }
  function setReqStatus(id, status) {
    var all = reqs();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) {
        all[i].status = status;
        all[i].decidedAt = Date.now();
        S().saveSocial({ reqs: all });
        return all[i];
      }
    }
    return null;
  }
  /* 通过：把「来源」和「添加时间」写到被加那个角色身上（资料页要显示） */
  function acceptReq(id) {
    var r = null, all = reqs();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) { r = all[i]; break; }
    if (!r) return null;
    setReqStatus(id, "accepted");
    ensureSocial(charById(r.from));
    var ch = charById(r.from);
    if (ch && ch.social) {
      ch.social.addedAt = Date.now();
      ch.social.addedVia = r.via ? ("通过" + (r.viaKind === "group" ? "群聊" : "好友") + "「" + r.via + "」添加") : "手动添加";
      saveChar(ch);
    }
    return r;
  }
  function rejectReq(id) { return setReqStatus(id, "rejected"); }

  /* ── 动态（朋友圈）───────────────────────────────
     现有 moments 结构：{ id, ts, text, imgs?, vis? }，没有 who 字段（= 我发的）。
     7.1 起角色发的带 who = 角色 id；读的时候 who 为空一律当我。 */
  function momentsOf(chId) {
    return (S().getMoments() || []).filter(function (m) {
      if (!m) return false;
      return chId === "me" ? !m.who : (m.who === chId);
    }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  }
  function addCharMoment(chId, text, imgs) {
    var list = S().getMoments() || [];
    var m = {
      id: "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      who: chId, ts: Date.now(), text: String(text || ""), imgs: imgs || [],
      vis: "public", byAI: true
    };
    list.unshift(m);
    S().saveMoments(list.slice(0, 500));
    return m;
  }
  function fmtDay(ts) {
    var d = new Date(ts || Date.now());
    return pad2(d.getMonth() + 1) + "月" + pad2(d.getDate()) + "日";
  }
  function fmtFull(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月";
  }

  /* ── 异步：让 AI 按背景补签名 / 地区（不阻塞渲染）──────────
     规则：只有「签名还是空」时才补一次，补完落库，下次不再调。
     用户手填过的（sign 非空）永远不覆盖。 */
  var aiPending = {};
  function fillByAI(ch) {
    if (!ch || aiPending[ch.id]) return;
    var so = ch.social;
    if (!so || (so.sign && String(so.sign).trim())) return;
    /* 试过一次就不再试：以前每次重渲资料页都打一次模型（sign 空 + 失败 → 无限重试）。
       用户手动清空签名时会把 aiSignTried 抹掉，那时才允许再试。 */
    if (so.aiSignTried) return;
    if (!(window.Api && Api.summarize)) return;
    var st = (D().state || {}).settings || {};
    if (!st.apiKey) return;
    aiPending[ch.id] = true;
    var f = ch.fields || {};
    var bg = [f.aiBackground, f.aiPersona, f.aiLikes, f.world].filter(Boolean).join("；").slice(0, 600);
    if (!bg) { aiPending[ch.id] = false; return; }
    var prompt = "根据这个人物的背景，给两样东西：\n" +
      "1) 一句个性签名（不超过 14 字，像微信签名，第一人称或短语，别写解释）；\n" +
      "2) 他大概所在的地区（中国省市，如「贵州 贵阳」）。\n" +
      "只输出两行，第一行写「签名：xxx」，第二行写「地区：xxx」，不要别的内容。\n\n" +
      "人物：\n" + bg;
    Api.summarize(st, [{ role: "user", content: prompt }]).then(function (r) {
      var t = String((r && r.text) || "");   /* summarize 返回 text，不是 content */
      var ms = /签名[:：]\s*(.+)/.exec(t);
      var mr = /地区[:：]\s*(.+)/.exec(t);
      var live = charById(ch.id);
      if (!live || !live.social) return;
      var touched = false;
      if (ms) {
        var sg = ms[1].trim().replace(/^["「『]|["」』]$/g, "").slice(0, 24);
        if (sg && !String(live.social.sign || "").trim()) { live.social.sign = sg; touched = true; }
      }
      if (mr) {
        var rg = mr[1].trim().slice(0, 16);
        if (rg && /[\u4e00-\u9fa5]/.test(rg)) { live.social.region = rg; touched = true; }
      }
      if (live.social) live.social.aiSignTried = true;   /* 标记「试过了」，无论成没成 */
      saveChar(live);
      if (curId === ch.id) render();
    }).catch(function () { /* 补不出来不影响资料页 */ })
      .then(function () { aiPending[ch.id] = false; });
  }

  /* ── DOM ──────────────────────────────────────── */
  function ensureLayer() {
    if (layer) return layer;
    layer = document.getElementById("profileLayer");
    if (layer) return layer;
    layer = el("div", "profile-layer");
    layer.id = "profileLayer";
    layer.hidden = true;
    document.body.appendChild(layer);
    return layer;
  }

  function head(title, onBack, rightNode) {
    var h = el("div", "pf-head");
    var b = el("button", "icon-btn pf-back");
    b.type = "button";
    b.setAttribute("aria-label", "返回");
    b.innerHTML = icon("chevron-left");
    b.addEventListener("click", onBack);
    h.appendChild(b);
    h.appendChild(el("div", "pf-title", title));
    if (rightNode) h.appendChild(rightNode);
    else h.appendChild(el("span", "pf-head-pad"));
    return h;
  }

  function row(label, value, onclick, extraCls) {
    var r = el("button", "pf-row" + (extraCls ? " " + extraCls : ""));
    r.type = "button";
    var l = el("span", "pf-row-k", label);
    var v = el("span", "pf-row-v");
    v.textContent = value == null || value === "" ? "未填写" : String(value);
    if (!value) v.classList.add("pf-empty");
    r.appendChild(l); r.appendChild(v);
    r.appendChild(el("span", "pf-row-a", "›"));
    if (onclick) r.addEventListener("click", onclick);
    else r.disabled = true;
    return r;
  }

  function infoRow(label, value) {
    var r = el("div", "pf-row pf-row-static");
    r.appendChild(el("span", "pf-row-k", label));
    var v = el("span", "pf-row-v");
    v.textContent = value == null || value === "" ? "—" : String(value);
    r.appendChild(v);
    return r;
  }

  function secTitle(t) {
    return el("div", "pf-sec", t);
  }

  /* ① 资料页 */
  function mainView(ch) {
    var so = ensureSocial(ch);
    var wrap = el("div", "pf-page");
    var more = el("button", "icon-btn pf-more");
    more.type = "button";
    more.setAttribute("aria-label", "更多");
    more.innerHTML = icon("dots-horizontal");
    more.addEventListener("click", function () { openDetail(); });
    wrap.appendChild(head("", function () { close(); }, more));

    var top = el("div", "pf-top");
    var av = el("div", "pf-av");
    var src = avatarUrl(ch.avatar);
    if (src) {
      var im = el("img");
      im.src = src; im.alt = "";
      av.appendChild(im);
    } else av.innerHTML = icon("account");
    top.appendChild(av);

    var info = el("div", "pf-info");
    info.appendChild(el("div", "pf-name", showName(ch)));
    var nk = nickName(ch);
    if (nk && nk !== showName(ch)) info.appendChild(el("div", "pf-line", "昵称：" + nk));
    info.appendChild(el("div", "pf-line", "Sekulum 号：" + (so.sid || "—")));
    info.appendChild(el("div", "pf-line", "地区：" + (so.region || "—")));
    top.appendChild(info);
    wrap.appendChild(top);

    wrap.appendChild(el("div", "pf-gap"));

    /* 朋友资料入口 */
    var d = el("button", "pf-entry");
    d.type = "button";
    var dt = el("div", "pf-entry-tx");
    dt.appendChild(el("div", "pf-entry-t", "朋友资料"));
    dt.appendChild(el("div", "pf-entry-s", "备注、电话、标签、备忘、照片"));
    d.appendChild(dt);
    d.appendChild(el("span", "pf-row-a", "›"));
    d.addEventListener("click", function () { openDetail(); });
    wrap.appendChild(d);

    /* 朋友圈缩略 */
    var ms = momentsOf(ch.id);
    var me = el("button", "pf-entry pf-entry-moments");
    me.type = "button";
    me.appendChild(el("div", "pf-entry-tx")).appendChild(el("div", "pf-entry-t", "动态"));
    var thumbs = el("div", "pf-thumbs");
    var withImg = ms.filter(function (m) { return m.imgs && m.imgs.length; }).slice(0, 3);
    if (withImg.length) {
      withImg.forEach(function (m) {
        var t = el("div", "pf-thumb");
        var i2 = el("img");
        i2.src = m.imgs[0]; i2.alt = "";
        t.appendChild(i2);
        thumbs.appendChild(t);
      });
    } else if (ms.length) {
      thumbs.appendChild(el("span", "pf-thumb-tx", ms.length + " 条动态"));
    } else {
      thumbs.appendChild(el("span", "pf-thumb-tx", "还没有动态"));
    }
    me.appendChild(thumbs);
    me.appendChild(el("span", "pf-row-a", "›"));
    me.addEventListener("click", function () { openMoments(); });
    wrap.appendChild(me);

    wrap.appendChild(el("div", "pf-gap"));

    /* 发消息 / 音视频 */
    var act1 = el("button", "pf-act");
    act1.type = "button";
    act1.innerHTML = icon("message-text-outline") + "<span>发消息</span>";
    act1.addEventListener("click", function () {
      close();
      var d2 = D();
      if (d2.openPhoneFor) { d2.openPhoneFor(ch.id); return; }
      if (d2.phone && d2.phone.openLine) d2.phone.openLine(ch.id);
    });
    wrap.appendChild(act1);

    var act2 = el("button", "pf-act");
    act2.type = "button";
    act2.innerHTML = icon("phone-outline") + "<span>语音通话</span>";
    act2.addEventListener("click", function () {
      close();
      var d3 = D();
      if (d3.openPhoneFor) d3.openPhoneFor(ch.id);
      if (U().toast) U().toast("进手机页后点「电话」即可拨号");
    });
    wrap.appendChild(act2);

    return wrap;
  }

  /* ② 朋友资料 */
  function detailView(ch) {
    var so = ensureSocial(ch);
    var wrap = el("div", "pf-page");
    wrap.appendChild(head("朋友资料", function () { openMain(); }));

    wrap.appendChild(secTitle("备注"));
    wrap.appendChild(row("备注名", so.remark || showName(ch), function () {
      ask("改备注名", "只改你看到的名字，不影响角色自己的认知。", so.remark || showName(ch)).then(function (v) {
        if (v === null) return;
        so.remark = v; saveChar(ch); render();
      });
    }));
    wrap.appendChild(row("电话", so.tel, function () {
      ask("改电话", "", so.tel).then(function (v) {
        if (v === null) return;
        so.tel = v; saveChar(ch); render();
      });
    }));
    wrap.appendChild(row("标签", so.tags, function () {
      ask("标签", "多个用顿号分开", so.tags).then(function (v) {
        if (v === null) return;
        so.tags = v; saveChar(ch); render();
      });
    }));
    wrap.appendChild(row("备忘", so.memo, function () {
      ask("长期备忘", "记在这里的是长期的事；「即时备忘录」在手机页加号里。", so.memo, true).then(function (v) {
        if (v === null) return;
        so.memo = v; saveChar(ch); render();
      });
    }));
    wrap.appendChild(row("照片", (so.photos && so.photos.length) ? so.photos.length + " 张" : "", function () {
      if (U().toast) U().toast("角色图库在「角色 → 图库」里，这里只显示数量");
    }));

    wrap.appendChild(secTitle("朋友权限"));
    wrap.appendChild(row("权限", "聊天、动态", null));

    wrap.appendChild(secTitle("更多信息"));
    var gs = commonGroups(ch.id);
    var gn = gs.map(function (g) { return g.title || "群聊"; });
    wrap.appendChild(row("我和TA的共同群聊", gs.length ? gs.length + " 个" + (gn.length ? "（" + gn.slice(0, 2).join("、") + (gn.length > 2 ? "…" : "") + "）" : "") : "0 个", null));
    wrap.appendChild(infoRow("签名", so.sign));
    wrap.appendChild(infoRow("来源", so.addedVia));
    wrap.appendChild(infoRow("添加时间", fmtFull(so.addedAt)));
    return wrap;
  }

  /* ③ 动态（原「朋友圈」，10-28 用户口径：这个名字有版权风险，全项目统一叫「动态」）
     · 角色：封面可上传，也可让 AI 按他的背景与气质画一张
     · 我（ch 传 null）：封面只能上传 —— 用户明确要求「背景只支持上传」
     embed=true 时不带整页外壳与标题栏，供手机页嵌进去用。 */
  function momentsView(ch, embed) {
    var isMe = !ch;
    var wrap = el("div", embed ? "pf-moments-embed" : "pf-page pf-moments-page");
    if (!embed) {
      wrap.appendChild(head(isMe ? "我的动态" : "动态", function () {
        if (isMe) close(); else openMain();
      }));
    }

    var cover = el("div", "pf-cover pf-cover-edit");
    var cov = coverOf(ch, isMe);
    if (cov) {
      cover.style.backgroundImage = "url(" + cov + ")";
      cover.classList.add("pf-cover-has");
    }
    cover.appendChild(el("div", "pf-cover-name", isMe
      ? (((D().state || {}).settings || {}).myName || "我")
      : showName(ch)));
    var cam = el("span", "pf-cover-cam");
    cam.innerHTML = icon("camera-outline") || icon("creation") || "";
    cover.appendChild(cam);
    cover.addEventListener("click", function () { editCover(ch, isMe); });
    wrap.appendChild(cover);

    var body = el("div", "pf-moments-body");
    var ms = momentsOf(isMe ? "me" : ch.id);
    if (!ms.length) {
      body.appendChild(el("div", "pf-empty-box", isMe
        ? "还没发过动态。手机页「+」→「发布动态」。"
        : "TA 还没发过动态。"));
    } else {
      ms.forEach(function (m) { body.appendChild(momentRow(m)); });
    }
    wrap.appendChild(body);
    return wrap;
  }

  /* 一条动态（角色版与「我」的版式完全一样，用户要求统一） */
  function momentRow(m) {
    var it = el("div", "pf-moment");
    it.appendChild(el("div", "pf-moment-day", fmtDay(m.ts)));
    var right = el("div", "pf-moment-main");
    var pics = (m.imgs && m.imgs.length) ? m.imgs : (m.image ? [m.image] : []);
    if (pics.length) {
      var grid = el("div", "pf-moment-imgs pf-n" + Math.min(3, pics.length));
      pics.slice(0, 6).forEach(function (src2) {
        var u = picUrl(src2);
        if (!u) return;
        var cell = el("div", "pf-moment-img");
        var i3 = el("img"); i3.src = u; i3.alt = "";
        cell.appendChild(i3); grid.appendChild(cell);
      });
      if (grid.children.length) right.appendChild(grid);
    }
    if (m.text) right.appendChild(el("div", "pf-moment-tx", m.text));
    it.appendChild(right);
    return it;
  }

  /* ── 封面：读 / 写 ──────────────────────────────
     角色存 ch.social.cover（跟角色卡一起加密、一起导出）；
     我存 settings.momentCover（和全局背景图同一套存法）。
     读的时候都过 picUrl —— 万一是附件对象也能解。 */
  function coverOf(ch, isMe) {
    if (isMe) {
      var st = (D().state || {}).settings || {};
      return st.momentCover || "";
    }
    var so = ch && ch.social;
    if (so && so.cover) return picUrl(so.cover);
    if (so && so.photos && so.photos[0]) return so.photos[0];   /* 老数据：图库第一张兜底 */
    return "";
  }

  function setCover(ch, isMe, url) {
    if (isMe) {
      var st = (D().state || {}).settings || {};
      var next = Object.assign({}, st, { momentCover: url || "" });
      var saved = S().saveSettings(next);
      D().state.settings = saved || next;
      return;
    }
    ch.social = ch.social || {};
    ch.social.cover = url || "";
    saveChar(ch);
  }

  /* 压缩后再存：封面会一直躺在设置 / 角色卡里，原图几百 KB 会把配额吃掉不少。
     720 宽足够铺满 180px 高的封面（DPR2 也够）。 */
  function shrink(url) {
    if (!url || String(url).slice(0, 5) !== "data:") return Promise.resolve(url || "");
    var fn = D().shrinkDataUrl;
    if (typeof fn !== "function") return Promise.resolve(url);
    return fn(url, 720, 0.82).catch(function () { return url; });
  }

  function editCover(ch, isMe) {
    var has = !!coverOf(ch, isMe);
    var items = [{ value: "upload", label: "从相册选一张", hint: "建议横图，会裁成 16:7 铺满" }];
    if (!isMe) items.push({ value: "ai", label: "让 AI 画一张", hint: "按 TA 的背景与气质生成" });
    if (has) items.push({ value: "clear", label: "恢复默认", hint: "去掉当前封面" });
    choose(isMe ? "我的动态封面" : "动态封面", items).then(function (v) {
      if (!v) return;
      if (v === "clear") { setCover(ch, isMe, ""); render(); return; }
      if (v === "upload") {
        var open = D().openAlbum;
        if (typeof open !== "function") { toast("相册不可用", true); return; }
        open({
          title: "选一张做封面",
          onPick: function (url) {
            if (!url) return;
            shrink(url).then(function (u) { setCover(ch, isMe, u); render(); });
          }
        });
        return;
      }
      if (v === "ai") genCover(ch);
    });
  }

  /* AI 画封面：只给角色用。按「外貌 + 气质 + 世界观」拼 prompt，
     不要人物正脸特写（封面是横幅，脸会被裁掉一半）。 */
  function genCover(ch) {
    if (!(window.Media && Media.image)) { toast("文生图没配好", true); return; }
    var st = (D().state || {}).settings || {};
    if (Media.capable && !Media.capable("img", st)) { toast("请先在设置里启用并配置文生图", true); return; }
    var f = (ch && ch.fields) || {};
    var ref = [f.aiAppearance, f.aiPersona, f.world, f.aiBackground].filter(Boolean).join("；").slice(0, 300);
    var prompt = "一张适合做手机动态封面的横版照片，写实摄影感，构图放松、留白多，不要文字、不要水印。" +
      (ref ? "气质与场景参考：" + ref : "");
    toast("正在画封面…");
    Media.image(prompt, st).then(function (url) {
      if (!url) { toast("没画出来，等下再试", true); return; }
      var toData = (String(url).slice(0, 5) === "data:")
        ? Promise.resolve(url)
        : fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
          return new Promise(function (res) {
            var fr = new FileReader();
            fr.onload = function () { res(String(fr.result || "")); };
            fr.onerror = function () { res(""); };
            fr.readAsDataURL(b);
          });
        }).catch(function () { return ""; });
      toData.then(function (d) {
        var u = d || url;
        return shrink(u).then(function (u2) {
          setCover(ch, false, u2); render(); toast("封面换好了");
        });
      });
    }).catch(function (e) {
      toast("画失败：" + (e && e.message ? e.message : e), true);
    });
  }

  /* ── 自绘选择层（不用原生 confirm；原生框在暗色主题下会白一块）── */
  function choose(title, items) {
    return new Promise(function (resolve) {
      var mask = el("div", "pf-edit");
      var card = el("div", "pf-edit-card");
      card.appendChild(el("div", "pf-edit-t", title));
      var list = el("div", "pf-choose");
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        mask.classList.add("pf-edit-out");
        setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 150);
        resolve(v);
      }
      items.forEach(function (it) {
        var b = el("button", "pf-choose-row");
        b.type = "button";
        b.appendChild(el("span", "pf-choose-t", it.label));
        if (it.hint) b.appendChild(el("span", "pf-choose-h", it.hint));
        b.addEventListener("click", function () { finish(it.value); });
        list.appendChild(b);
      });
      card.appendChild(list);
      var bar = el("div", "pf-edit-bar");
      var cancel = el("button", "btn ghost", "取消");
      cancel.type = "button";
      cancel.addEventListener("click", function () { finish(null); });
      bar.appendChild(cancel);
      card.appendChild(bar);
      mask.appendChild(card);
      document.body.appendChild(mask);
      mask.addEventListener("click", function (e) { if (e.target === mask) finish(null); });
    });
  }

  function toast(t, isErr) {
    if (U() && U().toast) U().toast(t, isErr);
  }

  /* ④ 新的朋友（好友申请列表）—— 手机页列表顶部那个入口进来 */
  function requestsView() {
    var wrap = el("div", "pf-page");
    wrap.appendChild(head("新的朋友", function () { close(); }));
    var list = pendingReqs();
    if (!list.length) {
      wrap.appendChild(el("div", "pf-empty-box", "没有新的申请。"));
      return wrap;
    }
    list.forEach(function (r) {
      var from = charById(r.from);
      var item = el("div", "pf-req");
      var av = el("div", "pf-req-av");
      var src = from ? avatarUrl(from.avatar) : "";
      if (src) { var im = el("img"); im.src = src; im.alt = ""; av.appendChild(im); }
      else av.innerHTML = icon("account");
      item.appendChild(av);
      var tx = el("div", "pf-req-tx");
      tx.appendChild(el("div", "pf-req-name", (from ? showName(from) : "未知角色") + " 想加你为好友"));
      tx.appendChild(el("div", "pf-req-via", r.via ? ("来自群聊「" + r.via + "」") : "手动发起"));
      item.appendChild(tx);
      var acts = el("div", "pf-req-acts");
      var ok = el("button", "btn primary mini", "同意");
      ok.type = "button";
      ok.addEventListener("click", function () {
        acceptReq(r.id);
        if (U().toast) U().toast("已添加");
        render();
      });
      var no = el("button", "btn ghost mini", "忽略");
      no.type = "button";
      no.addEventListener("click", function () {
        rejectReq(r.id);
        render();
      });
      acts.appendChild(ok); acts.appendChild(no);
      item.appendChild(acts);
      wrap.appendChild(item);
    });
    return wrap;
  }

  /* ⑤ 群聊里互相加好友（7.1）
     触发：建群成功后调一次。判定用规则，不调模型 ——
     建群是低频事件但一次可能牵动好几对成员，每对问一次模型既慢又贵，
     而且「谁加谁」这件事本来就有很强的社交直觉，规则能覆盖：
       · 同一个群里 = 有交集，这是「事件」；
       · 性格外向的先迈这一步（关键词），内向的只有一半概率；
       · 已经互相是好友（有过 accepted 记录）的不重复申请。 */
  var OUTGOING = ["开朗", "热络", "健谈", "主动", "热情", "话多", "外向", "自来熟", "活泼"];
  function maybeGroupFriending(sid) {
    var g = null;
    (S().getSessions() || []).forEach(function (x) { if (x.id === sid) g = x; });
    if (!g || !g.isGroup) return 0;
    var ms = (g.members || []).map(function (m) {
      return (m && typeof m === "object") ? (m.id || m.characterId || "") : m;
    }).filter(Boolean);
    if (ms.length < 2) return 0;
    var accepted = {};
    reqs().forEach(function (r) {
      if (r.status === "accepted") { accepted[r.from + ">" + r.to] = 1; accepted[r.to + ">" + r.from] = 1; }
    });
    var title = g.title || "群聊";
    var n = 0;
    for (var i = 0; i < ms.length; i++) {
      for (var j = 0; j < ms.length; j++) {
        if (i === j) continue;
        var a = ms[i], b = ms[j];
        if (accepted[a + ">" + b]) continue;
        var cha = charById(a);
        if (!cha) continue;
        var persona = String((cha.fields && cha.fields.aiPersona) || "");
        var eager = OUTGOING.some(function (k) { return persona.indexOf(k) >= 0; });
        if (!eager && Math.random() > 0.5) continue;
        if (requestFriend(a, b, title, "group")) n++;
      }
    }
    return n;
  }

  /* ── 自绘输入层（不用原生 prompt，也不复用 askDialog）──────────
     为什么不用 UI.askDialog：它把空串当取消（为了别的调用点方便），
     而这里「清空备注」是个正当需求。自己开一层，语义就清楚了：
     返回 "" = 清空，返回 null = 取消。 */
  function ask(title, hint, value, multiline) {
    return new Promise(function (resolve) {
      var mask = el("div", "pf-edit");
      var card = el("div", "pf-edit-card");
      card.appendChild(el("div", "pf-edit-t", title));
      if (hint) card.appendChild(el("div", "pf-edit-h", hint));
      var inp = document.createElement(multiline ? "textarea" : "input");
      inp.className = "pf-edit-in";
      if (multiline) inp.rows = 4; else inp.type = "text";
      inp.value = value == null ? "" : String(value);
      card.appendChild(inp);
      var bar = el("div", "pf-edit-bar");
      var bCancel = el("button", "btn ghost", "取消");
      var bOk = el("button", "btn primary", "确定");
      bCancel.type = "button"; bOk.type = "button";
      bar.appendChild(bCancel); bar.appendChild(bOk);
      card.appendChild(bar);
      mask.appendChild(card);
      document.body.appendChild(mask);

      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        /* 退场：150ms 淡出后再摘节点（和 app.css 的 .pf-edit-out 对齐）。
           立刻 resolve —— 调用方该更新界面就更新，遮罩自己淡走。 */
        mask.classList.add("pf-edit-out");
        setTimeout(function () {
          if (mask.parentNode) mask.parentNode.removeChild(mask);
        }, 150);
        resolve(v);
      }
      bCancel.addEventListener("click", function () { finish(null); });
      bOk.addEventListener("click", function () {
        var v = String(inp.value || "").trim();
        finish(v);            /* "" 就是清空，交给调用方判断 */
      });
      mask.addEventListener("click", function (e) { if (e.target === mask) finish(null); });
      setTimeout(function () { try { inp.focus(); } catch (e) { /* ignore */ } }, 60);
    });
  }

  /* ── 渲染与开关 ─────────────────────────────────── */
  function render() {
    var L = ensureLayer();
    if (!L || L.hidden) return;
    L.innerHTML = "";
    if (view === "requests") { L.appendChild(requestsView()); L.scrollTop = 0; return; }
    var ch = charById(curId);
    if (!ch) { close(); return; }
    var node = view === "detail" ? detailView(ch)
      : (view === "moments" ? momentsView(ch) : mainView(ch));
    L.appendChild(node);
    L.scrollTop = 0;
    fillByAI(ch);   /* 签名/地区缺失时后台补一次 */
  }

  function openMain() { view = "main"; render(); }
  function openDetail() { view = "detail"; render(); }
  function openMoments() { view = "moments"; render(); }
  /* 新的朋友：不带角色上下文，单独一层 */
  function openRequests() {
    var L = ensureLayer();
    if (!L) return false;
    cancelClose();
    curId = ""; view = "requests"; L.hidden = false;
    var app = document.getElementById("app");
    if (app) app.style.visibility = "hidden";
    render();
    return true;
  }

  function open(chId) {
    if (!chId) return false;
    var L = ensureLayer();
    if (!L) return false;
    cancelClose();
    curId = chId;
    view = "main";
    L.hidden = false;
    /* 打开时把主界面藏起来：资料页是整屏层，和引导页同一套路，
       免得顶栏 / 输入栏那些 position:fixed 的层级压上来。 */
    var app = document.getElementById("app");
    if (app) app.style.visibility = "hidden";
    render();
    return true;
  }
  var closeTimer = 0;
  /* 退场：先播 170ms 动画再摘内容（时长与 app.css 的 .pf-out 对齐）。
     原先直接 hidden = true，按返回键是一帧硬切，和项目里其它浮层不对称。 */
  function close() {
    var L = ensureLayer();
    curId = ""; view = "main";
    var app = document.getElementById("app");
    if (app) app.style.visibility = "";
    if (!L) return;
    if (L.hidden) { L.innerHTML = ""; return; }
    L.classList.add("pf-out");
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      closeTimer = 0;
      L.classList.remove("pf-out");
      L.hidden = true; L.innerHTML = "";
    }, 170);
  }
  /* 退场途中又被打开：撤掉动画与待执行的卸载，否则「关了又开」会被 170ms 后的定时器清空 */
  function cancelClose() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
    var L = ensureLayer();
    if (L) L.classList.remove("pf-out");
  }
  function isOpen() {
    var L = ensureLayer();
    /* 退场中（pf-out）算「已经关了」：否则按一次返回开始淡出、再按一次又被这里吃掉，
       用户会感觉「返回键失灵一下」。 */
    return !!(L && !L.hidden && !L.classList.contains("pf-out"));
  }
  /* 返回键：逐级退（资料页内 → 资料页主视角 → 关闭），对齐手机页那套约定 */
  function back() {
    if (!isOpen()) return false;
    if (view === "requests") { close(); return true; }
    if (view === "detail" || view === "moments") { openMain(); return true; }
    close();
    return true;
  }

  window.DL = window.DL || {};
  window.DL.profile = {
    open: open, close: close, isOpen: isOpen, back: back,
    openDetail: openDetail, openMoments: openMoments,
    ensureSocial: ensureSocial, showName: showName, charById: charById,
    commonGroups: commonGroups,
    momentsOf: momentsOf, addCharMoment: addCharMoment,
    requestFriend: requestFriend, pendingReqs: pendingReqs,
    acceptReq: acceptReq, rejectReq: rejectReq,
    openRequests: openRequests, maybeGroupFriending: maybeGroupFriending,
    /* 手机页「动态」页用：把「我的动态」渲染进给定容器（封面只能上传） */
    renderMine: function (box) {
      if (!box) return false;
      box.innerHTML = "";
      box.appendChild(momentsView(null, true));
      return true;
    },
    coverOf: coverOf, setCover: setCover
  };
  (window.__dlScripts = window.__dlScripts || []).push("profile.js");
})();
