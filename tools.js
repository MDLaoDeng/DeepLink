/* tools.js —— 给模型使用的工具（10-23 用户要求「直接加」）
 *
 * 以前「角色读自己的线」是前端一次性把档案塞进提示词，模型只能被动接受。
 * 这里给模型两个工具，让它自己决定读什么、读多少：
 *   line_read   读这条线自己的资料（记忆摘要 / 思绪 / 图库 / 认知关系 / 最近原话）
 *   line_search 在这条线自己的历史里按关键词找原话
 *
 * 读数范围（10-23 用户口径）：**摘要 + 最近 100 条原话**。
 *   更早的东西已经在记忆摘要里了，不必再逐条翻；100 条足够覆盖「还没被压缩的那段」。
 *
 * 两条底线：
 *  ① **只读当前这条线**。不跨角色、不跨会话 —— 这条线以外的东西模型永远看不到。
 *  ② 不改变任何数据。工具是只读的，不会写记忆、不会发消息。
 *
 * 依赖：window.Memory / window.Think / window.Store（调用时取，不在加载时快照）。
 * 本文件在 index.html 里排在 memory.js / think.js 之后、chat.js 之前。
 */
(function () {
  var LINE_READ = {
    type: "function",
    function: {
      name: "line_read",
      description: "读取你这条对话线（你和对方）自己的资料。what=memory 分层记忆摘要；" +
        "thinking 你自己之前写下的思绪；gallery 你以前的样子（图库描述）；" +
        "cognition 你对对方的认知 / 关系 / 共同经历 / 当前情境；recent 最近聊过的原话。",
      parameters: {
        type: "object",
        properties: {
          what: {
            type: "string",
            enum: ["memory", "thinking", "gallery", "cognition", "recent", "all"],
            description: "要读哪一块；不确定就 all（会带上各块要点）"
          },
          n: { type: "integer", description: "recent 时读几条，默认 8，最多 20" }
        },
        required: ["what"]
      }
    }
  };

  var LINE_SEARCH = {
    type: "function",
    function: {
      name: "line_search",
      description: "在这条线自己的历史（主聊天 + 手机消息）里按关键词找原话，" +
        "只看最近 " + 100 + " 条；更早的内容在 line_read 的记忆摘要里。" +
        "对方问「你之前不是说过…」而你想不起具体内容时用，别拿它当搜索引擎。",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "关键词，尽量短：一个人名、一个地点、一个词" },
          limit: { type: "integer", description: "最多返回几条，默认 6" }
        },
        required: ["q"]
      }
    }
  };

  function defs() { return [LINE_READ, LINE_SEARCH]; }

  function clip(t, n) {
    var s = String(t == null ? "" : t).replace(/[ \t]+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  /* 一条消息取正文：主聊天有 variants，手机只有 text */
  function textOf(m, isPhone) {
    if (!m) return "";
    if (isPhone) return String(m.text || "");
    if (typeof m.content === "string") return m.content;
    var v = m.variants && m.variants[m.vi || 0];
    if (typeof v === "string") return v;
    if (v && typeof v.content === "string") return v.content;
    return "";
  }

  function dayOf(ts) {
    if (!ts) return "";
    try {
      var d = new Date(ts);
      return (d.getMonth() + 1) + "-" + d.getDate() + " " +
        (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
    } catch (e) { return ""; }
  }

  /* 只看最近这么多条：和 line_search 同一口径，避免两处扫描范围不一致 */
  var SCAN = 100;

  function recentText(line, n) {
    var cap = Math.max(1, Math.min(20, Number(n) || 8));
    var who = "TA";
    var ch = null;
    try { ch = window.DL && window.DL.characterFor ? window.DL.characterFor(line) : null; } catch (e) { ch = null; }
    if (ch && ch.name) who = ch.name;
    var out = [];
    var take = function (arr, tag, isPhone) {
      var got = 0;
      var from = Math.max(0, (arr || []).length - SCAN);
      for (var i = (arr || []).length - 1; i >= from && got < cap; i--) {
        var m = arr[i];
        if (!m || m.kind === "sys" || m.kind === "recalled" || m.world || m.image) continue;
        var t = textOf(m, isPhone);
        if (!t) continue;
        var name = m.role === "user" ? "用户" : (m.speakerName || who);
        out.push("[" + tag + " " + dayOf(m.ts) + "] " + name + "：" + clip(t, 120));
        got++;
      }
    };
    take(line.messages || [], "主聊天", false);
    take((line.phone && line.phone.msgs) || [], "手机", true);
    if (!out.length) return "（这条线还没有聊天记录）";
    return out.reverse().join("\n");
  }

  function cognitionText(line) {
    var parts = [];
    var put = function (k, v, n) { var t = String(v || "").trim(); if (t) parts.push(k + "：" + clip(t, n || 200)); };
    put("和用户的关系", line.relation, 200);
    put("共同经历", line.shared, 220);
    put("最近一次的情境", line.scene, 160);
    put("对用户的认知", line.cognition, 200);
    return parts.length ? parts.join("\n") : "（还没有认知 / 关系记录）";
  }

  function run(name, args, ctx) {
    var a = args || {};
    var line = (ctx && ctx.line) || null;
    if (!line) return "（当前没有打开的对话线，读不到任何资料）";
    var M = window.Memory || {}, T = window.Think || null, S = window.Store || null;

    if (name === "line_read") {
      var what = String(a.what || "all");
      var n = Number(a.n) || 8;
      var one = function (k) {
        if (k === "memory") {
          var mt = "";
          try { mt = (M.memoryText && line.memory) ? String(M.memoryText(line.memory) || "") : ""; } catch (e) { mt = ""; }
          return mt ? clip(mt, 900) : "（还没有记忆摘要，聊过一段时间后会自动生成）";
        }
        if (k === "thinking") {
          var tb = "";
          try { tb = (T && T.readBlock) ? String(T.readBlock(line) || "") : ""; } catch (e) { tb = ""; }
          return tb ? clip(tb, 600) : "（你还没写下过思绪）";
        }
        if (k === "gallery") {
          var dg = "";
          try {
            dg = (S && S.charImageDigest && line.characterId) ? String(S.charImageDigest(line.characterId, 8) || "") : "";
          } catch (e) { dg = ""; }
          return dg ? clip(dg, 500) : "（图库里还没有和你相关的图）";
        }
        if (k === "cognition") return cognitionText(line);
        if (k === "recent") return recentText(line, n);
        return "";
      };
      if (what !== "all") {
        var got = one(what);
        return got || "（没有这一块）";
      }
      var all = [];
      ["cognition", "memory", "thinking", "recent", "gallery"].forEach(function (k) {
        var v = one(k);
        if (v && v.indexOf("（还没有") !== 0 && v.indexOf("（你还没") !== 0 && v.indexOf("（图库里还") !== 0) {
          all.push("【" + k + "】\n" + v);
        }
      });
      return all.length ? clip(all.join("\n\n"), 1500) : "（这条线还没有可读的资料）";
    }

    if (name === "line_search") {
      var q = String(a.q || "").trim();
      if (!q) return "（没给关键词，查不了）";
      var limit = Math.max(1, Math.min(20, Number(a.limit) || 6));
      var hits = [];
      var scan = function (arr, tag, isPhone) {
        var from = Math.max(0, (arr || []).length - SCAN);
        for (var i = (arr || []).length - 1; i >= from && hits.length < limit * 3; i--) {
          var m = arr[i];
          if (!m || m.kind === "sys" || m.kind === "recalled") continue;
          var t = textOf(m, isPhone);
          if (!t || t.indexOf(q) < 0) continue;
          var who = m.role === "user" ? "用户" : (m.speakerName || "TA");
          hits.push("[" + tag + " " + dayOf(m.ts) + "] " + who + "：" + clip(t, 140));
        }
      };
      scan(line.messages || [], "主聊天", false);
      scan((line.phone && line.phone.msgs) || [], "手机", true);
      if (!hits.length) return "（这条线里没找到「" + q + "」）";
      return "找到 " + hits.length + " 条：\n" + hits.slice(0, limit).join("\n");
    }

    return "（没有这个工具：" + name + "）";
  }

  window.Tools = { defs: defs, run: run };
  (window.__dlScripts = window.__dlScripts || []).push("tools.js");
})();
