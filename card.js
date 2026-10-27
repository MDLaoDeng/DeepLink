/* Sekulum —— 卡牌渲染
   把带块级 HTML 的内容放进「影子根」里渲染：卡里的 CSS 出不去，也不会被页面的
   主题样式串味；从 innerHTML 插进去的 <script> 按规范不会执行。

   三条硬线（卡是别人做的文件，不能假设它规矩）：
   ① 事件属性一律删掉：<img onerror=...> 是脚本的另一种写法，图加载失败就执行；
   ② 远程资源一律不加载：<img src="https://...">、@import、url(http...) 会让手机
      向第三方服务器发请求，泄露 IP 和打开时间，也违反「数据只存本机」；
   ③ href 里的 javascript: 前缀拦掉：点一下等于执行代码。

   剩下的能力：排版、折叠栏（details/summary）、表格、字号颜色、本地图片。
*/
(function () {
  /* 只有这些块级标签才算「这是一张卡」；<b> / <br> / <p> 走普通 Markdown 就行 */
  var BLOCK_RE = /<(div|details|section|article|table|style|figure|aside|header|footer|center)\b/i;

  var ALLOW_TAGS = ("div span p br hr b strong i em u s del ins sub sup small mark code pre " +
    "blockquote ul ol li dl dt dd h1 h2 h3 h4 h5 h6 details summary table thead tbody tfoot " +
    "tr th td caption colgroup col figure figcaption img a section article aside header footer " +
    "center ruby rt rp font style").split(" ");

  /* open 是 details 的默认展开标记，卡里写了就该照办；不放行会被静默收起 */
  var GLOBAL_ATTR = ["class", "style", "title", "align", "width", "height", "color", "size", "face", "open"];

  function isHtml(text) {
    var s = String(text == null ? "" : text);
    return BLOCK_RE.test(s);
  }

  function textOf(html) {
    var d = document.createElement("div");
    d.innerHTML = html;
    return d.textContent || "";
  }

  /* 只放行本地资源：data / blob / 相对路径 / 锚点。http、https、// 一律拒 */
  function safeUrl(u) {
    var s = String(u == null ? "" : u).trim();
    if (!s) return "";
    if (/^javascript:/i.test(s)) return "";
    if (/^(blob:|#)/i.test(s)) return s;
    if (/^data:image\//i.test(s)) return s;
    if (/^(?:https?:)?\/\//i.test(s)) return "";
    if (/^[a-z]+:/i.test(s)) return "";
    return s;
  }

  /* style 属性里也藏得住远程请求和表达式，逐条筛 */
  function safeStyle(v) {
    var s = String(v || "");
    if (/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(s)) return "";
    s = s.replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, function (all, q, u) {
      return /^data:image\//i.test(u) ? all : "none";
    });
    if (/@import/i.test(s)) return "";
    return s;
  }

  function cleanCss(css) {
    var s = String(css || "");
    if (/@import/i.test(s)) s = s.replace(/@import[^;]+;/gi, "");
    /* url(...) 只留 data: */
    s = s.replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, function (all, q, u) {
      return /^data:image\//i.test(u) ? all : "none";
    });
    s = s.replace(/expression\s*\([^)]*\)/gi, "none");
    return s;
  }

  function sanitize(html) {
    var src = String(html == null ? "" : html);
    var doc;
    try { doc = new DOMParser().parseFromString(src, "text/html"); }
    catch (e) { return escapeText(src); }
    if (!doc || !doc.body) return escapeText(src);
    walk(doc.body);
    /* 以 <style> 开头的内容，解析器会把它放进 head —— 只取 body 会白白丢掉卡里的 CSS */
    var headCss = "";
    if (doc.head) {
      var hs = doc.head.querySelectorAll("style");
      for (var i = 0; i < hs.length; i++) headCss += "<style>" + (hs[i].textContent || "") + "</style>";
    }
    return headCss + doc.body.innerHTML;
  }

  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* 自底向上清理：先处理子节点，再处理自己，避免改动集合时漏项 */
  function walk(node) {
    var kids = [];
    for (var i = 0; i < node.childNodes.length; i++) kids.push(node.childNodes[i]);
    for (var k = 0; k < kids.length; k++) {
      var el = kids[k];
      if (el.nodeType === 1) {
        var tag = String(el.tagName || "").toLowerCase();
        if (tag === "script" || tag === "iframe" || tag === "object" || tag === "embed" ||
            tag === "link" || tag === "meta" || tag === "base" || tag === "form" ||
            tag === "input" || tag === "button" || tag === "textarea" || tag === "select") {
          if (el.parentNode) el.parentNode.removeChild(el);
          continue;
        }
        if (ALLOW_TAGS.indexOf(tag) < 0) {
          /* 不在白名单：拆掉外壳、把子节点原样搬上去（保留里面的格式）。
             直接换 textContent 会把 <custom><b>粗</b></custom> 压成纯文字。 */
          if (el.parentNode) {
            while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
            el.parentNode.removeChild(el);
          }
          continue;
        }
        walk(el);
        cleanAttrs(el, tag);
      } else if (el.nodeType === 8) {
        if (el.parentNode) el.parentNode.removeChild(el);   /* 注释没有意义，清掉 */
      }
    }
  }

  function cleanAttrs(el, tag) {
    var names = [];
    for (var i = 0; i < el.attributes.length; i++) names.push(el.attributes[i].name);
    for (var k = 0; k < names.length; k++) {
      var name = names[k];
      var low = name.toLowerCase();
      if (low.indexOf("on") === 0) { el.removeAttribute(name); continue; }   /* 硬线① */
      if (low === "srcdoc" || low === "formaction" || low === "xlink:href") { el.removeAttribute(name); continue; }
      if (low === "href" || low === "src") {
        var u = safeUrl(el.getAttribute(name));
        if (!u) el.removeAttribute(name); else el.setAttribute(name, u);
        continue;
      }
      if (low === "style") {
        var st = safeStyle(el.getAttribute(name));
        if (!st) el.removeAttribute(name); else el.setAttribute(name, st);
        continue;
      }
      if (low === "srcset" || low === "poster" || low === "background") { el.removeAttribute(name); continue; }
      if (GLOBAL_ATTR.indexOf(low) < 0) el.removeAttribute(name);
    }
    if (tag === "a") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    if (tag === "img") {
      el.setAttribute("loading", "lazy");
      el.removeAttribute("srcset");
    }
  }

  /* 影子根里的基础样式：字体和颜色从宿主继承，只补卡内需要的最小排版 */
  var BASE_CSS = [
    ":host{display:block;max-width:100%;}",
    ".dl-card{color:inherit;font:inherit;line-height:1.6;word-break:break-word;overflow-wrap:break-word;}",
    ".dl-card p{margin:.5em 0;}",
    ".dl-card img{max-width:100%;height:auto;border-radius:8px;display:block;margin:.4em 0;}",
    ".dl-card details{border:1px solid var(--border,rgba(127,127,127,.35));border-radius:8px;padding:6px 10px;margin:.5em 0;background:rgba(127,127,127,.06);}",
    ".dl-card summary{cursor:pointer;font-weight:600;outline:none;}",
    ".dl-card details[open]>summary{margin-bottom:4px;}",
    ".dl-card table{width:100%;border-collapse:collapse;margin:.5em 0;}",
    ".dl-card th,.dl-card td{border:1px solid var(--border,rgba(127,127,127,.35));padding:4px 8px;text-align:left;}",
    ".dl-card blockquote{margin:.5em 0;padding-left:10px;border-left:3px solid var(--border,rgba(127,127,127,.45));opacity:.9;}",
    ".dl-card pre{white-space:pre-wrap;word-break:break-word;background:rgba(127,127,127,.12);padding:8px;border-radius:8px;overflow:auto;}",
    ".dl-card code{font-family:ui-monospace,Consolas,monospace;font-size:.95em;}",
    ".dl-card ul,.dl-card ol{padding-left:1.3em;margin:.4em 0;}"
  ].join("\n");

  function render(html) {
    var host = document.createElement("div");
    host.className = "card-host";
    if (!host.attachShadow) {           /* 极老内核兜底：退回纯文字，绝不把原始 HTML 塞进页面 */
      host.textContent = textOf(String(html == null ? "" : html));
      return host;
    }
    var root = host.attachShadow({ mode: "open" });
    var safe = sanitize(html);
    /* 卡里的 <style> 要提到影子根顶层才生效（嵌在 div 里也能生效，但统一提到前面更好管） */
    var styleChunks = [];
    safe = safe.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, function (all, css) {
      styleChunks.push(cleanCss(css));
      return "";
    });
    var st = document.createElement("style");
    st.textContent = BASE_CSS + "\n" + styleChunks.join("\n");
    root.appendChild(st);
    var box = document.createElement("div");
    box.className = "dl-card";
    box.innerHTML = safe;
    root.appendChild(box);
    return host;
  }

  /* 判定这条内容该不该进影子根。分两级：
     ① msg.html === true —— 导入卡带来、或用户手动编辑成的富文本，无条件走卡片；
     ② 否则看内容：必须有【成对闭合】的块级标签，且没有把标签转义成实体。
        后者是为了放过「模型在讲解 HTML」这一类：它会把标签写成 &lt;div&gt;，
        或者只写开标签不闭合，按普通 Markdown 显示才对。 */
  function shouldUseCard(msg) {
    if (!msg || !msg.content) return false;
    if (msg.html) return true;
    var s = String(msg.content);
    if (/&lt;(div|details|table|style|section|figure)\b/i.test(s)) return false;
    return /<(div|details|table|figure|section)\b[^>]*>[\s\S]*<\/\1\s*>/i.test(s);
  }

  window.Card = { isHtml: isHtml, shouldUseCard: shouldUseCard, render: render, sanitize: sanitize, textOf: textOf };
})();
