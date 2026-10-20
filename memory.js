/* DeepLink —— 角色记忆：分层压缩（日→周→月）/ 对我的认知 / 极度提纯 */
(function () {
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dateStr(ts) {
    const d = new Date(ts);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function endOfDayTs(ds) {
    const p = ds.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 23, 59, 59, 999).getTime();
  }
  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /* 取一条消息当前选中版本的文本（兼容多版本） */
  /* 表情 → 文字说明。模型看不见图，只能靠名字和意思认。
     自添加的表情包按 id 去 settings.stickers 里找（name / means 是上传时让 AI 写的）。 */
  function emojiReadable(text) {
    let t = String(text || "");
    if (!t) return t;
    const pack = (window.CONFIG && window.CONFIG.EMOJI_PACK) || [];
    const sets = (window.DL && window.DL.state && window.DL.state.settings) || {};
    const stickers = sets.stickers || [];
    /* 自添加：先把 token 换掉，避免后面的字符替换误伤 */
    if (t.indexOf("[[s:") >= 0) {
      t = t.replace(/\[\[s:([a-z0-9]+)\]\]/g, function (m, id) {
        const st = stickers.filter(function (x) { return x && x.id === id; })[0];
        if (!st) return "[表情包]";
        const name = st.name || "表情";
        return st.means ? ("[表情包:" + name + "｜" + st.means + "]") : ("[表情包:" + name + "]");
      });
    }
    /* 内置：逐个字符换。名字优先，没名字就跳过（保持原样） */
    for (let i = 0; i < pack.length; i++) {
      const it = pack[i];
      if (!it || !it.e || !it.n) continue;
      if (t.indexOf(it.e) >= 0) t = t.split(it.e).join("[表情:" + it.n + "]");
    }
    return t;
  }

  function msgText(m) {
    if (!m) return "";
    if (m.role === "user") {
      if (Array.isArray(m.variants) && m.variants.length) return emojiReadable(m.variants[m.vi || 0] || "");
      return emojiReadable(m.content || "");
    }
    const vs = Array.isArray(m.variants) && m.variants.length ? m.variants : [{ content: m.content }];
    const v = vs[m.vi || 0] || vs[0] || {};
    return emojiReadable(v.content || "");
  }

  /* 这条线的「AI 这边」到底叫什么。**必须带具体名字**：一律标成「角色：」的话，
     日更摘要和「对用户的认知」都分不清是用户做的还是角色做的 —— 一对一也一样会混
     （AI 会把角色做的事写成用户的特质）。群聊由每条消息自带的 speakerName 决定。 */
  function aiNameOf(rec) {
    try {
      if (rec && rec.isGroup) return "群成员";
      const id = rec && rec.characterId;
      if (id) {
        const st = window.Store;
        const list = (st && st.getCharacters) ? st.getCharacters() : [];
        for (let i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === id) return String(list[i].name || "角色");
        }
      }
    } catch (e) { /* 拿不到名字就退回默认 */ }
    return (rec && rec.characterId) ? "角色" : "助手";
  }

  function speakerOf(m, aiName) {
    if (m && m.role === "user") return "用户";
    return (m && m.speakerName) ? String(m.speakerName) : (aiName || "角色");
  }

  function dayTranscript(msgs, aiName) {
    return msgs
      .map((m) => speakerOf(m, aiName) + "：" + msgText(m).trim())
      .filter((t) => t.replace(/^[^：]*：/, "").trim().length > 1)
      .join("\n");
  }

  /* 某会话 coveredUntil 之后的原文（按时间升序），最多取 maxMsgs 条 */
  function collectSessionMsgs(messages, coveredUntil, maxMsgs) {
    const cutoff = coveredUntil || 0;
    const msgs = (messages || []).filter((m) => m.ts && m.ts > cutoff);
    msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return msgs.slice(Math.max(0, msgs.length - (maxMsgs || 40)));
  }

  /* 某会话「尚未被摘要覆盖」的最近原文 */
  function recentTranscript(messages, coveredUntil, maxMsgs, rec) {
    return dayTranscript(collectSessionMsgs(messages, coveredUntil, maxMsgs), aiNameOf(rec));
  }

  /* 会话的全部消息 = 主聊天消息 + 手机消息（手机里聊的内容同样要进三层记忆）。
     手机消息就地映射成「有 variants 的普通消息」，下游的 msgText / dayTranscript 直接认；
     无正文的结构化消息（转账 / 位置 / 图片 / 语音 / 通话）给一句可读的占位描述。 */
  function allMsgs(rec) {
    const out = (rec && rec.messages) ? rec.messages.slice() : [];
    const ph = (rec && rec.phone && rec.phone.msgs) || [];
    for (let i = 0; i < ph.length; i++) {
      const m = ph[i];
      if (!m || m.kind === "sys") continue;
      let txt = String(m.text || "");
      if (!txt) {
        if (m.kind === "image") txt = "[图片]" + (m.desc ? "：" + m.desc : "");
        else if (m.kind === "transfer") txt = "[转账]";
        else if (m.kind === "location") txt = "[位置]" + (m.place ? "：" + m.place : "");
        else if (m.kind === "voice") txt = "[语音]";
        else if (m.kind === "call") txt = "[通话]";
      }
      /* ⚠️ 形状必须跟主聊天一致：用户消息 variants 是「字符串」，助手消息是「对象 {content,q}」。
         全用字符串的话，msgText 的助手分支取 v.content 会拿到 undefined，角色在手机里说的话
         就会被日更 / 压缩整个丢掉（等于白聊）。 */
      const isUser = m.role === "user";
      out.push({
        role: isUser ? "user" : "assistant",
        ts: m.ts || 0,
        /* 手机里也可能是群聊（多个人在一个手机群里说话），说话人要一并带下去 */
        speaker: m.speaker || "",
        speakerName: m.speakerName || "",
        variants: [isUser ? txt : { content: txt, q: 0 }],
        vi: 0
      });
    }
    /* 手机消息是「追加」在主消息后面的，跨端消息的真实先后会被打乱。
       下游按时间生成日摘要 / 场景，这里先按 ts 归并（Chrome 83 的 sort 是稳定的）。 */
    out.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    return out;
  }

  /* 分层记忆拼成可注入的文本（越久越靠前） */
  function memoryText(mem) {
    if (!mem) return "";
    const out = [];
    if (mem.core) out.push("〖精华〗" + mem.core);
    (mem.months || []).forEach((x) => out.push("〖月·" + x.key + "〗" + x.summary));
    (mem.weeks || []).forEach((x) => out.push("〖周·" + x.key + "〗" + x.summary));
    (mem.days || []).forEach((x) => out.push("〖" + x.date + "〗" + x.summary));
    return out.join("\n");
  }

  /* 「我的人设」：设置里独立存的最多 10 套（全局，存本机）。
     id 指向当前选中的那套；找不到就退第一套。 */
  function activePersona(settings) {
    const s = settings || {};
    const list = Array.isArray(s.personas) ? s.personas : [];
    if (!list.length) return {};
    const id = s.activePersonaId || "";
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return list[0] || {};
  }

  /* 我的设定的取值优先级（用户口径：「以角色卡的为准」）：
     角色卡里的「你的*」→ 当前选中的「我的人设」→ 旧的 settings.my*（历史遗留字段）。 */
  function resolveMy(settings, f) {
    const s = settings || {};
    const p = activePersona(settings);
    return {
      name: f.myName || p.myName || s.myName || "",
      persona: f.myPersona || p.myPersona || s.myPersona || "",
      appearance: f.myAppearance || p.myAppearance || s.myAppearance || "",
      background: f.myBackground || p.myBackground || s.myBackground || "",
      likes: f.myLikes || p.myLikes || s.myLikes || "",
      callMe: f.aiCallMe || p.aiCallMe || ""
    };
  }

  /* 角色化对话的 system 文本：角色卡 + 我的设定 + 关系/场景 + 指令 + 认知 + 记忆摘要 */
  function buildSystemText(ch, s, settings) {
    if (!ch) return "";
    const f = ch.fields || {};
    const my = resolveMy(settings, f);
    const L = [CONFIG.ROLEPLAY_PROMPT, ""];
    /* 表情包（10-19）：只把「能用」的列给模型 —— scope=me 的是用户自己用的，不列。
       写法是 [表情:名字]，渲染层会把它画成图；不写就不发，绝不强求。 */
    const _pk = (window.CONFIG && CONFIG.EMOJI_PACK) || [];
    const _stk = (settings && settings.stickers) || [];
    /* 自添加的最多列 12 个：表情包攒到几十张以后，全列进去每次请求都要多烧几百 token，
       而模型也用不上那么多名字。去重是同名贴纸的保险（存储层已经保证不重名）。 */
    const _mine = _stk.filter(function (x) { return (x.scope || "both") !== "me" && x.name; })
      .map(function (x) { return String(x.name); })
      .filter(function (n, i, arr) { return arr.indexOf(n) === i; })
      .slice(0, 12);
    const _names = _pk.map(function (x) { return x.n; }).filter(Boolean).concat(_mine);
    const _emojiHint = _names.length
      ? "【表情包】你可以偶尔发一个表情代替说话（想逗他、害羞、无语、撒娇、被说中的时候）。" +
        "能用的表达：" + _names.join("、") + "。" +
        "想发就单独一行写 [表情:名字]（名字必须是上面列出的之一），不要塞进句子中间；" +
        "不想发就别写。没有情绪落点的时候不要发，一条回复最多一个。"
      : "";

    const _tl = timeLine(ch, s);
    if (_tl) { L.push(_tl); L.push(""); }
    L.push("【我（用户）的设定】");
    L.push("名称：" + (my.name || "未设定") + "；你对我的称呼：" + (my.callMe || my.name || "未设定"));
    if (my.persona) L.push("性格：" + my.persona);
    if (my.appearance) L.push("外貌：" + my.appearance);
    if (my.background) L.push("背景：" + my.background);
    if (my.likes) L.push("喜好：" + my.likes);
    L.push("");
    L.push("【你的设定】");
    L.push("名称：" + (f.aiName || ch.name || "未设定"));
    if (f.age) L.push("年龄：" + f.age);
    if (f.aiPersona) L.push("性格：" + f.aiPersona);
    if (f.aiAppearance) L.push("外貌：" + f.aiAppearance);
    if (f.aiBackground) L.push("背景：" + f.aiBackground);
    if (f.aiLikes) L.push("喜好：" + f.aiLikes);
    if (f.aiStyle) L.push("说话风格：" + f.aiStyle);
    if (f.world) { L.push(""); L.push("【世界观】"); L.push(f.world); }
    const sh = (s && s.shared) || f.shared;
    const rel = (s && s.relation) || f.relation;
    if (sh) { L.push(""); L.push("【共同经历】"); L.push(sh); }
    if (rel) { L.push(""); L.push("【当前关系】"); L.push(rel); }
    if (s && s.scene) { L.push(""); L.push("【当前场景】"); L.push(s.scene); }
    if (f.aiDirective) { L.push(""); L.push("【AI 指令】"); L.push(f.aiDirective); }
    if (s && s.cognition) { L.push(""); L.push("【对用户的认知】"); L.push(s.cognition); }
    const mem = memoryText(s && s.memory);
    if (mem) { L.push(""); L.push("【记忆摘要】"); L.push(mem); }
    /* 相熟型的手机角色：人在手机那头，不在一间屋里（10-19） */
    if (ch.phoneKind === "close") {
      L.push("");
      L.push("【联系方式的限定】你们只通过手机联系，彼此不在同一个空间。写「当前场景」时不要写成两人同处一室、面对面或正在一起做什么；" +
        "场景只能是各自所在的地方（比如他那边在加班、你这边刚回家），需要见面就当作还没见。");
    }
    if (_emojiHint) { L.push(""); L.push(_emojiHint); }
    /* 「TA 的思考」：只有压缩后读过、且还在七天内，才带这一段（先只存不读） */
    try {
      if (window.Think && window.Think.readBlock) {
        const tb = window.Think.readBlock(s);
        if (tb) { L.push(""); L.push(tb); }
      }
    } catch (e) { /* 思考读不出来不影响对话 */ }
    return L.join("\n").trim();
  }

  /* 只取「这个角色是谁」—— 群聊里要给每个成员各来一份，不能带上「我」的设定和这条线的记忆。 */
  function personaText(ch) {
    if (!ch) return "";
    const f = ch.fields || {};
    const L = [];
    L.push("名称：" + (f.aiName || ch.name || "未设定"));
    if (f.age) L.push("年龄：" + f.age);
    if (f.aiPersona) L.push("性格：" + f.aiPersona);
    if (f.aiAppearance) L.push("外貌：" + f.aiAppearance);
    if (f.aiBackground) L.push("背景：" + f.aiBackground);
    if (f.aiLikes) L.push("喜好：" + f.aiLikes);
    if (f.aiStyle) L.push("说话风格：" + f.aiStyle);
    if (f.world) { L.push(""); L.push("世界观：" + f.world); }
    if (f.aiDirective) { L.push(""); L.push("AI 指令：" + f.aiDirective); }
    return L.join("\n").trim();
  }

  /* ── 故事时间轴（10-15）────────────────────────────────────────
     会话上存 `s.time = { start, setAt }`：**设定那一刻（现实 setAt）故事里正好是 start**。
     之后按 1:1 跟随现实流动 —— 现实过了多久、故事里就过多久。
     所以「当前故事时间 = 现在 + (start - setAt)」，全篇只用一个常数偏移，简单且不漂。

     合法区间：由角色的「出生日期」+「你的当前年龄」定出来 —— [生日+年龄岁, 生日+年龄+1岁)。
     例：出生 2011-02-01、写着他 12 岁 → 只能落在 2023-02-01 ~ 2024-02-01 这一年内。
     写 2011（还没出生）或 2027（那时 16 岁了）都算背离设定，一律拒绝。
     缺出生日期或年龄读不出数字时不限制（validRange 回 null）。 */
  const DAY_MS = 86400000;
  const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  /* 加减「年」：用 Date 构造而不是加固定毫秒，闰年 / 月长才不会算歪 */
  function addYears(ms, n) {
    const d = new Date(ms);
    return new Date(d.getFullYear() + n, d.getMonth(), d.getDate(),
      d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
  }
  function parseYMD(v) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v || "").trim());
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), dd = Number(m[3]);
    /* 0000-00-00 = 「无限年龄」标记（10-20 用户口径）：
       没有具体出生日期，也就不限制时段，但时间系统照常能开。 */
    if (y === 0) return null;
    if (!(y >= 1 && y <= 9999 && mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31)) return null;
    /* 不能 new Date(y, …)：0~99 会被当成 19xx，公元 1 年会变成 1901。必须 setFullYear。 */
    const d = new Date(0);
    d.setFullYear(y, mo - 1, dd);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  /* 两个日期之间满了几周岁（不满则退一岁） */
  function yearsBetween(birthMs, nowMs) {
    if (typeof birthMs !== "number" || !isFinite(nowMs)) return null;
    if (nowMs < birthMs) return 0;
    const bd = new Date(birthMs), nd = new Date(nowMs);
    let a = nd.getFullYear() - bd.getFullYear();
    if (nd.getMonth() < bd.getMonth() ||
      (nd.getMonth() === bd.getMonth() && nd.getDate() < bd.getDate())) a--;
    return (a >= 0 && a <= 200) ? a : null;
  }
  /* 年龄（10-20 最终口径）：
       · 无限年龄（birth = 0000-00-00）→ 没有年龄，也不限制
       · **开了时间系统** → 年龄跟着故事时间走（满周岁才 +1），
         所以「年龄更新 → 合法时段跟着更新」，两者是一套东西，不冲突
       · **没开时间系统** → 只读填写的值（会话级优先），绝不按出生日期瞎推
     注意：设定时间那一刻还没 time，走的是「填写值」分支 —— 所以初始时间必须落在
     「出生日期 + 填写的年龄」那一年里，这就是那条硬规则。 */
  function ageOf(ch, s) {
    const f = (ch && ch.fields) || {};
    if (String(f.birth || "").slice(0, 4) === "0000") return null;
    const b = parseYMD(f.birth);
    if (b !== null && s && hasTimeline(s)) {
      const a = yearsBetween(b, nowOf(s));
      if (a !== null) return a;
    }
    if (s && s.age != null && String(s.age).trim() !== "") {
      const n0 = Number((/(\d{1,3})/.exec(String(s.age)) || [])[0]);
      if (n0 >= 0 && n0 <= 200) return n0;
    }
    const m = /(\d{1,3})/.exec(String(f.age || ""));
    if (!m) return null;
    const n = Number(m[1]);
    return (n >= 0 && n <= 200) ? n : null;
  }
  function validRange(ch, s) {
    const f = (ch && ch.fields) || {};
    const b = parseYMD(f.birth);
    if (b === null) return null;          /* 无限年龄 / 没填出生日期 → 不限制时段 */
    const a = ageOf(ch, s);
    if (a === null) return null;          /* 没填年龄 → 算不出时段 */
    return { from: addYears(b, a), to: addYears(b, a + 1) };
  }
  /* 这条线能不能开时间系统（10-20）：
     · 无限年龄（0000-00-00）→ 可以，不做限制
     · 出生日期 + 年龄都填了 → 可以，时段按上面那条算
     · 缺一个 → 不可以，先回去补 */
  function canTimeline(ch, s) {
    const f = (ch && ch.fields) || {};
    const inf = String(f.birth || "").slice(0, 4) === "0000";
    if (inf) return { ok: true, why: "", infinite: true };
    const b = parseYMD(f.birth);
    if (b === null) return { ok: false, why: "角色卡还没填「出生日期」" };
    const a = ageOf(ch, s);
    if (a === null) return { ok: false, why: "角色卡还没填「年龄」" };
    const r = validRange(ch, s);
    return { ok: true, why: "", infinite: false, from: r.from, to: r.to };
  }

  function timeOffset(s) {
    const t = s && s.time;
    if (!t || typeof t.start !== "number" || typeof t.setAt !== "number") return 0;
    return t.start - t.setAt;
  }
  function hasTimeline(s) { return !!(s && s.time && typeof s.time.start === "number"); }

  /* ── 离线锚点（10-15 追加）────────────────────────────────────
     退出（切后台 / 关页）时把「那一刻」写进 s.time.leftAt，毫秒级。
     下次进来算「所隔时间」用它 —— 比拿最后一条消息的时间靠谱：
     你可能只是看了会儿没说话就退出了。
     ※ 只留这一个锚点：剧情生成 / 主动发过消息之后会 rebaseTime 覆盖掉它，
       旧锚点一律丢弃（用户口径：只保留有对应剧情、动作的时间节点）。 */
  function markLeft(s, ms) {
    if (!s || !s.time) return false;
    s.time.leftAt = (typeof ms === "number") ? ms : Date.now();
    return true;
  }
  /* 这次进来「隔了多久」（毫秒）。没开时间系统 / 没有锚点 → null。
     冻结中（混搭模式 / 手动冻结）→ 也算「没有所隔时间」：
     冻结的语义就是「离线那段不算」，再让外面按 leftAt 去补剧情就自相矛盾了。 */
  function awayGap(s, nowMs) {
    const t = s && s.time;
    if (!t || typeof t.leftAt !== "number") return null;
    if (typeof t.frozenAt === "number") return null;
    const now = (typeof nowMs === "number") ? nowMs : Date.now();
    return Math.max(0, now - t.leftAt);
  }
  /* 以「当前这一刻」为新基准重新起算：start 就是此刻的故事时间、setAt 是此刻的现实时间。
     偏移不变（故事仍 1:1 跟随现实），但旧锚点（leftAt）就此作废，
     离线那一段算是「已经用剧情 / 动作交代过」，不再重复计入。 */
  function rebaseTime(s, kind) {
    const t = s && s.time;
    if (!t) return false;
    const story = nowOf(s);
    const real = Date.now();
    s.time = { start: story, setAt: real, marker: kind || "", markerAt: real };
    return true;
  }
  /* 跳过剧情生成时用（10-18 用户口径）：
     时间**承接上一次离开那一刻** —— 把故事时钟往回拨「这次离线了多久」，
     离线那一段不算进故事里。和 rebaseTime 正好相反：
       rebaseTime = 离线那段「已经用剧情交代过」，时间照常推进；
       holdTime   = 没交代，那段时间作废，回来还是走的时候那个点。 */
  function holdTime(s, gapMs) {
    const t = s && s.time;
    if (!t) return false;
    const story = nowOf(s) - Math.max(0, gapMs || 0);
    const real = Date.now();
    s.time = { start: story, setAt: real, marker: "hold", markerAt: real };
    return true;
  }
  /* 故事里的「现在」。冻结中（s.time.frozenAt 有值）就一直停在那一刻 ——
     用户「暂时退出」时用它，免得离开的那段被算进故事里。 */
  function nowOf(s) {
    const t = s && s.time;
    const base = (t && typeof t.frozenAt === "number") ? t.frozenAt : Date.now();
    return base + timeOffset(s);
  }
  /* ── 时间冻结（10-16 用户要求）────────────────────────
     双击对话设置里那个时间就冻结 / 再双击解冻；退出应用时也会问一句。
     冻结期间故事时间不走（nowOf 停在冻结那一刻）。 */
  function isFrozen(s) { return !!(s && s.time && typeof s.time.frozenAt === "number"); }
  function freezeTime(s) {
    if (!s || !s.time || isFrozen(s)) return false;
    s.time.frozenAt = Date.now();
    return true;
  }
  function unfreezeTime(s) {
    if (!isFrozen(s)) return false;
    const story = nowOf(s);          /* 冻结那一刻的故事时间（必须在删 frozenAt 之前取） */
    const real = Date.now();
    /* 冻结期间的时间不算数：以「解冻这一刻」为新基准，故事仍 1:1 跟随现实 */
    delete s.time.frozenAt;
    s.time.start = story;
    s.time.setAt = real;
    return true;
  }
  /* 把一条现实时间戳换算成故事时间（手机消息的 ts 就是现实时间戳） */
  function storyAt(s, realMs) { return (typeof realMs === "number" ? realMs : Date.now()) + timeOffset(s); }
  function fmtStory(ms, withSec) {
    const d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
      pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + (withSec ? (":" + pad2(d.getSeconds())) : "");
  }
  function fmtStoryShort(ms) {
    const d = new Date(ms);
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function weekdayOf(ms) { return "周" + WEEK_CN[new Date(ms).getDay()]; }
  /* 只要时:分 —— 顶栏那个按钮窄，塞不下日期 */
  function fmtHM(ms) {
    const d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  /* 这个时间点合不合法（带角色时）。返回 { ok, from, to } */
  function checkTime(ch, ms, s) {
    const r = validRange(ch, s);
    if (!r) return { ok: true, from: null, to: null };
    return { ok: ms >= r.from && ms < r.to, from: r.from, to: r.to };
  }
  /* 给 AI 看的时间行 */
  function timeLine(ch, s) {
    if (!s || !hasTimeline(s)) return "";
    const ms = nowOf(s);
    let t = "【当前时间】" + fmtStory(ms) + "（" + weekdayOf(ms) + "）—— 这是你们故事里的「现在」，" +
      "顺着它往下写，别倒退、也别跳到别的季节。";
    const r = validRange(ch, s);
    if (r) {
      t += "\n【时间范围】角色只可能处在这个区间内：" + fmtStory(r.from).slice(0, 10) + " 至 " +
        fmtStory(r.to).slice(0, 10) + "。写日期时不要越出这个范围。";
    }
    return t;
  }

  /* 中文数字（够用就行：一二三…十，十一，二十，二十五） */
  function cnNum(s) {
    const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const t = String(s || "").trim();
    if (/^\d+$/.test(t)) return Number(t);
    if (t === "十") return 10;
    if (/^十[零一二三四五六七八九]$/.test(t)) return 10 + map[t[1]];
    if (/^[一二两三四五六七八九]十$/.test(t)) return map[t[0]] * 10;
    if (/^[一二两三四五六七八九]十[零一二三四五六七八九]$/.test(t)) return map[t[0]] * 10 + map[t[2]];
    return (map[t] === undefined ? NaN : map[t]);
  }
  /* 从一段话里认一个「钟点」（20:30 / 晚上八点半 / 八点二十）→ 那一天的那个时刻 */
  function clockFrom(label, base) {
    const t = String(label || "");
    let hh = NaN, mm = 0, part = "";
    let m = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(t);
    if (m) { hh = Number(m[1]); mm = Number(m[2]); }
    else {
      m = /(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜)?([零一二三四五六七八九十两\d]{1,3})点(半|[零一二三四五六七八九十两\d]{1,3}分)?/.exec(t);
      if (!m) return null;
      part = m[1] || "";
      hh = cnNum(m[2]);
      if (m[3]) mm = (m[3] === "半") ? 30 : cnNum(String(m[3]).replace("分", ""));
    }
    if (!isFinite(hh) || hh > 24 || !isFinite(mm) || mm > 59) return null;
    if (/下午|傍晚|晚上|夜里|夜/.test(part) && hh < 12) hh += 12;
    if (/凌晨|清晨/.test(part) && hh === 12) hh = 0;
    if (part === "中午" && hh < 12) hh += 12;
    const d = new Date(base);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh % 24, mm, 30, 0).getTime();
  }
  /* 认一条括号里的话，给出「新的故事时间」。认不出回 null */
  function jumpOne(raw, base, ctx) {
    const t = String(raw || "").replace(/\s+/g, "");
    if (!t) return null;
    const day = (n) => base + n * DAY_MS;
    const at = (ms, hh, mm) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime(); };
    let m;   /* 提前声明：下面好几段都要复用（写进后面的分支里会踩 TDZ） */
    if (/(第二天|次日|明天)(早上|上午|清晨)/.test(t)) return { ms: at(day(1), 8, 0), label: "第二天早上" };
    if (/(第二天|次日|明天)中午/.test(t)) return { ms: at(day(1), 12, 0), label: "第二天中午" };
    if (/(第二天|次日|明天)(晚上|傍晚|夜里)/.test(t)) return { ms: at(day(1), 20, 0), label: "第二天晚上" };
    if (/(第二天|次日|明天)/.test(t)) return { ms: day(1), label: "第二天" };
    if (/后天/.test(t)) return { ms: day(2), label: "后天" };
    if (/昨天/.test(t)) return { ms: day(-1), label: "前一天" };
    if (/前天/.test(t)) return { ms: day(-2), label: "前两天" };
    if (/几天后|过了几天|过了几天后/.test(t)) return { ms: day(3), label: "几天后" };
    if (/一周后|一星期后|七天后/.test(t)) return { ms: day(7), label: "一周后" };
    if (/一个月后/.test(t)) return { ms: day(30), label: "一个月后" };
    /* 通用的「N 单位后」：两天后 / 三年后 / 半个月后 / 三周后… */
    m = /(半|[零一二三四五六七八九十两\d]{1,3})(年|个月|月|周|星期|天)后/.exec(t);
    if (m) {
      const n = (m[1] === "半") ? 0.5 : cnNum(m[1]);
      const u = m[2];
      if (isFinite(n) && n > 0) {
        /* 「半年后」不能 Math.round(0.5)=1 变成整年：不满 1 年的按天数折算 */
        const ms2 = (u === "年") ? (n >= 1 ? addYears(base, Math.round(n)) : day(n * 365))
          : (u === "个月" || u === "月") ? day(n * 30)
            : (u === "周" || u === "星期") ? day(n * 7)
              : day(n);
        return { ms: ms2, label: m[1] + u + "后" };
      }
    }
    if (/过了一会|过一会儿|一会儿|片刻后|稍后|没多久/.test(t)) return { ms: base + 15 * 60000, label: "过了一小会儿" };
    if (/半小时后|半个小时后/.test(t)) return { ms: base + 30 * 60000, label: "半小时后" };
    m = /(半|[零一二三四五六七八九十两\d]{1,3})(年|个月|月|周|星期|天)前/.exec(t);
    if (m) {
      const n = (m[1] === "半") ? 0.5 : cnNum(m[1]);
      const u = m[2];
      if (isFinite(n) && n > 0) {
        /* 同「后」分支：「半年前」不能 Math.round(0.5)=1 变成整年 */
        const ms3 = (u === "年") ? (n >= 1 ? addYears(base, -Math.round(n)) : day(-n * 365))
          : (u === "个月" || u === "月") ? day(-n * 30)
            : (u === "周" || u === "星期") ? day(-n * 7)
              : day(-n);
        return { ms: ms3, label: m[1] + u + "前" };
      }
    }
    m = /([零一二三四五六七八九十两\d]{1,3})个?小时后/.exec(t);
    if (m) { const h = cnNum(m[1]); if (isFinite(h) && h > 0 && h <= 72) return { ms: base + h * 3600000, label: h + " 小时后" }; }
    m = /([零一二三四五六七八九十两\d]{1,3})分钟后/.exec(t);
    if (m) { const n = cnNum(m[1]); if (isFinite(n) && n > 0 && n <= 1440) return { ms: base + n * 60000, label: n + " 分钟后" }; }
    if (/到达?约定|约定的时间|约定时间|到点了|该走了|时间到了/.test(t)) {
      /* 从最近的对话里捞一个钟点（例：上一句说的「八点见」），把时间推到那一刻 */
      const c = clockFrom(String((ctx && ctx.recent) || "") + " " + t, base);
      if (c !== null) return { ms: (c <= base ? c + DAY_MS : c), label: "约定的时间" };
      return { ms: base + 2 * 3600000, label: "约定的时间（按两小时后算）" };
    }
    const c = clockFrom(t, base);
    if (c !== null) return { ms: (c <= base ? c + DAY_MS : c), label: "当天的 " + fmtStory(c).slice(11, 16) };
    return null;
  }
  /* 只看括号里的内容；一段话里可能有好几个括号，取第一个认得出的 */
  function parseTimeJump(text, base, ctx) {
    const re = /[（(]([^）)]{1,60})[）)]/g;
    let m;
    while ((m = re.exec(String(text || ""))) !== null) {
      const r = jumpOne(m[1], base, ctx);
      if (r) return r;
    }
    return null;
  }
  /* 最近几条消息拼一行，给「到了约定时间」当上下文 */
  function recentLine(s) {
    try {
      return (allMsgs(s) || []).slice(-8).map((m) => msgText(m)).join(" ").slice(-500);
    } catch (e) { return ""; }
  }
  /* 按用户输入里的括号把故事时间推过去。返回：
       null                    = 没认出来，什么都不做
       { ok:false, from, to }  = 认出来了但越出角色设定，必须拒绝
       { ok:true, ms, label }  = 可以推，ms 是新的「故事现在」 */
  function tryJumpTime(s, ch, text) {
    if (!s) return null;
    /* 没开时间系统的线：不推时间，也**不能顺手给它开一条时间轴**。
       否则用户随手写一句「（第二天）」，这条线就悄悄有了故事时间（10-20 审查发现）。 */
    if (!hasTimeline(s)) return null;
    const base = nowOf(s);
    const r = parseTimeJump(text, base, { recent: recentLine(s) });
    if (!r) return null;
    /* 第三个参数不能省：年龄跟着故事时间走，判据得用这条线的 s（省了会拿"设定时年龄"算旧区间） */
    const ck = checkTime(ch, r.ms, s);
    if (!ck.ok) return { ok: false, label: r.label, from: ck.from, to: ck.to };
    return { ok: true, ms: r.ms, label: r.label };
  }

  function ensureMemory(rec) {
    if (!rec.memory || typeof rec.memory !== "object") rec.memory = {};
    const m = rec.memory;
    if (!Array.isArray(m.days)) m.days = [];
    if (!Array.isArray(m.weeks)) m.weeks = [];
    if (!Array.isArray(m.months)) m.months = [];
    if (typeof m.coveredUntil !== "number") m.coveredUntil = 0;
    return m;
  }

  function apiSettings(settings) {
    const s = Object.assign({}, settings);
    if (settings.compressModel) s.model = settings.compressModel;
    return s;
  }

  async function summarize(settings, system, user, maxTokens) {
    return Api.summarize(apiSettings(settings), [
      { role: "system", content: system },
      { role: "user", content: user }
    ], { maxTokens: maxTokens });
  }

  /* 日压缩：把「今天之前、尚未覆盖」的消息按天压成日摘要 */
  async function dailyCompress(rec, save, settings, report) {
    const m = ensureMemory(rec);
    if (!settings.apiKey) return { days: 0, usage: null, newText: "" };
    const cutoff = startOfToday();
    const groups = {};
    allMsgs(rec).forEach((msg) => {
      const ts = msg.ts || 0;
      if (!ts || ts <= m.coveredUntil || ts >= cutoff) return;
      const d = dateStr(ts);
      (groups[d] = groups[d] || []).push(msg);
    });
    const dates = Object.keys(groups).sort();
    let usage = null;
    let done = 0;
    const newParts = [];
    for (const d of dates) {
      const text = dayTranscript(groups[d], aiNameOf(rec));
      if (text.length > 20) {
        const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.daily, "日期：" + d + "\n\n" + text, 700);
        usage = Api.sumUsage(usage, out.usage);
        if (out.text.trim()) {
          /* 同一天可能已经有条目（「同步到各自线」会先往当天摘要里写一段群聊记忆）。
             原来无条件 push，第二天压缩时就会多出一条同 date 的记录 —— memoryText 里
             同一天打印两遍，周压缩也把同一天当两段素材。这里改成按日期合并。 */
          const exist = m.days.filter((x) => x && x.date === d)[0];
          if (exist) exist.summary = String(exist.summary || "") + "\n" + out.text.trim();
          else m.days.push({ date: d, summary: out.text.trim() });
          newParts.push(d + "：" + out.text.trim());
        } else {
          /* 模型没吐出摘要：**别**把这天标记成「已覆盖」——那样它的原文此后既不再喂给模型、
             也没有摘要顶上，等于静默丢掉一整天。停在当天，下次再压。 */
          break;
        }
      }
      /* 到这里才算这天处理完（有摘要，或内容太少没什么可压的）→ 推进水位线 */
      m.coveredUntil = Math.max(m.coveredUntil, endOfDayTs(d));
      done += 1;
      if (save) save();
      if (report) report("已压缩 " + d);
    }
    return { days: done, usage: usage, newText: newParts.join("\n") };
  }

  /* 分层并合：7 个日摘要→周，4 个周摘要→月。
     关键：**先问模型、拿到非空摘要才 splice**。先前是「先 splice 掉再请求」，
     模型一次空输出（超时 / 拒答 / 被截断）就把这 7 天（或 4 周）永久删掉、且已落库。 */
  async function rollup(rec, save, settings) {
    const m = ensureMemory(rec);
    let usage = null;
    while (m.days.length >= 7) {
      const batch = m.days.slice(0, 7);
      const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.weekly,
        batch.map((x) => x.date + "：" + x.summary).join("\n"), 700);
      usage = Api.sumUsage(usage, out.usage);
      if (!out.text.trim()) break;
      m.days.splice(0, 7);
      m.weeks.push({ key: batch[0].date + "~" + batch[batch.length - 1].date, summary: out.text.trim() });
      if (save) save();
    }
    while (m.weeks.length >= 4) {
      const batch = m.weeks.slice(0, 4);
      const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.monthly,
        batch.map((x) => x.key + "：" + x.summary).join("\n"), 700);
      usage = Api.sumUsage(usage, out.usage);
      if (!out.text.trim()) break;
      m.weeks.splice(0, 4);
      m.months.push({ key: batch[0].key + "~" + batch[batch.length - 1].key, summary: out.text.trim() });
      if (save) save();
    }
    return usage;
  }

  /* 用新增摘要更新「对我的认知」 */
  async function updateCognition(rec, save, settings, newText) {
    if (!settings.apiKey) return null;
    const src = (newText || memoryText(rec.memory) || "").trim();
    const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.cognition,
      "旧档案：\n" + (rec.cognition || "（空）") + "\n\n新增信息：\n" + (src || "（无）"), 700);
    if (out.text.trim()) { rec.cognition = out.text.trim(); if (save) save(); }
    return out.usage;
  }

  /* 从模型输出里取「当前关系 / 共同经历」。模型偶尔给别名键、或把经历写成数组，
     一并认下来，别因为一个键名不对就把整项丢了。 */
  function relationFromText(text) {
    const o = parseJsonObject(text);
    const pick = (keys) => {
      for (const k of keys) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) return v.trim();
        if (Array.isArray(v)) {
          const s = v.map((x) => String(x == null ? "" : x).trim()).filter(Boolean).join("\n");
          if (s) return s;
        }
      }
      return "";
    };
    return {
      relation: pick(["relation", "relationship", "关系", "当前关系"]),
      shared: pick(["shared", "experience", "experiences", "经历", "共同经历", "sharedExperiences"])
    };
  }

  /* 用新增摘要更新「当前关系」「共同经历」（会话级动态值）。base = 角色卡里的初始设定。
     模型经常一次只吐一个键，于是用户得点好几遍才齐 —— 缺哪个就自动再问一次（最多补一轮），
     并把「到底更新到了什么」如实返回，交给调用方说实话。 */
  async function updateRelationShared(rec, save, settings, base, newText) {
    if (!settings.apiKey) return { usage: null, changed: false, relation: false, shared: false };
    const b = base || {};
    const input = "初始设定：\n关系：" + (b.relation || "（无）") + "\n经历：" + (b.shared || "（无）") +
      "\n\n现有内容：\n关系：" + (rec.relation || "（无）") + "\n经历：" + (rec.shared || "（无）") +
      "\n\n新增记忆：\n" + ((newText || "").trim() || "（无）");
    let usage = null;
    let gotRel = false;
    let gotShared = false;
    for (let attempt = 0; attempt < 2 && !(gotRel && gotShared); attempt++) {
      const ask = attempt === 0 ? input
        : input + "\n\n（注意：上一次只返回了部分字段。请重新输出，务必同时给出 relation 与 shared，两项都要有内容。）";
      const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.relationShare, ask, 700);
      usage = Api.sumUsage(usage, out.usage);
      const got = relationFromText(out.text);
      if (!gotRel && got.relation) { rec.relation = got.relation; gotRel = true; }
      if (!gotShared && got.shared) { rec.shared = got.shared; gotShared = true; }
    }
    if ((gotRel || gotShared) && save) save();
    return { usage: usage, changed: gotRel || gotShared, relation: gotRel, shared: gotShared };
  }

  /* 用近期原文更新「当前场景」（会话级动态值）。sinceTs = 上次更新覆盖到的时间点 */
  async function updateScene(rec, save, settings, sinceTs) {
    if (!settings.apiKey) return null;
    const txt = recentTranscript(allMsgs(rec), sinceTs || 0, 40, rec);
    if (!txt.trim()) return null;
    const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.scene,
      "现有场景：\n" + (rec.scene || "（空）") + "\n\n近期对话：\n" + txt, 400);
    const changed = !!(out.text && out.text.trim());
    if (changed) { rec.scene = out.text.trim(); if (save) save(); }
    /* 返回 {usage, changed}：调用方据此决定要不要推进水位线。
       空输出时若照样当成功、把水位线推过去，这一天的场景更新就被静默跳过、之后不再重试
       （与 rollup / reCompress 的「拿到非空结果才推进」口径一致）。 */
    return { usage: out.usage, changed: changed };
  }

  /* 上线补压：日压缩 → 周/月并合 → 更新认知。opts.cognition 控制是否维护认知档案 */
  async function runCompression(rec, save, settings, opts, report) {
    const o = opts || {};
    const res = await dailyCompress(rec, save, settings, report);
    let usage = res.usage;
    usage = Api.sumUsage(usage, await rollup(rec, save, settings));
    if (res.newText && o.cognition) {
      usage = Api.sumUsage(usage, await updateCognition(rec, save, settings, res.newText));
      const rs = await updateRelationShared(rec, save, settings, o.seed, res.newText);
      usage = Api.sumUsage(usage, rs && rs.usage);
    }
    return { usage: usage, days: res.days };
  }

  /* 日更：场景 / 共同经历 / 关系 每天各更新一次（用户拍板：默认开）。
     水位线**拆成两条**：rec.dailySceneDay（场景）、rec.dailyRelationDay（关系/经历），
     另保留 rec.dailyDay 作为「两项都完成」的汇总标记（别处还在读它）。
     【为什么拆】原来只要任一项成功就把「今天已完成」打上 —— 失败的那项当天不再重试，
     等于静默丢掉一次更新；可改成「两项都成功才推进」又会让老是失败的那项天天重跑、白烧钱。
     拆开之后：各自成功各自推进，第二天谁没完成就只补谁。
     底线不变：**拿到非空结果才推进**（changed），空输出停在原地等下次。
     返回本次合并后的用量（供 recordUsage 记在「日更」名下）。 */
  async function dailyRefresh(rec, save, settings, base) {
    if (!rec || !settings || !settings.apiKey) return null;
    if (settings.dailyUpdate === false) return null;
    const today = dateStr(Date.now());
    /* 兼容旧数据：老版本只记 rec.dailyDay。当它等于今天、而两条新水位线还没建立起来时，
       就认为「今天已经跑过」，直接跳过 —— 否则升级当天会白跑一遍（白花钱）。 */
    if (rec.dailyDay === today && rec.dailySceneDay === undefined && rec.dailyRelationDay === undefined) return null;
    /* 每项每天最多试 2 次（rec.dailyTries）：
       一次失败不会让整天都不补；模型老是吐不出内容时，也不会「每发一条消息就重试一次」白烧钱。 */
    const tries = (rec.dailyTries && rec.dailyTries.day === today) ? rec.dailyTries : { day: today, scene: 0, relation: 0 };
    rec.dailyTries = tries;
    const needScene = (rec.dailySceneDay !== today) && tries.scene < 2;
    const needRelation = (rec.dailyRelationDay !== today) && tries.relation < 2;
    if (!needScene && !needRelation) return null;
    const since = rec.dailyDayTs || (rec.memory && rec.memory.coveredUntil) || 0;
    const txt = recentTranscript(allMsgs(rec), since, 80, rec);
    /* 没有新对话可总结 → 两项都标记完成（不打无谓的请求） */
    if (!txt.trim()) {
      rec.dailySceneDay = today; rec.dailyRelationDay = today;
      rec.dailyDay = today; if (save) save();
      return null;
    }
    let usage = null;
    let done = false;
    if (needScene) {
      tries.scene++;
      const su = await updateScene(rec, save, settings, since);
      if (su && su.usage) usage = Api.sumUsage(usage, su.usage);
      /* su 为 null = 压根没有可总结的文本（不是失败）→ 也算完成，别天天重试 */
      if (!su || su.changed) { rec.dailySceneDay = today; done = true; }
    }
    if (needRelation) {
      tries.relation++;
      const rs = await updateRelationShared(rec, save, settings, base, txt);
      if (rs && rs.usage) usage = Api.sumUsage(usage, rs.usage);
      /* changed=false 说明模型两轮都没吐出可用内容 → 不推进，下次再补 */
      if (rs && rs.changed) { rec.dailyRelationDay = today; done = true; }
    }
    if (rec.dailySceneDay === today && rec.dailyRelationDay === today) {
      rec.dailyDay = today; rec.dailyDayTs = Date.now(); done = true;
    }
    if (done && save) save();
    return usage;
  }

  /* ── 上下文筛选 ────────────────────────────────── */
  function ensureFilter(rec) {
    if (!rec.ctxFilter || typeof rec.ctxFilter !== "object") rec.ctxFilter = {};
    const cf = rec.ctxFilter;
    if (typeof cf.rule !== "string") cf.rule = "";
    if (typeof cf.every !== "number" || !(cf.every >= 1)) cf.every = 10;
    return cf;
  }
  function ensureCtxWash(sess) {
    if (!sess.ctxWash || typeof sess.ctxWash !== "object") sess.ctxWash = {};
    const cw = sess.ctxWash;
    if (typeof cw.washedFrom !== "number") cw.washedFrom = 0;
    if (typeof cw.washedUntil !== "number") cw.washedUntil = 0;
    if (!Array.isArray(cw.turns)) cw.turns = [];
    return cw;
  }

  /* 把模型返回的 JSON 轮次解析成 [{role,content}]；解析失败回退原文 */
  function parseTurns(text, fallbackMsgs) {
    const fallback = (fallbackMsgs || [])
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: msgText(m).trim() }))
      .filter((t) => t.content);
    try {
      const s = String(text || "").trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
      const a = s.indexOf("[");
      const b = s.lastIndexOf("]");
      if (a < 0 || b < 0) return fallback;
      const arr = JSON.parse(s.slice(a, b + 1));
      if (!Array.isArray(arr)) return fallback;
      const turns = arr
        .map((x) => ({ role: x && x.role === "user" ? "user" : "assistant", content: x && typeof x.content === "string" ? x.content.trim() : "" }))
        .filter((t) => t.content);
      return turns.length ? turns : fallback;
    } catch (e) { return fallback; }
  }

  /* 按规则把近期对话逐轮精简，结果存进会话的 ctxWash */
  async function applyFilter(sess, rule, save, settings) {
    rule = (rule || "").trim();
    if (!rule) return { ok: false, reason: "no-rule" };
    if (!settings.apiKey) return { ok: false, reason: "no-key" };
    const cw = ensureCtxWash(sess);
    const covered = (sess.memory && sess.memory.coveredUntil) || 0;
    const msgs = collectSessionMsgs(sess.messages, covered, 80);
    if (!msgs.length) return { ok: false, reason: "empty" };
    const input = dayTranscript(msgs, aiNameOf(sess));
    if (input.replace(/\s/g, "").length < 8) return { ok: false, reason: "empty" };
    const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.filter, "筛选规则：\n" + rule + "\n\n对话：\n" + input, 2000);
    cw.turns = parseTurns(out.text, msgs);
    cw.washedFrom = msgs[0].ts || 0;
    cw.washedUntil = msgs[msgs.length - 1].ts || 0;
    if (save) save();
    return { ok: true, usage: out.usage, count: cw.turns.length };
  }

  async function generateFilterRule(settings, draft) {
    return summarize(settings, CONFIG.COMPRESS_PROMPTS.filterRule, (draft || "").trim() || "（用户没有具体描述）", 600);
  }

  function parseJsonObject(text) {
    const s = String(text || "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return {};
    try {
      const o = JSON.parse(s.slice(a, b + 1));
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch (e) { return {}; }
  }

  /* 把用户一股脑写的零散设定，拆进角色卡的各个字段 */
  async function splitCharacterFields(settings, raw, fields) {
    const dict = fields.map((f) => f.key + "（" + f.label + "）：" + (f.current || "（空）")).join("\n");
    const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.splitChar, "字段表（键（说明）：现有内容）：\n" + dict + "\n\n用户输入：\n" + raw, 2000);
    return { fields: parseJsonObject(out.text), usage: out.usage };
  }

  /* 解析「〖精华〗/〖月·k〗/〖周·k〗/〖日期〗」行；无任何可识别行时返 null */
  function parseMemoryLines(text) {
    const out = { core: "", months: [], weeks: [], days: [] };
    let hit = 0;
    String(text || "").split(/\n+/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      let m = line.match(/^〖精华〗(.*)$/);
      if (m) { out.core = m[1].trim(); hit++; return; }
      m = line.match(/^〖月[·・]([^〗]*)〗(.*)$/);
      if (m) { out.months.push({ key: m[1].trim(), summary: m[2].trim() }); hit++; return; }
      m = line.match(/^〖周[·・]([^〗]*)〗(.*)$/);
      if (m) { out.weeks.push({ key: m[1].trim(), summary: m[2].trim() }); hit++; return; }
      m = line.match(/^〖([^〗]+)〗(.*)$/);
      if (m) { out.days.push({ date: m[1].trim(), summary: m[2].trim() }); hit++; return; }
    });
    return hit ? out : null;
  }

  /* 记忆纠偏：用户写一段文字，AI 据此重写整份记忆（保持分层不变） */
  async function correctMemory(rec, text, save, settings) {
    const m = ensureMemory(rec);
    const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.correct,
      "现有记忆：\n" + (memoryText(m) || "（空）") + "\n\n用户的纠正/补充：\n" + text, 2000);
    const parsed = parseMemoryLines(out.text);
    if (!parsed) return { changed: false, usage: out.usage };
    m.core = parsed.core;
    m.months = parsed.months;
    m.weeks = parsed.weeks;
    m.days = parsed.days;
    if (save) save();
    return { changed: true, usage: out.usage };
  }

  /* 再压缩：把全部记忆提纯为一条精华，覆盖点推到今天之前（保留今天的原文）
     返回 { ok, usage }：ok=false 表示模型没给出摘要、本次【什么都没动】。 */
  async function reCompress(rec, save, settings) {
    const m = ensureMemory(rec);
    const all = memoryText(m);
    if (!all && !rec.cognition) return null;
    const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.rec,
      (rec.cognition ? "认知：\n" + rec.cognition + "\n\n" : "") + all, 900);
    const core = out.text.trim();
    /* 【判据①：作用要与承诺一致】拿不到非空摘要就【什么都不动】并如实报失败。
       旧代码在空输出时仍清空 days/weeks/months、还把 coveredUntil 推到今天 ——
       等于把原记忆永久抹掉且已落库（与 rollup / dailyCompress 同类，那两处已修）。
       【判据③：隐患】与 rollup / dailyCompress 统一原则：拿到结果才推进水位线。 */
    if (!core) return { ok: false, usage: out.usage };
    m.core = core;
    m.days = []; m.weeks = []; m.months = [];
    m.coveredUntil = startOfToday();
    if (save) save();
    return { ok: true, usage: out.usage };
  }

  window.Memory = { buildSystemText, personaText, memoryText, allMsgs, runCompression, reCompress, ensureMemory, updateCognition, updateRelationShared, updateScene, dailyRefresh, recentTranscript, ensureFilter, ensureCtxWash, applyFilter, generateFilterRule, splitCharacterFields, correctMemory, activePersona,
    /* 表情 → 可读说明（10-19）：手机那边有自己的 msgText，也要用同一套翻译，
       否则模型收到的是 [[s:xxx]] 这种原始标记 */
    emojiReadable, msgText,
    /* 故事时间轴（10-15）：主对话 / 手机 / 世界生成 / 摘要都读它 */
    hasTimeline, timeOffset, nowOf, storyAt, fmtStory, fmtStoryShort, weekdayOf,
    validRange, checkTime, canTimeline, yearsBetween, timeLine, parseYMD, addYears, ageOf, tryJumpTime, DAY_MS, fmtHM,
    markLeft, awayGap, rebaseTime, holdTime, isFrozen, freezeTime, unfreezeTime };
})();
