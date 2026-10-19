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

    /* ── 时间口径（10-19 修正）──────────────────────────────
       用户在下拉里选的是「这条线的故事时间」（没开时间系统时就是现实时间）。
       但比较必须放在同一套坐标系里，所以 due 一律【存现实毫秒】：
         due = 选中的故事时间 − 偏移（偏移 = time.start − time.setAt）
       判断到点用【现实现在】（冻结时用 frozenAt —— 它本身就是现实毫秒）。
       以前是拿「按现实解析出来的 due」直接跟故事时间比：
       偏移不为 0 时，故事在未来的线一建就响、故事在过去的线永远不响。 */
    function sessOf(sid) {
      sync();
      var arr = Store.getSessions();
      for (var i = 0; i < arr.length; i++) { if (arr[i].id === sid) return arr[i] || null; }
      return null;
    }
    function timeOf(sid) {
      var s = sessOf(sid);
      return (s && s.time) || null;
    }
    function offOf(sid) {
      var t = timeOf(sid);
      if (!t || typeof t.start !== "number" || typeof t.setAt !== "number") return null;
      return t.start - t.setAt;
    }
    function realNow(sid) {
      var t = timeOf(sid);
      if (t && typeof t.frozenAt === "number") return t.frozenAt;
      return Date.now();
    }
    function isDue(r) {
      if (!r || r.done || !r.due) return false;
      return realNow(r.sid) >= r.due;
    }
    /* 显示用：把存的现实毫秒还原成「用户当初选的那个故事时间」 */
    function fmtFor(r) {
      var off = offOf(r && r.sid);
      return fmt((r.due || 0) + (off || 0));
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
      arr.forEach(function (r) {
        var row = document.createElement("div");
        row.className = "reminder-item" + (r.done ? " done" : "") + (isDue(r) ? " late" : "");

        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!r.done;
        cb.addEventListener("change", function () {
          /* 按 id 找，不按下标 —— 列表是排过序的，下标跟存储顺序对不上 */
          var next = list();
          next.forEach(function (x) { if (x.id === r.id) x.done = cb.checked; });
          save(next);
          renderList();
          syncDot();
        });

        var tx = document.createElement("div");
        tx.className = "reminder-tx";
        var b = document.createElement("b");
        b.textContent = r.text;
        tx.appendChild(b);
        if (r.due) {
          var sm = document.createElement("small");
          var late = isDue(r);
          sm.textContent = (late ? "已到时间 · " : "约定 ") + fmtFor(r) + (offOf(r.sid) === null ? "" : "（故事时间）");
          if (late) sm.className = "late";
          tx.appendChild(sm);
        }

        var del = document.createElement("button");
        del.type = "button";
        del.className = "icon-btn reminder-del";
        del.setAttribute("aria-label", "删除");
        del.innerHTML = UI.iconSvg("close");
        del.addEventListener("click", function () {
          /* 同上：按 id 删。以前用排序后的 i 去 splice 原始顺序的数组，会删错条目 */
          var next = list().filter(function (x) { return x.id !== r.id; });
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
      var sid = state.sessionId || "";
      var due = 0;
      if (asTime) {
        if (!at) { UI.toast("先把约定时间选上", true); return; }
        var picked = new Date(at).getTime();
        if (!picked || isNaN(picked)) { UI.toast("这个时间看不懂", true); return; }
        /* 下拉里选的是「故事时间」→ 换算成现实毫秒再存（见 offOf 那一大段注释）。
           没开时间系统的线 offset 为 null，当作现实时间，原样存。 */
        due = picked - (offOf(sid) || 0);
      }
      var arr = list();
      arr.push({
        id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        text: text,
        due: due,
        sid: sid,
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
