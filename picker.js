/* picker.js —— 滚轮式日期 / 时间选择（10-18 用户要求：系统原生那个太丑）
 *
 *   WheelPicker.open({ mode: "date",     value: "2026-10-18",       onOk: fn })
 *   WheelPicker.open({ mode: "datetime", value: "2026-10-18T20:30", onOk: fn })
 *   onOk 收到同格式字符串；取消就什么都不调。
 *
 * 每列都是一个可滚动的竖条，中间那行是选中项。
 * 不用 scroll-snap（Chrome 83 上偶发不吸附），改成「滚动停下后手动对齐 scrollTop」。
 *
 * 列的数据模型统一成 {el, base, count, idx}：
 *   显示值 = base + idx，idx 从 0 开始 —— 年和日的起点不一样（年从 1900 起算），
 *   所以 base 必须跟着列走，不能写死。
 */
(function () {
  var ITEM_H = 36;        /* 必须和 CSS 里 .wp-item 的高度一致 */
  var PAD = 2;            /* 上下各留几行，让选中项落在正中 */
  var SETTLE_MS = 140;    /* 停止滚动多久后对齐 */

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function daysIn(y, m) { return new Date(y, m, 0).getDate(); }   /* m: 1~12 */

  var root = null;
  var box = null;
  var cols = null;         /* { y, m, d, h, mi } 各 {el, base, count, idx} */
  var mode = "date";
  var onOk = null;

  function build() {
    if (root) return;
    root = document.createElement("div");
    root.className = "wp-mask";
    root.hidden = true;
    root.innerHTML =
      '<div class="wp-sheet">' +
        '<div class="wp-head">' +
          '<button type="button" class="wp-btn" data-wp="cancel">取消</button>' +
          '<b data-wp="title">选择日期</b>' +
          '<button type="button" class="wp-btn wp-ok" data-wp="ok">确定</button>' +
        '</div>' +
        '<div class="wp-cols" data-wp="cols"><div class="wp-marker"></div></div>' +
      '</div>';
    document.body.appendChild(root);
    box = root.querySelector('[data-wp="cols"]');
    root.addEventListener("click", function (ev) {
      var t = ev.target;
      if (t === root) { hide(); return; }
      var act = t && t.getAttribute ? t.getAttribute("data-wp") : null;
      if (act === "cancel") hide();
      else if (act === "ok") {
        var v = value();
        var cb = onOk;
        hide();
        if (typeof cb === "function") { try { cb(v); } catch (e) { /* ignore */ } }
      }
    });
  }

  /* 造一列：count 项，显示 label(base + i) */
  function makeCol(key, base, count, label) {
    var el = document.createElement("div");
    el.className = "wp-col";
    el.setAttribute("data-k", key);

    var top = document.createElement("div");
    top.className = "wp-pad";
    top.style.height = (ITEM_H * PAD) + "px";
    el.appendChild(top);

    for (var i = 0; i < count; i++) {
      var it = document.createElement("div");
      it.className = "wp-item";
      it.textContent = label(base + i);
      it.style.height = ITEM_H + "px";
      it.style.lineHeight = ITEM_H + "px";
      it.setAttribute("data-i", String(i));
      el.appendChild(it);
    }

    var bot = document.createElement("div");
    bot.className = "wp-pad";
    bot.style.height = (ITEM_H * PAD) + "px";
    el.appendChild(bot);

    var c = { el: el, base: base, count: count, idx: 0, key: key, label: label };

    var timer = null;
    el.addEventListener("scroll", function () {
      var i = clampIdx(c, Math.round(el.scrollTop / ITEM_H));
      mark(c, i);
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; settle(c); }, SETTLE_MS);
    }, { passive: true });

    el.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var s = t.getAttribute("data-i");
      if (s == null) return;
      c.idx = clampIdx(c, Number(s));
      go(c, true);
    });

    return c;
  }

  function clampIdx(c, i) {
    if (!isFinite(i)) return 0;
    return Math.max(0, Math.min(c.count - 1, i));
  }

  function mark(c, i) {
    if (!c || !c.el) return;
    var kids = c.el.querySelectorAll(".wp-item");
    for (var k = 0; k < kids.length; k++) kids[k].classList.toggle("on", k === i);
  }

  function go(c, smooth) {
    if (!c || !c.el) return;
    var top = c.idx * ITEM_H;
    if (smooth && c.el.scrollTo) c.el.scrollTo({ top: top, behavior: "smooth" });
    else c.el.scrollTop = top;
    mark(c, c.idx);
  }

  function settle(c) {
    if (!c || !c.el) return;
    c.idx = clampIdx(c, Math.round(c.el.scrollTop / ITEM_H));
    if (Math.abs(c.el.scrollTop - c.idx * ITEM_H) > 1) c.el.scrollTop = c.idx * ITEM_H;
    mark(c, c.idx);
    /* 年或月变了 → 日的可选项要重算（闰年、大小月） */
    if (c.key === "y" || c.key === "m") rebuildDays();
  }

  function rebuildDays() {
    var c = cols && cols.d;
    if (!c) return;
    var y = cols.y ? cols.y.base + cols.y.idx : 2026;
    var m = cols.m ? cols.m.base + cols.m.idx : 10;
    var n = daysIn(y, m);
    if (n === c.count) { c.idx = clampIdx(c, c.idx); return; }
    var keep = clampIdx(c, Math.min(c.idx, n - 1));
    var el = c.el;
    /* 只换中间那些项，上下两块留白原样保留 */
    Array.prototype.slice.call(el.querySelectorAll(".wp-item")).forEach(function (nd) { nd.remove(); });
    var bot = el.querySelector(".wp-pad:last-of-type");
    for (var i = 0; i < n; i++) {
      var it = document.createElement("div");
      it.className = "wp-item";
      it.textContent = String(i + 1);
      it.style.height = ITEM_H + "px";
      it.style.lineHeight = ITEM_H + "px";
      it.setAttribute("data-i", String(i));
      el.insertBefore(it, bot);
    }
    c.count = n;
    c.idx = keep;
    go(c, false);
    mark(c, keep);
  }

  function value() {
    if (!cols) return "";
    var p = function (c, dflt) { return c ? pad2(c.base + c.idx) : pad2(dflt); };
    var y = cols.y ? String(cols.y.base + cols.y.idx) : "2026";
    var mo = cols.m ? String(cols.m.base + cols.m.idx) : "1";
    var da = cols.d ? String(cols.d.base + cols.d.idx) : "1";
    var date = y + "-" + pad2(Number(mo)) + "-" + pad2(Number(da));
    if (mode === "date") return date;
    var h = cols.h ? String(cols.h.base + cols.h.idx) : "0";
    var mi = cols.mi ? String(cols.mi.base + cols.mi.idx) : "0";
    return date + "T" + pad2(Number(h)) + ":" + pad2(Number(mi));
  }

  function parse(v) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2}))?/.exec(String(v || ""));
    if (!m) {
      var now = new Date();
      return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), mi: now.getMinutes() };
    }
    return {
      y: Number(m[1]), m: +m[2], d: +m[3],
      h: m[4] != null ? +m[4] : 12,
      mi: m[5] != null ? +m[5] : 0
    };
  }

  function open(opts) {
    var o = opts || {};
    mode = o.mode === "datetime" ? "datetime" : "date";
    onOk = o.onOk || null;
    build();

    var p = parse(o.value);
    var yFrom = Math.max(1900, p.y - 80);
    var yTo = p.y + 20;

    /* 清掉上一次的列（保留中间那条选中线） */
    Array.prototype.slice.call(box.querySelectorAll(".wp-col")).forEach(function (n) { n.remove(); });

    cols = {};
    cols.y = makeCol("y", yFrom, yTo - yFrom + 1, function (v) { return v + " 年"; });
    cols.m = makeCol("m", 1, 12, function (v) { return v + " 月"; });
    cols.d = makeCol("d", 1, daysIn(p.y, p.m), function (v) { return v + " 日"; });
    box.appendChild(cols.y.el);
    box.appendChild(cols.m.el);
    box.appendChild(cols.d.el);
    if (mode === "datetime") {
      cols.h = makeCol("h", 0, 24, function (v) { return pad2(v) + " 时"; });
      cols.mi = makeCol("mi", 0, 60, function (v) { return pad2(v) + " 分"; });
      box.appendChild(cols.h.el);
      box.appendChild(cols.mi.el);
    }

    cols.y.idx = p.y - yFrom;
    cols.m.idx = p.m - 1;
    cols.d.idx = Math.min(p.d - 1, cols.d.count - 1);
    if (cols.h) cols.h.idx = p.h;
    if (cols.mi) cols.mi.idx = p.mi;

    root.querySelector('[data-wp="title"]').textContent = mode === "datetime" ? "选择时间" : "选择日期";
    box.classList.toggle("wide", mode === "datetime");
    root.hidden = false;

    /* 隐藏状态下设 scrollTop 不生效，等一帧再定位 */
    requestAnimationFrame(function () {
      ["y", "m", "d", "h", "mi"].forEach(function (k) {
        if (!cols[k]) return;
        go(cols[k], false);
        mark(cols[k], cols[k].idx);
      });
    });
  }

  function hide() { if (root) root.hidden = true; }

  window.WheelPicker = { open: open, close: hide };
})();
