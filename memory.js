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
  function msgText(m) {
    if (!m) return "";
    if (m.role === "user") {
      if (Array.isArray(m.variants) && m.variants.length) return String(m.variants[m.vi || 0] || "");
      return String(m.content || "");
    }
    const vs = Array.isArray(m.variants) && m.variants.length ? m.variants : [{ content: m.content }];
    const v = vs[m.vi || 0] || vs[0] || {};
    return String(v.content || "");
  }

  function dayTranscript(msgs) {
    return msgs
      .map((m) => (m.role === "user" ? "用户：" : "角色：") + msgText(m).trim())
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
  function recentTranscript(messages, coveredUntil, maxMsgs) {
    return dayTranscript(collectSessionMsgs(messages, coveredUntil, maxMsgs));
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

  function resolveMy(settings, f) {
    const s = settings || {};
    return {
      name: f.myName || s.myName || "",
      persona: f.myPersona || s.myPersona || "",
      appearance: f.myAppearance || s.myAppearance || "",
      background: f.myBackground || s.myBackground || "",
      likes: f.myLikes || s.myLikes || ""
    };
  }

  /* 角色化对话的 system 文本：角色卡 + 我的设定 + 关系/场景 + 指令 + 认知 + 记忆摘要 */
  function buildSystemText(ch, s, settings) {
    if (!ch) return "";
    const f = ch.fields || {};
    const my = resolveMy(settings, f);
    const L = [CONFIG.ROLEPLAY_PROMPT, ""];
    L.push("【我（用户）的设定】");
    L.push("名称：" + (my.name || "未设定") + "；你对我的称呼：" + (f.aiCallMe || my.name || "未设定"));
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
    return L.join("\n").trim();
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
    (rec.messages || []).forEach((msg) => {
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
      const text = dayTranscript(groups[d]);
      if (text.length > 20) {
        const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.daily, "日期：" + d + "\n\n" + text, 700);
        usage = Api.sumUsage(usage, out.usage);
        if (out.text.trim()) {
          m.days.push({ date: d, summary: out.text.trim() });
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
    const txt = recentTranscript(rec.messages, sinceTs || 0, 40);
    if (!txt.trim()) return null;
    const out = await summarize(settings, CONFIG.COMPRESS_PROMPTS.scene,
      "现有场景：\n" + (rec.scene || "（空）") + "\n\n近期对话：\n" + txt, 400);
    if (out.text.trim()) { rec.scene = out.text.trim(); if (save) save(); }
    return out.usage;
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
    const input = dayTranscript(msgs);
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

  window.Memory = { buildSystemText, memoryText, runCompression, reCompress, ensureMemory, updateCognition, updateRelationShared, updateScene, recentTranscript, ensureFilter, ensureCtxWash, applyFilter, generateFilterRule, splitCharacterFields, correctMemory };
})();
