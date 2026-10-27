/* Sekulum —— 「TA 的思考」（10-20 用户口径）

   一句话：角色随剧情过日子时，自己记下的内心记录。不是模型推理链，也不是给用户看的总结。

   规则（照用户原话拆的）：
   1. 只在**时间系统开着、且时间没被冻结**时工作。
   2. 三个记录时机：记忆更新、世界生成、后台活跃。
      世界生成优先级最高 —— 那天已经有剧情附带的思考，记忆更新就不再写一遍。
   3. 内容按性格走：学者想学习的事，爱哲思的人想抽象问题；允许无厘头、跳跃、自问自答。
   4. **先只存不读**：不参与对话上下文。
   5. 每过 7 个故事日压缩一次：碎的只留结论，带过程的只留关键。
      压缩完让角色读一次，之后七天不再读（那一段继续留在上下文里）。
   6. 对话设置里能看、能点「读取」，**只能读不能改**；可纠偏，但除非推论/观点离谱到
      和角色设定冲突，否则不改。

   数据（会话级，明文，和情绪日记一个待遇）：
     s.think = {
       days: [{ d: "2026-10-19", t: "……", src: "world|mem|idle" }],
       digest: "",       // 压缩后的那一段
       digestAt: 0,      // 上次压缩时的故事毫秒
       digestTo: "",     // 压缩覆盖到哪一天
       readAt: 0,        // 上次读取时的故事毫秒
       readText: "",     // 读取时注入的正文（七天内继续带）
       tries: {}         // { 日期: 次数 }，一天最多试 2 次，避免反复烧钱
     }
*/
(function () {
  var booted = false;

  function boot() {
    if (booted) return true;
    var D = window.DL;
    if (!D) return false;   /* app.js 还没就绪，等文件末尾的重试 */
    booted = true;

    var state = D.state;
    var WEEK = 7 * 86400000;
    var MAX_KEEP = 60;      /* 最多留 60 天的原始碎念，再多就把最老的丢掉（压缩过的不受影响） */

    function Store() { return window.Store || D.Store; }
    function Memory() { return window.Memory || D.Memory; }
    function Api() { return window.Api || D.Api; }

    function nowOf(s) {
      try {
        var M = Memory();
        if (M && M.nowOf) return M.nowOf(s);
      } catch (e) { /* 退回现实时间 */ }
      return Date.now();
    }
    function frozenOf(s) {
      try {
        var M = Memory();
        if (M && M.isFrozen) return !!M.isFrozen(s);
      } catch (e) { /* 当作没冻结 */ }
      return false;
    }
    function dayStr(ms) {
      try {
        var M = Memory();
        if (M && M.fmtStory) return M.fmtStory(ms).slice(0, 10);
      } catch (e) { /* ignore */ }
      return new Date(ms).toISOString().slice(0, 10);
    }

    /* 前提：时间系统开着 + 没冻结 + 用户没关这个功能。
       群聊不记：思考是「一个人」按自己性格写的，群聊里没有唯一的「他」；
       而且群聊的系统提示词不走 buildSystemText，记了也永远读不到 —— 白花钱。 */
    function enabled(s) {
      if (!s || s.isGroup) return false;
      if (!s.time || typeof s.time.start !== "number") return false;
      if (frozenOf(s)) return false;
      if (state.settings && state.settings.thinkOn === false) return false;
      return true;
    }

    function of(s) {
      if (!s) return null;
      if (!s.think || typeof s.think !== "object" || Array.isArray(s.think)) s.think = {};
      var t = s.think;
      if (!Array.isArray(t.days)) t.days = [];
      if (typeof t.digest !== "string") t.digest = "";
      if (typeof t.readText !== "string") t.readText = "";
      if (typeof t.digestAt !== "number") t.digestAt = 0;
      if (typeof t.readAt !== "number") t.readAt = 0;
      if (!t.tries || typeof t.tries !== "object") t.tries = {};
      /* 思考对象（10-20）：会话级，默认只想着自己 */
      if (!Array.isArray(t.about) || !t.about.length) t.about = ["self"];
      return t;
    }

    /* 可选对象：自己 / 用户 / 这条线相关的人（单线就是那个角色，群聊是全部成员） */
    function whoOf(s) {
      var out = [{ id: "self", label: "你自己" }, { id: "user", label: "用户" }];
      try {
        var chs = Store().getCharacters() || [];
        var ids = [];
        if (s && s.isGroup && Array.isArray(s.members)) ids = s.members;
        else if (s && s.characterId) ids = [s.characterId];
        ids.forEach(function (id) {
          var c = chs.filter(function (x) { return x && x.id === id; })[0];
          if (!c) return;
          var nm = (c.fields && c.fields.aiName) || c.name || "角色";
          out.push({ id: "c:" + id, label: nm });
        });
      } catch (e) { /* 读不到角色就只留自己 / 用户 */ }
      return out;
    }

    function save() {
      try { Store().saveSessions(Store().getSessions()); } catch (e) { /* ignore */ }
    }

    /* 取这条线的实时对象（Store 里那份，改完自己 save） */
    function live(sid) {
      try {
        var list = Store().getSessions() || [];
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === sid) return list[i];
      } catch (e) { /* ignore */ }
      return null;
    }

    function find(s, d) {
      var t = of(s);
      if (!t) return null;
      for (var i = 0; i < t.days.length; i++) if (t.days[i] && t.days[i].d === d) return t.days[i];
      return null;
    }

    /* 只留最近 MAX_KEEP 天。修剪时**先丢已经压进 digest 的**（它们的信息已经在 digest 里），
       实在不够再丢最老的 —— 别把还没压缩的碎念直接扔掉，那等于永久丢内容。 */
    function trimDays(t) {
      var over = t.days.length - MAX_KEEP;
      if (over <= 0) return;
      var cut = t.digestTo || "";
      for (var i = 0; i < t.days.length && over > 0;) {
        if (cut && t.days[i] && t.days[i].d && t.days[i].d <= cut) { t.days.splice(i, 1); over--; }
        else i++;
      }
      if (over > 0) t.days.splice(0, over);
    }

    /* 记一天的思考。同一天已有内容时**追加**（不同时机各写一句，本来就是碎念） */
    function add(s, d, text, src) {
      var t = of(s);
      var v = String(text || "").trim();
      if (!t || !v || !d) return false;
      var hit = find(s, d);
      if (hit) {
        /* 世界生成的那份优先级最高：已有 world 就不再追加 mem/idle */
        if (hit.src === "world" && src !== "world") return false;
        hit.t = (hit.t ? hit.t + "\n" : "") + v;
        if (src === "world") hit.src = "world";
      } else {
        t.days.push({ d: d, t: v, src: src || "mem" });
        trimDays(t);
      }
      return true;
    }

    function metaOf(s) {
      var ch = null;
      try { ch = D.characterFor ? D.characterFor(s) : null; } catch (e) { ch = null; }
      var f = (ch && ch.fields) || {};
      return {
        name: (f.aiName || (ch && ch.name) || "角色"),
        persona: f.aiPersona || "",
        style: f.aiStyle || "",
        likes: f.aiLikes || "",
        directive: f.aiDirective || "",
        relation: (s && s.relation) || "",
        scene: (s && s.scene) || ""
      };
    }

    /* 性格决定想什么：这句是给模型的硬要求，不是建议 */
    var THINK_SYS =
      "你在写「TA 的思考」——角色自己的内心记录。不是旁白，不是给用户看的作文。\n" +
      "硬要求：\n" +
      "1. 第一人称、口语、像自己跟自己嘀咕。禁止总结腔（不许「今天我意识到」「总的来说」「这让我明白」）。\n" +
      "2. 长度 1~3 句，允许跳跃、自问自答、无厘头、说半句就断了。\n" +
      "3. **必须符合这个人的性格**：学者会琢磨学习/研究上的事，爱哲思的人会想抽象的问题，" +
      "务实的想具体的事，敏感的人会反刍一句话的语气。不要写成通用感想。\n" +
      "4. 不要复述发生了什么，写「他怎么想这件事」。\n" +
      "5. 除了自己，也可以想别人：想别人时让人一眼看出是谁、怎么想他；不要提起没见过的人。\n" +
      "6. 只输出正文，不要标题、不要引号、不要列表符号。";

    /* 生成某一天的思考。opts.src = world / mem / idle；opts.scene 可带当天剧情摘要 */
    async function genFor(sid, d, opts) {
      var s = live(sid);
      if (!s) return false;
      if (!enabled(s)) return false;
      var t = of(s);
      /* 一天最多试 2 次 */
      var tries = Number(t.tries[d]) || 0;
      if (tries >= 2) return false;
      /* 那天已经有世界生成的思考 → 别的来源不再写；
         同一来源一天只写一次（免得每轮回复都追加一句，越攒越长） */
      var hit = find(s, d);
      var src = (opts && opts.src) || "mem";
      if (hit && (hit.src === "world" || hit.src === src)) return false;

      var A = Api();
      if (!A || !A.summarize) return false;
      var settings = state.settings;
      if (!settings || !settings.apiKey) return false;

      t.tries[d] = tries + 1;
      save();

      var m = metaOf(s);
      /* 思考对象（10-20）：不只是想自己，也能想别人 —— 会话设置里可多选 */
      var about = (opts && opts.about) || t.about || ["self"];
      var who = whoOf(s).filter(function (w) { return about.indexOf(w.id) >= 0; })
        .map(function (w) { return w.label; });
      var what = String((opts && opts.scene) || "").trim();
      var body = [
        "角色：" + m.name,
        "性格：" + (m.persona || "（未填）"),
        "说话风格：" + (m.style || "（未填）"),
        "喜好：" + (m.likes || "（未填）"),
        "当前关系：" + (m.relation || "（未记录）"),
        (m.directive ? "额外注意：" + m.directive : ""),
        "日期：" + d,
        (what ? "这天发生了什么：" + what : "这天没什么特别的事。"),
        "可以想的人：" + (who.length ? who.join("、") : "你自己"),
        "写这一天的心里话。想别人时要让人看得出想的是谁。"
      ].filter(Boolean).join("\n");

      var usage = null;
      var text = "";
      try {
        var r = await A.summarize(settings, [
          { role: "system", content: THINK_SYS },
          { role: "user", content: body }
        ], { maxTokens: 200 });
        text = String((r && r.text) || "").trim();
        usage = (r && r.usage) || null;
      } catch (e) {
        return false;
      }
      if (usage && typeof D.recordUsage === "function") {
        try { D.recordUsage(null, usage, s.characterId || "", "think"); } catch (e) { /* ignore */ }
      }
      text = text.replace(/^["「『]+|["」』]+$/g, "").trim();
      if (!text) return false;

      var s2 = live(sid);
      if (!s2) return false;
      if (add(s2, d, text, (opts && opts.src) || "mem")) save();
      return true;
    }

    /* 世界生成那批文本 → 抽出〖想法〗并按天入列。返回剥掉想法之后的剧情文本。
       ⚠️ 这里必须**先整段抽**再按天归位：提示词要求想法「另起一行」，
          逐行匹配时起头那行没有结束标记、结束那行没有起头标记，两边都对不上，
          结果一条也抽不出来、标记还留在正文里（10-20 审查发现的坑）。 */
    var THINK_RE = /[〖【\[]\s*想法\s*[〗】\]]?\s*([\s\S]*?)\s*[〖【\[]\s*\/\s*想法\s*[〗】\]]/g;

    function absorbWorld(sid, worldText) {
      var s = live(sid);
      if (!s) return String(worldText || "");
      var txt = String(worldText || "");
      if (!txt) return txt;

      /* 1) 所有想法整段抽出（允许跨行、一行多个），正文里换成占位符，行结构不动 */
      var marks = [];
      var body = txt.replace(THINK_RE, function (all, inner) {
        var v = String(inner || "").trim();
        if (!v) return "";
        marks.push(v);
        return "[[TK" + (marks.length - 1) + "]]";
      });
      if (!marks.length) return txt;      /* 没有想法：正文一个字都不动 */

      /* 2) 按「序号 + 日期」切天，占位符归到它所在的那天 */
      var lines = body.split(/\r?\n/);
      var out = [];
      var curDate = "";
      var curThink = [];
      var any = false;

      function flushDay() {
        if (curDate && curThink.length) {
          add(s, curDate, curThink.join("\n"), "world");
          any = true;
        }
        curThink = [];
        curDate = "";
      }

      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        /* 序号可选：worldParts 在展示时就把「1. 」去掉了，applyWorld 收到的是框内文本，
           只剩「3月12日 …」。只认「序号 + 日期」会一条都对不上 → 整批想法被丢掉。 */
        var head = /^\s*(?:(\d+)\s*[.、)）]\s*)?(\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|\d{1,2}[.\/]\d{1,2})/.exec(ln);
        if (head) {
          flushDay();
          var raw = head[2];
          if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) curDate = raw;
          else {
            var mm = /^(\d{1,2})月(\d{1,2})日$/.exec(raw) || /^(\d{1,2})[.\/](\d{1,2})$/.exec(raw);
            if (mm) {
              var y = dayStr(nowOf(s)).slice(0, 4);
              curDate = y + "-" + ("0" + mm[1]).slice(-2) + "-" + ("0" + mm[2]).slice(-2);
            }
          }
        }
        /* 占位符 → 归到当天（跨行的想法这时已经被拼回一段了） */
        ln = ln.replace(/\[\[TK(\d+)\]\]/g, function (all, k) {
          var v = marks[Number(k)];
          if (v) curThink.push(v);
          return "";
        }).replace(/\s+$/, "");
        if (!ln.trim()) continue;         /* 抽完只剩空行：不留空壳 */
        out.push(ln);
      }
      flushDay();
      /* 一个天头都没认出来（用户改写过框首、或模型没按格式写）：
         宁可记到「今天」，也不能让想法连着占位符一起消失。 */
      if (!any && marks.length) {
        add(s, dayStr(nowOf(s)), marks.join("\n"), "world");
        any = true;
      }
      if (any) save();
      return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    /* 7 个故事日压一次：碎的留结论、带过程的留关键 */
    var DIGEST_SYS =
      "你在压缩「TA 的思考」——一个角色这些天自己记下的零碎想法。\n" +
      "要求：\n" +
      "1. 特别碎的（一两句、没头没尾、纯吐槽）只留结论，不要还原原话。\n" +
      "2. 带过程的（在琢磨什么、怎么想的）只留关键的那步推理。\n" +
      "3. 保留这个人的性格与语气，不要压成中性的总结报告。\n" +
      "4. 三百字以内，分 2~5 条，用「- 」起头。\n" +
      "5. 只输出正文。";

    /* alsoRead=false：只压不读（对话设置里那个「压缩」按钮）。
       自动流程（tick）不传，保持「压缩完让角色读一次」的老行为。 */
    async function digest(sid, alsoRead) {
      var s = live(sid);
      if (!s) return "";
      if (!enabled(s)) return "";
      var t = of(s);
      var pending = t.days.filter(function (x) {
        return x && x.d && (!t.digestTo || x.d > t.digestTo);
      });
      if (!pending.length) return "";
      var A = Api();
      if (!A || !A.summarize) return "";
      var settings = state.settings;
      if (!settings || !settings.apiKey) return "";

      var src = pending.map(function (x) { return x.d + "：" + x.t; }).join("\n");
      var m = metaOf(s);
      var usage = null;
      var text = "";
      try {
        var r = await A.summarize(settings, [
          { role: "system", content: DIGEST_SYS },
          { role: "user", content: "角色：" + m.name + "\n性格：" + (m.persona || "（未填）") + "\n下面是这些天的想法：\n" + src }
        ], { maxTokens: 600 });
        text = String((r && r.text) || "").trim();
        usage = (r && r.usage) || null;
      } catch (e) { return ""; }
      if (usage && typeof D.recordUsage === "function") {
        try { D.recordUsage(null, usage, s.characterId || "", "think"); } catch (e) { /* ignore */ }
      }
      if (!text) return "";

      var s2 = live(sid);
      if (!s2) return "";
      var t2 = of(s2);
      t2.digest = text;
      t2.digestTo = pending[pending.length - 1].d;
      t2.digestAt = nowOf(s2);
      /* 压缩完就让角色读一次（手动点「压缩」时不要，见 alsoRead） */
      if (alsoRead !== false) {
        t2.readText = text;
        t2.readAt = t2.digestAt;
      }
      save();
      return text;
    }

    /* 该不该读：压缩后读过，七天内不再读 */
    function shouldAutoDigest(s) {
      if (!enabled(s)) return false;
      var t = of(s);
      if (!t) return false;
      var pending = t.days.filter(function (x) { return x && x.d && (!t.digestTo || x.d > t.digestTo); });
      if (!pending.length) return false;
      var n = nowOf(s);
      if (!t.digestAt) return pending.length >= 7;          /* 头一次：攒够 7 天再压 */
      return (n - t.digestAt) >= WEEK;
    }

    /* 后台时机（角色主动找你、记忆更新之后）调这个：攒够 7 天就自己压 + 读 */
    async function tick(sid) {
      var s = live(sid);
      if (!s || !shouldAutoDigest(s)) return false;
      await digest(sid);
      return true;
    }

    /* 拼进 system 的那一段（memory.buildSystemText 调） */
    function readBlock(s) {
      if (!enabled(s)) return "";
      var t = of(s);
      if (!t || !t.readText) return "";
      var n = nowOf(s);
      /* 七天内继续带着；超过七天就不带了，等下一次压缩 */
      if (t.readAt && (n - t.readAt) >= WEEK) return "";
      return "【你最近的想法（自己回顾用，不必主动提起）】\n" + t.readText +
        "\n提不提由你的性格决定：可能一股脑说出来，可能只自然流露一点，也可能干脆不说。";
    }

    /* 手动「读取」：马上压缩并读一次 */
    async function readNow(sid) {
      var s = live(sid);
      if (!s) return "";
      if (!enabled(s)) return "";
      var t = of(s);
      var out = "";
      var hasPending = t.days.some(function (x) { return x && x.d && (!t.digestTo || x.d > t.digestTo); });
      if (hasPending) out = await digest(sid);
      if (!out) out = of(live(sid) || s).digest || "";
      if (!out) return "";
      var s2 = live(sid);
      if (s2) {
        var t2 = of(s2);
        t2.readText = out;
        t2.readAt = nowOf(s2);
        save();
      }
      return out;
    }

    /* 纠偏：只改离谱的推论 / 观点，其余原样 */
    var CORRECT_SYS =
      "你在核对一份「角色的内心记录」。用户会指出哪里不对。\n" +
      "要求：\n" +
      "1. **只改确实与角色设定冲突、或明显离谱的推论与观点**；语气、偏好、情绪本来就可以反复，不要因为「和前面不一样」就改。\n" +
      "2. 用户指出的事实错误必须改对。\n" +
      "3. 保持第一人称口语，长度和原来差不多。\n" +
      "4. 只输出改完的正文；如果一处都不用改，就原样输出。";

    async function correct(sid, note) {
      var s = live(sid);
      if (!s) return "";
      if (!enabled(s)) return "";
      var t = of(s);
      var cur = t.digest || "";
      if (!cur) {
        var last = t.days.slice(-3).map(function (x) { return x.t; }).join("\n");
        cur = last;
      }
      if (!cur.trim()) return "";
      var noteTxt = String(note || "").trim();
      if (!noteTxt) return "";
      var A = Api();
      if (!A || !A.summarize) return "";
      var settings = state.settings;
      if (!settings || !settings.apiKey) return "";
      var m = metaOf(s);
      var usage = null;
      var text = "";
      try {
        var r = await A.summarize(settings, [
          { role: "system", content: CORRECT_SYS },
          { role: "user", content: "角色：" + m.name + "\n性格：" + (m.persona || "（未填）") +
            "\n原文：\n" + cur + "\n\n用户的纠正：" + noteTxt }
        ], { maxTokens: 600 });
        text = String((r && r.text) || "").trim();
        usage = (r && r.usage) || null;
      } catch (e) { return ""; }
      if (usage && typeof D.recordUsage === "function") {
        try { D.recordUsage(null, usage, s.characterId || "", "think"); } catch (e) { /* ignore */ }
      }
      if (!text) return "";
      if (text === cur) return "";      /* 模型认为不用改 */
      var s2 = live(sid);
      if (!s2) return "";
      var t2 = of(s2);
      t2.digest = text;
      /* 纠偏也算「读过这一次」：否则刚改完可能正好跨过七天，改后的内容反而注入不进去 */
      if (t2.readText) { t2.readText = text; t2.readAt = nowOf(s2); }
      save();
      return text;
    }

    /* 给界面用：按日期倒序 */
    function listOf(s) {
      var t = of(s);
      if (!t) return [];
      return t.days.slice().sort(function (a, b) { return String(a.d) < String(b.d) ? 1 : -1; });
    }

    window.Think = {
      enabled: enabled, of: of, add: add, genFor: genFor, digest: digest, tick: tick,
      /* whoOf 必须挂出来：roleplay.js 的「思考对象」多选框靠它填候选（漏了就一直空白） */
      whoOf: whoOf,
      readBlock: readBlock, readNow: readNow, correct: correct, listOf: listOf,
      absorbWorld: absorbWorld, dayStr: dayStr, nowOf: nowOf
    };
    return true;
  }

  function tryBoot() {
    if (boot()) return;
    var n = 0;
    var timer = setInterval(function () {
      if (boot() || ++n > 40) clearInterval(timer);
    }, 50);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tryBoot);
  else tryBoot();
})();
