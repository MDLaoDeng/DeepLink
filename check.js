#!/usr/bin/env node
/* check.js —— 交付前检查器
 *
 * 用法：
 *   node check.js          检查（重复 id / 关键元素丢了 / 新增元素没入快照）
 *   node check.js --gen    重建 ids.js 快照
 *
 * 为什么要有这个文件
 * ─────────────────
 * 1) 重复 id 这个 bug 从 6.2.1 活到现在：重复时 getElementById 只返回第一个，
 *    第二个元素永远拿不到值，表现是「某个开关点了没反应」——从界面上完全看不出原因。
 *    三行正则就能抓住，不该靠人眼。
 *
 * 2) app.js 里的 REQUIRED_IDS 是「启动时必须存在的元素」清单。以前是手写的一行
 *    629 项字符串：加个元素要手动往那行里塞名字，忘了就自检报缺；删了元素又要手动删，
 *    没人愿意维护。现在改成从 index.html 自动生成快照存进 ids.js，
 *    自检读快照 —— 人工不再维护那行。
 *
 * 退出码：0 = 通过，1 = 有问题（可以直接挂在交付流程里，失败就停）
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const HTML = path.join(ROOT, "index.html");
const SNAPSHOT = path.join(ROOT, "ids.js");

function readHtmlIds() {
  const html = fs.readFileSync(HTML, "utf8");
  const ids = [];
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.push(m[1]);
  return ids;
}

function readSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) return [];
  const src = fs.readFileSync(SNAPSHOT, "utf8");
  const m = /var L = (\[[\s\S]*?\]);/.exec(src);
  if (!m) return [];
  try { return JSON.parse(m[1]); } catch (e) { return []; }
}

function gen(ids) {
  const uniq = Array.from(new Set(ids)).sort();
  const lines = [];
  for (let i = 0; i < uniq.length; i += 8) {
    lines.push("  " + uniq.slice(i, i + 8).map((x) => JSON.stringify(x)).join(", "));
  }
  const out =
    "/* 自动生成，不要手改 —— 改 index.html 后跑 `node check.js --gen`。\n" +
    " *\n" +
    " * 这份清单是「启动时必须存在的元素」的快照（共 " + uniq.length + " 项）。\n" +
    " * app.js 的 REQUIRED_IDS 优先读它，读不到才退回旧的硬编码列表。\n" +
    " * 它只记录 index.html 里的静态 id；由 JS 动态创建的元素（#profileLayer、#cf_world 这类）\n" +
    " * 本来就不该出现在这里。 */\n" +
    "(function () {\n" +
    "  var L = [\n" + lines.join(",\n") + "\n  ];\n" +
    "  if (typeof window !== \"undefined\") window.DL_REQUIRED_IDS = L;\n" +
    "  if (typeof module !== \"undefined\") module.exports = { DL_REQUIRED_IDS: L };\n" +
    "})();\n";
  fs.writeFileSync(SNAPSHOT, out, "utf8");
  return uniq.length;
}

function main() {
  const ids = readHtmlIds();
  const argv = process.argv.slice(2);

  if (argv.indexOf("--gen") >= 0) {
    const n = gen(ids);
    console.log("ids.js 已生成：" + n + " 项");
    return 0;
  }

  let bad = 0;

  /* ① 重复 id */
  const seen = new Map();
  ids.forEach((id, i) => {
    if (seen.has(id)) {
      console.error("  [重复 id] \"" + id + "\"：第 " + (seen.get(id) + 1) + " 个与第 " + (i + 1) + " 个");
      bad++;
    } else seen.set(id, i);
  });

  /* ② 快照对比 */
  const snap = readSnapshot();
  const now = new Set(ids);
  const before = new Set(snap);

  if (!snap.length) {
    console.warn("  [提示] 还没有 ids.js，跑 `node check.js --gen` 生成一份");
  } else {
    /* 丢元素 = 真问题：某个界面元素被误删，代码里那处取值会变成 null */
    const lost = snap.filter((x) => !now.has(x));
    if (lost.length) {
      console.error("  [元素丢了] 快照里有、index.html 里没有（" + lost.length + " 个）：");
      lost.slice(0, 20).forEach((x) => console.error("      " + x));
      if (lost.length > 20) console.error("      …还有 " + (lost.length - 20) + " 个");
      bad += lost.length;
    }
    /* 新增 = 提醒，不算错：新加的元素本来就该重新生成快照 */
    const added = ids.filter((x) => !before.has(x));
    if (added.length) {
      console.warn("  [新增元素] " + added.length + " 个不在快照里，跑 `node check.js --gen` 更新：");
      added.slice(0, 10).forEach((x) => console.warn("      " + x));
    }
  }

  if (bad) {
    console.error("检查未通过：" + bad + " 个问题");
    return 1;
  }
  console.log("检查通过：id 总数 " + ids.length + "，无重复，快照一致");
  return 0;
}

process.exit(main());
