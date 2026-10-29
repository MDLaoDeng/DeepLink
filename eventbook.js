/* eventbook.js —— 事件流 + 事件簿（10-27）
 *
 * 事件流挂在会话上：session.events = [{ t, kind, text, mentions, source, at }]
 *   t        故事时间戳（没开时间系统的线退回真实时间）
 *   kind     world（离线剧情）/ day（日更摘要）/ spread（跨角色传播）
 *   mentions 这段提到了哪些角色 id（用来判断「谁在哪儿提过我」）
 *   source   live（本角色亲历）/ heard（听说、转述）
 *
 * 事件簿只读：把各线的事件按「世界观 → 世界线 → 日期」摊开，不改任何会话数据。
 * 用户口径（10-27）：可在设置里关闭；关掉后既不生成事件流也不显示入口 —— 省的不只是界面还有 token。
 */
(function () {
  "use strict";

  function Store() { var d = window.DL || {}; return d.Store || window.Store; }
  function UI() { var d = window.DL || {}; return d.UI || window.UI; }
  function Memory() { var d = window.DL || {}; return d.Memory || window.Memory; }
  function stateOf() { var d = window.DL || {}; return d.state || {}; }
  function on() { return stateOf().settings ? (stateOf().settings.eventBook !== false) : true; }

  /* 一条线的事件（过滤掉坏数据：没有故事时间或没有正文的不算） */
  function eventsOf(s) {
    var arr = (s && Array.isArray(s.events)) ? s.events : [];
    return arr.filter(function (e) { return e && typeof e.t === "number" && String(e.text || "").trim(); });
  }

  /* 写一条事件。按 sid 找会话，找不到就静默失败（事件流不值得为它报错） */
  function pushEvent(sid, ev) {
    if (!on()) return false;
    if (!sid || !ev || !String(ev.text || "").trim()) return false;
    var S = Store();
    if (!S) return false;
    var list = S.getSessions();
    var i = -1;
    for (var k = 0; k < list.length; k++) { if (list[k].id === sid) { i = k; break; } }
    if (i < 0) return false;
    if (!Array.isArray(list[i].events)) list[i].events = [];
    list[i].events.push({
      t: (typeof ev.t === "number") ? ev.t : Date.now(),
      kind: ev.kind || "day",
      text: String(ev.text || "").trim().slice(0, 600),
      mentions: Array.isArray(ev.mentions) ? ev.mentions.slice(0, 8) : [],
      source: (ev.source === "heard") ? "heard" : "live",
      at: Date.now()
    });
    /* 一条线最多留 500 条：事件簿是「看发生过什么」，不是全量存档 */
    if (list[i].events.length > 500) list[i].events = list[i].events.slice(-500);
    S.saveSessions(list);
    return true;
  }

  /* 世界观标题：角色卡里那段文字的前 12 字。没填就是「未设定世界观」 */
  function worldTitleOf(s) {
    var d = window.DL || {};
    var ch = null;
    try { ch = d.characterFor ? d.characterFor(s) : null; } catch (e) { ch = null; }
    var w = String((ch && ch.fields && ch.fields.world) || "").replace(/\s+/g, "").trim();
    if (!w) return "未设定世界观";
    return w.slice(0, 12) + (w.length > 12 ? "…" : "");
  }

  function charNameOf(s) {
    var d = window.DL || {};
    var ch = null;
    try { ch = d.characterFor ? d.characterFor(s) : null; } catch (e) { ch = null; }
    return (ch && ch.name) || "听澜";
  }

  function dateOf(t) {
    var M = Memory();
    try { if (M && M.fmtStory) return M.fmtStory(t).slice(0, 10); } catch (e) { /* ignore */ }
    var d = new Date(t);
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /* 整页打开（10-27 用户口径：事件簿是一整个页面，不是弹窗） */
  function openEventBook() {
    var p = document.getElementById("eventBookPage");
    if (!p) return;
    if (ebCloseTimer) { clearTimeout(ebCloseTimer); ebCloseTimer = 0; }
    p.classList.remove("closing");
    p.hidden = false;
    renderEventBook();
  }
  /* 收起带退场（10-29）：进场是 eb-in（从右轻推），退场照同一方向退回去。
     原来 hidden 一置就硬切，全项目最后两处「进有出无」之一。 */
  var ebCloseTimer = 0;
  function closeEventBook() {
    var p = document.getElementById("eventBookPage");
    if (!p || p.hidden || p.classList.contains("closing")) return;
    p.classList.add("closing");
    if (ebCloseTimer) clearTimeout(ebCloseTimer);
    ebCloseTimer = setTimeout(function () {
      ebCloseTimer = 0;
      p.classList.remove("closing");
      p.hidden = true;
    }, (window.UI && UI.exitMs) ? UI.exitMs(160) : 160);
  }
  function eventBookOpen() {
    var p = document.getElementById("eventBookPage");
    /* 退场中当成「已关」：否则按一次返回开始淡出、再按一次又被这里吃掉 */
    return !!(p && !p.hidden && !p.classList.contains("closing"));
  }

  /* 渲染：世界观 → 世界线 → 日期。倒序（最近的在上面），总量封顶 200 条 */
  function renderEventBook() {
    var box = document.getElementById("eventBookBody");
    if (!box) return;
    box.innerHTML = "";
    if (!on()) {
      box.appendChild(hintEl("事件簿已在设置里关闭（设置 → 高级功能 → 事件簿）"));
      return;
    }
    var S = Store();
    var sessions = S ? S.getSessions() : [];
    var worlds = {};      /* 世界观名 -> { 线名 -> { items: [{t,text,kind}] } } */
    var total = 0;
    sessions.forEach(function (s) {
      var evs = eventsOf(s);
      if (!evs.length) return;
      var w = worldTitleOf(s);
      var line = charNameOf(s) + " · " + (s.mainLine ? "主线" : (s.title || "支线"));
      if (!worlds[w]) worlds[w] = {};
      if (!worlds[w][line]) worlds[w][line] = [];
      evs.forEach(function (e) {
        worlds[w][line].push({ t: e.t, text: e.text, kind: e.kind, source: e.source, mentions: e.mentions });
        total++;
      });
    });
    if (!total) {
      box.appendChild(hintEl("还没有事件。世界生成 / 日更之后，这里会按天列出各条线发生了什么。"));
      return;
    }
    var worldKeys = Object.keys(worlds).sort();
    var shown = 0;
    worldKeys.forEach(function (wk, wi) {
      var det = document.createElement("details");
      det.className = "eb-world";
      if (wi === 0) det.open = true;
      var sum = document.createElement("summary");
      var name = document.createElement("b");
      name.textContent = wk;
      var cnt = document.createElement("i");
      var n = 0;
      Object.keys(worlds[wk]).forEach(function (lk) { n += worlds[wk][lk].length; });
      cnt.textContent = n + " 条";
      sum.appendChild(name); sum.appendChild(cnt);
      det.appendChild(sum);

      var lineKeys = Object.keys(worlds[wk]).sort();
      lineKeys.forEach(function (lk) {
        var ld = document.createElement("details");
        ld.className = "eb-line";
        /* 这条线的事件不多就直接展开 —— 打开事件簿还要再点两下才看得到内容，太绕 */
        ld.open = (worlds[wk][lk].length <= 12);
        var ls = document.createElement("summary");
        var lb = document.createElement("b");
        lb.textContent = lk;
        var lc = document.createElement("i");
        lc.textContent = worlds[wk][lk].length + " 条";
        ls.appendChild(lb); ls.appendChild(lc);
        ld.appendChild(ls);

        /* 按日期分组，日期倒序 */
        var byDay = {};
        worlds[wk][lk].forEach(function (it) {
          var d = dateOf(it.t);
          if (!byDay[d]) byDay[d] = [];
          byDay[d].push(it);
        });
        var days = Object.keys(byDay).sort().reverse();
        days.forEach(function (day) {
          if (shown >= 200) return;
          var dh = document.createElement("div");
          dh.className = "eb-day";
          dh.textContent = day;
          ld.appendChild(dh);
          byDay[day].sort(function (a, b) { return b.t - a.t; }).forEach(function (it) {
            if (shown >= 200) return;
            shown++;
            var row = document.createElement("div");
            row.className = "eb-item eb-" + (it.kind || "day");
            var tag = document.createElement("span");
            tag.className = "eb-tag";
            tag.textContent = it.kind === "world" ? "剧情" : (it.kind === "spread" ? "转述" : "当天");
            var tx = document.createElement("span");
            tx.className = "eb-text";
            tx.textContent = it.text;
            if (it.source === "heard") {
              var h = document.createElement("i");
              h.className = "eb-heard";
              h.textContent = "听说";
              tx.appendChild(h);
            }
            row.appendChild(tag);
            row.appendChild(tx);
            ld.appendChild(row);
          });
        });
        det.appendChild(ld);
      });
      box.appendChild(det);
    });
    if (shown >= 200) {
      var more = hintEl("只显示最近 200 条（事件簿是「看发生过什么」，不做全量存档）");
      box.appendChild(more);
    }
  }

  function hintEl(t) {
    var d = document.createElement("div");
    d.className = "hint";
    d.textContent = t;
    return d;
  }

  function bind() {
    var b = document.getElementById("openEventBookBtn");
    if (b && !b.dataset.bound) {
      b.dataset.bound = "1";
      b.addEventListener("click", function () {
        try { if (window.DL.closeSidebar) window.DL.closeSidebar(); } catch (e) { /* ignore */ }
        openEventBook();
      });
    }
    var back = document.getElementById("eventBookBack");
    if (back && !back.dataset.bound) {
      back.dataset.bound = "1";
      back.addEventListener("click", closeEventBook);
    }
    /* 入口跟着开关走：关掉事件簿就整块藏起来 */
    var s = stateOf().settings || {};
    if (b) b.hidden = (s.eventBook === false);
    /* 光在加载时判一次不够（10-29 修）：用户在设置里把开关关掉后，入口要立刻消失，
       而不是等下次冷启动。refreshEventBookEntry 以前没有任何调用方 —— 这里改成
       直接盯住那个开关，同时把 refreshEventBookEntry 变成「真的能刷」的入口。 */
    var sw = document.getElementById("setEventBook");
    if (sw && !sw.dataset.ebBound) {
      sw.dataset.ebBound = "1";
      sw.addEventListener("change", function () {
        var st2 = stateOf().settings || {};
        if (b) b.hidden = (st2.eventBook === false);
      });
    }
  }

  var api = {
    eventsOf: eventsOf,
    pushEvent: pushEvent,
    openEventBook: openEventBook,
    closeEventBook: closeEventBook,
    eventBookOpen: eventBookOpen,
    renderEventBook: renderEventBook,
    refreshEventBookEntry: bind
  };
  var D = window.DL || (window.DL = {});
  Object.keys(api).forEach(function (k) { D[k] = api[k]; });
  try { bind(); } catch (e) { /* 侧边栏还没建好就等下次 */ }

  (window.__dlScripts = window.__dlScripts || []).push("eventbook.js");
})();
