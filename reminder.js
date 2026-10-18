/* reminder.js —— 备忘录（10-18 用户要求）
 *
 * 两种：
 *  - 普通备忘：只列在清单里，不打点。
 *  - 约定型（due > 0）：按「这条对话的故事时间」算，到点了在侧栏冒红点。
 *    没开时间系统的对话不参与到点提醒（用户口径），只当普通备忘列着。
 *
 * 数据存 settings.reminders，跟着设置一起备份 / 导出，不新开存储键。
 * 本文件只往 window.DL 挂一个 reminder 入口，不改其它模块行为。
 */
(function () {
  var booted = false;

  function boot() {
    if (booted) return true;
    var D = window.DL;
    if (!D) return false;
    booted = true;

    var Store = null, state = null, UI = null;
    function sync() {
      Store = D.Store || window.Store;
      state = D.state;
      UI = D.UI || window.UI;
    }
    sync();

    function $(s) { return document.querySelector(s); }
    function list() { sync(); return (state.settings.reminders || []).slice(); }
    function save(arr) {
      sync();
      var next = Store.saveSettings({ reminders: arr });
      if (state.settings) state.settings.reminders = next.reminders;
    }

    /* 当前故事时间：这条线开了时间系统才有值，否则返回 0。
       算法和 memory.js 的 nowOf 一致：冻结时用冻结那一刻，不冻结就用现在。 */
    function storyNow(sid) {
      sync();
      var s = null;
      var arr = Store.getSessions();
      for (var i = 0; i < arr.length; i++) { if (arr[i].id === sid) { s = arr[i]; break; } }
      var t = s && s.time;
      if (!t || typeof t.start !== "number" || typeof t.setAt !== "number") return 0;
      var base = (typeof t.frozenAt === "number") ? t.frozenAt : Date.now();
      return base + (t.start - t.setAt);
    }

    /* 这条备忘「现在」对应的时间：有故事时间就用故事时间，没有就退回现实时间 */
    function nowFor(r) {
      var sn = storyNow(r && r.sid);
      return sn || Date.now();
    }

    function isDue(r) {
      if (!r || r.done || !r.due) return false;
      return nowFor(r) >= r.due;
    }

    function dueCount() {
      var n = 0;
      list().forEach(function (r) { if (isDue(r)) n++; });
      return n;
    }

    /* 红点挂在「助手」那个分栏上（听澜在那一栏）。
       用户口径：入口在手机页「这条线」里，**提醒**在听澜这一侧冒出来。 */
    function syncDot() {
      var dot = $("#reminderDot");
      var n = dueCount();
      if (dot) dot.hidden = n === 0;
      var tab = document.querySelector('#sideTabs .side-tab[data-side="assistant"]');
      if (tab) tab.title = n ? ("听澜这边有 " + n + " 条备忘到点了") : "";
    }

    function fmt(ms) {
      var d = new Date(ms);
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function renderList() {
      var box = $("#reminderList");
      if (!box) return;
      var arr = list();
      box.innerHTML = "";
      if (!arr.length) {
        var empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "还没有备忘。";
        box.appendChild(empty);
        return;
      }
      /* 未完成在前、到点的更前 */
      arr.sort(function (a, b) {
        if (!!a.done !== !!b.done) return a.done ? 1 : -1;
        return (a.due || 0) - (b.due || 0);
      });
      arr.forEach(function (r, i) {
        var row = document.createElement("div");
        row.className = "reminder-item" + (r.done ? " done" : "") + (isDue(r) ? " late" : "");

        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!r.done;
        cb.addEventListener("change", function () {
          arr[i].done = cb.checked;
          save(arr);
          renderList();
          syncDot();
        });

        var tx = document.createElement("div");
        tx.className = "reminder-tx";
        var b = document.createElement("b");
        b.textContent = r.text;
        tx.appendChild(b);
        if (r.due) {
          var sub = document.createElement("small");
          var late = isDue(r);
          sub.textContent = (late ? "已到时间 · " : "约定 ") + fmt(r.due) + (storyNow(r.sid) ? "（故事时间）" : "");
          if (late) sub.className = "late";
          tx.appendChild(sub);
        }

        var del = document.createElement("button");
        del.type = "button";
        del.className = "icon-btn reminder-del";
        del.setAttribute("aria-label", "删除");
        del.innerHTML = UI.iconSvg("close");
        del.addEventListener("click", function () {
          var next = list();
          next.splice(i, 1);
          save(next);
          renderList();
          syncDot();
        });

        row.appendChild(cb);
        row.appendChild(tx);
        row.appendChild(del);
        box.appendChild(row);
      });
    }

    function add() {
      sync();
      var tx = $("#reminderText");
      var text = tx ? String(tx.value || "").trim() : "";
      if (!text) { UI.toast("先写点什么", true); return; }
      var asTime = $("#reminderAsTime") && $("#reminderAsTime").checked;
      var at = $("#reminderAt") ? String($("#reminderAt").value || "") : "";
      var due = 0;
      if (asTime) {
        if (!at) { UI.toast("先把约定时间选上", true); return; }
        due = new Date(at).getTime();
        if (!due || isNaN(due)) { UI.toast("这个时间看不懂", true); return; }
      }
      var arr = list();
      arr.push({
        id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        text: text,
        due: due,
        sid: state.sessionId || "",
        done: false,
        createdAt: Date.now()
      });
      save(arr);
      if (tx) tx.value = "";
      renderList();
      syncDot();
      UI.toast("记下了");
    }

    function open() {
      sync();
      UI.openModal("reminderModal");
      renderList();
      syncDot();
    }

    /* 每 20 秒对一次点：时间系统一直在走，不定时看就永远不冒红点 */
    setInterval(function () { try { syncDot(); } catch (e) { /* ignore */ } }, 20000);

    /* 入口在手机页「这条线」面板里（phone.js 调 D.reminder.open），这里只接「加进去」 */
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest("#reminderAddBtn")) { add(); return; }
    });
    document.addEventListener("change", function (ev) {
      var t = ev.target;
      if (t && t.id === "reminderAsTime") {
        var f = $("#reminderTimeField");
        if (f) f.hidden = !t.checked;
      }
    });

    window.DL.reminder = {
      open: open,
      add: add,
      render: renderList,
      sync: syncDot,
      list: list,
      storyNow: storyNow
    };
    try { syncDot(); } catch (e) { /* ignore */ }
    return true;
  }

  if (!boot()) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    var tries = 0;
    var retry = function () { if (boot()) return; if (++tries < 20) setTimeout(retry, 150); };
    setTimeout(retry, 150);
  }
})();
