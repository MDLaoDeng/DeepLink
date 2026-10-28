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
  var booted = false;  /* boot 幂等：DOMContentLoaded 与补拍 retry 各会调一次，别重复绑事件 / 分裂状态 */
  function boot() {
    if (booted) return true;
  var D = window.DL;
  if (!D) return false;
  booted = true;   /* 已真正初始化过，后续再被调用直接返回 */

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

  /* 引导页第 2 屏只放第一层（10-27）：整棵树 60+ 行，手机上一屏要滚半天，
     而这一屏的活是「先让人知道能干什么」，细节留给使用指南。 */
  function featureTop(tree) {
    return String(tree || "").split("\n").filter(function (ln) {
      return /^[├└]─\s/.test(ln);
    }).map(function (ln) {
      return "· " + ln.replace(/^[├└]─\s*/, "");
    }).join("\n");
  }

  function openIntro() {
    setText("#introTree", featureTop(CONFIG.FEATURE_TREE));
    introShow(0);
    UI.openModal("introModal");
    /* 整页引导（10-27）：样式表里那套在这台内核上没完全压住顶栏/输入栏
       （它们 position:fixed 且层级更高），这里用内联样式兜一次 —— 内联优先级最高，
       一定能盖住。颜色从主题变量取，不写死。 */
    try {
      var m = document.getElementById("introModal");
      if (!m) return;
      var cs = getComputedStyle(document.body);
      var panel = String(cs.getPropertyValue("--panel") || "").replace(/^\s+|\s+$/g, "") || "#1B1D23";
      m.style.zIndex = "210";
      m.style.backgroundColor = panel;
      m.style.alignItems = "stretch";
      /* 最狠也最稳的一招：打开引导时把主界面整块藏起来。
         顶栏/输入栏是 position:fixed 且层级压着 .modal，z-index 抬到 210 都还透 ——
         与其继续跟层叠较劲，不如让下面那层直接不可见。 */
      var app = document.getElementById("app");
      if (app) app.style.visibility = "hidden";
      var sheet = m.querySelector(".modal-sheet");
      if (sheet) {
        sheet.style.height = "100%";
        sheet.style.maxHeight = "none";
        sheet.style.margin = "0";
        sheet.style.borderRadius = "0";
        sheet.style.backgroundColor = panel;
      }
    } catch (e) { /* 内联兜底失败也不影响引导流程 */ }
  }

  /* app.js 的「上一步」按钮原来是 `introShow(introIdx - 1)` —— introIdx 是数值、不能挂到 D 上
     （挂上去就是快照，永远停在 0），所以包一个 introPrev 给外面用。 */
  function introPrev() { introShow(introIdx - 1); }

  function introFinish() {
    state.settings = Store.saveSettings({ onboarded: true });
    UI.closeModal("introModal");
    /* 引导结束 → 把主界面放回来（打开时藏过，见 openIntro） */
    try { var app = document.getElementById("app"); if (app) app.style.visibility = ""; } catch (e) { /* ignore */ }
  }

  function introNext() {
    const n = document.querySelectorAll("#introModal .intro-page").length;
    if (introIdx >= n - 1) introFinish(); else introShow(introIdx + 1);
  }

  /* ── 数据导入导出 + 自动备份 ───────────────────── */
  /* 导出时抹掉的字段。lock* 也要抹：口令门的凭据不该跟着文件走，
     换机导入后带着一把别人家的锁，自己都解不开。 */
  const KEY_FIELDS = ["apiKey", "tavilyKey", "customSearchKey", "asrKey", "ttsKey", "imgKey", "visionKey", "videoKey", "musicKey",
    "lockSalt", "lockHash", "lockCodeHash"];

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

  /* 导入「不含密钥」的设置时，配置库会被空串覆盖 —— 而 store 读盘是按配置库
     重算扁平字段的，于是重启后所有 Key 都变空（当下还看得到 Key，第二天全 401）。
     这里按【配置身份】沿用本机 Key：型号+地址 → 型号 → 同序位 三级匹配。
     为什么不按序位：用户在别处增删过一行模型配置，下标就错开了，
     Key 会串到别的服务商头上 —— 请求发得出去、扣的是别人家的钱，或者直接 401。 */
  function mergeSetsKeepKey(inSets, localSets) {
    const KINDS = ["main", "asr", "tts", "img", "vision"];
    /* 先原样带上所有区，再对已知的五个区做「沿用本机 Key」——
       以后新增模型区也不会因为没写进 KINDS 而被整个丢掉。 */
    const out = Object.assign({}, inSets || {});
    KINDS.forEach(function (k) {
      const a = Array.isArray(inSets && inSets[k]) ? inSets[k] : [];
      const b = Array.isArray(localSets && localSets[k]) ? localSets[k] : [];
      out[k] = a.map(function (set, i) {
        const o = Object.assign({}, set);
        if (o.apiKey) return o;                    /* 导入文件自己带了 Key，优先 */
        const sameModel = function (x) { return x && (x.model || "") === (o.model || ""); };
        const sameBoth = function (x) {
          return sameModel(x) && (x.baseUrl || "") === (o.baseUrl || "");
        };
        const hit = b.filter(sameBoth)[0] || b.filter(sameModel)[0] || b[i];
        if (hit && hit.apiKey) o.apiKey = hit.apiKey;
        return o;
      });
    });
    return out;
  }

  /* 「不含密钥」导出的文件里，9 个密钥字段是**空串**（不是没有这个键）。
     导入时若原样 saveSettings（Object.assign），空串会把本机已经填好的 Key 覆盖成空。
     所以导入前先把空出来的密钥字段整个删掉 —— 保留本机值，也保留导入文件里的非空值。 */
  function stripEmptyKeys(s) {
    if (!s || typeof s !== "object") return s;
    const o = Object.assign({}, s);
    KEY_FIELDS.forEach((k) => { if (!o[k]) delete o[k]; });
    if (o.modelSets && typeof o.modelSets === "object") {
      const sets = {};
      Object.keys(o.modelSets).forEach((kind) => {
        const list = o.modelSets[kind];
        sets[kind] = Array.isArray(list)
          ? list.map((p) => { const q = Object.assign({}, p); if (!q.apiKey) delete q.apiKey; return q; })
          : list;
      });
      o.modelSets = sets;
    }
    return o;
  }

  /* 角色个人图库要跟「它所属的角色 / 会话」一起走（用户口径）。
     导出对象是**副本**（Object.assign），绝不往实时数据上挂 __charImages，
     否则下一次 saveCharacters 就把它当角色字段存进本机了。 */
  function withCharImages(list, drop) {
    return (list || []).map(function (c) {
      if (!c || !c.id) return c;
      const copy = Object.assign({}, c);
      const dump = Store.dumpCharImages([c.id], drop);
      if (dump[c.id] && dump[c.id].length) copy.__charImages = dump[c.id];
      return copy;
    });
  }

  function buildExportData(scope, withKeys) {
    const noImg = checkedOf("#exportNoImg");
    if (scope === "full") {
      return {
        settings: withKeys ? Store.getSettings() : stripKeys(Store.getSettings()),
        characters: withCharImages(Store.getCharacters(), noImg),
        sessions: sessionsForExport(),
        charImages: Store.dumpCharImages(null, noImg),
        /* 这三块以前不在导出里：换机以后动态、用量、助手记忆全丢，而且没有别的迁移路径 */
        moments: Store.getMoments(),
        usage: Store.getUsage(),
        usageCats: Store.getUsageCats(),
        assistantMemory: Store.getAssistantMemory()
      };
    }
    if (scope === "settings") return withKeys ? Store.getSettings() : stripKeys(Store.getSettings());
    if (scope === "characters") return withCharImages(Store.getCharacters(), noImg);
    if (scope === "character") {
      /* 10-27 用户口径：只导某个角色时，要连它的**所有线**一起带走
         —— 记忆、关系网、对「我」的认知全在会话里，只导卡等于什么都没带。 */
      const cid = $v("#exportCharSel");
      const ch = Store.getCharacters().filter((c) => c.id === cid)[0] || null;
      if (!ch) return null;
      const pack = withCharImages([ch], noImg)[0] || ch;
      const ss = sessionsForExport().filter((s) => (s.characterId || "") === cid);
      return { character: pack, sessions: ss };
    }
    if (scope === "session") {
      const s = sessionsForExport().find((x) => x.id === $v("#exportSessionSel"));
      if (!s) return null;
      const dump = Store.dumpCharImages([s.characterId], noImg);
      if (s.characterId && dump[s.characterId] && dump[s.characterId].length) s.__charImages = dump[s.characterId];
      return s;
    }
    return null;
  }

  /* 导出：先让用户设口令，整个 payload 用这个口令加密（口令不存进 App） */
  /* 导出要能「换机带得走」：本机图片已经落到文件里（imgRef），导出必须重新内联成 dataUrl，
     否则换台手机后那些引用全指不到东西、图片全变「已过期」。
     勾了「不含原图」就把图片整个丢掉（只留 name/kind/desc），文件更小、更适合分享。
     注意：sessionsForExport 给的是【浅拷贝】（messages 与实时数据同一份），
     所以这里必须再复制一层附件，绝不能就地改 —— 否则会把正在用的数据改坏。 */
  function inlineAttachList(msgs, drop) {
    return (msgs || []).map((m) => {
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
  }
  function inlineExportImages(list, drop) {
    (list || []).forEach((s) => {
      if (!s) return;
      s.messages = inlineAttachList(s.messages, drop);
      /* 手机消息（session.phone.msgs）里的图同样要内联，否则换机后手机聊天里的图全变「已过期」。
         s.phone 在浅拷贝里与实时数据是同一个对象引用，必须先复制一层再替换 msgs，
         绝不能就地改 —— 那会把正在用的数据改坏。 */
      if (s.phone && s.phone.msgs) {
        s.phone = Object.assign({}, s.phone, { msgs: inlineAttachList(s.phone.msgs, drop) });
      }
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
    /* 本机没有 WebCrypto 时 sealWithPass 会降级成「口令混淆」。这个必须说出来：
       否则用户以为文件是加密的，其实只能挡住「随手打开」。 */
    if (!Store.canEncrypt()) {
      UI.toast("这台设备不支持真加密，导出文件用的是口令混淆（能挡住随手打开，挡不住专门破解）。有条件的话换一台设备再导出一次。", true);
    }
    return { app: "Sekulum", kind: kind, appVersion: CONFIG.APP_VERSION, exportedAt: new Date().toISOString(), enc: enc };
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
  /* 目录候选统一由 Store 提供（10-23）：这里、图片保存、文档导出共用同一份规则，
     路径策略以后再改只改 store.js 一处。 */
  function shareDirCandidates() {
    try {
      if (Store && Store.fileDirs) return Store.fileDirs();
    } catch (e) { /* 老版本没有这个方法，落到下面的兜底 */ }
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
    /* 角色个人图库随角色一起进来（先摘掉 __charImages，别让它变成角色字段存进本机） */
    const imgs = {};
    valid.forEach((c) => { if (c.__charImages) { imgs[c.id] = c.__charImages; delete c.__charImages; } });
    if (Object.keys(imgs).length && Store.restoreCharImages) Store.restoreCharImages(imgs);
    const list = Store.getCharacters();
    const collide = valid.filter((c) => list.some((x) => x.id === c.id));
    if (collide.length) {
      const ok = await UI.confirmDialog("导入角色", collide.length + " 个角色与现有同 ID，将覆盖现有的，确定？");
      if (!ok) return false;
    }
    valid.forEach((c) => { const i = list.findIndex((x) => x.id === c.id); if (i >= 0) list[i] = c; else list.push(c); });
    /* 落盘被拒（存储只读 / 读失败锁定）时要如实报失败，别报「导入完成」骗人 */
    if (Store.saveCharacters(list) === false) { UI.toast("导入未写入：存储只读或被锁定", true); return false; }
    return true;
  }

  async function importSessions(arr) {
    const valid = (arr || []).filter((s) => s && s.id && Array.isArray(s.messages));
    if (!valid.length) { UI.toast("没有有效的会话数据", true); return false; }
    /* 会话里可能带着它那条角色线的图库（导出时挂在 __charImages 上），同样先摘出来 */
    const imgs = {};
    valid.forEach((s) => {
      if (!s.__charImages) return;
      if (s.characterId) imgs[s.characterId] = s.__charImages;
      delete s.__charImages;
    });
    if (Object.keys(imgs).length && Store.restoreCharImages) Store.restoreCharImages(imgs);
    for (let k = 0; k < valid.length; k++) {
      const s = valid[k];
      /* 导出的文件里只带密文：记忆、认知，以及「当前场景 / 当前关系 / 共同经历」都在 memEnc 里。
         这里原来只解回前两项，三项被留成 undefined，紧跟的 saveSessions 就按空写回 ——
         表现是「导入完之后那三栏全空了」，而且不给任何提示（与「从备份恢复」那条同一个坑，
         那边当时补过、这条漏了）。 */
      if (s.memEnc && s.memory === undefined && s.cognition === undefined) {
        const txt = await Store.decryptMem(s.memEnc);
        if (txt) {
          try {
            const p = JSON.parse(txt);
            s.memory = p.memory;
            s.cognition = p.cognition;
            MEM_EXTRA_FIELDS.forEach((k2) => { if (p[k2] !== undefined) s[k2] = p[k2]; });
          } catch (e) { /* ignore */ }
        }
      }
    }
    const list = Store.getSessions();
    const collide = valid.filter((s) => list.some((x) => x.id === s.id));
    if (collide.length) {
      const ok = await UI.confirmDialog("导入会话", collide.length + " 个会话与现有同 ID，将覆盖现有的，确定？");
      if (!ok) return false;
    }
    valid.forEach((s) => { const i = list.findIndex((x) => x.id === s.id); if (i >= 0) list[i] = s; else list.unshift(s); });
    /* 同上：落盘被拒要如实报失败 */
    if (Store.saveSessions(list) === false) { UI.toast("导入未写入：存储只读或被锁定", true); return false; }
    return true;
  }

  /* 导入来的 settings 必须先过一遍白名单：
     ① 本地不认识的键一律丢弃（文件里塞什么进来都不影响本机）
     ② lock* 全部忽略 —— 文件里带个 lockHash 就能把人锁在门外，这是唯一有实际风险的一条
     ③ modelSets 每个区最多 6 套（与界面上限一致）
     ④ 极端超长的文本字段（背景图 base64）截断，防止一导入就把存储顶满 */
  function sanitizeImportSettings(d) {
    const src = (d && typeof d === "object") ? d : {};
    const out = {};
    Object.keys(src).forEach((k) => {
      if (!(k in CONFIG.DEFAULT_SETTINGS)) return;
      if (/^lock/i.test(k)) return;
      let v = src[k];
      if (typeof v === "string" && v.length > 4 * 1024 * 1024) v = "";
      out[k] = v;
    });
    if (out.modelSets && typeof out.modelSets === "object") {
      const sets = {};
      Object.keys(out.modelSets).forEach((kind) => {
        const arr = out.modelSets[kind];
        sets[kind] = Array.isArray(arr) ? arr.slice(0, 6) : arr;
      });
      out.modelSets = sets;
    }
    return out;
  }

  async function applyImport(payload) {
    if (!payload || typeof payload !== "object" || payload.app !== "Sekulum" && payload.app !== "deeplink") { UI.toast("不是 Sekulum 的导出数据", true); return false; }
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
      const d = stripEmptyKeys(data);
      if (d.modelSets) d.modelSets = mergeSetsKeepKey(d.modelSets, Store.getSettings().modelSets);
      state.settings = Store.saveSettings(sanitizeImportSettings(d));
      return true;
    }
    /* 10-27：新格式是 { character, sessions }（角色 + 它的所有线）；
       老格式直接就是角色卡本身 —— 两种都要认，不然老的导出文件导不进来。 */
    if (kind === "character") {
      if (data && data.character && typeof data.character === "object") {
        let ok = await importCharacters([data.character]);
        if (Array.isArray(data.sessions) && data.sessions.length) {
          ok = (await importSessions(data.sessions)) && ok;
        }
        return ok;
      }
      return importCharacters([data]);
    }
    if (kind === "characters") return importCharacters(data);
    if (kind === "session") return importSessions([data]);
    if (kind === "full") {
      if (data && data.settings) state.settings = Store.saveSettings(sanitizeImportSettings(data.settings));
      let ok = true;
      if (data && Array.isArray(data.characters)) ok = (await importCharacters(data.characters)) && ok;
      if (data && Array.isArray(data.sessions)) ok = (await importSessions(data.sessions)) && ok;
      /* 全量导出时图库是单独一块（charImages: {角色id: [...]}） */
      if (data && data.charImages && Store.restoreCharImages) Store.restoreCharImages(data.charImages);
      /* 动态 / 用量 / 助手记忆：文件里有才恢复。老文件没带这几块，跳过即可，不报错 */
      if (data && Array.isArray(data.moments)) Store.saveMoments(data.moments);
      if (data && data.usage) Store.saveUsage(data.usage);
      if (data && data.usageCats) Store.saveUsageCats(data.usageCats);
      if (data && data.assistantMemory) Store.saveAssistantMemory(data.assistantMemory);
      return ok;
    }
    UI.toast("无法识别的导出类型：" + kind, true);
    return false;
  }

  async function importFromText() {
    const txt = $v("#importText").trim();
    if (!txt) { UI.toast("先粘贴 JSON 或选文件", true); return; }
    let payload;
    try { payload = JSON.parse(txt); } catch (e) { UI.toast("JSON 解析失败：" + (e.message || e), true); return; }
    if (await applyImport(payload)) { migrateData(false); fillSettings(); UI.toast("导入完成"); syncToggles(); renderAll(); renderDataSelects(); }
  }

  async function importFromFile(file) {
    try {
      const txt = await file.text();
      let payload;
      try { payload = JSON.parse(txt); } catch (e) { UI.toast("文件不是有效 JSON", true); return; }
      if (await applyImport(payload)) { migrateData(false); fillSettings(); UI.toast("导入完成"); syncToggles(); renderAll(); renderDataSelects(); }
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

  /* 把任意 data URL 写进「无需存储权限」的那几个候选目录（图片保存走这条）。
     复用 shareDirCandidates，不再自己拼路径 —— 以前图片保存用的是 <a download>，
     在 WebView 里点了基本没反应，只能提示「若无反应可长按图片保存」，等于把问题甩给用户。
     成功返回完整路径，全失败返回 ""。 */
  function writeDataUrlToSafeDirs(name, dataUrl) {
    let dirs = [];
    try { dirs = shareDirCandidates().safe; } catch (e) { dirs = []; }
    for (let i = 0; i < dirs.length; i++) {
      const cand = dirs[i] + "/Sekulum/" + name;
      try {
        const w = Store.callBridge("保存指定文件", cand, dataUrl);
        if (w === false) continue;
        if (Store.hasBridge("判断指定文件") && Store.callBridge("判断指定文件", cand) === false) continue;
        return cand;
      } catch (e) { /* 这个目录不通就试下一个 */ }
    }
    return "";
  }

  /* 保存图片（AI 文生图 / 自己发的图都走这里） */
  function saveImage(src, name) {
    if (!src) { UI.toast("没有可保存的图片", true); return; }
    const base = String(name || ("Sekulum_" + Date.now())).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "image";
    const file = /\.(png|jpe?g|webp|gif)$/i.test(base) ? base : base + ".png";
    /* 有桥就正经落盘（文件管理器能直接看见），路径也告给用户 */
    if (String(src).slice(0, 5) === "data:" && Store.hasBridge("保存指定文件")) {
      const path = writeDataUrlToSafeDirs(file, src);
      if (path) { UI.toast("已保存：" + path); return; }
    }
    /* 外置图（imgRef 那种）本来就是盘上的文件，不需要「再存一次」 */
    if (String(src).slice(0, 5) !== "data:" && Store.hasBridge && Store.hasBridge("保存指定文件")) {
      UI.toast("这张是盘上的图片文件，直接在文件管理器里找就行");
      return;
    }
    /* 只有浏览器预览（没有桥）才走下载兜底 */
    try {
      const a = document.createElement("a");
      a.href = src;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      UI.toast("已尝试下载（浏览器预览用）");
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
    renderStoragePanel();
  }

  /* ── 「存储」区（用户要求：把原「数据」模块并进来，并按类型显示占比）──
     口径（界面下方也写了一份，免得看数字犯迷糊）：
     ① 键值类数据按字符估算，1 字符 ≈ 2 字节；
     ② 图片是外置文件，用原生的「获取文件大小」读真实字节；
     ③ 只统计 App 自己写的数据，不含安装包本体与 WebView 缓存。 */

  /* 外置图片文件（对话图 dl_img_ / 角色图 dl_cimg_）的真实占用。
     「获取目录排列」返回的是用 \ 分段的字符串，这里只认我们自己那两个前缀，
     顺带把「不属于本 App 的文件」全过滤掉。无桥环境直接返回 0。 */
  function imageFileBytes() {
    const out = { bytes: 0, count: 0 };
    if (!Store.hasBridge("获取目录排列") || !Store.hasBridge("获取文件大小")) return out;
    /* 目录要和 Store 的 imgDir() 保持一致：内部文件目录优先，退到外部文件目录 */
    let dir = "";
    try { dir = String(Store.callBridge("获取内部文件目录") || ""); } catch (e) { dir = ""; }
    if (!dir) { try { dir = String(Store.callBridge("获取外部文件目录") || ""); } catch (e) { dir = ""; } }
    if (!dir) return out;
    dir = dir.replace(/\/+$/, "");
    /* 三个前缀都算本 App 的：对话图 dl_img_、角色图/表情包 dl_cimg_、背景图 dl_bg_。
       以前只认前两个，而且只扫根目录 —— 但角色图其实是写在 charimg/ 子目录里的，
       结果是「存储占用」里图片那一项长期偏低，用户看到的数字和实际不符。 */
    const PREFIXES = ["dl_img_", "dl_cimg_", "dl_bg_"];
    const isOurs = function (name) {
      for (let i = 0; i < PREFIXES.length; i++) {
        if (String(name).indexOf(PREFIXES[i]) === 0) return true;
      }
      return false;
    };
    const scan = function (base, allowSub) {
      let list = "";
      try { list = String(Store.callBridge("获取目录排列", base + "/") || ""); } catch (e) { list = ""; }
      String(list).split("\\").forEach(function (raw) {
        const item = String(raw).trim();
        if (!item) return;
        if (item.charAt(item.length - 1) === "/") {
          /* 子目录：图片就存在 charimg/ 里，进去扫一层（只往下走一层，避免死循环） */
          if (allowSub && item.replace(/\/+$/, "") === "charimg") scan(base + "/charimg", false);
          return;
        }
        if (!isOurs(item)) return;
        let sz = 0;
        try { sz = Number(Store.callBridge("获取文件大小", base + "/" + item)) || 0; } catch (e) { sz = 0; }
        out.count++;
        out.bytes += sz;
      });
    };
    scan(dir, true);
    return out;
  }

  function renderStoragePanel() {
    const box = $("#storageBars");
    if (!box) return;
    const fmt = function (n) {
      const b = Number(n) || 0;
      if (b < 1024) return b + " B";
      if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
      return (b / 1048576).toFixed(2) + " MB";
    };
    const groups = [
      { name: "对话消息", keys: ["aicode.sessions.v1"] },
      { name: "角色卡", keys: ["aicode.characters.v1"] },
      { name: "记忆与用量", keys: ["aicode.assistantmem.v1", "aicode.usage.v1", "aicode.usagecat.v1", "aicode.devsalt.v1"] },
      { name: "动态", keys: ["aicode.moments.v1"] },
      { name: "备份快照", keys: ["aicode.backups.v1"] },
      { name: "图库索引", keys: ["aicode.charimg.v1"] },
      { name: "设置", keys: ["aicode.settings.v1", "aicode.current.v1"] }
    ];
    const native = Store.storageBackend() === "native";
    const rows = [];
    groups.forEach(function (g) {
      let b = 0;
      g.keys.forEach(function (k) {
        try {
          const v = native ? Store.callBridge("获取指定文本", k, "") : localStorage.getItem(k);
          if (v) b += (String(k).length + String(v).length) * 2;
        } catch (e) { /* 某一项读不出来就跳过，别让整块统计挂掉 */ }
      });
      if (b > 0) rows.push({ name: g.name, size: b, extra: "" });
    });
    const im = imageFileBytes();
    if (im.count) rows.push({ name: "图片文件", size: im.bytes, extra: im.count + " 张" });
    let total = 0;
    rows.forEach(function (r) { total += r.size; });
    const sum = $("#storageSum");
    if (sum) sum.textContent = total ? ("本机共占约 " + fmt(total) + "，" + rows.length + " 类") : "暂时没有可统计的数据";
    box.innerHTML = "";
    rows.sort(function (a, b) { return b.size - a.size; });
    rows.forEach(function (r) {
      const line = document.createElement("div");
      line.className = "st-row";
      const nm = document.createElement("span");
      nm.className = "st-name";
      nm.textContent = r.name;
      const bar = document.createElement("span");
      bar.className = "st-bar";
      const fill = document.createElement("i");
      fill.className = "st-fill";
      fill.style.width = (total ? Math.max(3, Math.round(r.size / total * 100)) : 0) + "%";
      bar.appendChild(fill);
      const val = document.createElement("span");
      val.className = "st-val";
      val.textContent = fmt(r.size) + (r.extra ? "，" + r.extra : "");
      line.appendChild(nm); line.appendChild(bar); line.appendChild(val);
      box.appendChild(line);
    });
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
      /* imgRef 必须留着：它是外置图片的路径（几十字节）。丢了它，恢复备份后
         该会话所有图片永久「已过期」，而且写盘后不可回滚。 */
      c.attachments = m.attachments.map((a) => ({ name: a.name, kind: a.kind, mime: a.mime, size: a.size, desc: a.desc, imgRef: a.imgRef }));
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
    /* 图库跟着这条会话（即它的角色线）一起备份进来。
       只带**最近 3 张**：备份每会话留 2 份，把 12 张全内联进去会把存储撑得很难看；
       「以前画过什么」靠文字摘要就能保住人物一致性，图多一张少一张影响不大。 */
    if (s.characterId && Store.dumpCharImages) {
      const dump = Store.dumpCharImages([s.characterId], false, 3);
      if (dump[s.characterId] && dump[s.characterId].length) sess.__charImages = dump[s.characterId];
    }
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
    /* 备份里的图库也装回去（同 id 的会跳过，反复恢复不会翻倍） */
    if (restored.__charImages) {
      if (restored.characterId && Store.restoreCharImages) {
        const im = {};
        im[restored.characterId] = restored.__charImages;
        Store.restoreCharImages(im);
      }
      delete restored.__charImages;
    }
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
    return "输入 " + fmtNum(u.prompt) + "　输出 " + fmtNum(u.completion) + "　总计 " + fmtNum(u.total) + "　缓存命中 " + cacheRate(u) + "%";
  }

  /* 消耗类型（用量统计里按类型看花费）。除对话外的每一项也都在这里显示，
     不会因为「不是聊天」就不计账。 */
  const USAGE_CATS = [
    { id: "chat", name: "对话" },
    { id: "memory", name: "记忆压缩 / 认知" },
    { id: "daily", name: "日更（场景 / 关系 / 经历）" },
    { id: "world", name: "世界生成" },
    { id: "group", name: "群聊" },
    /* 6.2.6：文档评析是独立的一次模型调用，以前没有分类、界面直接显示 "doc" */
    { id: "doc", name: "文档评析" },
    { id: "moment", name: "发布动态筛选" },
    { id: "summary", name: "助手总结" },
    /* 10-25 补：这两件事以前没传类型，被算进「对话」，看不出来花了多少 */
    { id: "split", name: "角色拆分" },
    /* 10-26 补：AI 创建（一句话生成整张卡）也是独立调用，别混进「角色拆分」里看不出成本 */
    { id: "create", name: "AI 创建" },
    { id: "filter", name: "过滤规则" },
    { id: "phone", name: "手机" },
    { id: "auto", name: "自动发信息" },
    { id: "quickreply", name: "快捷回复" },
    /* 6.2.2 新增两类：这两件事都是真实的模型调用，以前混在「其它 / 记忆压缩」里看不清 */
    { id: "sticker", name: "表情包命名" },
    /* 10-25 补：图片描述也是独立的视觉模型调用，以前没类型，混在「对话」里 */
    { id: "vision", name: "图片描述" },
    /* 10-25 补：视频 / 音乐生成的提示词是独立的一次模型调用。
       以前把 kind（"video" / "music"）直接当分类传进来，但表里没有这两项，
       「按类型」只渲染表内的 id —— 这两笔钱一直没人看见，而「合计」里有，两处对不上。 */
    { id: "video", name: "视频生成" },
    { id: "music", name: "音乐生成" },
    { id: "caps", name: "模型能力检测" },
    { id: "think", name: "TA 的思考" },
    /* 10-27 补：性格变化「规划路线」是一次独立调用，以前记在「角色拆分」里看不出来 */
    { id: "drift", name: "性格变化（路线规划）" },
    { id: "fork", name: "回溯重建" },
    { id: "other", name: "其它" }
  ];
  /* status / diary 这两个分类从来没有独立调用（状态量化、情绪日记都是并进对话回复里给的），
     界面永远显示 0，已从表里去掉。旧版本万一记过账，映射成「其它」——
     否则会显示成 status / diary 这种生 id。 */
  const OLD_CAT_ALIAS = { status: "状态量化（已并入对话）", diary: "情绪日记（已并入对话）" };
  function catName(id) {
    if (OLD_CAT_ALIAS[id]) return OLD_CAT_ALIAS[id];
    const c = USAGE_CATS.filter((x) => x.id === id)[0];
    return c ? c.name : id;
  }

  /* 估算花费（元）。单位都是「元 / 百万 tokens」。
     fuzzy（默认）：不分命中/未命中，按输入 / 输出两档粗算 —— 够用且不必较真。
     fixed：按你填的三档单价（缓存命中 / 未命中 / 输出）精确算。
     【为什么是估算】价目会变、缓存命中由服务端定，这里只是给你一个量级参考。 */
  function usageCost(u) {
    u = u || {};
    const s = state.settings || {};
    const pHit = Number(s.usagePriceHit); const pIn = Number(s.usagePriceIn); const pOut = Number(s.usagePriceOut);
    const hit = u.cacheHit || 0;
    const miss = (typeof u.cacheMiss === "number") ? u.cacheMiss : Math.max(0, (u.prompt || 0) - hit);
    const comp = u.completion || 0;
    /* 填 0 是合法输入（本地模型 / 免费额度 / 自己垫付），不能被当成「没填」按默认价算。
       判据改成「是个 >=0 的有限数」，而不是 >0。 */
    const rate = (v, d) => (typeof v === "number" && isFinite(v) && v >= 0) ? v : d;
    const inRate = rate(pIn, 2);
    const outRate = rate(pOut, 8);
    const hitRate = rate(pHit, 0.2);
    const cost = ((s.usagePriceMode || "fuzzy") === "fixed")
      ? (hit * hitRate + miss * inRate + comp * outRate) / 1e6
      : ((u.prompt || 0) * inRate + comp * outRate) / 1e6;
    return cost;
  }
  function fmtYuan(v) {
    v = v || 0;
    if (v <= 0) return "¥0";
    if (v < 0.01) return "¥" + v.toFixed(4);
    if (v < 1) return "¥" + v.toFixed(3);
    return "¥" + v.toFixed(2);
  }

  function usageCells(u) {
    u = u || {};
    return "<span class='u-cell'>输入 " + fmtNum(u.prompt) + "</span>" +
      "<span class='u-cell'>输出 " + fmtNum(u.completion) + "</span>" +
      "<span class='u-cell'>总计 " + fmtNum(u.total) + "</span>" +
      "<span class='u-cell'>缓存命中 " + cacheRate(u) + "%</span>" +
      "<span class='u-cell u-cost'>约 " + fmtYuan(usageCost(u)) + "</span>";
  }

  function renderCharUsage(ch) {
    const el = $("#charUsageLine");
    if (el) el.textContent = ch ? ("本角色累计：" + usageText(ch.usage)) : "";
  }

  /* 手机花费预警只报一次（同一次运行内），免得每次记账都弹 */
  let phoneWarned = false;

  /* 记一次用量：会话 / 角色 / 全局 / 按类型，并做预警。
     cat = 消耗类型，必须是 USAGE_CATS 里的 id。
     不传 / 传了表里没有的值 → 一律落「其它」并在控制台带调用栈点名：
     那说明有新调用漏登记，别让它静默混进别的桶（BUG-49 就是这么攒下十几处的）。 */
  const VALID_USAGE_CATS = {};
  USAGE_CATS.forEach(function (c) { VALID_USAGE_CATS[c.id] = 1; });

  function recordUsage(sid, u, characterId, cat) {
    if (!u) return;
    if (cat && !VALID_USAGE_CATS[cat]) {
      /* 表外分类：写进 usageCats 也没人渲染（「按类型」只遍历 USAGE_CATS），
         钱花了、账上看不见。并进「其它」并点名，否则这种错永远发现不了。 */
      try {
        console.warn("[Sekulum] recordUsage 未知分类「" + cat + "」，已并入「其它」", new Error().stack);
      } catch (e) { /* ignore */ }
      cat = "other";
    }
    if (!cat) {
      /* OPT-04：以前缺省会猜 chat / memory，于是漏传类型的用量静默混进主桶，
         看统计根本发现不了（BUG-49 就是这么攒下十几处的）。
         现在统一落「其它」并在控制台点名：「其它」突然变大 = 有新调用漏传了。 */
      cat = "other";
      try { console.warn("[Sekulum] recordUsage 未传类型，已记入「其它」", new Error().stack); } catch (e) { /* ignore */ }
    }
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
    /* 按类型累计：**除对话外的一切消耗也都记在这里**，用量统计里才看得到 */
    try {
      const cats = Store.getUsageCats();
      cats[cat] = Api.sumUsage(cats[cat], u);
      Store.saveUsageCats(cats);
    } catch (e) { /* ignore */ }
    if (u.prompt > (state.settings.tokenWarnThreshold || 30000)) {
      UI.toast("上下文已达 " + u.prompt + " tokens，花费可能偏高；可用「当前设定」里的「再压缩」提纯", true);
    }
    /* 手机单独一条花费预警（你在 D1 里选的口径：给手机这条线单开预警，并可细分） */
    try {
      const lim = Number(state.settings.phoneWarnYuan) || 0;
      if (lim > 0 && cat === "phone" && !phoneWarned) {
        const pu = Store.getUsageCats().phone || null;
        if (pu && usageCost(pu) >= lim) {
          phoneWarned = true;
          UI.toast("手机用量花费已达 " + fmtYuan(usageCost(pu)) + "，超过设定的 " + fmtYuan(lim) + "；在「用量统计 · 按类型」里看细分", true);
        }
      }
    } catch (e) { /* ignore */ }
  }

  function renderUsageStats() {
    const gEl = $("#usageGlobal");
    if (gEl) {
      const mode = (state.settings.usagePriceMode || "fuzzy") === "fixed" ? "固定计费标准" : "模糊估算";
      gEl.innerHTML = "<div class='usage-row'><span class='u-name'>合计</span>" + usageCells(Store.getUsage()) + "</div>" +
        "<p class='hint'>花费为估算值（当前按「" + mode + "」）。要更准可在「设置 → 用量花费」里填你自己的计费单价；要归零可在「设置 → 用量花费」里点「清零用量」。</p>";
    }
    /* 按类型：**除对话外的一切 AI 消耗**都在这里 */
    const catEl = $("#usageCats");
    if (catEl) {
      catEl.innerHTML = "";
      const cats = Store.getUsageCats();
      const ids = USAGE_CATS.map((c) => c.id).filter((id) => cats[id] && (cats[id].total || cats[id].prompt || cats[id].completion));
      if (!ids.length) catEl.innerHTML = "<div class='usage-empty'>暂无分类用量</div>";
      ids.forEach((id) => {
        const d = document.createElement("div");
        d.className = "usage-row";
        d.innerHTML = "<span class='u-name'>" + UI.escapeHtml(catName(id)) + "</span>" + usageCells(cats[id]);
        catEl.appendChild(d);
      });
    }
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
    } catch (e) { console.warn("[Sekulum] 数据迁移出错", e); }
  }

  /* ── 重置 ──────────────────────────────────────── */
  /* 注意：main/asr/tts/img/vision 五个模型区不在这里 —— 它们在 resetGroup() 里
     走「配置库」分支单独处理（既要重置生效值，也要把配置库缩回一套）。 */
  const RESET_GROUPS = {
    gen: ["temperature", "topP"],
    prompt: ["systemPrompt", "searchProvider", "searxngInstances", "customSearchUrl"],
    imgstore: ["imgToText", "imgExpireTurns"],
    memory: ["roleplayEnabled", "myName", "myPersona", "myAppearance", "myBackground", "myLikes", "assistantCompress", "compressModel", "tokenWarnThreshold", "notifyTasks"],
    feats: ["dailyUpdate", "worldGen", "statusQuant", "autoMessage", "autoMessageMin", "autoMessagePhone"],
    format: ["adoptFormat"],
    video: ["videoEnabled", "videoBaseUrl", "videoKey", "videoModel", "videoMode", "videoRatio", "videoSize",
      "videoDuration", "videoFps", "videoCreatePath", "videoStatusPath", "videoResultField",
      "videoPollMs", "videoPollMax", "videoTemplate"],
    music: ["musicEnabled", "musicBaseUrl", "musicKey", "musicModel", "musicDuration", "musicFormat",
      "musicWithLyrics", "musicCreatePath", "musicStatusPath", "musicResultField",
      "musicPollMs", "musicPollMax", "musicTemplate"],
    usageprice: ["usagePriceMode", "usagePriceHit", "usagePriceIn", "usagePriceOut", "phoneWarnYuan"]
  };

  const RESET_LABELS = { gen: "生成参数", prompt: "提示词与联网搜索", main: "主模型", asr: "听觉模型", tts: "朗读模型", img: "画图模型", vision: "视觉模型", imgstore: "图片存储", memory: "角色扮演与记忆压缩", feats: "功能开关", format: "采用格式", usageprice: "用量花费", video: "视频生成", music: "音乐生成" };

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
      if (key === "img") {
        patch.imgEnabled = !!def.imgEnabled;
        patch.imgSize = def.imgSize;
        patch.imgToImg = !!def.imgToImg;
        patch.phoneShareImg = !!def.phoneShareImg;
        patch.charMomentAuto = true;                /* 默认开 */
        patch.charMomentImg = !!def.charMomentImg;  /* 默认关 */
      }
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
    try { fillSettingsInner(); renderLockState(); } catch (e) { console.warn("[Sekulum] fillSettings 出错", e); }
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
    setChecked("#setImgToImg", !!s.imgToImg);
    setChecked("#setPhoneShareImg", !!s.phoneShareImg);
    setChecked("#setCharMoment", s.charMomentAuto !== false);   /* 默认开 */
    setChecked("#setMomentImg", !!s.charMomentImg);             /* 默认关 */

    setChecked("#setVisionEnabled", !!s.visionEnabled);

    /* 视频 / 音乐 */
    setChecked("#setVideoEnabled", !!s.videoEnabled);
    setVal("#setVideoBaseUrl", s.videoBaseUrl || "");
    setVal("#setVideoKey", s.videoKey || "");
    setVal("#setVideoModel", s.videoModel || "");
    setVal("#setVideoMode", s.videoMode || "t2v");
    setVal("#setVideoRatio", s.videoRatio || "16:9");
    setVal("#setVideoSize", s.videoSize || "");
    setVal("#setVideoDuration", s.videoDuration == null ? "" : String(s.videoDuration));
    setVal("#setVideoFps", s.videoFps == null ? "" : String(s.videoFps));
    setVal("#setVideoCreatePath", s.videoCreatePath || "");
    setVal("#setVideoStatusPath", s.videoStatusPath || "");
    setVal("#setVideoResultField", s.videoResultField || "");
    setVal("#setVideoPollMs", s.videoPollMs == null ? "" : String(s.videoPollMs));
    setVal("#setVideoPollMax", s.videoPollMax == null ? "" : String(s.videoPollMax));
    setVal("#setVideoTemplate", s.videoTemplate || "");

    setChecked("#setMusicEnabled", !!s.musicEnabled);
    setVal("#setMusicBaseUrl", s.musicBaseUrl || "");
    setVal("#setMusicKey", s.musicKey || "");
    setVal("#setMusicModel", s.musicModel || "");
    setVal("#setMusicDuration", s.musicDuration == null ? "" : String(s.musicDuration));
    setVal("#setMusicFormat", s.musicFormat || "mp3");
    setChecked("#setMusicWithLyrics", !!s.musicWithLyrics);
    setVal("#setMusicCreatePath", s.musicCreatePath || "");
    setVal("#setMusicStatusPath", s.musicStatusPath || "");
    setVal("#setMusicResultField", s.musicResultField || "");
    setVal("#setMusicPollMs", s.musicPollMs == null ? "" : String(s.musicPollMs));
    setVal("#setMusicPollMax", s.musicPollMax == null ? "" : String(s.musicPollMax));
    setVal("#setMusicTemplate", s.musicTemplate || "");

    setChecked("#setRoleplayEnabled", !!s.roleplayEnabled);
    setChecked("#setGroupWarn", !s.groupWarnOff);
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

    /* ── 6.0.0 新增：功能开关 / 采用格式 / 背景 / 用量花费 ── */
    setChecked("#setDailyUpdate", s.dailyUpdate !== false);
    setChecked("#setToolUse", s.toolUse !== false);
    setChecked("#setWorldGen", s.worldGen !== false);
    setChecked("#setEventBook", s.eventBook !== false);
    setChecked("#setStatusQuant", s.statusQuant !== false);
    setVal("#setStatusCards", cardNamesText(s.statusCards));
    setChecked("#setAutoMessage", !!s.autoMessage);
    setVal("#setAutoMessageMin", Number(s.autoMessageMin) || 30);
    setChecked("#setAutoMessagePhone", !!s.autoMessagePhone);
    setVal("#setAdoptFormat", s.adoptFormat || "");
    setVal("#setUsagePriceMode", s.usagePriceMode || "fuzzy");
    setVal("#setUsagePriceHit", (s.usagePriceHit == null ? "" : String(s.usagePriceHit)));
    setVal("#setUsagePriceIn", (s.usagePriceIn == null ? "" : String(s.usagePriceIn)));
    setVal("#setUsagePriceOut", (s.usagePriceOut == null ? "" : String(s.usagePriceOut)));
    setVal("#setPhoneWarn", (s.phoneWarnYuan == null ? "" : String(s.phoneWarnYuan)));
    setChecked("#setLive2dEnabled", !!s.live2dEnabled);
    setVal("#setLive2dModel", s.live2dModel || "");
    setVal("#setBgBlur", typeof s.bgBlur === "number" ? s.bgBlur : 0);
    setVal("#setBgBright", typeof s.bgBright === "number" ? s.bgBright : 100);
    /* 手机页背景（独立于聊天背景） */
    setVal("#setPhoneBgBlur", typeof s.phoneBgBlur === "number" ? s.phoneBgBlur : 0);
    setVal("#setPhoneBgBright", typeof s.phoneBgBright === "number" ? s.phoneBgBright : 100);
  /* ── 启动动画预览（10-29）─────────────────────────────
     六套动效以前只能「保存 → 重启 → 看」，试错一次要一次完整启动；
     更糟的是那五项设置本来根本没生效（见 app.js 的 applySplashSettings），怎么试都一样。
     这里把真启动页那套结构搬进一个小框里播 3 秒。
     ⚠️ 文案规则必须和 applySplashSettings 一字不差 —— 否则「预览看到的」和「真启动」两个样。
     ⚠️ 容器里不用 #splashW1 这类 id：同一份 id 出现两次，getElementById 只认第一个。 */
  var splashPrevTimer = 0;
  function playSplashPreview() {
    var box = document.getElementById("splashPreview");
    if (!box) return;
    var sel = document.getElementById("setSplashAnim");
    var anim = sel ? String(sel.value || "0") : "0";
    var tx = document.getElementById("setSplashText");
    var sb = document.getElementById("setSplashSub");
    var main = tx ? String(tx.value || "").trim() : "";
    var sub = sb ? String(sb.value || "").trim() : "";

    var w1 = main, w2 = "";
    if (!main) {
      if (anim === "0") { w1 = "你好，世界"; w2 = ""; }
      else { w1 = "Sek"; w2 = "ulum"; }
    }

    var sp = document.createElement("div");
    sp.className = "splash";
    sp.setAttribute("data-anim", anim);

    var stage = document.createElement("div");
    stage.className = "splash-stage";

    var mark = document.createElement("div");
    mark.className = "splash-mark";
    var s1 = document.createElement("span"); s1.className = "w1"; s1.textContent = w1;
    var s2 = document.createElement("span"); s2.className = "w2"; s2.textContent = w2;
    var ln = document.createElement("span"); ln.className = "splash-line";
    mark.appendChild(s1); mark.appendChild(s2); mark.appendChild(ln);

    var cr = document.createElement("div");
    cr.className = "splash-credit";
    cr.textContent = sub || "菠萝味柠檬汁/DS共同制作";

    sp.appendChild(stage); sp.appendChild(mark); sp.appendChild(cr);

    box.hidden = false;
    box.innerHTML = "";
    box.appendChild(sp);

    if (splashPrevTimer) clearTimeout(splashPrevTimer);
    splashPrevTimer = setTimeout(function () {
      box.hidden = true;
      box.innerHTML = "";
      splashPrevTimer = 0;
    }, 3000);
  }
  (function bindSplashPreview() {
    var b = document.getElementById("splashPreviewBtn");
    if (b) b.addEventListener("click", playSplashPreview);
  })();

    /* 启动动画：动画套系 / 文字 / 图片 / 角色头像 */
    setVal("#setSplashAnim", String(s.splashAnim == null ? "0" : s.splashAnim));
    setVal("#setSplashText", s.splashText || "");
    setVal("#setSplashSub", s.splashSub || "");
    setVal("#setSplashImage", s.splashImage || "");
    (function () {
      /* 角色头像下拉：每次填表都按当前的角色列表重建，别让删掉的角色留在选项里 */
      const sel = $("#setSplashAvatar");
      if (!sel) return;
      const keep = String(s.splashAvatar || "");
      sel.innerHTML = "";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "（不用头像）";
      sel.appendChild(none);
      Store.getCharacters().forEach(function (c) {
        const o = document.createElement("option");
        o.value = c.id || "";
        o.textContent = c.name || "角色";
        sel.appendChild(o);
      });
      sel.value = keep;
      /* 选项是重建的 → 刷新自绘按钮上的文字，否则按钮还显示旧的角色名 */
      if (UI.pickRefreshAll) UI.pickRefreshAll();
    })();
    try {
      if (D.bgDraft) D.bgDraft.settings = s.bgImage || "";
      if (D.renderBgPreview) D.renderBgPreview("#setBgPreview", s.bgImage || "");
      if (D.bgDraft) D.bgDraft.phone = s.phoneBgImage || "";
      if (D.renderBgPreview) D.renderBgPreview("#setPhoneBgPreview", s.phoneBgImage || "");
      if (D.syncBgLabels) D.syncBgLabels();
    } catch (e) { /* ignore */ }

    /* 模型配置卡片：绑定（只需一次）+ 渲染 */
    bindModelSetEvents();
    renderModelSets();
    renderModelBadge();
    avatarDraft.settingsUser = s.avatarUser || "";
    /* 助手默认头像 = 听澜那张（用户 10-22 口径）。老数据里存的是空串，
       直接显示空预览会让人以为没设头像，所以这里同样回落。 */
    avatarDraft.settingsAi = s.avatarAi || ((CONFIG && CONFIG.BUILTIN_ASSISTANT && CONFIG.BUILTIN_ASSISTANT.avatar) || "");
    avatarDraft.phoneUser = s.phoneAvatarUser || "";
    renderAvatarPreview("#setAvatarUserPreview", avatarDraft.settingsUser, "user");
    renderAvatarPreview("#setAvatarAiPreview", avatarDraft.settingsAi, "assistant");
    renderAvatarPreview("#setPhoneAvUserPreview", avatarDraft.phoneUser, "user", avatarDraft.settingsUser);
    renderCapsLine();
    applyUploadTypes();
    bindCapChecks();
    syncCapChecks();
    autoDetectIfStale();
    renderSettingsMemory();
    /* 存储统计要同步问原生桥（每张图一次），200 张图就是 200+ 次主线程调用。
       以前在这里直接算，表现成「点设置要顿一下」；改成先让设置页出来，随后再填。 */
    setTimeout(renderDataUsage, 400);
    syncProviderFields();
  }

  function syncRangeLabels() {
    setText("#setTempVal", Number($v("#setTemperature")).toFixed(2));
    setText("#setTopPVal", Number($v("#setTopP")).toFixed(2));
  }

  function syncProviderFields() {
    const v = $v("#setSearchProvider");
    /* auto 也显示：DeepSeek 搜索没结果时会回落到 Tavily，这个 Key 就是备用通道 */
    setDisplay("#tavilyField", (v === "tavily" || v === "auto") ? "" : "none");
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
      phoneAvatarUser: avatarDraft.phoneUser,
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
      imgToImg: checkedOf("#setImgToImg"),
      phoneShareImg: checkedOf("#setPhoneShareImg"),
      charMomentAuto: checkedOf("#setCharMoment"),
      charMomentImg: checkedOf("#setMomentImg"),

      roleplayEnabled: checkedOf("#setRoleplayEnabled"),
      groupWarnOff: !checkedOf("#setGroupWarn"),
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

      /* ── 6.0.0：功能开关 / 采用格式 / 用量花费 ──
         （早先只写了「回填」，没写「读取」→ 这几个开关改了保存也不生效，这里补上。） */
      dailyUpdate: checkedOf("#setDailyUpdate"),
      toolUse: checkedOf("#setToolUse"),
      worldGen: checkedOf("#setWorldGen"),
      eventBook: checkedOf("#setEventBook"),
      statusQuant: checkedOf("#setStatusQuant"),
      /* 附带卡片的项目名（全局这一层）。空数组 = 没配 = 不显示卡片 */
      statusCards: parseCardLines($v("#setStatusCards")),
      autoMessage: checkedOf("#setAutoMessage"),
      autoMessageMin: Number($v("#setAutoMessageMin")) || 30,
      autoMessagePhone: checkedOf("#setAutoMessagePhone"),
      adoptFormat: $v("#setAdoptFormat"),
      usagePriceMode: $v("#setUsagePriceMode") || "fuzzy",
      usagePriceHit: numOr($v("#setUsagePriceHit"), state.settings.usagePriceHit, 0.2),
      usagePriceIn: numOr($v("#setUsagePriceIn"), state.settings.usagePriceIn, 2),
      usagePriceOut: numOr($v("#setUsagePriceOut"), state.settings.usagePriceOut, 8),
      phoneWarnYuan: numOr($v("#setPhoneWarn"), state.settings.phoneWarnYuan, 0),
      live2dEnabled: checkedOf("#setLive2dEnabled"),
      live2dModel: $v("#setLive2dModel"),

      /* 视频 / 音乐：字段全留空就是「不启用」，不会影响其它功能 */
      videoEnabled: checkedOf("#setVideoEnabled"),
      videoBaseUrl: $v("#setVideoBaseUrl"),
      videoKey: $v("#setVideoKey"),
      videoModel: $v("#setVideoModel"),
      videoMode: $v("#setVideoMode") || "t2v",
      videoRatio: $v("#setVideoRatio") || "16:9",
      videoSize: $v("#setVideoSize"),
      videoDuration: numOr($v("#setVideoDuration"), state.settings.videoDuration, 5),
      videoFps: numOr($v("#setVideoFps"), state.settings.videoFps, 24),
      videoCreatePath: $v("#setVideoCreatePath"),
      videoStatusPath: $v("#setVideoStatusPath"),
      videoResultField: $v("#setVideoResultField"),
      videoPollMs: numOr($v("#setVideoPollMs"), state.settings.videoPollMs, 3000),
      videoPollMax: numOr($v("#setVideoPollMax"), state.settings.videoPollMax, 120),
      videoTemplate: $v("#setVideoTemplate"),

      musicEnabled: checkedOf("#setMusicEnabled"),
      musicBaseUrl: $v("#setMusicBaseUrl"),
      musicKey: $v("#setMusicKey"),
      musicModel: $v("#setMusicModel"),
      musicDuration: numOr($v("#setMusicDuration"), state.settings.musicDuration, 30),
      musicFormat: $v("#setMusicFormat") || "mp3",
      musicWithLyrics: checkedOf("#setMusicWithLyrics"),
      musicCreatePath: $v("#setMusicCreatePath"),
      musicStatusPath: $v("#setMusicStatusPath"),
      musicResultField: $v("#setMusicResultField"),
      musicPollMs: numOr($v("#setMusicPollMs"), state.settings.musicPollMs, 3000),
      musicPollMax: numOr($v("#setMusicPollMax"), state.settings.musicPollMax, 120),
      musicTemplate: $v("#setMusicTemplate"),

      visionEnabled: checkedOf("#setVisionEnabled")
    };
    /* 模型配置最后统一写：配置库与「生效值」必须一起改，否则两份数据会打架 */
    const cur = readAllSets();
    const flat = flattenSets(cur.sets, cur.index);
    Object.keys(flat).forEach(function (k) { form[k] = flat[k]; });
    return form;
  }

  /* 数字输入框留空 → 用原值（空串 Number 出来是 0，会把「每百万 2 元」悄悄改成 0） */
  function numOr(raw, fallback, dflt) {
    const t = String(raw == null ? "" : raw).trim();
    if (t === "") return (typeof fallback === "number" ? fallback : dflt);
    const n = Number(t);
    return isFinite(n) ? n : (typeof fallback === "number" ? fallback : dflt);
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

  /* ── 群聊 · 对彼此的认知（10-18）────────────────────────────
     两级折叠：一级「谁」，二级「他对谁」。数据只在群聊会话上：
       session.peerCog  = { 角色id: { 另一角色id: "…" } }
       session.peerCogOn = 要不要把这些认知注入对话（默认关）
     这里只管铺界面，更新 / 同步由 chat.js 干（按钮在 app.js 绑）。 */
  function renderGroupCog(s) {
    const sec = document.getElementById("groupCogSection");
    if (!sec) return;
    const isGroup = !!(s && s.isGroup);
    sec.hidden = !isGroup;
    if (!isGroup) return;
    const on = document.getElementById("setPeerCogOn");
    if (on) on.checked = !!s.peerCogOn;
    const box = document.getElementById("peerCogList");
    if (!box) return;
    box.innerHTML = "";
    const members = (window.DL.groupMembers ? window.DL.groupMembers(s) : []) || [];
    const cog = (window.DL.peerCogOf ? window.DL.peerCogOf(s) : {}) || {};
    if (members.length < 2) {
      const p = document.createElement("p");
      p.className = "pc-none";
      p.textContent = "这个群还没有两个以上成员，认知无从谈起。";
      box.appendChild(p);
      return;
    }
    let any = false;
    members.forEach((a) => {
      const row = cog[a.id] || {};
      const d = document.createElement("details");
      d.className = "pc-role";
      const sm = document.createElement("summary");
      const nm = document.createElement("span");
      nm.textContent = a.name;
      const cnt = document.createElement("span");
      cnt.className = "hint";
      let n = 0;
      members.forEach((b) => { if (b.id !== a.id && String(row[b.id] || "").trim()) n++; });
      cnt.textContent = n ? (n + " / " + (members.length - 1)) : "空";
      sm.appendChild(nm);
      sm.appendChild(cnt);
      d.appendChild(sm);
      members.forEach((b) => {
        if (b.id === a.id) return;
        const sub = document.createElement("details");
        sub.className = "pc-sub";
        const ss = document.createElement("summary");
        ss.textContent = "对 " + b.name;
        sub.appendChild(ss);
        const body = document.createElement("div");
        body.className = "pc-body";
        const t = String(row[b.id] || "").trim();
        body.textContent = t || "还没有内容。点「更新认知」，AI 会按群里最近的对话整理一份。";
        if (t) any = true;
        sub.appendChild(body);
        d.appendChild(sub);
      });
      box.appendChild(d);
    });
    if (!any) {
      const tip = document.createElement("p");
      tip.className = "pc-none";
      tip.textContent = "目前一条印象都没有。先聊几轮，再点「更新认知」。";
      box.insertBefore(tip, box.firstChild);
    }
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
    /* 相册接口是「探测式」接入的：猜不到名字就退回系统选择器，
       所以这里把探测结果直接打出来，真机上能一眼看出原生桥有没有这个能力。 */
    let albumInfo = "未探测";
    try {
      const ap = (window.DL && window.DL.nativeAlbumProbe) ? window.DL.nativeAlbumProbe() : { pick: [], list: [] };
      if (ap.pick.length) albumInfo = "已找到 " + ap.pick.join(" / ");
      else if (ap.list.length) albumInfo = "只有列表接口：" + ap.list.join(" / ") + "（暂未接入）";
      else albumInfo = "没找到，选图走系统选择器";
    } catch (e) { albumInfo = "探测出错：" + (e.message || e); }
    out.appendChild(testLine(true, "原生相册接口：" + albumInfo));

    /* ── 原生接口诊断 ──────────────────────────────
       真机上「调了原生却看不出效果」时，唯一可靠的抓手就是接口到底存不存在、返回什么。
       这里只调「判断 / 获取」这类【只读】接口，绝不在这里触发任何写操作。
       结果可以一键复制（界面不铺长文本，避免自检面板被撑爆）。 */
    const diag = [];
    diag.push("Sekulum 诊断 " + new Date().toLocaleString());
    diag.push("前端版本：" + CONFIG.APP_VERSION);
    diag.push("上次运行版本：" + (state.settings.lastRunVersion || "（无）"));
    /* 「更新后首次打开」专项：清缓存是本项目唯一「只在真机执行」的启动动作
       （无桥环境 hasBridge 恒 false），这里把它与就绪耗时一起亮出来，便于真机定位。 */
    let clearTries = "0";
    try { clearTries = sessionStorage.getItem("deeplink.cacheClearTries") || "0"; } catch (e) { /* ignore */ }
    diag.push("本次启动清缓存：已尝试 " + clearTries + " 次");
    diag.push("首屏就绪耗时：" + (window.__deeplinkReady
      ? (window.__dlBootT0 ? (Date.now() - window.__dlBootT0) + "ms" : "（无起点）")
      : "尚未就绪"));
    /* 启动分段：每段是「距启动起点的累计毫秒」，定位 230ms 花在哪一步用（10-18 新增） */
    try {
      const marks = (window.__dlBootMarks || []).map((it) => it[0] + " " + it[1] + "ms").join(" / ");
      diag.push("启动分段：" + (marks || "（无）"));
    } catch (e) { diag.push("启动分段：（读不出来）"); }
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
        const rt = Memory.recentTranscript(s.messages || [], 0, 40, s);
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
    try { if (out && out.usage) recordUsage(null, out.usage, null, "other"); } catch (e) { /* ignore */ }
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
  /* ── 设置页 7 大模块（10-16 用户要求：点进模块再做具体设置）────────────
     HTML 结构不动：按每个 section 的 h3 文本归组、打 data-group；
     首页 #settingsHome 列 7 个入口，点进去只显示该组的 section。
     「用量统计 / 导入导出」是打开各自弹窗，不切视图。 */
  var SG_TITLE = { basic: "基本配置", advanced: "高级功能", persona: "我的人设", usage: "用量统计", io: "导入导出", storage: "储存占用", about: "关于应用" };
  /* h3 文本前缀 → 组。加一个 section 只需在这里加一行（用 indexOf === 0 前缀匹配，
     因为 h3 里可能还夹着「重置本区」按钮）。 */
  var SEC_GROUP = [
    ["主模型", "basic"], ["头像", "basic"], ["生成参数", "basic"], ["采用格式", "basic"],
    ["自定义聊天背景", "basic"], ["手机背景", "basic"], ["启动动画", "basic"],
    ["听觉模型", "advanced"], ["语音合成", "advanced"], ["文生图", "advanced"], ["视觉模型", "advanced"],
    ["图片", "advanced"], ["角色扮演", "advanced"], ["功能开关", "advanced"], ["用量花费", "advanced"],
    ["live2D", "advanced"], ["角色记忆总览", "advanced"], ["后台与通知", "advanced"], ["应用加密", "advanced"],
    ["我的人设", "persona"], ["存储", "storage"], ["关于", "about"]
  ];
  function secGroup(title) {
    for (var i = 0; i < SEC_GROUP.length; i++) { if (title.indexOf(SEC_GROUP[i][0]) === 0) return SEC_GROUP[i][1]; }
    return "advanced";
  }
  /* h3 里可能带「重置本区」按钮 —— 只取纯文本节点，别把按钮文字算进来 */
  function h3PlainText(h3) {
    if (!h3) return "";
    var t = "";
    for (var n = h3.firstChild; n; n = n.nextSibling) { if (n.nodeType === 3) t += n.nodeValue; }
    return t.replace(/\s+/g, "");
  }
  /* 主模型能力：查表 → 查不到就当纯文本（宁可不放开）。
     用户口径是「联网自动检测」：表里没有的名字，这里会尝试走搜索源查一次再落库。 */
  function capsOfName(name) {
    var table = ((window.CONFIG && CONFIG.MODEL_CAPS) || []).slice();
    var t = String(name || "").toLowerCase();
    /* 长的键优先（10-19）：原来按表里书写顺序命中，"o3" 这种短键会先吃掉
       "xx-o3-pro"，"deepseek" 也会抢在 "deepseek-vl" 前面。 */
    table.sort(function (a, b) { return String(b.k).length - String(a.k).length; });
    for (var i = 0; i < table.length; i++) {
      if (t.indexOf(String(table[i].k).toLowerCase()) >= 0) return table[i];
    }
    return null;
  }
  function syncCapChecks() {
    var m = (state.settings.modelCaps || {}).manual;
    if (!m) return;
    var map = { capVision: "vision", capAsr: "asr", capTts: "tts", capImg: "img" };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.checked = !!m[map[id]];
    });
  }
  function bindCapChecks() {
    var map = { capVision: "vision", capAsr: "asr", capTts: "tts", capImg: "img" };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || el.dataset.bound) return;
      el.dataset.bound = "1";
      el.addEventListener("change", function () {
        var cur = (state.settings.modelCaps || {});
        var manual = Object.assign({}, cur.manual || {});
        manual[map[id]] = !!el.checked;
        /* 把 model 一起写上（10-19）：不写的话下次进设置会被 autoDetectIfStale 判成「过期」，
           重新检测后整个 modelCaps 被替换，用户刚勾的 manual 就没了。 */
        var next = Object.assign({}, cur, { manual: manual, src: "手动指定", model: state.settings.model || "" });
        state.settings = Store.saveSettings({ modelCaps: next });
        applyUploadTypes();
        renderCapsLine();
      });
    });
  }
  function renderCapsLine() {
    var el = document.getElementById("capsLine");
    if (!el) return;
    var caps = state.settings.modelCaps;
    var name = state.settings.model || "（未设置主模型）";
    if (!caps) { el.textContent = "主模型：" + name + "。还没检测过能力。"; return; }
    if (caps.unknown && !caps.manual) {
      el.textContent = "主模型：" + name + "。没检测出结论，上传类型先不限制（下面可以自己勾）。";
      return;
    }
    /* 显示「实际生效」的那套：手勾优先。以前这里只读 caps，用户勾完「看图」
       上行还写着「只当文字模型」，界面和行为的结论正好相反。 */
    var eff = effectiveCaps();
    var on = [];
    if (eff.vision) on.push("看图");
    if (eff.asr) on.push("听音");
    if (eff.tts) on.push("朗读");
    if (eff.img) on.push("画图");
    var srcTxt = caps.manual ? "手动指定" : (caps.src || "");
    el.textContent = "主模型：" + name + "，" + (on.length ? "支持 " + on.join(" / ") : "只当文字模型") +
      (srcTxt ? "（" + srcTxt + "）" : "");
  }
  /* 按能力放开上传类型：不能看图的就别让选图片，不能听音的别让选音频 */
  /* 手动勾选优先：用户自己知道自己的模型行不行，比任何查表都准。 */
  function effectiveCaps() {
    var c = state.settings.modelCaps || {};
    var m = c.manual || null;
    if (m) return { vision: !!m.vision, asr: !!m.asr, tts: !!m.tts, img: !!m.img };
    return { vision: !!c.vision, asr: !!c.asr, tts: !!c.tts, img: !!c.img };
  }
  function applyUploadTypes() {
    var caps = effectiveCaps();
    var m = state.settings || {};
    /* 10-19 修两处：
       1. 独立视觉 / 语音模型（设置里那套 visionEnabled / asrEnabled）本来就负责「主模型看不了图，
          先用视觉模型转成文字」。只看主模型会把这条成熟链路从入口堵死；
       2. 没检测过（modelCaps 为 null）时【不收紧】—— 否则用户只是打开设置看一眼，
          出来就发现图片选不了了。 */
    var known = !!(m.modelCaps && !m.modelCaps.unknown);
    var canVision = !known ? true : !!(caps.vision || m.mainCompat ||
      (window.Media && Media.capable && Media.capable("vision", m)));
    var canAsr = !known ? true : !!(caps.asr ||
      (window.Media && Media.capable && Media.capable("asr", m)));
    var list = [".txt", ".md", ".json", ".pdf"];
    if (canVision) list = list.concat([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
    if (canAsr) list = list.concat([".mp3", ".wav", ".m4a", ".ogg", ".webm"]);
    var accept = list.join(",");
    ["fileInput", "plusFile"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.setAttribute) el.setAttribute("accept", accept);
    });
  }
  /* 问模型自己：不依赖外部搜索源，用你填的那个 key 调一次，让它只回一段 JSON。
     失败了就当没问过（不阻断，也不当成「不支持」）。 */
  async function askModelCaps(name) {
    if (!Api || !Api.summarize) return null;
    try {
      var r = await Api.summarize(state.settings, [
        { role: "system", content: "你只输出一个 JSON 对象，不要解释、不要代码块。" },
        { role: "user", content: "下面这个模型是否支持这四项能力？模型名：" + name +
          "。字段：vision=能接收图片输入；asr=能接收音频输入；tts=能输出语音；img=能生成图片。" +
          "只输出形如 {\"vision\":true,\"asr\":false,\"tts\":false,\"img\":false} 的 JSON。" }
      ], { maxTokens: 120 });
      var t = String((r && r.text) || "");
      /* 这一步也是真实调用，按「除对话外一切 AI 消耗都计入」的口径记账 */
      if (r && r.usage) { try { recordUsage(null, r.usage, "", "caps"); } catch (e) { /* ignore */ } }
      var m = t.match(/\{[\s\S]*\}/);
      if (!m) return null;
      var j = JSON.parse(m[0]);
      return { vision: !!j.vision, asr: !!j.asr, tts: !!j.tts, img: !!j.img };
    } catch (e) { return null; }
  }

  async function detectModelCaps(silent) {
    var name = state.settings.model || "";
    if (!name) { if (!silent) UI.toast("先在主模型里填一个模型名", true); return; }
    var hit = capsOfName(name);
    var caps = null;
    if (hit) {
      caps = { model: name, vision: !!hit.vision, asr: !!hit.asr, tts: !!hit.tts, img: !!hit.img, src: "内置表：" + hit.n };
    } else {
      if (!silent) UI.toast("表里没有，正在问模型自己…");
      var asked = await askModelCaps(name);
      /* 没问出结论时**不能**写成「四项全不支持」（10-19）：
         那等于凭空把上传类型全关掉，用户只是打开设置看一眼就传不了图了。
         写成 unknown，上传限制原样放开，界面如实说「没确认」。 */
      caps = asked
        ? Object.assign({ model: name, src: "模型自述" }, asked)
        : { model: name, unknown: true, src: "未确认（上传类型暂不限制）" };
    }
    /* 手动勾过的必须留着：用户比内置表清楚自己的模型，点一次「检测」不该把它冲掉。
       所以只覆盖「机器判定」那部分，manual 原样带回去。 */
    var prevCaps = state.settings.modelCaps || {};
    state.settings = Store.saveSettings({
      modelCaps: Object.assign({}, prevCaps, caps, { manual: prevCaps.manual || null })
    });
    renderCapsLine();
    applyUploadTypes();
    if (!silent) UI.toast("已记录：" + caps.src);
  }

  /* 模型名一变，下次进设置自动重测一次（用户不用记得点按钮）。
     10-19：用户手动勾过就不再自动覆盖 —— 他比表更清楚自己的模型；而且自动检测对
     表里没有的名字会实打实发一次请求，不该在「只是打开设置看看」时悄悄花钱。 */
  function autoDetectIfStale() {
    var c = state.settings.modelCaps;
    if (!state.settings.model) return;
    if (c && c.manual) return;
    /* 同一个模型已经问过一次没结论了，别每次进设置都再发一次请求 */
    if (c && c.unknown && c.model === state.settings.model) return;
    if (c && c.model === state.settings.model && c.src) return;
    detectModelCaps(true);
  }

  function bindCapsBtn() {
    var b = document.getElementById("detectCapsBtn");
    if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", function () { detectModelCaps(false); }); }
  }

  function setupSettingsHome() {
    bindCapsBtn();
    var body = document.getElementById("settingsBody");
    if (!body || body.dataset.sgReady) return;
    body.dataset.sgReady = "1";
    var secs = body.querySelectorAll(".settings-section");
    for (var i = 0; i < secs.length; i++) {
      /* HTML 里已显式指定组的（那些没有 h3、按文本归不了组的容器）别覆盖 */
      if (secs[i].getAttribute("data-group")) continue;
      secs[i].setAttribute("data-group", secGroup(h3PlainText(secs[i].querySelector("h3"))));
    }
  }
  /* 整页模式下左上角那个键是「返回上一级」：子页 → 首页；首页 → 关闭设置。
     （设置页已改成整页，右上角的 × 被 CSS 隐藏了，所以首页也得有这个键。） */
  function sgBack() {
    var body = document.getElementById("settingsBody");
    if (body && body.classList.contains("sg")) { sgHome(); return; }
    UI.closeModal("settingsModal");
  }
  function sgHome() {
    var body = document.getElementById("settingsBody");
    if (!body) return;
    /* 退出子页也走一小段（10-21 用户要求：进出都要有动画，不能啪一下） */
    if (body.classList.contains("sg") && !body.classList.contains("sg-out")) {
      body.classList.add("sg-out");
      setTimeout(function () {
        body.classList.remove("sg-out");
        body.classList.remove("sg");
        body.removeAttribute("data-sg");
        setText("#settingsTitle", "设置");
        setHidden("#settingsBack", false);
        body.scrollTop = 0;
      }, 150);
      return;
    }
    body.classList.remove("sg");
    body.classList.remove("sg-out");
    body.removeAttribute("data-sg");
    setText("#settingsTitle", "设置");
    setHidden("#settingsBack", false);
    body.scrollTop = 0;
  }
  function sgOpen(name) {
    var body = document.getElementById("settingsBody");
    if (!body) return;
    setupSettingsHome();
    /* 用量统计 / 导入导出：开一个**整页子页叠在设置之上**，不关设置页。
       老写法是「先 closeModal(settingsModal) 再 openModal(usageModal)」，
       于是用户按返回就直接掉回主界面，而且那两个老弹窗只有 60 层，
       被 88 层的设置页整个盖住 → 表现成「点了没反应」。两处一起改掉。 */
    if (name === "usage") { renderUsageStats(); UI.openModal("usageModal"); return; }
    if (name === "io") { openData(); return; }
    if (name === "persona") renderPersona();
    if (name === "storage") renderStoragePanel();
    body.classList.add("sg");
    body.setAttribute("data-sg", name);
    setText("#settingsTitle", SG_TITLE[name] || "设置");
    setHidden("#settingsBack", false);
    body.scrollTop = 0;
  }
  function bindSettingsHome() {
    setupSettingsHome();
    var home = document.getElementById("settingsHome");
    if (home && !home.dataset.bound) {
      home.dataset.bound = "1";
      home.addEventListener("click", function (ev) {
        var btn = (ev.target && ev.target.closest) ? ev.target.closest(".sg-item") : null;
        if (btn) sgOpen(btn.getAttribute("data-sg"));
      });
    }
    var back = document.getElementById("settingsBack");
    if (back && !back.dataset.bound) { back.dataset.bound = "1"; back.addEventListener("click", sgBack); }
    /* 每次从侧边栏进设置都回到首页（延后一拍，避开本来的打开逻辑） */
    var open = document.getElementById("openSettingsBtn");
    if (open && !open.dataset.sgWatch) {
      open.dataset.sgWatch = "1";
      open.addEventListener("click", function () { setTimeout(sgHome, 0); });
    }
  }

  /* ── 我的人设（10-16）──────────────────────────────
     全局存「你」的设定，最多 10 套，只存本机、随设置一起导出。
     注入优先级（用户口径「以角色卡的为准」）：角色卡「你的*」→ 当前人设 → 旧的 settings.my*（见 memory.js 的 resolveMy）。 */
  var PERSONA_FIELDS = [
    ["myName", "我的名称", 0],
    ["myGender", "我的性别（男 / 女 / 其他，其他可自填）", 0],
    ["aiCallMe", "你对我的称呼", 0],
    ["myPersona", "我的性格", 1],
    ["myAppearance", "我的外貌", 1],
    ["myBackground", "我的背景", 1],
    ["myLikes", "我的喜好", 1]
  ];
  var PERSONA_MAX = 10;
  var personaSaveTimer = null;
  function personaList() { var s = state.settings || {}; return Array.isArray(s.personas) ? s.personas : []; }
  function curPersona() {
    var list = personaList();
    if (!list.length) return null;
    var id = (state.settings && state.settings.activePersonaId) || "";
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return list[0];
  }
  function personaNewId() { return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  /* 输入防抖落库：人设是独立数据，改完即存（不像角色卡那样必须手点保存） */
  function personaFlush() {
    if (personaSaveTimer) { clearTimeout(personaSaveTimer); personaSaveTimer = null; }
    state.settings = Store.saveSettings({ personas: personaList() });
  }
  function personaQueueSave() {
    if (personaSaveTimer) clearTimeout(personaSaveTimer);
    personaSaveTimer = setTimeout(personaFlush, 400);
  }
  function ensurePersona() {
    if (personaList().length) return;
    var p = { id: personaNewId(), name: "默认人设" };
    state.settings = Store.saveSettings({ personas: [p], activePersonaId: p.id });
  }
  function renderPersona() {
    var box = document.getElementById("personaFields");
    if (!box) return;
    ensurePersona();
    var list = personaList();
    var cur = curPersona();
    setText("#personaCount", String(list.length));
    var sel = document.getElementById("personaPick");
    if (sel) {
      sel.innerHTML = "";
      list.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id; o.textContent = p.name || "未命名";
        sel.appendChild(o);
      });
      sel.value = cur ? cur.id : "";
      if (UI.pickRefreshAll) UI.pickRefreshAll();
    }
    box.innerHTML = "";
    PERSONA_FIELDS.forEach(function (f) {
      var wrap = document.createElement("label");
      wrap.className = "field";
      var sp = document.createElement("span");
      sp.textContent = f[1];
      wrap.appendChild(sp);
      var el = f[2] ? document.createElement("textarea") : document.createElement("input");
      if (f[2]) el.rows = 2; else el.type = "text";
      el.id = "pf_" + f[0];
      el.value = (cur && cur[f[0]]) || "";
      el.addEventListener("input", function () { personaSetField(f[0], el.value); });
      wrap.appendChild(el);
      box.appendChild(wrap);
    });
  }
  function personaSetField(key, val) {
    var cur = curPersona();
    if (!cur) return;
    cur[key] = val;
    /* 就地改完再存 —— 回写进数组，避免只改了引用没落库 */
    var list = personaList();
    for (var i = 0; i < list.length; i++) { if (list[i].id === cur.id) list[i] = cur; }
    personaQueueSave();
  }
  function personaPick(id) {
    personaFlush();
    state.settings = Store.saveSettings({ activePersonaId: id });
    renderPersona();
  }
  function personaNew() {
    var list = personaList();
    if (list.length >= PERSONA_MAX) { UI.toast("最多 " + PERSONA_MAX + " 套，先删一套再建", true); return; }
    personaFlush();
    var p = { id: personaNewId(), name: "人设 " + (list.length + 1) };
    list.push(p);
    state.settings = Store.saveSettings({ personas: list, activePersonaId: p.id });
    renderPersona();
    UI.toast("已新建「" + p.name + "」");
  }
  function personaDel() {
    var list = personaList();
    if (list.length <= 1) { UI.toast("至少要留一套", true); return; }
    var cur = curPersona();
    if (!cur) return;
    var i = -1;
    for (var k = 0; k < list.length; k++) if (list[k].id === cur.id) i = k;
    if (i < 0) return;
    list.splice(i, 1);
    state.settings = Store.saveSettings({ personas: list, activePersonaId: list[Math.max(0, i - 1)].id });
    renderPersona();
  }
  function personaDigest() {
    var lines = [];
    PERSONA_FIELDS.forEach(function (f) {
      var el = document.getElementById("pf_" + f[0]);
      var v = el ? String(el.value || "").trim() : "";
      if (v) lines.push(f[1] + "：" + v);
    });
    return lines.join("\n");
  }
  /* 套用到当前角色卡：只填「空着的」那几栏 —— 已填的不动（以角色卡为准） */
  function personaApply() {
    var cur = curPersona();
    if (!cur) return;
    personaApplyById(cur.id);
  }
  /* 按 id 套用（角色页那个下拉用这个；不依赖「当前选中的是哪套」） */
  function personaApplyById(id) {
    var list = personaList();
    var p = null;
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) p = list[i]; }
    if (!p) { UI.toast("找不到这套人设", true); return 0; }
    var ch = activeCharacter();
    if (!ch) { UI.toast("先去角色页选一个角色", true); return 0; }
    var f = ch.fields || (ch.fields = {});
    var n = 0;
    PERSONA_FIELDS.forEach(function (x) {
      var v = String(p[x[0]] || "").trim();
      if (!v) return;
      if (String(f[x[0]] || "").trim()) return;      /* 已填的不覆盖 */
      f[x[0]] = v; n++;
    });
    if (!n) { UI.toast("角色卡里这几栏都填过了，没动", true); return 0; }
    var cl = Store.getCharacters();
    for (var k = 0; k < cl.length; k++) {
      if (cl[k].id === ch.id) cl[k] = Object.assign({}, cl[k], { fields: f, updatedAt: Date.now() });
    }
    Store.saveCharacters(cl);
    UI.toast("已把「" + (p.name || "人设") + "」套进角色卡（填了 " + n + " 个空栏）");
    return n;
  }
  /* 给角色页那个下拉用：只要 id 和名字，别把整份人设递出去 */
  function personaOptions() {
    return personaList().map(function (p) { return { id: p.id, name: p.name || "未命名" }; });
  }
  async function personaSplit(again) {
    var cur = curPersona();
    if (!cur) return;
    var typed = String($v("#personaSplitInput") || "").trim();
    var raw = typed;
    if (again) { var dg = personaDigest(); raw = typed ? (typed + "\n\n" + dg) : dg; }
    if (!raw) { UI.toast("先写一段关于你自己的话", true); return; }
    if (!state.settings.apiKey) { UI.toast("先去设置里填 API Key", true); return; }
    setDisabled("#personaSplitRun", true);
    setText("#personaSplitState", "AI 正在拆分…");
    try {
      var fields = PERSONA_FIELDS.map(function (f) {
        var el = document.getElementById("pf_" + f[0]);
        return { key: f[0], label: f[1], current: el ? el.value : "" };
      });
      var r = await window.Memory.splitCharacterFields(state.settings, raw, fields);
      if (r.usage) recordUsage(null, r.usage, "", "other");
      var n = 0;
      PERSONA_FIELDS.forEach(function (f) {
        var v = r.fields[f[0]];
        if (typeof v === "string" && v.trim()) {
          var el2 = document.getElementById("pf_" + f[0]);
          if (el2) el2.value = v.trim();
          cur[f[0]] = v.trim();
          n++;
        }
      });
      personaFlush();
      setText("#personaSplitState", n ? ("已填入 " + n + " 项，已自动保存") : "没拆出可用内容，写具体一点再试");
    } catch (e) {
      setText("#personaSplitState", "拆分失败：" + (e && e.message ? e.message : e));
    } finally {
      setDisabled("#personaSplitRun", false);
    }
  }
  /* AI 创建（人设，10-26）：一句话 → 上面那几栏。
     和 AI 拆分分工一样：拆是把现成材料归类，创建是凭一句话造。
     人设只有「我」这一边，所以不用选范围。 */
  var lastPersonaBrief = "";
  function switchPersonaAiTab(which) {
    var tabs = document.getElementById("personaAiTabs");
    if (tabs) {
      var bs = tabs.querySelectorAll(".ai-tab");
      for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("on", bs[i].getAttribute("data-ai") === which);
    }
    var c = document.getElementById("personaAiCreate");
    var s = document.getElementById("personaAiSplit");
    if (c) c.hidden = (which !== "create");
    if (s) s.hidden = (which !== "split");
  }
  async function personaCreate(again) {
    var cur = curPersona();
    if (!cur) return;
    var typed = String($v("#personaCreateInput") || "").trim();
    var brief = typed || lastPersonaBrief;
    if (!brief) { UI.toast("先写一句话描述你自己", true); return; }
    lastPersonaBrief = brief;
    if (!state.settings.apiKey) { UI.toast("先去设置里填 API Key", true); return; }
    setDisabled("#personaCreateRun", true);
    setDisabled("#personaCreateAgain", true);
    setText("#personaCreateState", again ? "AI 正在换一个版本…" : "AI 正在创建…");
    try {
      var r = await Memory.createFields(state.settings,
        brief + (again ? "\n\n（上一版不满意，这次换一个明显不同的方向）" : ""), "me", []);
      if (r.usage && recordUsage) recordUsage(null, r.usage, "", "create");
      var keys = PERSONA_FIELDS.map(function (f) { return f[0]; });
      var n = 0;
      keys.forEach(function (k) {
        var v = r.fields[k];
        v = (typeof v === "number") ? String(v) : (typeof v === "string" ? v.trim() : "");
        if (!v) return;
        cur[k] = v;
        var el = document.getElementById("pf_" + k);
        if (el) el.value = v;
        n++;
      });
      if (n) personaQueueSave();
      var notes = Array.isArray(r.fields.notes)
        ? r.fields.notes.map(function (x) { return String(x || "").trim(); }).filter(Boolean).slice(0, 8)
        : [];
      setText("#personaCreateState",
        (n ? ("已填入 " + n + " 项，可以接着改") : "没生成出可用内容，描述得再具体一点")
        + (notes.length ? "。替你定的：" + notes.join("、") : ""));
    } catch (e) {
      setText("#personaCreateState", "创建失败：" + (e.message || e));
    } finally {
      setDisabled("#personaCreateRun", false);
      setDisabled("#personaCreateAgain", false);
    }
  }

  function bindPersona() {
    var sel = document.getElementById("personaPick");
    if (sel && !sel.dataset.bound) { sel.dataset.bound = "1"; sel.addEventListener("change", function () { personaPick(sel.value); }); }
    var b;
    b = document.getElementById("personaNewBtn");    if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", personaNew); }
    b = document.getElementById("personaDelBtn");    if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", personaDel); }
    b = document.getElementById("personaApplyBtn");  if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", personaApply); }
    b = document.getElementById("personaSplitRun");  if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", function () { personaSplit(false); }); }
    b = document.getElementById("personaSplitAgain"); if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", function () { personaSplit(true); }); }
    var at = document.getElementById("personaAiTabs");
    if (at && !at.dataset.bound) {
      at.dataset.bound = "1";
      at.addEventListener("click", function (e) {
        var b = (e.target && e.target.closest) ? e.target.closest(".ai-tab") : null;
        if (!b) return;
        switchPersonaAiTab(b.getAttribute("data-ai"));
      });
    }
    [[document.getElementById("personaCreateRun"), false],
     [document.getElementById("personaCreateAgain"), true]].forEach(function (pair) {
      var b = pair[0];
      if (!b || b.dataset.bound) return;
      b.dataset.bound = "1";
      b.addEventListener("click", function () {
        var r = personaCreate(pair[1]);
        if (r && r.catch) r.catch(function (e) { UI.toast("创建失败：" + ((e && e.message) || e), true); });
      });
    });
    bindWorlds();
    renderWorlds();
  }

  /* ── 世界观库（10-26）──────────────────────────────────────
     最多 50 套。内置 10 套在首次使用时注入，worldsSeeded 保证只注一次。
     内置的只读 —— 要改就「复制当前」生成一套自己的。
     取用优先级在 memory.js 的 worldFor：角色卡 fields.world（非空）> 这里选中的那一套。
     **只注入一份** —— 两份都给模型，它会自己揉一个折中版本，比不填更糟。 */
  var WORLD_MAX = 50;
  var worldSaveTimer = null;
  function worldList() {
    var s = state.settings || {};
    return Array.isArray(s.worlds) ? s.worlds : [];
  }
  function ensureWorlds() {
    var s = state.settings || {};
    if (s.worldsSeeded) return;
    var presets = (window.CONFIG && CONFIG.WORLD_PRESETS) || [];
    var list = presets.map(function (p, i) {
      return { id: "w_p" + i, name: p.name, text: p.text, builtin: true };
    });
    state.settings = Store.saveSettings({
      worlds: list,
      worldId: list.length ? list[0].id : "",
      worldsSeeded: true
    });
  }
  function curWorld() {
    var list = worldList();
    if (!list.length) return null;
    var id = (state.settings && state.settings.worldId) || "";
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return list[0];
  }
  function worldFlush() {
    if (worldSaveTimer) { clearTimeout(worldSaveTimer); worldSaveTimer = null; }
    state.settings = Store.saveSettings({
      worlds: worldList(),
      worldId: (state.settings && state.settings.worldId) || ""
    });
  }
  function worldQueueSave() {
    if (worldSaveTimer) clearTimeout(worldSaveTimer);
    worldSaveTimer = setTimeout(worldFlush, 400);
  }
  function worldSetField(key, val) {
    var cur = curWorld();
    if (!cur || cur.builtin) return;      /* 内置只读 */
    cur[key] = val;
    var list = worldList();
    for (var i = 0; i < list.length; i++) { if (list[i].id === cur.id) list[i] = cur; }
    worldQueueSave();
  }
  function worldOptions() {
    return worldList().map(function (w) {
      return { id: w.id, name: w.name || "未命名", builtin: !!w.builtin };
    });
  }
  function worldTextOf(id) {
    var list = worldList();
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return String(list[i].text || ""); }
    return "";
  }
  function renderWorlds() {
    ensureWorlds();
    var list = worldList();
    var cur = curWorld();
    setText("#worldCount", String(list.length));
    var sel = document.getElementById("worldPick");
    if (sel) {
      sel.innerHTML = "";
      list.forEach(function (w) {
        var o = document.createElement("option");
        o.value = w.id;
        o.textContent = (w.name || "未命名") + (w.builtin ? "（内置）" : "");
        sel.appendChild(o);
      });
      sel.value = cur ? cur.id : "";
      if (UI.pickRefreshAll) UI.pickRefreshAll();
    }
    setVal("#worldName", cur ? (cur.name || "") : "");
    setVal("#worldText", cur ? (cur.text || "") : "");
    var ro = !!(cur && cur.builtin);
    var nm = document.getElementById("worldName");
    var tx = document.getElementById("worldText");
    if (nm) nm.readOnly = ro;
    if (tx) tx.readOnly = ro;
    var del = document.getElementById("worldDelBtn");
    if (del) del.disabled = ro || list.length <= 1;
    renderWorldList();
  }
  /* 列表：搜名称或内容；一次正好露出 5 套（高度在 CSS 里定死，多的内部滚） */
  function renderWorldList() {
    var box = document.getElementById("worldList");
    if (!box) return;
    var kw = String($v("#worldSearch") || "").trim().toLowerCase();
    var list = worldList();
    var cur = curWorld();
    box.innerHTML = "";
    var hit = 0;
    list.forEach(function (w) {
      var nm = String(w.name || "");
      var tx = String(w.text || "");
      if (kw && nm.toLowerCase().indexOf(kw) < 0 && tx.toLowerCase().indexOf(kw) < 0) return;
      hit++;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "world-item" + (cur && cur.id === w.id ? " on" : "");
      var nb = document.createElement("b");
      nb.textContent = nm || "未命名";
      b.appendChild(nb);
      if (w.builtin) {
        var tag = document.createElement("i");
        tag.textContent = "内置";
        b.appendChild(tag);
      }
      b.addEventListener("click", function () { worldPick(w.id); });
      box.appendChild(b);
    });
    if (!hit) {
      var e = document.createElement("div");
      e.className = "world-empty";
      e.textContent = kw ? "没有匹配的世界观" : "还没有世界观，点上面「新建一套」";
      box.appendChild(e);
    }
  }
  function worldPick(id) {
    worldFlush();
    state.settings = Store.saveSettings({ worldId: id });
    renderWorlds();
  }
  function worldNewId() { return "w_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function worldNew() {
    var list = worldList();
    if (list.length >= WORLD_MAX) { UI.toast("最多 " + WORLD_MAX + " 套，先删一套再建", true); return; }
    worldFlush();
    var w = { id: worldNewId(), name: "世界观 " + (list.length + 1), text: "" };
    list.push(w);
    state.settings = Store.saveSettings({ worlds: list, worldId: w.id });
    renderWorlds();
    UI.toast("已新建「" + w.name + "」");
  }
  function worldCopy() {
    var cur = curWorld();
    if (!cur) return;
    var list = worldList();
    if (list.length >= WORLD_MAX) { UI.toast("最多 " + WORLD_MAX + " 套，先删一套再建", true); return; }
    worldFlush();
    var w = { id: worldNewId(), name: (cur.name || "世界观") + "（副本）", text: cur.text || "" };
    list.push(w);
    state.settings = Store.saveSettings({ worlds: list, worldId: w.id });
    renderWorlds();
    UI.toast("已复制成一套自己的，可以改了");
  }
  function worldDel() {
    var cur = curWorld();
    if (!cur) return;
    if (cur.builtin) { UI.toast("内置的不能删，可以「复制当前」再改", true); return; }
    var list = worldList();
    if (list.length <= 1) { UI.toast("至少要留一套", true); return; }
    var i = -1;
    for (var k = 0; k < list.length; k++) { if (list[k].id === cur.id) i = k; }
    if (i < 0) return;
    list.splice(i, 1);
    state.settings = Store.saveSettings({ worlds: list, worldId: list[Math.max(0, i - 1)].id });
    renderWorlds();
    UI.toast("已删除");
  }
  function bindWorlds() {
    var sel = document.getElementById("worldPick");
    if (sel && !sel.dataset.bound) { sel.dataset.bound = "1"; sel.addEventListener("change", function () { worldPick(sel.value); }); }
    var b = document.getElementById("worldName");
    if (b && !b.dataset.bound) {
      b.dataset.bound = "1";
      b.addEventListener("input", function () { worldSetField("name", b.value); renderWorldList(); });
    }
    b = document.getElementById("worldText");
    if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("input", function () { worldSetField("text", b.value); }); }
    b = document.getElementById("worldNewBtn");  if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", worldNew); }
    b = document.getElementById("worldCopyBtn"); if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", worldCopy); }
    b = document.getElementById("worldDelBtn");  if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", worldDel); }
    b = document.getElementById("worldPanelBtn");
    if (b && !b.dataset.bound) {
      b.dataset.bound = "1";
      b.addEventListener("click", function () {
        var p = document.getElementById("worldPanel");
        if (!p) return;
        p.hidden = !p.hidden;
        b.textContent = p.hidden ? "展开世界观库（搜索 / 切换）" : "收起世界观库";
        if (!p.hidden) renderWorldList();
      });
    }
    b = document.getElementById("worldSearch");
    if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("input", renderWorldList); }
  }

  /* ── 离线原因（10-17）──────────────────────────────
     设置里可无限添加（抽屉式浮窗）；会话里只能从这里选，不能增改。
     存在 settings.offlineReasons；会话上的引用是 session.offlineReasonId。 */
  function reasonList() { var s = state.settings || {}; return Array.isArray(s.offlineReasons) ? s.offlineReasons : []; }
  function reasonText(id) {
    var list = reasonList();
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return String(list[i].text || ""); }
    return "";
  }
  function openReasonDrawer() {
    var el = document.getElementById("reasonDrawer");
    if (el) el.classList.remove("closing");
    renderReasonDrawer(); setHidden("#reasonDrawer", false);
  }
  /* 收起先播退场再 hidden（10-27）：原来一置 hidden 就硬切，进有动效出没有 */
  function closeReasonDrawer() {
    var el = document.getElementById("reasonDrawer");
    if (!el || el.hidden || el.classList.contains("closing")) return;
    el.classList.add("closing");
    setTimeout(function () {
      el.classList.remove("closing");
      setHidden("#reasonDrawer", true);
    }, 200);
  }
  function renderReasonDrawer() {
    var box = document.getElementById("reasonList");
    if (!box) return;
    box.innerHTML = "";
    var list = reasonList();
    if (!list.length) {
      var e = document.createElement("p");
      e.className = "hint";
      e.textContent = "还没有。下面加一条，比如「去上班了」。";
      box.appendChild(e);
      return;
    }
    list.forEach(function (r) {
      var item = document.createElement("div");
      item.className = "reason-item";
      var sp = document.createElement("span");
      sp.textContent = r.text;
      item.appendChild(sp);
      var del = document.createElement("button");
      del.className = "icon-btn r-del";
      del.type = "button";
      del.setAttribute("aria-label", "删除");
      del.innerHTML = UI.iconSvg("delete-outline");
      del.addEventListener("click", function () { delReason(r.id); });
      item.appendChild(del);
      box.appendChild(item);
    });
  }
  function addReason() {
    var inp = document.getElementById("reasonNewInput");
    var t = inp ? String(inp.value || "").trim() : "";
    if (!t) { UI.toast("先写一条理由", true); return; }
    var list = reasonList().slice();
    list.push({ id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: t });
    state.settings = Store.saveSettings({ offlineReasons: list });
    if (inp) inp.value = "";
    renderReasonDrawer();
  }
  function delReason(id) {
    state.settings = Store.saveSettings({ offlineReasons: reasonList().filter(function (r) { return r.id !== id; }) });
    renderReasonDrawer();
  }
  function bindReason() {
    var b;
    b = document.getElementById("openReasonBtn"); if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", openReasonDrawer); }
    b = document.getElementById("reasonClose");   if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", closeReasonDrawer); }
    b = document.getElementById("reasonMask");    if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", closeReasonDrawer); }
    b = document.getElementById("reasonAddBtn");  if (b && !b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", addReason); }
    var inp = document.getElementById("reasonNewInput");
    if (inp && !inp.dataset.bound) {
      inp.dataset.bound = "1";
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addReason(); } });
    }
  }

  /* 附带卡片的三层编辑器共用：多行名字 <-> 数组（设置页自己留一份，别依赖 chat.js 的加载顺序） */
  function parseCardLines(text) {
    var out = [];
    String(text || "").split(/\r?\n/).forEach(function (line) {
      var n = line.trim();
      if (!n || n.length > 12 || out.indexOf(n) >= 0) return;
      out.push(n);
    });
    return out.slice(0, 20);
  }
  function cardNamesText(arr) {
    return (Array.isArray(arr) ? arr : []).map(function (x) { return String((x && x.name) || x || ""); })
      .filter(Boolean).join("\n");
  }

  var api = {
    introShow: introShow, introFinish: introFinish, introNext: introNext, introPrev: introPrev,
    openIntro: openIntro,
    doExportDownload: doExportDownload, doExportShare: doExportShare, doExportCopy: doExportCopy,
    importFromText: importFromText, importFromFile: importFromFile, syncExportScope: syncExportScope,
    openData: openData, saveImage: saveImage,
    /* 我的人设（10-26）：角色页要用「选一套套进去」，所以把列表和按 id 套用挂出来 */
    personaOptions: personaOptions, personaApplyById: personaApplyById,
    /* 世界观库（10-26）：启动时注入内置 10 套；角色页下拉要列表和按 id 取正文 */
    ensureWorlds: ensureWorlds, worldOptions: worldOptions, worldTextOf: worldTextOf,
    snapshotSession: snapshotSession, sessionsForExport: sessionsForExport, saveSnapshot: saveSnapshot,
    buildExportData: buildExportData, applyImport: applyImport,
    maybeAutoBackup: maybeAutoBackup, backupNow: backupNow, restoreBackupNow: restoreBackupNow,
    renderBackupLine: renderBackupLine, renderCharUsage: renderCharUsage, recordUsage: recordUsage,
    renderUsageStats: renderUsageStats, migrateData: migrateData,
    resetGroup: resetGroup, resetAllSettings: resetAllSettings,
    fillSettings: fillSettings, syncRangeLabels: syncRangeLabels, syncProviderFields: syncProviderFields,
    renderModelSets: renderModelSets, readAllSets: readAllSets, parseModels: splitModels,
    toggleModelPanel: toggleModelPanel, closeModelPanel: closeModelPanel, renderModelBadge: renderModelBadge,
    readSettingsForm: readSettingsForm, syncChip: syncChip, syncToggles: syncToggles,
    selfTest: selfTest, renderGroupCog: renderGroupCog,

    /* D2 应用加密（锁屏层 + 找回 + 设置页那段） */
    lockGate: lockGate, lockAppReady: lockAppReady,
    lockSubmit: lockSubmit, lockForgot: lockForgot, lockBackToPass: lockBackToPass,
    recSubmit: recSubmit, quizStart: quizStart, quizSubmit: quizSubmit, quizGiveUp: quizGiveUp,
    lockResetSave: lockResetSave, lockResetBack: lockResetBack, lockQuit: lockQuit,
    lockToggle: lockToggle, lockChangePass: lockChangePass, lockResetCode: lockResetCode,
    codeCopy: codeCopy, codeClose: codeClose, renderLockState: renderLockState
  };
  Object.keys(api).forEach(function (k) {
    /* 同上（roleplay.js）：只转发现有函数，undefined 成员会让调用点抛
       「Cannot read property 'apply' of undefined」，看着像框架问题。 */
    if (typeof api[k] !== "function") return;
    D[k] = function () { syncModules(); return api[k].apply(null, arguments); };
  });

  /* 脚本一跑就先决定「要不要关门」。放在这儿是为了不依赖 app.js 的执行顺序。 */
  try { lockInitialCover(); } catch (e) { console.warn("[Sekulum] 锁屏层初始化失败", e); }
  /* 设置页 7 大模块 + 我的人设：DOM 已就绪（脚本在 body 末尾），一次绑定即可 */
  try { bindSettingsHome(); bindPersona(); bindReason(); } catch (e) { console.warn("[Sekulum] 设置分区绑定失败", e); }

  (window.__dlScripts = window.__dlScripts || []).push("settings.js");
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
