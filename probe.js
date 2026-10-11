/* 探针文件：只为验证一件事 —— 「封装工具会不会把 index.html 引用的新增 js 一起打包」。
   它不依赖任何其它文件、也不做任何事，只是往 window.__dlScripts 里登记自己。
   app.js 的「连接自检」会把结果显示成「附加脚本：已加载 probe.js / 未加载」。

   结论怎么用：
   - 显示「已加载」→ 工具会带上新增文件 → 之后可以放心把 app.js 按域拆开。
   - 显示「未加载」→ 工具只认原来那几个文件名 → 那就不能新增文件，只拆到已有文件里。
   - 无论哪种结果，App 功能都不受影响（探针本身不带功能）。 */
(function () {
  try {
    window.__dlScripts = window.__dlScripts || [];
    window.__dlScripts.push("probe.js");
  } catch (e) { /* ignore */ }
})();
