/* settings.js —— 数据导入导出 / 自动备份 / 用量统计 / 重置 / 设置表单 / 自检 / 首次引导
 * 从 app.js 拆出（见 HANDOFF.md 4.9 拆分计划）。
 *
 * 为什么这么写：
 *  - 本文件在 index.html 里排在 app.js 之后 —— 执行时 window.DL 一定已存在。
 *  - 搬运时【没有改函数体】，只在下面把 DL 里的同名成员解构成局部变量，
 *    所以搬过来的代码与在 app.js 里逐字一致。
 *  - 末尾自注册并登记 window.__dlScripts（连接自检的「附加脚本」会显示）。
 *
 * 本文件不新增依赖、不改行为、不动版号。
 */
(function () {
  /* 打包工具不一定按 index.html 的顺序执行脚本：app.js 可能晚于本文件。
     那时 window.DL 还不存在 —— 等它就绪后再初始化一次。返回 false = 还没就绪。 */
  function boot() {
  var D = window.DL;
  if (!D) return false;

  /* 共享件解构（名字与 app.js 内保持一致，保证搬来的代码不用改一个字） */
  var $ = D.$, $v = D.$v, state = D.state, setText = D.setText;
  var setVal = D.setVal, setHidden = D.setHidden, setDisabled = D.setDisabled, setDisplay = D.setDisplay;
  var setChecked = D.setChecked, checkedOf = D.checkedOf, session = D.session, renderAll = D.renderAll;
  var activeCharacter = D.activeCharacter, audioState = D.audioState, avatarDraft = D.avatarDraft, renderAvatarPreview = D.renderAvatarPreview;
  var jsonDataUrl = D.jsonDataUrl, exportFileName = D.exportFileName, missingIds = D.missingIds;
  var applyNoImage = D.applyNoImage;   /* 无图模式开关：设置变更后要同步 body 类，见 syncToggles */

  /* 与 store.js 的 MEM_EXTRA 同一组：记忆之外、同样被加密的会话字段。
     快照/恢复必须对它们对称处理，否则恢复备份会把这三项清空（见 restoreBackupNow）。 */
  var MEM_EXTRA_FIELDS = ["scene", "relation", "shared"];

  /* ⚠️ 下面这些【不在加载时快照】：它们是「模块」或「别的子模块提供的入口」。
     打包工具不一定按 index.html 的顺序执行脚本；若相关文件排在本文件之后执行，
     快照会把它永久钉死在 undefined，而且【不报错】（真机踩过：发消息报
     Cannot read property 'run' of undefined）。改成进公开入口时重取一次。 */
  var UI, Store, Api, Memory, Media, Search, CONFIG, fillSessionForm, saveChar, fillCharacterForm, renderSettingsMemory, syncPlaceholder;
  function syncModules() {
    UI = D.UI || window.UI;
    Store = D.Store || window.Store;
    Api = D.Api || window.Api;
    Memory = D.Memory || window.Memory;
    Media = D.Media || window.Media;
    Search = D.Search || window.Search;
    CONFIG = D.CONFIG || window.CONFIG;
    fillSessionForm = D.fillSessionForm || window.fillSessionForm;
    saveChar = D.saveChar || window.saveChar;
    fillCharacterForm = D.fillCharacterForm || window.fillCharacterForm;
    renderSettingsMemory = D.renderSettingsMemory || window.renderSettingsMemory;
    syncPlaceholder = D.syncPlaceholder || window.syncPlaceholder;
  }
  syncModules();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncModules);
  else setTimeout(syncModules, 0);

  /* ── 首次引导 ──────────────────────────────────── */
  let introIdx = 0;

  function introShow(i) {
    const pages = document.querySelectorAll("#introModal .intro-page");
    if (!pages.length) return;
    introIdx = Math.max(0, Math.min(i, pages.length - 1));
    for (let k = 0; k < pages.length; k++) pages[k].hidden = (k !== introIdx);
    setDisabled("#introPrev", introIdx === 0);
    setText("#introNext", introIdx === pages.length - 1 ? "开始使用" : "下一步");
    const dots = $("#introDots");
    if (dots) {
      dots.innerHTML = "";
      for (let k = 0; k < pages.length; k++) {
        const d = document.createElement("span");
        d.className = "intro-dot" + (k === introIdx ? " on" : "");
        dots.appendChild(d);
      }
    }
  }

  function openIntro() {
    setText("#introTree", CONFIG.FEATURE_TREE || "");
    introShow(0);
    UI.openModal("introModal");
  }

  /* app.js 的「上一步」按钮原来是 `introShow(introIdx - 1)` —— introIdx 是数值、不能挂到 D 上
     （挂上去就是快照，永远停在 0），所以包一个 introPrev 给外面用。 */
  function introPrev() { introShow(introIdx - 1); }

  function introFinish() {
    state.settings = Store.saveSettings({ onboarded: true });
    UI.closeModal("introModal");
  }

  function introNext() {
    const n = document.querySelectorAll("#introModal .intro-page").length;
    if (introIdx >= n - 1) introFinish(); else introShow(introIdx + 1);
  }

  /* ── 数据导入导出 + 自动备份 ───────────────────── */
  const KEY_FIELDS = ["apiKey", "tavilyKey", "customSearchKey", "asrKey", "ttsKey", "imgKey", "visionKey"];

  function fmtTime(ts) {
    try {
      const d = new Date(ts);
      const p = (n) => (n < 10 ? "0" : "") + n;
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch (e) { return ""; }
  }

  function stripKeys(s) {
    const o = Object.assign({}, s || {});
    KEY_FIELDS.forEach((k) => { o[k] = ""; });
    /* 各模型区的配置库里也藏着密钥，得一并抹掉，否则「不含密钥导出」会漏 */
    if (o.modelSets && typeof o.modelSets === "object") {
      const sets = {};
      Object.keys(o.modelSets).forEach((kind) => {
        const list = o.modelSets[kind];
        sets[kind] = Array.isArray(list)
          ? list.map((p) => Object.assign({}, p, { apiKey: "" }))
          : list;
      });
      o.modelSets = sets;
    }
    return o;
  }

  function buildExportData(scope, withKeys) {
    if (scope === "full") {
      return { settings: withKeys ? Store.getSettings() : stripKeys(Store.getSettings()), characters: Store.getCharacters(), sessions: sessionsForExport() };
    }
    if (scope === "settings") return withKeys ? Store.getSettings() : stripKeys(Store.getSettings());
    if (scope === "characters") return Store.getCharacters();
    if (scope === "character") return Store.getCharacters().find((c) => c.id === $v("#exportCharSel")) || null;
    if (scope === "session") return sessionsForExport().find((s) => s.id === $v("#exportSessionSel")) || null;
    return null;
  }

  /* 导出：先让用户设口令，整个 payload 用这个口令加密（口令不存进 App） */
  /* 导出要能「换机带得走」：本机图片已经落到文件里（imgRef），导出必须重新内联成 dataUrl，
     否则换台手机后那些引用全指不到东西、图片全变「已过期」。
     勾了「不含原图」就把图片整个丢掉（只留 name/kind/desc），文件更小、更适合分享。
     注意：sessionsForExport 给的是【浅拷贝】（messages 与实时数据同一份），
     所以这里必须再复制一层附件，绝不能就地改 —— 否则会把正在用的数据改坏。 */
  function inlineExportImages(list, drop) {
    (list || []).forEach((s) => {
      if (!s) return;
      s.messages = (s.messages || []).map((m) => {
        if (!m || !m.attachments || !m.attachments.length) return m;
        const c = Object.assign({}, m);
        c.attachments = m.attachments.map((a) => {
          if (!a || a.kind !== "image") return a;
          const b = Object.assign({}, a);
          if (drop) { delete b.imgRef; delete b.dataUrl; return b; }
          /* 只要带了本机引用，就一律换成内联数据；解不出来就只剩描述
             （导入后显示「已过期」）。绝不能让本机路径进导出文件 —— 换了机器必然指不到。 */
          if (b.imgRef) {
            if (!b.dataUrl) { const u = Store.imageURL(a); if (u) b.dataUrl = u; }
            delete b.imgRef;
          }
          return b;
        });
        return c;
      });
    });
    return list;
  }

  async function payloadJson() {
    const kind = $v("#exportScope");
    const data = buildExportData(kind, checkedOf("#exportKeys"));
    if (data == null) { UI.toast("没有可导出的内容", true); return null; }
    const noImg = checkedOf("#exportNoImg");
    if (kind === "full") inlineExportImages(data.sessions, noImg);
    else if (kind === "session") inlineExportImages([data], noImg);
    const pass = await askPass("给导出文件设个口令", "导出的内容会用这个口令加密，口令不会存进 App；以后导入时要输同一个。忘了就永久解不开。", true);
    if (pass === null) return null;
    let enc;
    try { enc = await Store.sealWithPass(JSON.stringify(data), pass); }
    catch (e) { UI.toast("加密失败：" + (e.message || e), true); return null; }
    return { app: "DeepLink", kind: kind, appVersion: CONFIG.APP_VERSION, exportedAt: new Date().toISOString(), enc: enc };
  }

  async function doExportDownload() {
    const p = await payloadJson();
    if (!p) return;
    const json = JSON.stringify(p, null, 2);
    const name = exportFileName(p.kind);
    /* 优先走原生：保存到 Download 目录（封装 WebView 里 <a download> 不一定生效） */
    if (Store.hasBridge("保存下载文件")) {
      /* 先过存储权限：没有就弹一次系统申请（这是本项目里唯一需要主动申请的系统权限；
         拒绝也如实说明，并指一条不需要权限的路 —— 「分享文件」走的是外部文件目录）。 */
      const granted = Store.ensureStorageAsync ? await Store.ensureStorageAsync() : true;
      if (!granted) {
        UI.toast("没有存储权限，保存不到 Download。可以直接用「分享文件」—— 那条路不需要权限", true);
        return;
      }
      const dir = String(Store.callBridge("获取外部存储目录") || "").replace(/\/+$/, "");
      const path = dir ? dir + "/Download/" + name : "";
      const ret = Store.callBridge("保存下载文件", name, jsonDataUrl(json));
      /* 有的原生实现返回 void，所以拿路径再确认一次；确认不了就当成功 */
      let ok2 = ret !== false;
      if (ok2 && path && Store.hasBridge("判断指定文件")) {
        if (Store.callBridge("判断指定文件", path) === false) ok2 = false;
      }
      if (!ok2) {
        UI.toast("保存到 Download 失败（多半是没存储权限）——可直接用「分享文件」或复制 JSON", true);
        return;
      }
      UI.toast("已保存到 Download：" + name);
      return;
    }
    if (json.length > 1500000) UI.toast("内容较大（约 " + Math.round(json.length / 1024) + " KB），下载/复制可能较慢");
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 4000);
      UI.toast("已尝试下载（若没反应请用「复制 JSON」）");
    } catch (e) {
      UI.toast("下载失败，请用「复制 JSON」", true);
    }
  }

  /* 分享落盘目录，按「最可能被系统分享认账」排序，并分成两组：
      无需权限组（先试，不该为分享去打扰用户）：
        1) 获取外部文件目录 → /storage/emulated/0/Android/data/包名/files
           —— 既是外部路径、又不需要存储权限（jointapi 明确写了「操作无需存储权限」），首选
        2) 获取内部文件目录 → /data/data/包名/files
      需要存储权限组（只有上面全写不进去时才动，且会先申请权限）：
        3) 获取外部存储目录 + /Download */
  function shareDirCandidates() {
    const safe = [];
    const perm = [];
    const add = (arr, v) => { const d = String(v || "").replace(/\/+$/, ""); if (d && arr.indexOf(d) < 0) arr.push(d); };
    if (Store.hasBridge("获取外部文件目录")) add(safe, Store.callBridge("获取外部文件目录"));
    if (Store.hasBridge("获取内部文件目录")) add(safe, Store.callBridge("获取内部文件目录"));
    if (Store.hasBridge("获取外部存储目录")) {
      const e = String(Store.callBridge("获取外部存储目录") || "").replace(/\/+$/, "");
      if (e) add(perm, e + "/Download");
    }
    return { safe: safe, perm: perm };
  }

  /* 往一组候选目录里逐个试写，成功返回路径，全失败返回 ""（并回填原因） */
  let lastWriteErr = "";
  function writeExportTo(dirs, name, json) {
    for (let i = 0; i < dirs.length; i++) {
      const cand = dirs[i] + "/" + name;
      try {
        const w = Store.callBridge("保存指定文件", cand, jsonDataUrl(json));
        if (w === false) { lastWriteErr = "写入被拒：" + cand; continue; }
        if (Store.hasBridge("判断指定文件") && Store.callBridge("判断指定文件", cand) === false) {
          lastWriteErr = "写入后找不到文件：" + cand;
          continue;
        }
        return cand;
      } catch (e) { lastWriteErr = "写入失败：" + (e.message || e); }
    }
    return "";
  }

  /* 存到 App 目录再调系统分享（发给微信/文件管理器都行） */
  async function doExportShare() {
    const p = await payloadJson();
    if (!p) return;
    if (!Store.hasBridge("保存指定文件") || !Store.hasBridge("分享指定文件")) {
      UI.toast("当前环境不支持分享，请用「保存到 Download」或复制 JSON", true);
      return;
    }
    const groups = shareDirCandidates();
    if (!groups.safe.length && !groups.perm.length) {
      UI.toast("拿不到可写的目录，分享不可用（可改用「保存到 Download」或复制 JSON）", true);
      return;
    }
    const json = JSON.stringify(p, null, 2);
    const name = exportFileName(p.kind);
    /* 先走无需权限的目录；都不行才申请存储权限去试 Download 兜底 */
    let path = writeExportTo(groups.safe, name, json);
    if (!path && groups.perm.length) {
      const granted = Store.ensureStorageAsync ? await Store.ensureStorageAsync() : true;
      if (granted) path = writeExportTo(groups.perm, name, json);
    }
    if (!path) { UI.toast("导出失败：" + (lastWriteErr || "没有可用的目录"), true); return; }
    let sh;
    try { sh = Store.callBridge("分享指定文件", path); }
    catch (e) { UI.toast("调起分享失败：" + (e.message || e) + "（文件已写到 " + path + "）", true); return; }
    if (sh === false) { UI.toast("系统拒绝了分享请求（文件已写到 " + path + "）", true); return; }
    UI.toast("已生成导出文件并调起分享");
  }

  async function doExportCopy() {
    const p = await payloadJson();
    if (!p) return;
    let json;
    try { json = JSON.stringify(p); } catch (e) { UI.toast("序列化失败", true); return; }
    UI.copyText(json).then((ok) => UI.toast(ok ? "已复制（已用你的口令加密）" : "复制失败，可改用下载", !ok));
  }

  async function importCharacters(arr) {
    const valid = (arr || []).filter((c) => c && c.id && typeof c === "object");
    if (!valid.length) { UI.toast("没有有效的角色数据", true); return false; }
    const list = Store.getCharacters();
    const collide = valid.filter((c) => list.some((x) => x.id === c.id));
    if (collide.length) {
      const ok = await UI.confirmDialog("导入角色", collide.length + " 个角色与现有同 ID，将覆盖现有的，确定？");
      if (!ok) return false;
    }
    valid.forEach((c) => { const i = list.findIndex((x) => x.id === c.id); if (i >= 0) list[i] = c; else list.push(c); });
    Store.saveCharacters(list);
    return true;
  }

  async function importSessions(arr) {
    const valid = (arr || []).filter((s) => s && s.id && Array.isArray(s.messages));
    if (!valid.length) { UI.toast("没有有效的会话数据", true); return false; }
    for (let k = 0; k < valid.length; k++) {
      const s = valid[k];
      if (s.memEnc && s.memory === undefined && s.cognition === undefined) {
        const txt = await Store.decryptMem(s.memEnc);
        if (txt) { try { const p = JSON.parse(txt); s.memory = p.memory; s.cognition = p.cognition; } catch (e) { /* ignore */ } }
      }
    }
    const list = Store.getSessions();
    const collide = valid.filter((s) => list.some((x) => x.id === s.id));
    if (collide.length) {
      const ok = await UI.confirmDialog("导入会话", collide.length + " 个会话与现有同 ID，将覆盖现有的，确定？");
      if (!ok) return false;
    }
    valid.forEach((s) => { const i = list.findIndex((x) => x.id === s.id); if (i >= 0) list[i] = s; else list.unshift(s); });
    Store.saveSessions(list);
    return true;
  }

  async function applyImport(payload) {
    if (!payload || typeof payload !== "object" || payload.app !== "DeepLink" && payload.app !== "deeplink") { UI.toast("不是 DeepLink 的导出数据", true); return false; }
    const kind = payload.kind;
    let data = payload.data;
    if (payload.enc) {
      const pass = await askPass("输入导出时的口令", "这份文件是用口令加密的，输对当时设的口令才能导入。", false);
      if (pass === null) return false;
      const txt = await Store.openWithPass(payload.enc, pass);
      if (txt == null) { UI.toast("口令不对，或文件损坏", true); return false; }
      try { data = JSON.parse(txt); } catch (e) { UI.toast("解开的内容无效", true); return false; }
    }
    if (kind === "settings") {
      if (!data || typeof data !== "object") { UI.toast("数据为空", true); return false; }
      state.settings = Store.saveSettings(data);
      return true;
    }
    if (kind === "character") return importCharacters([data]);
    if (kind === "characters") return importCharacters(data);
    if (kind === "session") return importSessions([data]);
    if (kind === "full") {
      if (data && data.settings) state.settings = Store.saveSettings(data.settings);
      if (data && Array.isArray(data.characters)) await importCharacters(data.characters);
      if (data && Array.isArray(data.sessions)) await importSessions(data.sessions);
      return true;
    }
    UI.toast("无法识别的导出类型：" + kind, true);
    return false;
  }

  async function importFromText() {
    const txt = $v("#importText").trim();
    if (!txt) { UI.toast("先粘贴 JSON 或选文件", true); return; }
    let payload;
    try { payload = JSON.parse(txt); } catch (e) { UI.toast("JSON 解析失败：" + (e.message || e), true); return; }
    if (await applyImport(payload)) { migrateData(true); UI.toast("导入完成"); syncToggles(); renderAll(); renderDataSelects(); }
  }

  async function importFromFile(file) {
    try {
      const txt = await file.text();
      let payload;
      try { payload = JSON.parse(txt); } catch (e) { UI.toast("文件不是有效 JSON", true); return; }
      if (await applyImport(payload)) { migrateData(true); UI.toast("导入完成"); syncToggles(); renderAll(); renderDataSelects(); }
    } catch (e) { UI.toast("读取文件失败：" + (e.message || e), true); }
  }

  function renderDataSelects() {
    const cs = $("#exportCharSel");
    if (cs) {
      const chs = Store.getCharacters();
      cs.innerHTML = chs.length ? chs.map((c) => '<option value="' + UI.escapeHtml(c.id) + '">' + UI.escapeHtml(c.name || "角色") + "</option>").join("") : '<option value="">（无角色）</option>';
    }
    const ss = $("#exportSessionSel");
    if (ss) {
      const ses = Store.getSessions();
      ss.innerHTML = ses.length ? ses.map((s) => '<option value="' + UI.escapeHtml(s.id) + '">' + UI.escapeHtml(s.title || "未命名") + "</option>").join("") : '<option value="">（无会话）</option>';
    }
    syncExportScope();
  }

  function syncExportScope() {
    const v = $v("#exportScope");
    /* 注意：这两个 wrap 带 hidden 属性，必须用 hidden 切换（setDisplay 会被 [hidden]{display:none!important} 盖掉）*/
    setHidden("#exportCharWrap", v !== "character");
    setHidden("#exportSessionWrap", v !== "session");
    if (UI.pickRefreshAll) UI.pickRefreshAll();
  }

  /* 保存图片（AI 文生图 / 自己发的图都走这里） */
  function saveImage(src, name) {
    if (!src) { UI.toast("没有可保存的图片", true); return; }
    try {
      const a = document.createElement("a");
      a.href = src;
      a.download = name || ("DeepLink_" + Date.now() + ".jpg");
      document.body.appendChild(a);
      a.click();
      a.remove();
      UI.toast("已尝试保存（若无反应，可长按图片用系统保存）");
    } catch (e) { UI.toast("保存失败", true); }
  }

  /* 本机数据占用（localStorage 有容量天花板；接了原生存储就没这个限制） */
  function renderDataUsage() {
    const el = $("#dataUsageLine");
    if (!el) return;
    let chars = 0, keys = 0;
    const native = Store.storageBackend() === "native";
    try {
      if (native) {
        Store.storageKeys().forEach((k) => {
          const v = Store.callBridge("获取指定文本", k, "");
          if (v) { chars += String(k).length + String(v).length; keys++; }
        });
      } else {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          chars += String(k).length + String(localStorage.getItem(k) || "").length;
          keys++;
        }
      }
    } catch (e) { /* ignore */ }
    const bytes = chars * 2;   /* 按 UTF-16 估算，1 字符≈2 字节 */
    const txt = bytes < 1048576 ? Math.round(bytes / 1024) + " KB" : (bytes / 1048576).toFixed(2) + " MB";
    el.textContent = "本机数据约 " + txt + "（" + keys + " 项，存于" + (native ? "App 原生存储" : "浏览器 localStorage") + "）。" + (native ? "" : "浏览器上限通常 5 MB 左右，接近了就导出或清理。");
  }

  function openData() {
    renderDataSelects();
    setVal("#importText", "");
    UI.openModal("dataModal");
  }

  /* 快照：剥掉附件 dataUrl（省空间），保留名称/类型 */
  function stripAttach(msgs) {
    return (msgs || []).map((m) => {
      if (!m.attachments || !m.attachments.length) return m;
      const c = Object.assign({}, m);
      c.attachments = m.attachments.map((a) => ({ name: a.name, kind: a.kind, mime: a.mime, size: a.size, desc: a.desc }));
      return c;
    });
  }

  function askPass(title, note, needConfirm) {
    return new Promise((resolve) => {
      setText("#passTitle", title || "口令");
      setText("#passNote", note || "");
      setDisplay("#passConfirmWrap", needConfirm ? "" : "none");
      setVal("#passInput", "");
      setVal("#passConfirm", "");
      const ok = $("#passOk"), cancel = $("#passCancel");
      if (!ok || !cancel) { resolve(null); return; }
      function cleanup(result) {
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        UI.closeModal("passModal");
        resolve(result);
      }
      function onOk() {
        const v = $v("#passInput");
        if (!v) { UI.toast("请先输入口令", true); return; }
        if (needConfirm && v !== $v("#passConfirm")) { UI.toast("两次输入不一致", true); return; }
        cleanup(v);
      }
      function onCancel() { cleanup(null); }
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      UI.openModal("passModal");
      setTimeout(() => { const el = $("#passInput"); if (el) el.focus(); }, 80);
    });
  }

  function snapshotSession(s) {
    let sess;
    try { sess = JSON.parse(JSON.stringify(s)); } catch (e) { sess = Object.assign({}, s); }
    sess.messages = stripAttach(s.messages);
    /* 落地只留密文（memEnc）。裁剪规则跟会话落盘【共用】store.js 的 strippedCopy ——
       记忆之外的场景/关系/经历也是明文，必须一起清；解不开（没密文）时原样留着更安全。 */
    sess = Store.strippedCopy(sess);
    return { at: Date.now(), sess: sess };
  }

  /* 导出用：记忆换成密文，不带明文 */
  /* 导出用的会话快照。
     记忆【明着带走】：新版密文的外层是「设备密钥」（见 store.js 记忆加密段），
     换台手机必然解不开 —— 老版这里塞的是 memEnc，换机导入后记忆全成空。
     而导出文件本身已经被用户口令加密（dlp1）了，明文放在里面不会更弱，换了机才带得走。
     万一这条记忆在本机都没解开（memory 为空），那就保留 memEnc 原样带走，导入端再试一次。 */
  function sessionsForExport() {
    return Store.getSessions().map((s) => {
      const o = Object.assign({}, s);
      if (o.memory === undefined && o.cognition === undefined) return o;
      delete o.memEnc;
      return o;
    });
  }

  function saveSnapshot(s, snap) {
    const all = Store.getBackups();
    const arr = Array.isArray(all[s.id]) ? all[s.id] : [];
    arr.unshift(snap);
    all[s.id] = arr.slice(0, 2);
    return Store.saveBackups(all);
  }

  function maybeAutoBackup(s, reason) {
    try {
      if (!s || !s.autoBackup) return;
      const arr = Store.getBackups()[s.id] || [];
      const last = arr[0] ? (arr[0].at || 0) : 0;
      const gap = reason === "load" ? 24 * 3600 * 1000 : 3600 * 1000;
      if (Date.now() - last < gap) return;
      saveSnapshot(s, snapshotSession(s));
      if (state.settings.notifyTasks) UI.toast("已自动备份对话「" + (s.title || "") + "」");
    } catch (e) { /* 超限就跳过 */ }
  }

  function backupNow() {
    const s = session();
    if (!s) { UI.toast("先打开一个对话", true); return; }
    try { saveSnapshot(s, snapshotSession(s)); renderBackupLine(s); UI.toast("已备份"); }
    catch (e) { UI.toast("备份失败（存储可能已满）", true); }
  }

  async function restoreBackupNow() {
    const s = session();
    if (!s) { UI.toast("先打开一个对话", true); return; }
    const arr = Store.getBackups()[s.id] || [];
    if (!arr.length) { UI.toast("该对话还没有备份", true); return; }
    const snap = arr[0];
    const ok = await UI.confirmDialog("恢复备份", "将用备份（" + fmtTime(snap.at) + "）覆盖对话「" + ((snap.sess && snap.sess.title) || s.title || "") + "」的全部消息，确定？");
    if (!ok) return;
    const restored = Object.assign({}, snap.sess);
    /* 快照落盘时经 Store.strippedCopy 把「记忆 + 场景/关系/经历」一起清成空、只留密文(memEnc)。
       恢复必须【对称】地把它们全部解回来 —— 少解一项，紧跟的 saveSessions 就会把它按空写回，
       表现为「恢复备份后 当前场景/当前关系/共同经历 被静默清空」。 */
    if (restored.memEnc) {
      const txt = await Store.decryptMem(restored.memEnc);
      if (txt) {
        try {
          const p = JSON.parse(txt);
          restored.memory = p.memory;
          restored.cognition = p.cognition;
          MEM_EXTRA_FIELDS.forEach((k) => { if (p[k] !== undefined) restored[k] = p[k]; });
        } catch (e) { /* ignore */ }
      }
    }
    if (restored.memory === undefined && restored.cognition === undefined) { restored.memory = s.memory; restored.cognition = s.cognition; }
    /* 解不出来的那几项（比如本机都解不开的密文）退回当前值，绝不写空。 */
    MEM_EXTRA_FIELDS.forEach((k) => { if (restored[k] === undefined) restored[k] = s[k]; });
    const list = Store.getSessions();
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list[i] = restored; else list.push(restored);
    Store.saveSessions(list);
    fillSessionForm(session());
    renderAll();
    UI.toast("已从备份恢复");
  }

  function renderBackupLine(s) {
    const el = $("#sessionBackupLine");
    if (!el) return;
    if (!s) { el.textContent = ""; return; }
    const arr = Store.getBackups()[s.id] || [];
    el.textContent = "自动备份：" + (s.autoBackup ? "已开启" : "未开启") + (arr.length ? ("；最近备份 " + fmtTime(arr[0].at) + "（共 " + arr.length + " 份）") : "；尚无备份");
  }

  /* ── 用量统计 ──────────────────────────────────── */
  function fmtNum(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }

  function cacheRate(u) { return u && u.prompt ? Math.round((u.cacheHit || 0) / u.prompt * 100) : 0; }

  function usageText(u) {
    u = u || {};
    return "输入 " + fmtNum(u.prompt) + " · 输出 " + fmtNum(u.completion) + " · 总计 " + fmtNum(u.total) + " · 缓存命中 " + cacheRate(u) + "%";
  }

  function usageCells(u) {
    u = u || {};
    return "<span class='u-cell'>输入 " + fmtNum(u.prompt) + "</span>" +
      "<span class='u-cell'>输出 " + fmtNum(u.completion) + "</span>" +
      "<span class='u-cell'>总计 " + fmtNum(u.total) + "</span>" +
      "<span class='u-cell'>缓存命中 " + cacheRate(u) + "%</span>";
  }

  function renderCharUsage(ch) {
    const el = $("#charUsageLine");
    if (el) el.textContent = ch ? ("本角色累计：" + usageText(ch.usage)) : "";
  }

  /* 记一次用量：会话 / 角色 / 全局，并做预警 */
  function recordUsage(sid, u, characterId) {
    if (!u) return;
    if (sid) {
      const list = Store.getSessions();
      const i = list.findIndex((x) => x.id === sid);
      if (i >= 0) { list[i].usage = Api.sumUsage(list[i].usage, u); Store.saveSessions(list); }
    }
    if (characterId) {
      const cs = Store.getCharacters();
      const j = cs.findIndex((c) => c.id === characterId);
      if (j >= 0) { cs[j].usage = Api.sumUsage(cs[j].usage, u); cs[j].updatedAt = Date.now(); Store.saveCharacters(cs); }
    }
    Store.saveUsage(Api.sumUsage(Store.getUsage(), u));
    if (u.prompt > (state.settings.tokenWarnThreshold || 30000)) {
      UI.toast("上下文已达 " + u.prompt + " tokens，花费可能偏高；可用「当前设定」里的「再压缩」提纯", true);
    }
  }

  function renderUsageStats() {
    const gEl = $("#usageGlobal");
    if (gEl) gEl.innerHTML = "<div class='usage-row'><span class='u-name'>合计</span>" + usageCells(Store.getUsage()) + "</div>";
    const sEl = $("#usageSessions");
    if (sEl) {
      sEl.innerHTML = "";
      const rows = Store.getSessions().filter((s) => s.usage);
      if (!rows.length) sEl.innerHTML = "<div class='usage-empty'>暂无会话用量</div>";
      rows.forEach((s) => {
        const d = document.createElement("div");
        d.className = "usage-row";
        d.innerHTML = "<span class='u-name'>" + UI.escapeHtml(s.title || "未命名") + "</span>" + usageCells(s.usage);
        sEl.appendChild(d);
      });
    }
    const cEl = $("#usageChars");
    if (cEl) {
      cEl.innerHTML = "";
      const rows = Store.getCharacters().filter((c) => c.usage);
      if (!rows.length) cEl.innerHTML = "<div class='usage-empty'>暂无角色用量</div>";
      rows.forEach((c) => {
        const d = document.createElement("div");
        d.className = "usage-row";
        d.innerHTML = "<span class='u-name'>" + UI.escapeHtml(c.name || "角色") + "</span>" + usageCells(c.usage);
        cEl.appendChild(d);
      });
    }
  }

  function migrateData(force) {
    try {
      if (!force && (state.settings.dataVersion || 0) >= 2) return;
      if (Store.readFailed()) return;
      const chars = Store.getCharacters();
      const sessions = Store.getSessions();
      chars.forEach((c) => {
        const f = c.fields || {};
        const mine = sessions.filter((s) => (s.characterId || "") === c.id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        let first = mine[0];
        if (!first) {
          const now = Date.now();
          first = { id: "s_" + now.toString(36) + Math.random().toString(36).slice(2, 7), title: "主线", characterId: c.id, createdAt: now, updatedAt: now, systemPrompt: "", alias: "", temperature: null, topP: null, avatarUser: "", avatarAi: "", usage: null, scene: "", cognition: "", memory: null, autoBackup: false, mainLine: true, pinned: false, ctxWash: null, messages: [] };
          sessions.push(first);
        }
        if (f.scene && !first.scene) first.scene = f.scene;
        if (c.cognition && !first.cognition) first.cognition = c.cognition;
        if (c.memory && !first.memory) first.memory = c.memory;
        if (c.autoBackup) first.autoBackup = true;
        first.mainLine = true;
        mine.slice(1).forEach((s) => { if (!s.scene) s.scene = f.scene || ""; });
        delete c.cognition; delete c.memory; delete c.autoBackup;
        if (c.fields) delete c.fields.scene;
        if (c.ctxFilter && (typeof c.ctxFilter.washedUntil === "number" || Array.isArray(c.ctxFilter.turns))) {
          if (!first.ctxWash) first.ctxWash = { washedFrom: c.ctxFilter.washedFrom || 0, washedUntil: c.ctxFilter.washedUntil || 0, turns: c.ctxFilter.turns || [] };
          delete c.ctxFilter.washedFrom; delete c.ctxFilter.washedUntil; delete c.ctxFilter.turns;
        }
      });
      const am = Store.getAssistantMemory();
      if (am && am.memory) {
        const asst = sessions.filter((s) => !(s.characterId || "")).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        if (asst[0] && !asst[0].memory) asst[0].memory = am.memory;
      }
      /* 旧的全局助手指记忆已并入会话，清掉这个键，免得留明文 */
      try { Store.removeRaw("aicode.assistantmem.v1"); } catch (e) { /* ignore */ }
      Store.saveCharacters(chars);
      Store.saveSessions(sessions);
      state.settings = Store.saveSettings({ dataVersion: 2 });
    } catch (e) { console.warn("[DeepLink] 数据迁移出错", e); }
  }

  /* ── 重置 ──────────────────────────────────────── */
  /* 注意：main/asr/tts/img/vision 五个模型区不在这里 —— 它们在 resetGroup() 里
     走「配置库」分支单独处理（既要重置生效值，也要把配置库缩回一套）。 */
  const RESET_GROUPS = {
    gen: ["temperature", "topP"],
    prompt: ["systemPrompt", "searchProvider", "searxngInstances", "customSearchUrl"],
    imgstore: ["imgToText", "imgExpireTurns"],
    memory: ["roleplayEnabled", "myName", "myPersona", "myAppearance", "myBackground", "myLikes", "assistantCompress", "compressModel", "tokenWarnThreshold", "notifyTasks"]
  };

  const RESET_LABELS = { gen: "生成参数", prompt: "提示词与联网搜索", main: "主模型", asr: "听觉模型", tts: "朗读模型", img: "画图模型", vision: "视觉模型", imgstore: "图片存储", memory: "角色扮演与记忆压缩" };

  /* 「恢复默认设置」不动这些：密钥、API 地址、头像、主题、内部标记、顶栏开关、
     后台常驻（它牵着系统权限，重置不该悄悄把权限设置也改掉） */
  const RESET_KEEP = ["apiKey", "baseUrl", "tavilyKey", "customSearchKey", "asrKey", "ttsKey", "imgKey", "visionKey",
    /* 五个模型区的「生效值」字段：它们是从 modelSets 派生出来的，模型配置既然保留，
       这些派生字段也必须保留，否则「恢复默认设置」那一瞬间两份数据会不一致。 */
    "model", "asrBaseUrl", "asrModel", "ttsBaseUrl", "ttsModel", "imgBaseUrl", "imgModel", "visionBaseUrl", "visionModel",
    /* 各模型区的配置库（含里面的密钥）与「当前用哪套」也必须保留，
       否则「恢复默认设置」会把用户辛苦填的几套平台配置一次性清空。 */
    "modelSets", "modelSetIndex",
    "avatarUser", "avatarAi", "theme", "mode", "onboarded", "lastActiveDate", "dataVersion",
    "cryptWarned", "imgExpireNotified", "activeCharacterId", "searchEnabled", "thinkingEnabled", "bgKeep",
    /* 应用加密这一整组也必须保留：否则「恢复默认设置」会把口令悄悄清掉，
       等于把已经上好的锁又自己打开了 —— 那是最不能接受的一种「意外」。 */
    "lockEnabled", "lockSalt", "lockHash", "lockCodeHash", "lockCodeUsed", "lockFail", "lockUntil"];

  function resetSettingsKeys(keys, label) {
    const patch = {};
    keys.forEach((k) => { if (k in CONFIG.DEFAULT_SETTINGS) patch[k] = CONFIG.DEFAULT_SETTINGS[k]; });
    state.settings = Store.saveSettings(patch);
    fillSettings();
    syncToggles();
    renderAll();
    UI.toast("已重置：" + label);
  }

  async function resetGroup(key) {
    /* 模型区：既要把生效值还原，也要把这一区的「配置库」缩回一套。
       当前那套的 API Key 会保留到新的「配置一」——重置不该顺手删掉用户充过钱的密钥。 */
    if (Store.SET_KINDS.indexOf(key) >= 0) {
      const label = RESET_LABELS[key] || key;
      const okm = await UI.confirmDialog("重置" + label, "把「" + label + "」恢复成一套默认配置？（当前这套的 API Key 会保留下来）");
      if (!okm) return;
      const f = Store.SET_FLAT[key];
      const def = CONFIG.DEFAULT_SETTINGS;
      const patch = {};
      patch[f.base] = def[f.base] || "";
      patch[f.key] = String(state.settings[f.key] || "");
      patch[f.model] = def[f.model] || "";
      if (key === "main") { patch.mainCompat = !!def.mainCompat; }
      if (key === "asr") { patch.asrEnabled = !!def.asrEnabled; patch.asrLang = def.asrLang; }
      if (key === "tts") { patch.ttsEnabled = !!def.ttsEnabled; patch.ttsVoice = def.ttsVoice; patch.ttsAutoRead = !!def.ttsAutoRead; }
      if (key === "img") { patch.imgEnabled = !!def.imgEnabled; patch.imgSize = def.imgSize; }
      if (key === "vision") { patch.visionEnabled = !!def.visionEnabled; }
      const sets = Object.assign({}, state.settings.modelSets);
      sets[key] = [{ name: "配置一", baseUrl: patch[f.base], apiKey: patch[f.key], models: patch[f.model] }];
      patch.modelSets = sets;
      const idx = Object.assign({}, state.settings.modelSetIndex);
      idx[key] = 0;
      patch.modelSetIndex = idx;
      state.settings = Store.saveSettings(patch);
      fillSettings();
      syncToggles();
      renderAll();
      UI.toast("已重置：" + label);
      return;
    }
    if (key === "charfilter") {
      const ch = activeCharacter();
      if (!ch) return;
      const okc = await UI.confirmDialog("重置筛选", "把「上下文筛选」的规则与轮数恢复默认？");
      if (!okc) return;
      const cf = Memory.ensureFilter(ch);
      cf.rule = "";
      cf.every = 10;
      saveChar(ch);
      fillCharacterForm(ch);
      UI.toast("已重置筛选规则");
      return;
    }
    const keys = RESET_GROUPS[key];
    if (!keys) return;
    const label = RESET_LABELS[key] || key;
    const ok = await UI.confirmDialog("重置本区", "把「" + label + "」恢复默认？");
    if (!ok) return;
    resetSettingsKeys(keys, label);
  }

  async function resetAllSettings() {
    const ok = await UI.confirmDialog("恢复默认设置", "把设置里的参数恢复默认？（API Key、API 地址、各密钥、头像、主题都会保留）");
    if (!ok) return;
    const keys = Object.keys(CONFIG.DEFAULT_SETTINGS).filter((k) => RESET_KEEP.indexOf(k) < 0);
    resetSettingsKeys(keys, "全部参数");
  }

  function fillSettings() {
    try { fillSettingsInner(); renderLockState(); } catch (e) { console.warn("[DeepLink] fillSettings 出错", e); }
  }

  function fillSettingsInner() {
    const s = state.settings;
    /* 五个模型区的「接口地址 / API Key / 模型名」都不在表单里了 ——
       它们由各区的配置卡片（renderModelSets）维护，保存时由 collectModelSets() 统一写回。 */
    setVal("#setTemperature", typeof s.temperature === "number" ? s.temperature : 1);
    setVal("#setTopP", typeof s.topP === "number" ? s.topP : 1);
    syncRangeLabels();
    setVal("#setSystemPrompt", s.systemPrompt || "");
    setVal("#setSearchProvider", s.searchProvider || "auto");
    setVal("#setTavilyKey", s.tavilyKey || "");
    setVal("#setCustomUrl", s.customSearchUrl || "");
    setVal("#setCustomKey", s.customSearchKey || "");
    setVal("#setInstances", s.searxngInstances || "");
    setChecked("#setMainCompat", !!s.mainCompat);

    setChecked("#setAsrEnabled", !!s.asrEnabled);
    setVal("#setAsrLang", s.asrLang || "");

    setChecked("#setTtsEnabled", !!s.ttsEnabled);
    setVal("#setTtsVoice", s.ttsVoice || "");
    setChecked("#setTtsAuto", !!s.ttsAutoRead);

    setChecked("#setImgEnabled", !!s.imgEnabled);
    setVal("#setImgSize", s.imgSize || "");

    setChecked("#setVisionEnabled", !!s.visionEnabled);

    setChecked("#setRoleplayEnabled", !!s.roleplayEnabled);
    setVal("#setMyName", s.myName || "");
    setVal("#setMyPersona", s.myPersona || "");
    setVal("#setMyAppearance", s.myAppearance || "");
    setVal("#setMyBackground", s.myBackground || "");
    setVal("#setMyLikes", s.myLikes || "");
    setChecked("#setAssistantCompress", !!s.assistantCompress);
    setVal("#setCompressModel", s.compressModel || "");
    setVal("#setTokenWarn", typeof s.tokenWarnThreshold === "number" ? s.tokenWarnThreshold : 30000);
    setChecked("#setNotifyTasks", s.notifyTasks !== false);
    setChecked("#setImgToText", s.imgToText !== false);
    setVal("#setImgExpireTurns", typeof s.imgExpireTurns === "number" ? s.imgExpireTurns : 10);
    setChecked("#setNoImage", !!s.noImage);
    setChecked("#setBgKeep", !!s.bgKeep);

    /* 模型配置卡片：绑定（只需一次）+ 渲染 */
    bindModelSetEvents();
    renderModelSets();
    renderModelBadge();
    avatarDraft.settingsUser = s.avatarUser || "";
    avatarDraft.settingsAi = s.avatarAi || "";
    renderAvatarPreview("#setAvatarUserPreview", avatarDraft.settingsUser, "user");
    renderAvatarPreview("#setAvatarAiPreview", avatarDraft.settingsAi, "assistant");
    renderSettingsMemory();
    renderDataUsage();
    syncProviderFields();
  }

  function syncRangeLabels() {
    setText("#setTempVal", Number($v("#setTemperature")).toFixed(2));
    setText("#setTopPVal", Number($v("#setTopP")).toFixed(2));
  }

  function syncProviderFields() {
    const v = $v("#setSearchProvider");
    setDisplay("#tavilyField", v === "tavily" ? "" : "none");
    /* #customSearchField 在 app.css 有一条【id 级】的 display:none（优先级高于 .field 的 flex）。
       内联置 "" 只是清掉内联声明，会被那条 id 规则盖回 none —— 于是选「自定义接口」时
       地址/密钥输入框永远不出现、整块功能不可用。必须显式给 flex 才盖得住。 */
    setDisplay("#customSearchField", v === "custom" ? "flex" : "none");
  }

  /* ── 模型配置：每个模型区各自最多 6 套 ────────────
     数据结构在 store.js 的 normalizeModelSets 里归一化；这里只管渲染与读写。
     关键约定：settings 里那些扁平字段（baseUrl/apiKey/model、asrBaseUrl/asrKey/asrModel…）
     永远等于「当前那套配置的生效值」—— 所以别的模块（媒体 / 搜索 / 接口）
     照旧只读扁平字段，完全不用知道多配置的存在。

     一个「配置」= 名字 + 接口地址 + API Key + 模型（可多个，每行一个）。
     主模型那区写多个模型时，它们会全部列进聊天页右上角的切换面板。 */
  const CN_NUM = ["一", "二", "三", "四", "五", "六"];
  const MSET_DEFAULT_BASE = "https://api.deepseek.com";

  function defaultSetName(i) { return "配置" + (CN_NUM[i] || String(i + 1)); }

  function splitModels(text) { return Store.splitModelList(text); }

  function msetBox(kind) { return $("#mset" + kind.charAt(0).toUpperCase() + kind.slice(1)); }

  /* 从 DOM 里把五个区的配置读出来（index 沿用当前状态）。
     注意：这里会带上用户在卡片里「还没点保存」的编辑 —— 因为增/删/切都是即时生效的，
     不这么读的话，用户刚改完地址就点「用这套」，改动会丢。 */
  function readAllSets() {
    const cur = state.settings;
    const sets = {};
    const index = {};
    Store.SET_KINDS.forEach(function (kind) {
      let list = [];            // 下面「卡片没渲染」兜底分支会重新赋值 → 必须 let，不能 const
      const box = msetBox(kind);
      if (box) {
        Array.prototype.forEach.call(box.querySelectorAll(".mset-card"), function (card, i) {
          const val = function (k) {
            const el = card.querySelector('[data-k="' + k + '"]');
            return el ? String(el.value || "") : "";
          };
          list.push({
            name: val("name").trim() || defaultSetName(i),
            baseUrl: val("baseUrl").trim(),
            apiKey: val("apiKey").trim(),
            models: val("models").replace(/\r/g, "").trim()
          });
        });
      }
      if (!list.length) {
        list = (cur.modelSets && Array.isArray(cur.modelSets[kind])) ? cur.modelSets[kind].slice() : [];
      }
      if (!list.length) {
        list = [{ name: "配置一", baseUrl: (kind === "main" ? MSET_DEFAULT_BASE : ""), apiKey: "", models: "" }];
      }
      const ci = Number(cur.modelSetIndex && cur.modelSetIndex[kind]);
      index[kind] = Math.min(Math.max(isFinite(ci) ? ci : 0, 0), list.length - 1);
      sets[kind] = list;
    });
    return { sets: sets, index: index };
  }

  /* 已保存状态下的配置库（聊天页切换面板用这个，免得把设置页里没保存的编辑也一起提交） */
  function stateSets() {
    const s = state.settings;
    const sets = {};
    const index = {};
    Store.SET_KINDS.forEach(function (kind) {
      let list = (s.modelSets && Array.isArray(s.modelSets[kind])) ? s.modelSets[kind].slice() : [];
      if (!list.length) {
        list = [{ name: "配置一", baseUrl: (kind === "main" ? MSET_DEFAULT_BASE : ""), apiKey: "", models: "" }];
      }
      const ci = Number(s.modelSetIndex && s.modelSetIndex[kind]);
      index[kind] = Math.min(Math.max(isFinite(ci) ? ci : 0, 0), list.length - 1);
      sets[kind] = list;
    });
    return { sets: sets, index: index };
  }

  /* 依据「配置库 + 各区选中的第几套」算出要落盘的完整 patch（含扁平生效值）。
     overrideMainModel：聊天页切换面板点了某个模型时，用它指定主模型名。 */
  function flattenSets(sets, index, overrideMainModel) {
    const patch = { modelSets: {}, modelSetIndex: {} };
    Store.SET_KINDS.forEach(function (kind) {
      const f = Store.SET_FLAT[kind];
      const list = Array.isArray(sets[kind]) ? sets[kind] : [];
      let idx = Number(index[kind]);
      if (!isFinite(idx) || idx < 0) idx = 0;
      if (idx > list.length - 1) idx = list.length - 1;
      const active = list[idx] || {};
      const ms = splitModels(active.models);
      patch.modelSets[kind] = list;
      patch.modelSetIndex[kind] = idx;
      patch[f.base] = String(active.baseUrl || (kind === "main" ? MSET_DEFAULT_BASE : ""));
      patch[f.key] = String(active.apiKey || "");
      if (kind === "main") {
        const want = String(overrideMainModel || state.settings.model || "");
        patch[f.model] = (ms.indexOf(want) >= 0) ? want : (ms[0] || want || "deepseek-flash");
      } else {
        patch[f.model] = ms[0] || "";
      }
    });
    return patch;
  }

  /* 统一出口：把配置库写回设置、刷新设置页与顶栏徽章、重算媒体按钮可见性 */
  function commitSets(sets, index, overrideMainModel) {
    state.settings = Store.saveSettings(flattenSets(sets, index, overrideMainModel));
    renderModelSets();
    renderModelBadge();
    try { syncToggles(); } catch (e) { /* ignore */ }
    return state.settings;
  }

  function renderModelBadge() {
    setText("#modelBadge", state.settings.model || "未选模型");
  }

  function mkSetInput(labelText, type, value, ph, key) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const sp = document.createElement("span");
    sp.textContent = labelText;
    wrap.appendChild(sp);
    let input;
    if (type === "textarea") {
      input = document.createElement("textarea");
      input.rows = 2;
    } else {
      input = document.createElement("input");
      input.type = type;
    }
    input.setAttribute("data-k", key);
    input.placeholder = ph;
    input.value = value;
    wrap.appendChild(input);
    return wrap;
  }

  function mkMiniBtn(attr, value, text) {
    const b = document.createElement("button");
    b.className = "btn ghost mini";
    b.type = "button";
    b.setAttribute(attr, value);
    b.textContent = text;
    return b;
  }

  function mkSetCard(kind, i, set, isActive, total) {
    const card = document.createElement("div");
    card.className = "mset-card" + (isActive ? " active" : "");
    card.setAttribute("data-mkind", kind);
    card.setAttribute("data-idx", String(i));

    const head = document.createElement("div");
    head.className = "mset-head";
    const nameInput = document.createElement("input");
    nameInput.className = "mset-name";
    nameInput.type = "text";
    nameInput.setAttribute("data-k", "name");
    nameInput.value = set.name || defaultSetName(i);
    nameInput.placeholder = defaultSetName(i);
    head.appendChild(nameInput);
    if (isActive) {
      const b = document.createElement("span");
      b.className = "mset-badge";
      b.textContent = "使用中";
      head.appendChild(b);
    }
    const actions = document.createElement("div");
    actions.className = "mset-actions";
    if (!isActive) actions.appendChild(mkMiniBtn("data-act", "use", "用这套"));
    if (total > 1) actions.appendChild(mkMiniBtn("data-act", "del", "删除"));
    head.appendChild(actions);
    card.appendChild(head);

    card.appendChild(mkSetInput("接口地址 (Base URL)", "url", set.baseUrl || "", "留空则沿用主模型", "baseUrl"));
    card.appendChild(mkSetInput("API Key", "password", set.apiKey || "", "留空则沿用主 Key", "apiKey"));
    if (kind === "main") {
      card.appendChild(mkSetInput("模型（每行一个）", "textarea", set.models || "", "deepseek-flash\ndeepseek-v4-pro", "models"));
    } else {
      card.appendChild(mkSetInput("模型", "text", set.models || "", "留空则嫁接到主模型", "models"));
    }
    return card;
  }

  function renderModelSets() {
    const s = state.settings;
    Store.SET_KINDS.forEach(function (kind) {
      const box = msetBox(kind);
      if (!box) return;
      const list = (s.modelSets && s.modelSets[kind]) || [];
      const activeIdx = (s.modelSetIndex && s.modelSetIndex[kind]) || 0;
      box.innerHTML = "";
      list.forEach(function (set, i) {
        box.appendChild(mkSetCard(kind, i, set, i === activeIdx, list.length));
      });
    });
    setText("#providerNowLine", "当前主模型：" + (s.model || "\u2014"));
  }

  /* ── 增 / 删 / 切（每个区各管各的）───────────────── */
  function addSet(kind) {
    const cur = readAllSets();
    const list = cur.sets[kind];
    if (list.length >= Store.MAX_SETS) { UI.toast("每区最多 " + Store.MAX_SETS + " 套配置"); return; }
    list.push({ name: defaultSetName(list.length), baseUrl: "", apiKey: "", models: "" });
    commitSets(cur.sets, cur.index);
    UI.toast("已添加「" + defaultSetName(list.length - 1) + "」，填完记得点「保存设置」");
  }

  function removeSet(kind, i) {
    const cur = readAllSets();
    const before = cur.sets[kind];
    if (before.length <= 1) { UI.toast("至少留一套配置"); return; }
    const name = (before[i] && before[i].name) ? before[i].name : defaultSetName(i);
    UI.confirmDialog("删除配置", "删除「" + name + "」？这套的地址与密钥会一起删掉。").then(function (ok) {
      if (!ok) return;
      const now = readAllSets();
      const list = now.sets[kind];
      if (list.length <= 1) { UI.toast("至少留一套配置"); return; }
      list.splice(i, 1);
      let idx = now.index[kind];
      if (i === idx) idx = 0;
      else if (i < idx) idx = idx - 1;
      now.index[kind] = Math.min(Math.max(idx, 0), list.length - 1);
      commitSets(now.sets, now.index);
      UI.toast("已删除「" + name + "」");
    });
  }

  function switchSet(kind, i) {
    const cur = readAllSets();
    const list = cur.sets[kind] || [];
    if (!list[i]) return;
    cur.index[kind] = i;
    /* 主模型切配置：当前主模型不在新配置的模型清单里就自动挑第一个，免得切过去直接请求失败 */
    let override;
    if (kind === "main") {
      const ms = splitModels(list[i].models);
      const curModel = state.settings.model;
      override = (ms.indexOf(curModel) >= 0) ? curModel : (ms[0] || "");
    }
    commitSets(cur.sets, cur.index, override);
    UI.toast("已切到「" + (list[i].name || defaultSetName(i)) + "」");
  }

  let msetBound = false;
  function bindModelSetEvents() {
    if (msetBound) return;
    const modal = $("#settingsModal");
    const panel = $("#modelPanel");
    if (!modal && !panel) return;
    msetBound = true;
    if (modal) modal.addEventListener("click", onModelSetClick);
    if (panel) panel.addEventListener("click", onModelPanelClick);
  }

  function onModelSetClick(ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    const add = t.closest("[data-add]");
    if (add) { addSet(add.getAttribute("data-add")); return; }
    const btn = t.closest("[data-act]");
    if (!btn) return;
    const card = btn.closest(".mset-card");
    if (!card) return;
    const kind = card.getAttribute("data-mkind");
    const i = Number(card.getAttribute("data-idx"));
    const act = btn.getAttribute("data-act");
    if (act === "use") switchSet(kind, i);
    else if (act === "del") removeSet(kind, i);
  }

  /* ── 顶栏「切换主模型」面板（全自绘，不用系统原生控件）────── */
  function renderModelPanel() {
    const box = $("#modelPanelList");
    if (!box) return;
    const s = state.settings;
    const list = (s.modelSets && s.modelSets.main) || [];
    const activeIdx = (s.modelSetIndex && s.modelSetIndex.main) || 0;
    box.innerHTML = "";
    let total = 0;
    list.forEach(function (set, pi) {
      const models = splitModels(set.models);
      if (!models.length) return;
      const g = document.createElement("div");
      g.className = "mp-group";
      g.textContent = (set.name || defaultSetName(pi)) + (pi === activeIdx ? " · 使用中" : "");
      box.appendChild(g);
      models.forEach(function (m) {
        total += 1;
        const on = (pi === activeIdx && m === s.model);
        const item = document.createElement("div");
        item.className = "mp-item" + (on ? " on" : "");
        item.setAttribute("data-pi", String(pi));
        item.setAttribute("data-model", m);
        const nm = document.createElement("span");
        nm.className = "mp-name";
        nm.textContent = m;
        item.appendChild(nm);
        if (on) {
          const ck = document.createElement("span");
          ck.className = "mp-check";
          ck.innerHTML = UI.iconSvg("check");
          item.appendChild(ck);
        }
        box.appendChild(item);
      });
    });
    if (!total) {
      const e = document.createElement("div");
      e.className = "mp-empty";
      e.textContent = "还没有可选的模型。去「设置 \u2192 主模型」把模型名填上（每行一个）。";
      box.appendChild(e);
    }
  }

  function toggleModelPanel() {
    const p = $("#modelPanel");
    if (!p) return;
    if (!p.hidden) { setHidden("#modelPanel", true); return; }
    renderModelPanel();
    setHidden("#modelPanel", false);
  }

  function closeModelPanel() { setHidden("#modelPanel", true); }

  function onModelPanelClick(ev) {
    const t = ev.target;
    const item = (t && t.closest) ? t.closest(".mp-item") : null;
    if (!item) return;
    const pi = Number(item.getAttribute("data-pi"));
    const model = item.getAttribute("data-model") || "";
    if (!model) return;
    const cur = stateSets();
    if (!cur.sets.main[pi]) return;
    cur.index.main = pi;
    commitSets(cur.sets, cur.index, model);
    closeModelPanel();
    UI.toast("主模型：" + model);
  }

  function readSettingsForm() {
    const form = {
      /* 五个模型区的地址 / 密钥 / 模型都不在这里取 —— 它们在末尾由 collectModelSets() 统一写入 */
      avatarUser: avatarDraft.settingsUser,
      avatarAi: avatarDraft.settingsAi,
      temperature: Number($v("#setTemperature")),
      topP: Number($v("#setTopP")),
      systemPrompt: $v("#setSystemPrompt"),
      searchProvider: $v("#setSearchProvider"),
      tavilyKey: $v("#setTavilyKey").trim(),
      customSearchUrl: $v("#setCustomUrl").trim(),
      customSearchKey: $v("#setCustomKey").trim(),
      searxngInstances: $v("#setInstances"),
      mainCompat: checkedOf("#setMainCompat"),

      asrEnabled: checkedOf("#setAsrEnabled"),
      asrLang: $v("#setAsrLang").trim(),

      ttsEnabled: checkedOf("#setTtsEnabled"),
      ttsVoice: $v("#setTtsVoice").trim(),
      ttsAutoRead: checkedOf("#setTtsAuto"),

      imgEnabled: checkedOf("#setImgEnabled"),
      imgSize: $v("#setImgSize").trim(),

      roleplayEnabled: checkedOf("#setRoleplayEnabled"),
      myName: $v("#setMyName").trim(),
      myPersona: $v("#setMyPersona").trim(),
      myAppearance: $v("#setMyAppearance").trim(),
      myBackground: $v("#setMyBackground").trim(),
      myLikes: $v("#setMyLikes").trim(),
      assistantCompress: checkedOf("#setAssistantCompress"),
      compressModel: $v("#setCompressModel").trim(),
      tokenWarnThreshold: Number($v("#setTokenWarn")) || 30000,
      notifyTasks: checkedOf("#setNotifyTasks"),
      imgToText: checkedOf("#setImgToText"),
      imgExpireTurns: Number($v("#setImgExpireTurns")) || 10,
      noImage: checkedOf("#setNoImage"),
      bgKeep: checkedOf("#setBgKeep"),

      visionEnabled: checkedOf("#setVisionEnabled")
    };
    /* 模型配置最后统一写：配置库与「生效值」必须一起改，否则两份数据会打架 */
    const cur = readAllSets();
    const flat = flattenSets(cur.sets, cur.index);
    Object.keys(flat).forEach(function (k) { form[k] = flat[k]; });
    return form;
  }

  function syncChip(input) {
    const chip = input.closest(".chip");
    if (chip) chip.classList.toggle("on", !!input.checked);
  }

  function syncToggles() {
    /* 设置变更（导入 / 恢复默认 / 保存）都汇到这里：同步无图模式，避免 body 类停在旧值、
       要重启才生效。applyNoImage 是幂等的，重复调用无副作用。 */
    if (typeof applyNoImage === "function") applyNoImage(state.settings.noImage);
    setChecked("#searchToggle", !!state.settings.searchEnabled);
    setChecked("#thinkToggle", !!state.settings.thinkingEnabled);
    setVal("#effortSelect", state.settings.reasoning || "high");
    setDisplay("#effortWrap", state.settings.thinkingEnabled ? "" : "none");
    syncChip($("#searchToggle"));
    syncChip($("#thinkToggle"));

    const asrOn = Media.capable("asr", state.settings);
    const imgOn = Media.capable("img", state.settings);
    $("#micBtn").hidden = !asrOn;
    $("#imgChip").hidden = !imgOn;
    if (!imgOn) {
      setChecked("#imgToggle", false);
    }
    syncChip($("#imgToggle"));
    document.body.classList.toggle("tts-on", Media.capable("tts", state.settings));
    if (audioState.recording && !asrOn) {
      audioState.recording = false;
      $("#micBtn").classList.remove("recording");
      Media.recorder.cancel();
    }
    syncPlaceholder();
    /* 顶栏那枚「主模型」徽章：每次状态刷新都对齐一次，免得启动时停在 HTML 里的静态文字 */
    renderModelBadge();
  }

  /* ── 自检 ──────────────────────────────────────── */
  function testLine(ok, text) {
    const div = document.createElement("div");
    div.className = "selftest-line " + (ok === null ? "skip" : (ok ? "ok" : "bad"));
    const icon = ok === null ? "information-outline" : (ok ? "check-circle-outline" : "alert-circle-outline");
    div.innerHTML = UI.iconSvg(icon) + "<span>" + UI.escapeHtml(text) + "</span>";
    return div;
  }

  async function selfTest() {
    const out = $("#selfTestOut");
    out.hidden = false;
    out.innerHTML = "";
    const settings = Object.assign({}, state.settings, readSettingsForm());

    const miss = missingIds();
    out.appendChild(testLine(miss.length === 0, miss.length ? ("界面元素：缺 " + miss.join("、")) : "界面元素：齐全"));

    const cc = Store.canEncrypt();
    out.appendChild(testLine(cc, cc ? ("记忆加密：可用（" + (window.isSecureContext ? "安全上下文" : "未知上下文") + "）") : "记忆加密：不可用——此环境不支持 Web Crypto，记忆将以明文保存、导出也会失败"));

    /* 记忆密钥来源：真机上想知道「是不是绑了本机」就看这一行 */
    try {
      const ki = Store.memKeyInfo();
      out.appendChild(testLine(true, "记忆密钥：" + (ki.device ? "设备密钥（绑定本机，换手机解不开）" : "内置口令（拿不到设备标识，已退回旧方案）")
        + (ki.legacy ? "；还有 " + ki.legacy + " 个会话是旧格式，会在后台自动升级" : "")));
      out.appendChild(testLine(!!ki.salt, "密钥盐：" + (ki.salt ? "本机独立随机（已生成）" : "缺失（无法加密记忆）")));
    } catch (e) { out.appendChild(testLine(false, "记忆密钥：检查出错 " + (e.message || e))); }

    /* 角色卡加密状态：以前是裸 JSON 躺着（年龄/性格/外貌/背景/喜好/世界观/AI 指令全明文），现在整份进密文 */
    try {
      const ci = Store.charsKeyInfo();
      out.appendChild(testLine(!ci.broken, ci.broken
        ? "角色卡加密：磁盘上是解不开的密文（已停止覆盖写入，数据还在）"
        : ("角色卡加密：整份加密（" + ci.count + " 个角色" + (ci.enc ? "" : "，尚未生成密文") + "）")));
    } catch (e) { out.appendChild(testLine(false, "角色卡加密：检查出错 " + (e.message || e))); }

    const nb = Store.storageBackend() === "native";
    out.appendChild(testLine(true, "存储后端：" + (nb ? "App 原生存储（无 5MB 上限）" : "浏览器 localStorage（约 5MB 上限）")));

    /* 图片外置状态：真机上判断「图片有没有真的搬进文件」就靠这一行 */
    try {
      const st = Store.imgStats();
      if (!st.bridge) {
        out.appendChild(testLine(true, "图片存储：内联 base64（当前环境没有原生文件接口，属正常）"));
      } else if (!st.dir) {
        out.appendChild(testLine(false, "图片存储：拿不到可写目录，图片仍以内联保存"));
      } else {
        const kb = Math.round(st.inlineBytes / 1024);
        out.appendChild(testLine(st.inline === 0, "图片存储：文件 " + st.refs + " 张 / 内联 " + st.inline + " 张" +
          (st.inline ? "（约 " + kb + " KB 待搬）" : "（全部已外置）")));
        out.appendChild(testLine(!!st.dir, "图片目录：" + st.dir));
      }
    } catch (e) { out.appendChild(testLine(false, "图片存储：检查出错 " + (e.message || e))); }

    /* 应用加密（口令门）状态：说清「它是口令门、不是加密」，别让人误以为安全等级很高 */
    try {
      if (!lockIsOn()) {
        out.appendChild(testLine(true, "应用加密：未开启（开启后每次打开 App 要先输口令；它挡的是「捡到手机随手翻」，不是加密）"));
      } else {
        const s = lockNow();
        out.appendChild(testLine(true, "应用加密：已开启（纯口令门，聊天记录本身仍是明文）"));
        out.appendChild(testLine(!!s.lockCodeHash && !s.lockCodeUsed,
          "恢复码：" + (s.lockCodeUsed ? "已用过，建议在设置里重设一串" : (s.lockCodeHash ? "有效（离线可用）" : "缺失"))));
        const left = lockCooldownLeft();
        out.appendChild(testLine(true, "错误冷却：" + (left > 0 ? ("正在冷却，还剩 " + lockFmtWait(left)) : "未在冷却（已连错 " + (s.lockFail || 0) + " 次）")));
      }
    } catch (e) { out.appendChild(testLine(false, "应用加密：检查出错 " + (e.message || e))); }

    let sheetInfo = "未加载";
    try {
      for (let i = 0; i < document.styleSheets.length; i++) {
        const sh = document.styleSheets[i];
        if (String(sh.href || "").indexOf("app.css") >= 0) {
          let n = 0; try { n = sh.cssRules ? sh.cssRules.length : 0; } catch (e) { n = -1; }
          sheetInfo = n + " 条规则";
        }
      }
    } catch (e) { /* ignore */ }
    out.appendChild(testLine(sheetInfo !== "未加载", "样式表：app.css " + sheetInfo));
    let varsOn = false;
    try { varsOn = !!(getComputedStyle(document.documentElement).getPropertyValue("--bg") || "").trim(); } catch (e) { /* ignore */ }
    out.appendChild(testLine(varsOn, "主题变量：" + (varsOn ? "已注入" : "未注入")));
    let allNames = [];
    try { allNames = Object.keys(window.webapp || {}).filter((k) => typeof window.webapp[k] === "function").sort(); } catch (e) { /* ignore */ }
    out.appendChild(testLine(allNames.length ? null : false, "原生接口：可用 " + allNames.length + " 个" + (allNames.length ? "" : "（纯浏览器环境）")));

    /* ── 原生接口诊断 ──────────────────────────────
       真机上「调了原生却看不出效果」时，唯一可靠的抓手就是接口到底存不存在、返回什么。
       这里只调「判断 / 获取」这类【只读】接口，绝不在这里触发任何写操作。
       结果可以一键复制（界面不铺长文本，避免自检面板被撑爆）。 */
    const diag = [];
    diag.push("DeepLink 诊断 " + new Date().toLocaleString());
    diag.push("前端版本：" + CONFIG.APP_VERSION);
    diag.push("附加脚本：" + ((window.__dlScripts || []).join(" ") || "（无）"));
    diag.push("接口总数：" + allNames.length);
    diag.push("接口名单：" + (allNames.join(" ") || "（无）"));
    out.appendChild(document.createTextNode("原生接口诊断："));
    const PROBE = ["判断快捷方式", "判断通知权限", "判断优化权限", "判断深色模式状态",
      "获取系统版本", "获取内部文件目录", "获取外部文件目录", "获取外部存储目录",
      "获取设备ID", "获取应用版名", "获取应用版号"];
    PROBE.forEach((n) => {
      const has = !!(window.webapp && typeof window.webapp[n] === "function");
      let val = "—";
      if (has) {
        try {
          const v = window.webapp[n]();
          val = (v === undefined) ? "undefined" : (v === null ? "null" : String(v));
        } catch (e) { val = "抛错：" + (e.message || e); }
      }
      diag.push(n + "：" + (has ? val : "缺失"));
      out.appendChild(testLine(has ? null : false, n + "：" + (has ? val : "【接口不存在】")));
    });
    const copyLine = document.createElement("div");
    copyLine.className = "selftest-line skip";
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn ghost";
    copyBtn.type = "button";
    copyBtn.textContent = "复制诊断信息";
    /* 元素是刚创建的，必然存在；这里不用 on()（on() 在绑定时就找元素，接不住动态节点） */
    copyBtn.addEventListener("click", () => {
      UI.copyText(diag.join("\n")).then((ok) => UI.toast(ok ? "已复制诊断信息，直接发给我就行" : "复制失败，改成截屏也行", !ok));
    });
    const copyHint = document.createElement("span");
    copyHint.textContent = "　点它复制（含接口名单与真实返回值），发给我就能定位";
    copyLine.appendChild(copyBtn);
    copyLine.appendChild(copyHint);
    out.appendChild(copyLine);

    /* 一键测试状态栏通知：比「等生成完看通知」快得多，能直接验证整条链路通不通 */
    const notiLine = document.createElement("div");
    notiLine.className = "selftest-line skip";
    const notiBtn = document.createElement("button");
    notiBtn.className = "btn ghost";
    notiBtn.type = "button";
    notiBtn.textContent = "测试状态栏通知";
    notiBtn.addEventListener("click", () => {
      if (!Store.hasBridge("发送状态栏内容")) { UI.toast("当前环境不支持状态栏通知", true); return; }
      let granted = "取不到";
      try { if (Store.hasBridge("判断通知权限")) granted = String(Store.callBridge("判断通知权限")); } catch (e) { granted = "抛错"; }
      let ret;
      try { ret = Store.callBridge("发送状态栏内容", 99, "测试通知", "能看到这条，就说明通知链路是通的", ""); }
      catch (e) { UI.toast("发送失败：" + (e.message || e), true); return; }
      UI.toast("已发出测试通知（通知权限=" + granted + "，返回=" + String(ret) + "）——看状态栏");
    });
    const notiHint = document.createElement("span");
    notiHint.textContent = "　点它发一条测试通知，直接看链路通不通";
    notiLine.appendChild(notiBtn);
    notiLine.appendChild(notiHint);
    out.appendChild(notiLine);
    /* 探针：验证封装工具会不会带上新增的 js 文件 */
    const extras = (window.__dlScripts || []);
    out.appendChild(testLine(null, "附加脚本：" + (extras.length ? ("已加载 " + extras.join("、")) : "未加载（若你已重新打包却仍显示这个，说明工具不会带上新增文件）")));

    const mEls = $("#messages").children;
    if (mEls.length >= 2) {
      const gaps = [];
      for (let i = 1; i < Math.min(mEls.length, 4); i++) {
        gaps.push(Math.round(mEls[i].getBoundingClientRect().top - mEls[i - 1].getBoundingClientRect().bottom));
      }
      const cs = getComputedStyle($("#messages"));
      out.appendChild(testLine(null, "消息间距：实测 " + gaps.join("/") + "px（容器 gap=" + cs.rowGap + "，第 2 条 margin-top=" + getComputedStyle(mEls[1]).marginTop + "）"));
    } else {
      out.appendChild(testLine(null, "消息间距：不足两条消息，无法测量"));
    }

    const ct = $(".composer-tools");
    if (ct && ct.children.length >= 2) {
      const ch = ct.children;
      const cg = Math.round(ch[1].getBoundingClientRect().left - ch[0].getBoundingClientRect().right);
      out.appendChild(testLine(null, "芯片间距：实测 " + cg + "px（容器 gap=" + getComputedStyle(ct).columnGap + "，flex-wrap=" + getComputedStyle(ct).flexWrap + "）"));
    }

    out.appendChild(testLine(Store.available, "本地存储：" + (Store.available ? "可用（历史记录可保存）" : "不可用，历史记录无法保存")));

    if (!settings.apiKey) {
      out.appendChild(testLine(false, "DeepSeek 直连：未填写 API Key"));
    } else {
      out.appendChild(document.createTextNode("DeepSeek 直连：测试中…"));
      const pending = out.lastChild;
      try {
        const r = await Api.ping(settings);
        pending.remove();
        out.appendChild(testLine(true, "DeepSeek 直连：成功（模型 " + r.model + "）"));
      } catch (e) {
        pending.remove();
        out.appendChild(testLine(false, "DeepSeek 直连：失败 —— " + (e.message || e)));
      }
    }

    out.appendChild(document.createTextNode("联网搜索：" + settings.searchProvider + " 测试中…"));
    const pending2 = out.lastChild;
    try {
      const r = await Search.search("DeepSeek", settings);
      pending2.remove();
      if (r.results.length) {
        out.appendChild(testLine(true, "联网搜索：成功（来源 " + r.provider + "，返回 " + r.results.length + " 条）"));
      } else {
        out.appendChild(testLine(false, "联网搜索：未返回结果，可改用 Tavily 或自定义接口"));
      }
    } catch (e) {
      pending2.remove();
      out.appendChild(testLine(false, "联网搜索：失败 —— " + (e.message || e)));
    }

    const asrCap = Media.capable("asr", settings);
    out.appendChild(testLine(settings.asrEnabled ? asrCap : null,
      settings.asrEnabled
        ? (asrCap ? "听觉模型：已配置（点麦克风实测）" : "听觉模型：已启用，但地址/密钥/模型没填齐")
        : "听觉模型：未启用"));

    if (settings.ttsEnabled && Media.capable("tts", settings)) {
      out.appendChild(document.createTextNode("语音合成：合成中…"));
      const pend3 = out.lastChild;
      try {
        const url = await Media.speak("测试", settings);
        pend3.remove();
        if (url && url.indexOf("blob:") === 0) URL.revokeObjectURL(url);
        out.appendChild(testLine(true, "语音合成：成功"));
      } catch (e) {
        pend3.remove();
        out.appendChild(testLine(false, "语音合成：失败 —— " + (e.message || e)));
      }
    } else {
      out.appendChild(testLine(settings.ttsEnabled ? false : null,
        settings.ttsEnabled ? "语音合成：已启用，但地址/密钥/模型没填齐" : "语音合成：未启用"));
    }

    const imgCap = Media.capable("img", settings);
    out.appendChild(testLine(settings.imgEnabled ? imgCap : null,
      settings.imgEnabled
        ? (imgCap ? "文生图：已配置（用画图开关实测）" : "文生图：已启用，但地址/密钥/模型没填齐")
        : "文生图：未启用"));

    out.appendChild(document.createElement("hr"));
    UI.themeDiagnostics().forEach((line) => out.appendChild(testLine(null, line)));
  }

  /* ══════════ D2 应用加密：口令门 + AI 现场出题找回 ══════════

     【先把话说清楚】它是「口令门」，不是加密。
       挡的是「捡到手机随手翻」—— 聊天记录本身仍然明文躺在手机上（真正加密的只有
       角色记忆那一层，见 store.js 的记忆加密段）。所以别把它当保险箱。
     口令只存「加盐散列」（lockSalt + lockHash），App 里没有任何地方存明文口令，
       也没有能反推出明文的东西；因此「找回」本质上只能走另一条独立凭据
       （恢复码散列）或另一次身份核验（AI 现场出题）。
     恢复码同样只存散列。题目不预存：每次都由 AI 拿【实时聊天记录】现场生成、现场判定，
       所以机器里没有「参考答案」可以被翻出来。

     ⚠️ 内部一律用 setHidden 切盒子：这五个盒子带 hidden 属性，
        setDisplay 会被 [hidden]{display:none!important} 盖掉。 */

  const LOCK_ITER = 150000;               /* PBKDF2 轮数，与导出那层对齐 */
  const LOCK_FREE_TRIES = 3;              /* 前 3 次错不冷却 */
  const LOCK_QUIZ_MAX_ASK = 6;            /* 一共最多问几个问题（含追问） */
  const LOCK_QUIZ_MAX_FOLLOW = 3;         /* 「搭着边」最多追问几次 */
  const LOCK_QUIT_SECONDS = 5;            /* 全失败后几秒退出 */
  const LOCK_CODE_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679";   /* 去掉易混的 0O1I8B2Z5S */
  const LOCK_BOXES = ["#lockPassBox", "#lockRecoverBox", "#lockQuizBox", "#lockResetBox", "#lockDeadBox"];

  let lockUnlocked = false;      /* 本次运行已经进过 App */
  let lockAppStarted = false;    /* app.js 的启动流程跑完了没有 */
  let lockWantHide = false;      /* 解锁成功但启动流程还没跑完 → 等它跑完再收 */
  let lockHideWait = null;       /* 兜底：启动流程万一没来报告，也不能把人永远关在门外 */
  let lockShownOnce = false;     /* 本模块启动时自己盖一次层（不指望 app.js 一定按顺序执行） */
  let lockBusy = false;
  let lockTick = null;
  let lockDeadTimer = null;
  let lockLastCode = "";         /* 只为了「复制」按钮，不落盘、不参与校验 */
  let recoverVia = "";           /* "code" | "ai"：当前是靠哪条路进来的（决定要不要烧掉恢复码） */
  let quizCtx = "";
  let quizAsked = [];
  let quizFollow = 0;
  let quizQuestion = "";
  let quizPending = false;

  /* ── 小工具 ─────────────────────────────────────── */
  function lockB64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    try { return btoa(s); } catch (e) { return ""; }
  }
  function lockUnb64(str) {
    try {
      const bin = atob(String(str || ""));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    } catch (e) { return null; }
  }
  function lockRand(n) {
    if (!Store.canEncrypt()) return null;
    try { return crypto.getRandomValues(new Uint8Array(n)); } catch (e) { return null; }
  }
  /* 口令 / 恢复码 → 加盐散列。文本先加域前缀，免得「恢复码恰好等于口令」时散列相同 */
  async function lockDigest(text) {
    const saltB64 = Store.getSettings().lockSalt || "";
    const saltU8 = lockUnb64(saltB64);
    if (!saltU8 || !Store.canEncrypt()) return "";
    const enc = new TextEncoder();
    try {
      const base = await crypto.subtle.importKey("raw", enc.encode("deeplink-lock|" + text), "PBKDF2", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: saltU8, iterations: LOCK_ITER, hash: "SHA-256" }, base, 256);
      return lockB64(new Uint8Array(bits));
    } catch (e) { return ""; }
  }
  function lockSave(patch) {
    state.settings = Store.saveSettings(patch);
    renderLockState();
    return state.settings;
  }
  function lockNow() { try { return Store.getSettings(); } catch (e) { return {}; } }
  function lockIsOn() { const s = lockNow(); return !!(s.lockEnabled && s.lockHash && s.lockSalt); }
  function lockCooldownLeft() { const s = lockNow(); return Math.max(0, (s.lockUntil || 0) - Date.now()); }
  /* 前 3 次错不冷却；第 4 次起每错一次多锁 1 分钟（存在设置里 → 重启仍然生效） */
  function lockCooldownFor(fail) { return fail <= LOCK_FREE_TRIES ? 0 : (fail - LOCK_FREE_TRIES) * 60000; }
  function lockFmtWait(ms) {
    const sec = Math.ceil(ms / 1000);
    if (sec < 60) return sec + " 秒";
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return r ? (m + " 分 " + r + " 秒") : (m + " 分钟");
  }
  function lockMsg(sel, text, good) {
    const el = $(sel);
    if (!el) return;
    el.textContent = text || "";
    if (good) el.classList.add("ok"); else el.classList.remove("ok");
  }
  function lockBox(sel) {
    for (let i = 0; i < LOCK_BOXES.length; i++) setHidden(LOCK_BOXES[i], LOCK_BOXES[i] !== sel);
  }
  function lockIcons(sel) {
    const el = $(sel);
    if (el && UI.applyIcons) UI.applyIcons(el);
  }

  /* ── 设置页那一段的显示 ─────────────────────────── */
  function renderLockState() {
    const el = $("#setLockState");
    const on = lockIsOn();
    const cb = $("#setLockEnabled");
    if (cb) setChecked("#setLockEnabled", on);
    if (!el) return;
    if (!on) { el.textContent = "当前：未开启。开启后每次打开 App 都要先输口令。"; return; }
    const s = lockNow();
    el.textContent = "当前：已开启。" + (s.lockCodeUsed ? "恢复码已用过，建议点「重设恢复码」换一串。" : "恢复码有效。") + "想换口令点「改口令」。";
  }

  /* ── 锁屏层的显示 / 收起 ────────────────────────── */
  function lockShow() {
    if (lockUnlocked) return;
    lockBox("#lockPassBox");
    lockMsg("#lockErr", "");
    setVal("#lockInput", "");
    setHidden("#lockScreen", false);
    lockIcons("#lockScreen");
    refreshLockCooldown();
  }
  function lockHide() {
    setHidden("#lockScreen", true);
    setHidden("#codeScreen", true);
    if (lockTick) { clearInterval(lockTick); lockTick = null; }
    if (lockDeadTimer) { clearInterval(lockDeadTimer); lockDeadTimer = null; }
  }
  /* 解锁成功后能不能马上收层：启动流程还在跑就先不收，免得「解锁了又闪一下才进」。
     兜底：万一 app.js 的启动流程没来报告（打包工具乱序执行等），3 秒后也照样收，
     绝不能把已经通关的人永远关在门外。 */
  function lockTryHide() {
    if (!lockUnlocked) return;
    if (lockAppStarted) { lockHide(); return; }
    lockWantHide = true;
    if (!lockHideWait) {
      lockHideWait = setTimeout(function () {
        lockHideWait = null;
        if (!lockUnlocked) return;
        lockWantHide = false;
        lockHide();
      }, 3000);
    }
  }
  function refreshLockCooldown() {
    const left = lockCooldownLeft();
    setDisabled("#lockOk", left > 0);
    setDisabled("#lockInput", left > 0);
    if (left > 0) {
      lockMsg("#lockErr", "错太多次了，请等 " + lockFmtWait(left) + " 再试");
      if (!lockTick) {
        lockTick = setInterval(function () {
          const l = lockCooldownLeft();
          if (l <= 0) {
            clearInterval(lockTick); lockTick = null;
            setDisabled("#lockOk", false); setDisabled("#lockInput", false);
            lockMsg("#lockErr", "可以再试了");
            return;
          }
          lockMsg("#lockErr", "错太多次了，请等 " + lockFmtWait(l) + " 再试");
        }, 1000);
      }
    } else if (lockTick) {
      clearInterval(lockTick); lockTick = null;
    }
  }

  /* ── 进 App 的口令门 ────────────────────────────── */
  function lockGate() {
    syncModules();
    if (!lockIsOn()) return false;
    lockUnlocked = false;
    lockAppStarted = false;
    lockWantHide = false;
    lockShow();
    return true;
  }
  /* app.js 启动流程跑完 → 这时才允许收层 */
  function lockAppReady() {
    lockAppStarted = true;
    if (lockHideWait) { clearTimeout(lockHideWait); lockHideWait = null; }
    if (lockWantHide) { lockWantHide = false; lockHide(); }
  }
  /* 本模块自己先盖一次：不指望打包工具一定按 index.html 的顺序执行 app.js。
     盖在这儿比盖在 init() 里还早，等于「脚本一跑就把门关上」。 */
  function lockInitialCover() {
    if (lockShownOnce) return;
    lockShownOnce = true;
    if (!lockIsOn()) return;
    lockAppStarted = false;   /* 等 app.js 的启动流程来报「可以收层了」 */
    lockShow();
  }
  function lockPassed(msg) {
    lockUnlocked = true;
    recoverVia = "";
    lockSave({ lockFail: 0, lockUntil: 0 });
    if (lockTick) { clearInterval(lockTick); lockTick = null; }
    lockMsg("#lockErr", "", true);
    if (msg) UI.toast(msg);
    lockTryHide();
  }
  function lockFailOnce() {
    const s = lockNow();
    const fail = (s.lockFail || 0) + 1;
    const cd = lockCooldownFor(fail);
    lockSave({ lockFail: fail, lockUntil: cd ? Date.now() + cd : 0 });
    setVal("#lockInput", "");
    if (cd) lockMsg("#lockErr", "口令不对。已错 " + fail + " 次，等 " + lockFmtWait(cd) + " 再试");
    else lockMsg("#lockErr", "口令不对，再试一次（已错 " + fail + " 次）");
    refreshLockCooldown();
  }
  async function lockSubmit() {
    if (lockBusy) return;
    syncModules();
    lockBusy = true;
    try {
      if (lockCooldownLeft() > 0) { refreshLockCooldown(); return; }
      const pass = $v("#lockInput");
      if (!pass) { lockMsg("#lockErr", "先输入口令"); return; }
      const h = await lockDigest(pass);
      if (!h) { lockMsg("#lockErr", "校验失败：此环境不支持加密接口"); return; }
      if (h === lockNow().lockHash) { lockPassed("口令正确"); return; }
      lockFailOnce();
    } catch (e) {
      lockMsg("#lockErr", "校验出错：" + (e.message || e));
    } finally { lockBusy = false; }
  }
  function lockForgot() {
    syncModules();
    recoverVia = "";
    lockBox("#lockRecoverBox");
    lockMsg("#recErr", "");
    setVal("#recInput", "");
    setText("#recNote", "两条路：先用事先抄好的恢复码（离线可用，不联网也能用）；或者让 AI 基于你的聊天记录现场出几个问题考你（这条要联网、还要 API Key 可用）。");
  }
  function lockBackToPass() {
    recoverVia = "";
    lockMsg("#recErr", "");
    lockMsg("#quizErr", "");
    lockBox("#lockPassBox");
    refreshLockCooldown();
  }

  /* ── 恢复码（离线兜底）──────────────────────────── */
  function lockNewCode() {
    const r = lockRand(12);
    if (!r) return "";
    let s = "";
    for (let i = 0; i < 12; i++) s += LOCK_CODE_ALPHABET.charAt(r[i] % LOCK_CODE_ALPHABET.length);
    return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12);
  }
  /* 恢复码的「规范形」= 去掉所有分隔符、统一大写。
     ⚠️ 生成端（lockEnableNow / lockChangePass / lockResetCode）和校验端（recSubmit）
        必须【都】拿规范形去算散列。展示时带连字符只是为了好抄，
        绝不能拿带连字符的串去算散列 —— 否则生成的和校验的根本对不上，恢复码永远验不过。 */
  function lockNormCode(v) { return String(v || "").toUpperCase().replace(/[^0-9A-Z]/g, ""); }
  function codeShow(code) {
    lockLastCode = code;
    setText("#codeText", code);
    setHidden("#codeScreen", false);
    lockIcons("#codeScreen");
  }
  function codeClose() { lockLastCode = ""; setHidden("#codeScreen", true); }
  function codeCopy() {
    if (!lockLastCode) return;
    UI.copyText(lockLastCode).then((ok) => UI.toast(ok ? "恢复码已复制" : "复制失败，麻烦手抄一下", !ok));
  }
  async function recSubmit() {
    syncModules();
    const raw = lockNormCode($v("#recInput"));
    if (!raw) { lockMsg("#recErr", "先输入恢复码"); return; }
    const s = lockNow();
    if (!s.lockCodeHash) { lockMsg("#recErr", "这台机器上没有可用的恢复码，改用「让 AI 问我」"); return; }
    if (s.lockCodeUsed) { lockMsg("#recErr", "这串恢复码已经用过了，改用「让 AI 问我」"); return; }
    const h = await lockDigest("code|" + raw);
    if (!h || h !== s.lockCodeHash) { lockMsg("#recErr", "恢复码不对"); return; }
    recoverVia = "code";
    lockMsg("#recErr", "恢复码正确", true);
    lockToReset("恢复码正确。设一个新口令吧。");
  }

  /* ── AI 现场出题 ────────────────────────────────── */
  const QUIZ_ASK_SYS = [
    "你在帮手机主人验证身份：他忘记了自己聊天 App 的开机口令，只能用「你问他答」来证明是本人。",
    "下面会给他这台手机上真实的聊天记录（长期记忆摘要 + 近期原文）。请据此出一道题。",
    "要求：",
    "1. 只问【反复出现、稳定】的事：习惯、口头禅、常聊的话题、共同经历、约定、关系、常去的地方、养过的宠物这类。",
    "2. 不要问只出现过一次的细碎细节，不要问「第几次」「几号」「几点」这种没法稳定回忆的东西。",
    "3. 一次只问一个问题。问题要短、口语化，像熟人随口一问。",
    "4. 不要把聊天原文整句抄进问题里，也不要在问题里暗示答案。",
    "5. 「已经问过的问题」里出现过的方向，换一个方向问。",
    "严格只输出一行 JSON，不要任何解释、不要代码块：{\"question\":\"...\"}"
  ].join("\n");

  const QUIZ_JUDGE_SYS = [
    "你仍在做同一场身份验证：判断手机主人对上一个问题的回答。",
    "判定标准（宁可严一点，不要放水）：",
    "correct：与聊天记录吻合，而且带具体细节（人名、称呼、地点、约定、原话、具体发生过的事）。",
    "vague：方向沾边但笼统含糊，像是在猜（例如「我们经常聊天」「你对我很好」）。",
    "wrong：与聊天记录矛盾，或明显编造、答非所问、乱填、套话。",
    "只依据给出的聊天记录判断，不要凭想象补充，也不要因为礼貌而放水。",
    "verdict 为 vague 时，mode 必须是 follow（追问一个更具体、更好答的细节）或 next（换一个完全不同方向的问题），reply 写那句要接着问的话。",
    "verdict 为 correct 或 wrong 时，mode 填 none，reply 填空字符串。",
    "严格只输出一行 JSON，不要任何解释、不要代码块：{\"verdict\":\"correct|vague|wrong\",\"mode\":\"follow|next|none\",\"reply\":\"...\"}"
  ].join("\n");

  function quizJson(txt) {
    let t = String(txt || "").replace(/```/g, "").trim();
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; }
  }
  /* 拿聊天记录当题源：优先当前会话；当前会话太空就挑消息最多的那条 */
  function quizContext() {
    function ofSession(s) {
      if (!s) return "";
      const parts = [];
      try {
        const mt = s.memory ? Memory.memoryText(s.memory) : "";
        if (mt) parts.push("【长期记忆摘要】\n" + mt.slice(0, 1800));
      } catch (e) { /* ignore */ }
      try {
        const rt = Memory.recentTranscript(s.messages || [], 0, 40);
        if (rt) parts.push("【近期聊天原文】\n" + rt.slice(0, 2600));
      } catch (e) { /* ignore */ }
      return parts.join("\n\n");
    }
    let best = "";
    try { best = ofSession(session()); } catch (e) { best = ""; }
    if (best.length >= 80) return best;
    let pick = "";
    try {
      (Store.getSessions() || []).forEach(function (s) {
        const t = ofSession(s);
        if (t.length > pick.length) pick = t;
      });
    } catch (e) { /* ignore */ }
    return pick.length >= 80 ? pick : "";
  }
  async function quizCall(sys, userText) {
    const settings = state.settings || Store.getSettings();
    if (!settings.apiKey) throw new Error("没有可用的 API Key");
    const out = await Api.summarize(settings, [
      { role: "system", content: sys },
      { role: "user", content: userText }
    ], { maxTokens: 400 });
    try { if (out && out.usage) recordUsage(null, out.usage, null); } catch (e) { /* ignore */ }
    return String((out && out.text) || "").trim();
  }
  function quizBusy(on, note) {
    setDisabled("#quizA", !!on);
    setDisabled("#quizOk", !!on);
    setDisabled("#quizBack", !!on);
    if (note !== undefined) setText("#quizNote", note || "");
  }
  async function quizStart() {
    syncModules();
    recoverVia = "ai";
    lockBox("#lockQuizBox");
    lockMsg("#quizErr", "");
    setVal("#quizA", "");
    setText("#quizQ", "");
    quizAsked = []; quizFollow = 0; quizQuestion = "";
    quizBusy(true, "正在根据你的聊天记录想问题…");
    quizCtx = quizContext();
    if (!quizCtx) {
      quizBusy(false, "这台机器上还没有足够的聊天记录，AI 出不了题。请改用恢复码。");
      return;
    }
    await quizNext();
  }
  async function quizNext() {
    lockMsg("#quizErr", "");
    quizBusy(true, "正在想下一个问题…");
    setVal("#quizA", "");
    try {
      const user = quizCtx + "\n\n【已经问过的问题】\n" + (quizAsked.length ? quizAsked.join("\n") : "（还没有）");
      const j = quizJson(await quizCall(QUIZ_ASK_SYS, user));
      const q = j && j.question ? String(j.question).trim() : "";
      if (!q) throw new Error("AI 没给出问题");
      quizQuestion = q;
      quizAsked.push(q);
      setText("#quizQ", q);
      quizBusy(false, "第 " + quizAsked.length + " 个问题。答不上来就别硬猜，猜错就直接退出了。");
      const el = $("#quizA");
      if (el && el.focus) el.focus();
      return;
    } catch (e) {
      setText("#quizQ", "");
      quizBusy(false, "出不了题：" + (e.message || e) + "。可以改用恢复码。");
    }
  }
  async function quizSubmit() {
    if (quizPending) return;
    syncModules();
    const ans = ($v("#quizA") || "").trim();
    if (!ans) { lockMsg("#quizErr", "先写点什么"); return; }
    if (!quizQuestion) { lockMsg("#quizErr", "现在还没有题目"); return; }
    quizPending = true;
    try {
      lockMsg("#quizErr", "正在核对…");
      quizBusy(true, "正在核对你的回答…");
      const user = quizCtx
        + "\n\n【已经问过的问题】\n" + quizAsked.join("\n")
        + "\n\n【上一个问题】\n" + quizQuestion
        + "\n\n【本人的回答】\n" + ans.slice(0, 600);
      const j = quizJson(await quizCall(QUIZ_JUDGE_SYS, user));
      const verdict = j && String(j.verdict || "").toLowerCase();
      const mode = j && String(j.mode || "").toLowerCase();
      const reply = j && j.reply ? String(j.reply).trim() : "";
      if (verdict === "correct") {
        lockMsg("#quizErr", "对上了", true);
        quizBusy(false, "验证通过。");
        lockToReset("验证通过。设一个新口令吧。");
        return;
      }
      if (verdict === "wrong") { quizBusy(false, ""); lockDead("回答和聊天记录对不上，不能确认是你本人。"); return; }
      if (verdict !== "vague") { quizBusy(false, "AI 没有给出判定，再试一次吧。"); return; }
      quizFollow++;
      if (quizFollow > LOCK_QUIZ_MAX_FOLLOW) { quizBusy(false, ""); lockDead("连着几次都答得太笼统，没法确认是你本人。"); return; }
      if (!reply) {
        if (quizAsked.length >= LOCK_QUIZ_MAX_ASK) { quizBusy(false, ""); lockDead("问题问完了，还是没能确认是你本人。"); return; }
        await quizNext();
        return;
      }
      if (mode === "next" && quizAsked.length >= LOCK_QUIZ_MAX_ASK) { quizBusy(false, ""); lockDead("问题问完了，还是没能确认是你本人。"); return; }
      quizQuestion = reply;
      quizAsked.push(reply);
      setText("#quizQ", reply);
      setVal("#quizA", "");
      quizBusy(false, mode === "next"
        ? ("第 " + quizAsked.length + " 个问题（换了个方向）：尽量说具体一点。")
        : ("你的回答有点像在猜，再具体一点（已追问 " + quizFollow + " 次，最多 " + LOCK_QUIZ_MAX_FOLLOW + " 次）："));
      const el = $("#quizA");
      if (el && el.focus) el.focus();
    } catch (e) {
      quizBusy(false, "核对失败：" + (e.message || e) + "。可以改用恢复码，或稍后再点「让 AI 问我」。");
    } finally {
      quizPending = false;
    }
  }
  function quizGiveUp() {
    recoverVia = "";
    lockMsg("#quizErr", "");
    lockBox("#lockRecoverBox");
  }

  /* ── 全失败：警告 → 5 秒后退出 ──────────────────── */
  function lockDead(why) {
    recoverVia = "";
    lockBox("#lockDeadBox");
    lockIcons("#lockScreen");
    let n = LOCK_QUIT_SECONDS;
    const paint = (t) => setText("#deadNote", why + " 为保护里面的内容，" + t + "。");
    paint(n + " 秒后自动退出");
    setDisabled("#deadOk", false);
    if (lockDeadTimer) clearInterval(lockDeadTimer);
    lockDeadTimer = setInterval(function () {
      n--;
      if (n <= 0) { clearInterval(lockDeadTimer); lockDeadTimer = null; lockQuit(); return; }
      paint(n + " 秒后自动退出");
    }, 1000);
  }
  function lockQuit() {
    if (lockDeadTimer) { clearInterval(lockDeadTimer); lockDeadTimer = null; }
    if (Store.hasBridge("关闭应用退出")) {
      Store.callBridge("关闭应用退出");
      setText("#deadNote", "已请求退出。");
      return;
    }
    setText("#deadNote", "当前环境没法自动退出，请手动关掉 App。");
  }

  /* ── 通过验证后：改口令 / 重设凭据 ───────────────── */
  function lockToReset(note) {
    lockBox("#lockResetBox");
    lockIcons("#lockScreen");
    setText("#resetNote", note || "设一个新口令吧。");
    lockMsg("#resetErr", "");
    setVal("#resetPass1", "");
    setVal("#resetPass2", "");
    const el = $("#resetPass1");
    if (el && el.focus) el.focus();
  }
  async function lockResetSave() {
    syncModules();
    const a = $v("#resetPass1");
    const b = $v("#resetPass2");
    if (!a || a.length < 4) { lockMsg("#resetErr", "口令至少 4 位"); return; }
    if (a !== b) { lockMsg("#resetErr", "两次输入不一样"); return; }
    const h = await lockDigest(a);
    if (!h) { lockMsg("#resetErr", "算散列失败：此环境不支持加密接口"); return; }
    const patch = { lockEnabled: true, lockHash: h, lockFail: 0, lockUntil: 0 };
    if (recoverVia === "code") patch.lockCodeUsed = true;   /* 恢复码一次性：真用它进了才作废 */
    lockSave(patch);
    lockMsg("#resetErr", "已保存", true);
    lockPassed("口令已更新");
  }
  /* 「取消改口令」= 放弃这次找回 → 回到口令门
     （#lockResetBox 只会出现在锁屏层里；设置页里改口令走的是弹窗，不用这个盒子） */
  function lockResetBack() {
    recoverVia = "";
    lockMsg("#resetErr", "");
    lockBox("#lockPassBox");
    refreshLockCooldown();
  }

  /* ── 设置页的动作（在 App 里操作）────────────────── */
  async function lockEnableNow() {
    syncModules();
    if (!Store.canEncrypt()) { UI.toast("当前环境不支持加密接口，没法开启应用加密", true); renderLockState(); return; }
    const pass = await askPass("设置开机口令", "至少 4 位。口令只以「加盐散列」存本机，App 不保存明文、也没法反推。忘了它只能靠 AI 现场出题，或者事先抄下的恢复码。", true);
    if (pass === null) { renderLockState(); return; }
    if (pass.length < 4) { UI.toast("口令太短了，至少 4 位", true); renderLockState(); return; }
    const saltU8 = lockRand(16);
    if (!saltU8) { UI.toast("生成随机盐失败", true); renderLockState(); return; }
    const salt = lockB64(saltU8);
    state.settings = Store.saveSettings({ lockSalt: salt });     /* 先落盐，散列要用它 */
    const h = await lockDigest(pass);
    if (!h) { UI.toast("算口令散列失败", true); renderLockState(); return; }
    const code = lockNewCode();
    const ch = code ? await lockDigest("code|" + lockNormCode(code)) : "";
    if (!ch) { UI.toast("生成恢复码失败", true); renderLockState(); return; }
    lockSave({ lockEnabled: true, lockSalt: salt, lockHash: h, lockCodeHash: ch, lockCodeUsed: false, lockFail: 0, lockUntil: 0 });
    codeShow(code);
    UI.toast("已开启应用加密");
  }
  async function lockDisableNow() {
    syncModules();
    const pass = await askPass("关闭应用加密", "先输入当前口令，确认是本人操作。", false);
    if (pass === null) { renderLockState(); return; }
    const h = await lockDigest(pass);
    if (!h || h !== lockNow().lockHash) { UI.toast("口令不对，没有关闭", true); renderLockState(); return; }
    lockSave({ lockEnabled: false, lockSalt: "", lockHash: "", lockCodeHash: "", lockCodeUsed: false, lockFail: 0, lockUntil: 0 });
    UI.toast("已关闭应用加密");
  }
  async function lockChangePass() {
    syncModules();
    if (!lockIsOn()) { UI.toast("还没有开启应用加密", true); return; }
    const old = await askPass("改口令", "先输入当前口令。", false);
    if (old === null) return;
    const h0 = await lockDigest(old);
    if (!h0 || h0 !== lockNow().lockHash) { UI.toast("当前口令不对", true); return; }
    const pass = await askPass("设置新口令", "新口令至少 4 位。改完会给你一串新的恢复码。", true);
    if (pass === null) return;
    if (pass.length < 4) { UI.toast("口令太短了，至少 4 位", true); return; }
    const h = await lockDigest(pass);
    if (!h) { UI.toast("算口令散列失败", true); return; }
    const code = lockNewCode();
    const ch = code ? await lockDigest("code|" + lockNormCode(code)) : "";
    if (!ch) { UI.toast("生成恢复码失败", true); return; }
    lockSave({ lockEnabled: true, lockHash: h, lockCodeHash: ch, lockCodeUsed: false, lockFail: 0, lockUntil: 0 });
    codeShow(code);
    UI.toast("口令已更新");
  }
  async function lockResetCode() {
    syncModules();
    if (!lockIsOn()) { UI.toast("还没有开启应用加密", true); return; }
    const pass = await askPass("重设恢复码", "先输入当前口令。", false);
    if (pass === null) return;
    const h = await lockDigest(pass);
    if (!h || h !== lockNow().lockHash) { UI.toast("口令不对", true); return; }
    const code = lockNewCode();
    const ch = code ? await lockDigest("code|" + lockNormCode(code)) : "";
    if (!ch) { UI.toast("生成恢复码失败", true); return; }
    lockSave({ lockCodeHash: ch, lockCodeUsed: false });
    codeShow(code);
  }
  async function lockToggle() {
    syncModules();
    const want = checkedOf("#setLockEnabled");
    if (want === lockIsOn()) { renderLockState(); return; }
    if (want) await lockEnableNow(); else await lockDisableNow();
    renderLockState();
  }

  /* ── 自注册：把 app.js / chat.js / roleplay.js 仍要用的入口挂到 window.DL ───────
     写法与 chat.js / roleplay.js 一致：app.js 里保留同名的「转发壳」（只转发、不实现），
     运行时再转到这里来。⚠️ 这里挂的名字，app.js 的 window.DL 字面量里不能再写一遍，
     否则会转发到它自己、无限递归。

     外面套一层只为在每次进入公开入口前重取一遍模块（syncModules）——
     打包工具若不按 index.html 顺序执行脚本，这是唯一能兜住「模块晚到」的地方。 */
  var api = {
    introShow: introShow, introFinish: introFinish, introNext: introNext, introPrev: introPrev,
    openIntro: openIntro,
    doExportDownload: doExportDownload, doExportShare: doExportShare, doExportCopy: doExportCopy,
    importFromText: importFromText, importFromFile: importFromFile, syncExportScope: syncExportScope,
    openData: openData, saveImage: saveImage,
    snapshotSession: snapshotSession, sessionsForExport: sessionsForExport, saveSnapshot: saveSnapshot,
    maybeAutoBackup: maybeAutoBackup, backupNow: backupNow, restoreBackupNow: restoreBackupNow,
    renderBackupLine: renderBackupLine, renderCharUsage: renderCharUsage, recordUsage: recordUsage,
    renderUsageStats: renderUsageStats, migrateData: migrateData,
    resetGroup: resetGroup, resetAllSettings: resetAllSettings,
    fillSettings: fillSettings, syncRangeLabels: syncRangeLabels, syncProviderFields: syncProviderFields,
    renderModelSets: renderModelSets, readAllSets: readAllSets, parseModels: splitModels,
    toggleModelPanel: toggleModelPanel, closeModelPanel: closeModelPanel, renderModelBadge: renderModelBadge,
    readSettingsForm: readSettingsForm, syncChip: syncChip, syncToggles: syncToggles,
    selfTest: selfTest,

    /* D2 应用加密（锁屏层 + 找回 + 设置页那段） */
    lockGate: lockGate, lockAppReady: lockAppReady,
    lockSubmit: lockSubmit, lockForgot: lockForgot, lockBackToPass: lockBackToPass,
    recSubmit: recSubmit, quizStart: quizStart, quizSubmit: quizSubmit, quizGiveUp: quizGiveUp,
    lockResetSave: lockResetSave, lockResetBack: lockResetBack, lockQuit: lockQuit,
    lockToggle: lockToggle, lockChangePass: lockChangePass, lockResetCode: lockResetCode,
    codeCopy: codeCopy, codeClose: codeClose, renderLockState: renderLockState
  };
  Object.keys(api).forEach(function (k) {
    D[k] = function () { syncModules(); return api[k].apply(null, arguments); };
  });

  /* 脚本一跑就先决定「要不要关门」。放在这儿是为了不依赖 app.js 的执行顺序。 */
  try { lockInitialCover(); } catch (e) { console.warn("[DeepLink] 锁屏层初始化失败", e); }

  window.__dlScripts.push("settings.js");
  return true;
  }

  /* 正常情况（app.js 先执行）第一次就成功；否则等 DOM 就绪 + 再补拍几次 */
  if (!boot()) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    let tries = 0;
    const retry = () => { if (boot()) return; if (++tries < 20) setTimeout(retry, 150); };
    setTimeout(retry, 150);
  }
})();
