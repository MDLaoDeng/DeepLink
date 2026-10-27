/* Sekulum —— 本地存储：设置、会话、主题 */
(function () {
  const K_SETTINGS = "aicode.settings.v1";

  /* ── 每个模型区各自最多 6 套配置 ──────────────────
     一个「配置」= 名字 + 接口地址 + API Key + 模型（可以多个，每行一个）。

     主模型 / 听觉 / 朗读 / 画图 / 视觉 五个区各管各的，互不影响。
     主模型那区一个配置里可以写多个模型名（聊天页右上角就在这些里面挑）；
     其余区一个配置写一个模型名即可。

     设计原则：modelSets 是「配置库」，那些扁平字段（baseUrl/apiKey/model、
     asrBaseUrl/asrKey/asrModel…）是「生效值」—— 永远等于当前那套配置的值。
     所以 media.js / search.js / api.js 这些只读扁平字段的模块，完全不用知道多配置的存在。

     本函数是幂等的：任何时候调、调多少次，结果都一致。 */
  const MAX_SETS = 6;
  const CN_NUM = ["一", "二", "三", "四", "五", "六"];
  const DEFAULT_BASE_URL = "https://api.deepseek.com";

  /* 每个模型区 ↔ 扁平字段的映射 */
  const SET_FLAT = {
    main:   { base: "baseUrl",       key: "apiKey",     model: "model" },
    asr:    { base: "asrBaseUrl",    key: "asrKey",     model: "asrModel" },
    tts:    { base: "ttsBaseUrl",    key: "ttsKey",     model: "ttsModel" },
    img:    { base: "imgBaseUrl",    key: "imgKey",     model: "imgModel" },
    vision: { base: "visionBaseUrl", key: "visionKey",  model: "visionModel" }
  };
  const SET_KINDS = Object.keys(SET_FLAT);

  /* 一行一个模型名，也认中英文逗号 */
  function splitModelList(text) {
    return String(text || "").split(/[\n,\uff0c]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /* fromDisk=false 表示磁盘上还没存过 modelSets → 用扁平字段造「配置一」 */
  function normalizeModelSets(s, fromDisk) {
    const srcSets = (fromDisk && s.modelSets && typeof s.modelSets === "object") ? s.modelSets : {};
    const srcIdx = (s.modelSetIndex && typeof s.modelSetIndex === "object") ? s.modelSetIndex : {};
    const sets = {};
    const index = {};
    SET_KINDS.forEach(function (kind) {
      const f = SET_FLAT[kind];
      let list = [];
      if (Array.isArray(srcSets[kind])) {
        list = srcSets[kind]
          .filter((p) => p && typeof p === "object")
          .slice(0, MAX_SETS)
          .map(function (p, i) {
            return {
              name: String(p.name || ("配置" + (CN_NUM[i] || String(i + 1)))),
              baseUrl: String(p.baseUrl || ""),
              apiKey: String(p.apiKey || ""),
              models: String(p.models || "")
            };
          });
      }
      if (!list.length) {
        list = [{
          name: "配置一",
          baseUrl: String(s[f.base] || (kind === "main" ? DEFAULT_BASE_URL : "")),
          apiKey: String(s[f.key] || ""),
          models: String(s[f.model] || "")
        }];
      }
      let idx = Number(srcIdx[kind]);
      if (!isFinite(idx) || idx < 0) idx = 0;
      if (idx > list.length - 1) idx = list.length - 1;
      const active = list[idx];
      const ms = splitModelList(active.models);
      /* 生效值只取当前那套，**不**回落到旧扁平字段 ——
         否则切到一套没填 Key 的配置时，会拿着上一套的 Key 去请求，又难查又危险。
         主模型地址空着兜一个默认值；其余区留空是「有意义的空」——
         media.js 会把它当作「沿用主模型」，这正是设置页里写的那条规则。 */
      s[f.base] = String(active.baseUrl || (kind === "main" ? DEFAULT_BASE_URL : ""));
      s[f.key] = String(active.apiKey || "");
      if (kind === "main") {
        /* 当前主模型还在新配置的清单里就留着，否则取第一个；全空兜一个名字免得请求直接挂 */
        const cur = String(s[f.model] || "");
        s[f.model] = (ms.indexOf(cur) >= 0) ? cur : (ms[0] || cur || "deepseek-flash");
      } else {
        s[f.model] = ms[0] || "";
      }
      sets[kind] = list;
      index[kind] = idx;
    });
    return { sets: sets, index: index };
  }
  const K_SESSIONS = "aicode.sessions.v1";
  const K_CURRENT = "aicode.current.v1";
  const K_CHARS = "aicode.characters.v1";
  /* 关键表的备份键（ADV-03）：会话与角色卡都是「整表写入」，
     一旦写坏 / 主键被清掉就是「聊天记录全没了」。写之前把上一版留在这里，
     读不到主键时能退回来。settings 这类小表不备份 —— 坏了重填就行。 */
  const K_BAK_SESSIONS = "aicode.bak.sessions";
  const K_BAK_CHARS = "aicode.bak.characters";
  const BAK_MAP = {};
  BAK_MAP[K_SESSIONS] = K_BAK_SESSIONS;
  BAK_MAP[K_CHARS] = K_BAK_CHARS;
  const K_USAGE = "aicode.usage.v1";
  const K_USAGECAT = "aicode.usagecat.v1";
  /* 手机「动态」：全局一条时间线。可见范围记在每条动态自己的 lines 里（会话 id 数组） */
  const K_MOMENTS = "aicode.moments.v1";
  /* 社交层（7.1）：好友申请队列。角色的资料字段（Sekulum 号 / 电话 / 备注…）
     存在角色对象自己的 social 子对象上，见 profile.js 的 ensureSocial。
     这里只放「谁想加谁、通过没有、从哪儿来的」这类关系事件。 */
  const K_SOCIAL = "aicode.social.v1";
  const K_AMEM = "aicode.assistantmem.v1";
  const K_BACKUPS = "aicode.backups.v1";
  /* 角色个人图库索引：{ 角色id: [ {id, ref, mime, style, styleName, subject, desc, ts} ] }
     图片文件本体走外置文件（原生桥），这里只存「谁有什么图、每张画的是什么」。 */
  const K_CHARIMG = "aicode.charimg.v1";

  function safeParse(text, fallback) {
    try {
      const v = JSON.parse(text);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  /* 读失败（localStorage 抛异常）时置真：此时绝不允许覆盖写入，否则会把用户历史洗掉 */
  let readError = false;
  /* 解析结果内存缓存：避免每次 getSessions 都重新 JSON.parse 全量（对话多时会卡）。
     （角色卡的内存明文缓存是 charsPlain，见下面「角色卡加密」段） */
  let sessionsCache = null;

  /* ── 存储后端 ─────────────────────────────────────
     封装工具在产物里注入了一个原生对象 `webapp`（@JavascriptInterface），
     它的「数据存储与获取类」接口和 localStorage 几乎一样，但**同步、无 5MB 上限**：
       webapp.存储指定文本(key, value) / webapp.获取指定文本(key, 默认值) / webapp.删除指定存储(key)
     容器/浏览器里没有这个对象 → 自动退回 localStorage，行为完全不变。 */
  /* ⚠️ aicode.devsalt.v1 必须在名单里：它是 dl2 记忆密文的外层密钥材料，
     漏了它，迁移后原生读不到盐 → devSalt() 生成新盐覆盖写 → 盘上所有密文永久解不开。
     盐和密文必须同生共死，这是「整机搬家」，一个键都不能少。 */
  const NATIVE_KEYS = ["aicode.settings.v1", "aicode.sessions.v1", "aicode.current.v1",
    "aicode.characters.v1", "aicode.usage.v1", "aicode.usagecat.v1", "aicode.moments.v1", "aicode.assistantmem.v1", "aicode.backups.v1", "aicode.charimg.v1",
    "aicode.devsalt.v1"];
  let backend = null;
  /* 迁移是否已经跑过一遍。跑过之后，原生返回空就代表「这个键真的没有」，
     不能再回落到 localStorage —— 那是迁移时留下的旧快照，会让「清空 / 删除」读回旧值。
     见 readRaw 的注释。 */
  let nativeMigrated = false;
  let migrateRetry = 0;   /* 迁移失败后的重试次数（有上限，避免永久失败时每 5 秒重来一次） */

  function nativeKV() {
    try {
      const w = window.webapp;
      return (w && typeof w["获取指定文本"] === "function" && typeof w["存储指定文本"] === "function" && typeof w["删除指定存储"] === "function") ? w : null;
    } catch (e) { return null; }
  }
  /* 首次使用时做一次读写自检，通过才用原生存储（不通过就安全退回 localStorage） */
  function pickBackend() {
    if (backend) return backend;
    backend = "local";
    const w = nativeKV();
    if (!w) return backend;
    try {
      const probe = "dl_probe_" + Math.random().toString(36).slice(2);
      w["存储指定文本"](probe, probe);
      const back = w["获取指定文本"](probe, "");
      w["删除指定存储"](probe);
      if (back === probe) {
        backend = "native";
        /* 迁移放到后台跑：首次往原生写大量数据很慢，阻塞会拖死启动（而且读会先走 localStorage 兑底） */
        setTimeout(migrateToNative, 1500);
      }
      else console.warn("[Sekulum] 原生存储自检未通过，用 localStorage");
    } catch (e) {
      console.warn("[Sekulum] 原生存储不可用，用 localStorage", e);
    }
    return backend;
  }
  /* 一次性把已有数据搬进原生存储；localStorage 原样保留一份作兜底快照 */
  function migrateToNative() {
    const w = nativeKV();
    if (!w) return;
    /* 逐个键各自 try：任何一个键写失败都算【没搬完】，绝不能置 nativeMigrated。
       置了之后 readRaw 会停止回落 localStorage，那些没搬过去的键当场读成空 ——
       用户看到「历史全没了」，接着新建会话还会把仅存的数据覆盖掉。 */
    let failed = false;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || NATIVE_KEYS.indexOf(k) < 0) continue;
      try {
        if (w["获取指定文本"](k, "")) continue;   /* 原生已有 → 不覆盖 */
        const v = localStorage.getItem(k);
        if (v == null) continue;
        const r = w["存储指定文本"](k, v);
        if (r === false) { failed = true; break; }
      } catch (e) { failed = true; break; }
    }
    if (failed) {
      migrateRetry++;
      if (migrateRetry <= 3) setTimeout(migrateToNative, 5000);
      else console.warn("[Sekulum] 数据迁移多次失败，仍按 localStorage 读取（不会丢数据）");
      return;
    }
    /* 确实搬完了一遍：此后原生返回空即为「这个键真的没有」，
       readRaw 不再回落 localStorage（否则会读回这里的旧快照）。 */
    migrateRetry = 0;   /* 成功过就把失败计数清掉，否则以后再失败一次就直接放弃 */
    nativeMigrated = true;
  }
  /* 统一调用原生桥：不存在或抛错都安全空转（返 undefined），保证无桥环境（浏览器/测试/预览）行为不变 */
  function callBridge(name) {
    let w = null;
    try { w = window.webapp; } catch (e) { w = null; }
    if (!w || typeof w[name] !== "function") return undefined;
    try { return w[name].apply(w, Array.prototype.slice.call(arguments, 1)); }
    catch (e) { console.warn("[Sekulum] 原生接口调用失败：" + name, e); return undefined; }
  }
  function hasBridge(name) {
    try { return !!(window.webapp && typeof window.webapp[name] === "function"); } catch (e) { return false; }
  }
  function readRaw(key) {
    try {
      if (pickBackend() === "native") {
        const v = nativeKV()["获取指定文本"](key, "");
        if (v !== "" && v != null) { readError = false; return String(v); }
        /* 迁移已经跑过 → 原生返回空就是「这个键真的没有」：直接返回空，
           绝不能回落 localStorage —— 那是迁移时留下的旧快照，会让
           「清空 / 删除」读回旧值（例如删掉的当前会话又回来了）。
           只有「迁移还没跑完」时才回落，那时数据确实还没搬过去。 */
        if (nativeMigrated) { readError = false; return null; }
        /* 原生还没这个键（迁移还没跑完）→ 退回 localStorage，避免“数据像丢了” */
      }
      const out = localStorage.getItem(key);
      /* 读成功就把错误标记清掉：这个标记是「刚刚读失败」的意思，
         一直挂着会让 getSessions 永久返回空、所有写入被永久拒绝 ——
         一次偶发失败就能把 App 变成只读且「数据全丢」的样子。 */
      readError = false;
      return out;
    } catch (e) { readError = true; return undefined; }
  }
  /* 最近一次写盘到底成没成。
     localStorage 配额满 / 原生 KV 被锁时 setItem 会抛，writeRaw 吞掉了异常只回 false ——
     以前调用方（尤其 saveSettings）根本不看这个返回值，于是「设置已保存」照样弹出来，
     重启后全回落。这里记一笔，界面在关键保存点查一下就能如实报错。 */
  let lastWriteOk = true;
  /* 纯写，不碰备份 —— 给「写备份」自己用，避免递归 */
  function rawSet(key, val) {
    try {
      if (pickBackend() === "native") {
        const r = nativeKV()["存储指定文本"](key, String(val));
        return r !== false;
      }
      localStorage.setItem(key, String(val));
      return true;
    } catch (e) { return false; }
  }

  /* m3：备份节流。同一张表 5 分钟内只备份一次。
     不节流的话，saveSessions（12 个调用点）每写一次都要「读全表 + 再写一份全表备份」，
     角色卡那边一次保存本来就要写两次（明文兜底 + 密文），叠上备份就是 2 读 4 写。
     破坏性写入（用户清空 / 导入覆盖 / 恢复备份）由调用方传 forceBak 强制备份。 */
  const BAK_LAST = {};
  const BAK_GAP = 5 * 60 * 1000;

  function writeRaw(key, value, forceBak) {
    /* ADV-03：关键表写之前把「上一版」存成备份。
       顺序很讲究：先备份旧值、再写新值。备份失败绝不能挡住主写入。 */
    const bk = BAK_MAP[key];
    if (bk && (forceBak || !BAK_LAST[bk] || Date.now() - BAK_LAST[bk] > BAK_GAP)) {
      try {
        const old = readRaw(key);
        if (old != null && String(old).length > 2 && rawSet(bk, String(old))) {
          BAK_LAST[bk] = Date.now();
        }
      } catch (e) { /* ignore */ }
    }
    try {
      if (pickBackend() === "native") {
        const r = nativeKV()["存储指定文本"](key, String(value));
        /* 原生明确回 false = 没写成（配额满 / 库被锁）。以前一律当成功，
           于是「已保存」照弹、重启全回落。抛出去交给外层 catch 记 lastWriteOk。 */
        if (r === false) throw new Error("原生存储写入失败");
        lastWriteOk = true;
        return true;
      }
      localStorage.setItem(key, value);
      lastWriteOk = true;
      return true;
    } catch (e) { lastWriteOk = false; return false; }
  }
  function removeRaw(key) {
    try {
      if (pickBackend() === "native") { nativeKV()["删除指定存储"](key); return true; }
      localStorage.removeItem(key);
      return true;
    } catch (e) { return false; }
  }

  /* ── 图片外置：内联 base64 → 文件 + 引用（imgRef）─────────────────
     为什么要做：一张 1600px 的 jpg 约 300KB~1MB，转成 base64 还要再涨三分之一。
     几十张图累积起来，会话 JSON 就到几十 MB —— 原生存储与 localStorage 都吃不消，
     而且每次 saveSessions 都要把整坨重新序列化一遍。
     做法：图片落到 App 目录的文件里，会话里只留一个路径引用（imgRef）。

     三条底线（一条都不能少）：
       ① 只加不删 —— 写文件【成功】之后才删内联 dataUrl；
       ② 失败保持原样 —— 任何一步失败都原样留着内联，宁可体积没降，绝不丢图；
       ③ 无桥环境（浏览器 / 测试 / 预览）自动空转 —— 没有原生接口就什么都不做，
          既有用例行为完全不变。 */
  const IMG_PREFIX = "dl_img_";
  /* imgRef → 可直接用的 data URL 缓存。
     为什么要缓存：渲染一次消息列表会问一遍所有可见图片，没缓存就要每次都同步读文件。
     为什么要【限长】：缓存里是完整 base64，一张图几百 KB，不封顶会一直涨。
     满了就按插入顺序淘汰最早的（下次用到再读一次，代价远小于内存失控）。 */
  const imgCache = {};
  const imgCacheKeys = [];
  const IMG_CACHE_MAX = 20;
  function imgCachePut(ref, url) {
    if (imgCache[ref] === undefined) imgCacheKeys.push(ref);
    imgCache[ref] = url;
    while (imgCacheKeys.length > IMG_CACHE_MAX) {
      const k = imgCacheKeys.shift();
      if (k !== ref) delete imgCache[k];
    }
  }
  function imgCacheDrop(ref) {
    delete imgCache[ref];
    const i = imgCacheKeys.indexOf(ref);
    if (i >= 0) imgCacheKeys.splice(i, 1);
  }
  let imgDirCache = null;

  /* 图片落到哪个目录：优先内部私有目录（无需权限、最不容易被系统清理），
     拿不到再退外部私有目录（同样无需权限）。 */
  function imgDir() {
    if (imgDirCache !== null) return imgDirCache;
    let d = "";
    if (hasBridge("获取内部文件目录")) d = String(callBridge("获取内部文件目录") || "");
    if (!d && hasBridge("获取外部文件目录")) d = String(callBridge("获取外部文件目录") || "");
    imgDirCache = d.replace(/\/+$/, "");
    return imgDirCache;
  }
  /* 文件名由【内容】决定：同一张图重复搬家不会产生第二个文件，迁移也可以安全重跑 */
  function imgHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h.toString(36);
  }
  function imgSplit(dataUrl) {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataUrl == null ? "" : dataUrl));
    if (!m) return null;
    return { mime: m[1] || "image/jpeg", b64: m[3] || "" };
  }
  function imgExt(mime) {
    const t = String(mime || "");
    if (t.indexOf("png") >= 0) return "png";
    if (t.indexOf("webp") >= 0) return "webp";
    if (t.indexOf("gif") >= 0) return "gif";
    return "jpg";
  }

  /* 把一条附件的内联图搬进文件。返回 true = 「这条现在已经有引用了」（含本来就有的情况） */
  function hoistOne(att) {
    if (!att || att.kind !== "image") return true;   /* 非图片不管 */
    if (att.imgRef) return true;                     /* 已是引用 */
    if (!att.dataUrl) return true;                   /* 既没内联也没引用：保持原样 */
    if (!hasBridge("保存指定文件")) return false;     /* 无桥：原样留着内联 */
    const dir = imgDir();
    if (!dir) return false;
    const sp = imgSplit(att.dataUrl);
    if (!sp || !sp.b64) return false;
    const path = dir + "/" + IMG_PREFIX + imgHash(sp.mime + ":" + sp.b64) + "." + imgExt(sp.mime);
    try {
      const w = callBridge("保存指定文件", path, att.dataUrl);
      if (w === false) return false;                 /* 原生明确说没写成 */
      if (hasBridge("判断指定文件")) {
        if (callBridge("判断指定文件", path) === false) return false;
      } else if (w === undefined) {
        /* 没有「判断指定文件」可复核、保存又只回了个 undefined/void：
           有些原生实现就是这样（settings.js 里也注明过）。没法确认文件到底写没写成，
           那就宁可不搬 —— 绝不能在「文件可能没写成」的情况下把内联图删掉。 */
        return false;
      }
    } catch (e) { return false; }                    /* 抛错也算失败 */
    /* 到这里文件确实在了，才动内联 —— 这就是底线① */
    att.imgRef = path;
    /* 【故意不预填缓存】：搬家只是把图挪到文件里，不需要为此在内存里再留一份完整 base64
       （否则迁移几十张图会瞬间吃掉一大块内存）。真正渲染时自然会读一次并缓存。 */
    delete att.dataUrl;
    return true;
  }

  /* 扫描会话里的所有附件，能搬的都搬走。返回搬了几张 */
  function hoistImages(list) {
    if (!hasBridge("保存指定文件")) return 0;
    let n = 0;
    (list || []).forEach((s) => {
      /* 主聊天消息 + 手机消息都要扫：手机里的图同样是大图，不能只留在内联 */
      const bags = [(s && s.messages) || [], (s && s.phone && s.phone.msgs) || []];
      bags.forEach((msgs) => {
        for (let i = 0; i < msgs.length; i++) {
          const as = (msgs[i] && msgs[i].attachments) || [];
          for (let j = 0; j < as.length; j++) {
            const a = as[j];
            if (!a || a.kind !== "image" || !a.dataUrl || a.imgRef) continue;
            if (hoistOne(a)) n++;
          }
        }
      });
    });
    return n;
  }

  /* ── 角色个人图库：和「角色本人」相关的图，单独归档 ────────────────
     用户口径：跟角色自己相关的图存进一个文件夹，每次再生成前先看一眼，
     免得长相 / 发色 / 常穿的衣服前后对不上。
     做法：图片文件走外置文件机制（原生桥「保存指定文件」），优先放进私有目录下的
     charimg/ 子目录（放不成就平铺到私有目录、用 dl_cimg_ 前缀区分）；
     图库索引（谁有什么图、每张画的是什么）另存一份小 JSON，落在原生 KV 里。
     三条底线同 hoistOne：写成功才登记、失败保持原样、无桥自动空转。 */
  const CIMG_PREFIX = "dl_cimg_";
  const CIMG_MAX = 12;              /* 每个角色最多留 12 张，超了从最老的开始清（够保形象一致，也不占地方） */

  function charImgAll() {
    const raw = readRaw(K_CHARIMG);
    if (raw === undefined) return {};
    const v = safeParse(raw, {});
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  }
  function charImgSaveAll(map) {
    if (readError) return;
    writeRaw(K_CHARIMG, JSON.stringify(map || {}));
  }

  /* 把一段 dataUrl 写进外置文件，返回落到哪个路径（写不成就回空串）。
     先试子目录、再退平铺：原生实现不一定支持自动建目录，两种都试一遍最稳。 */
  function saveExternalImage(dataUrl, prefix) {
    if (!hasBridge("保存指定文件")) return "";
    const dir = imgDir();
    if (!dir) return "";
    const sp = imgSplit(dataUrl);
    if (!sp || !sp.b64) return "";
    const file = (prefix || CIMG_PREFIX) + imgHash(sp.mime + ":" + sp.b64) + "." + imgExt(sp.mime);
    const cands = [dir + "/charimg/" + file, dir + "/" + file];
    for (let i = 0; i < cands.length; i++) {
      const p = cands[i];
      try {
        const w = callBridge("保存指定文件", p, dataUrl);
        if (w === false) continue;
        if (hasBridge("判断指定文件")) {
          if (callBridge("判断指定文件", p) === false) continue;
        } else if (w === undefined) {
          continue;   /* 没法确认写没写成 → 换下一个候选，绝不假装成功 */
        }
        return p;
      } catch (e) { /* 换下一个候选 */ }
    }
    return "";
  }
  /* 从外置文件读回可直接用的 data URL */
  function readExternalImage(path, mime) {
    if (!path) return "";
    try {
      const back = String(callBridge("获取文件内容", path) || "");
      if (!back) return "";
      return back.slice(0, 5) === "data:" ? back : ("data:" + (mime || "image/png") + ";base64," + back);
    } catch (e) { return ""; }
  }

  /* ── 记忆加密（双层：内层随机 AES-256-GCM，外层用「设备密钥」派生）─────
     只加密「记忆」：各会话的 memory + cognition（备份快照里同。
     crypto.subtle 是异步的，但 getSessions() 必须同步，所以明文放内存缓存
     plainMem，密文放 cipherMem；启动时 unlockMemory() 解一次。

     外层密钥有两代：
       dl1（老版）—— 用源码里写死的口令 MDLDDS 派生。谁拿到源码谁都能解，只挡「随手翻文件」。
       dl2（现在）—— 用「设备标识 + 每次安装随机生成的盐」派生：
                     盐存本机、不上云、不进导出文件。换了手机或清了 App 数据就解不开。
                     拿不到设备标识（浏览器 / 老封装）→ 退回内置口令，行为与老版一致。
     两代密文都能解；启动时会把剩下的 dl1 在后台悄悄换成 dl2（换不动就原样留着，绝不变砖）。
     必须说清楚：这仍然只是【防翻看】，不是【防有备而来】—— 派生材料都在本机。 */
  const CRYPT_PASS = "MDLDDS";                       /* 老版口令，仅用于解 dl1 */
  const K_DEV_SALT = "aicode.devsalt.v1";
  const ENC_V2 = "dl2:";
  const ENC_V1 = "dl1:";
  let outerKey = null;                               /* dl1 的外层密钥（懒派生） */
  let outerKey2 = null;                              /* dl2 的外层密钥（懒派生） */
  let devSaltCache = null;
  let devSeedCache = null;
  let memUnlocked = false;
  const plainMem = {};
  const cipherMem = {};
  const encPlain = {};
  /* 有密文但【解不开】的会话（换机 / 清了 App 数据）：一律不缓存、不覆盖、不删明文。
     少了这道闸，「解不开 → 继续用 → 保存」会用当前设备密钥把老密文盖掉，原数据就永久没了。 */
  const brokenMem = {};
  let memSeq = 0;
  let memPending = Promise.resolve();
  let memUnlockPromise = null;   /* 启动解锁只跑一次，后来者共享同一个 Promise（见 unlockMemory） */

  function cryptoOk() {
    try { return !!(window.crypto && window.crypto.subtle && window.TextEncoder && window.btoa); } catch (e) { return false; }
  }
  function bytesToB64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function b64ToBytes(str) {
    const bin = atob(str);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function outerAesKey() {
    if (outerKey) return outerKey;
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(CRYPT_PASS), "PBKDF2", false, ["deriveKey"]);
    outerKey = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: enc.encode("deeplink-memory-v1"), iterations: 120000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return outerKey;
  }

  function isLegacyEnc(str) { return typeof str === "string" && str.slice(0, 4) === ENC_V1; }

  /* 每次安装的随机盐：生成一次就存本机（走 readRaw/writeRaw → 有原生存储就落原生）。
     存不出来（无 localStorage / 写入被拒）→ 退化成「本次进程内有效」，
     不影响本次使用，只是下次启动解不开老密文（那时仍然能解 dl1 兜底）。 */
  function devSalt() {
    if (devSaltCache !== null) return devSaltCache;
    let v = "";
    try { v = String(readRaw(K_DEV_SALT) || ""); } catch (e) { v = ""; }
    if (!v && cryptoOk()) {
      v = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
      /* ⚠️ 读失败时【绝不能覆盖写】：readRaw 出错会返回 undefined（readError=true），
         此时误判成「没盐」再写一把新的，会让盘上原有的盐被换掉 —— 既有的 dl2 密文全部永久解不开。
         读失败就只在本轮进程内用临时盐（解不开老密文，但绝不破坏盘上的盐）。 */
      if (!readError) { try { writeRaw(K_DEV_SALT, v); } catch (e) { /* ignore */ } }
    }
    devSaltCache = v;
    return v;
  }
  /* 设备标识：桥有「获取设备ID」就用它，否则空串（外层退回内置口令） */
  function devSeed() {
    if (devSeedCache !== null) return devSeedCache;
    let id = "";
    try { id = String(callBridge("获取设备ID") || ""); } catch (e) { id = ""; }
    devSeedCache = id;
    return devSeedCache;
  }
  async function outerAesKey2() {
    if (outerKey2) return outerKey2;
    const enc = new TextEncoder();
    const salt = devSalt();
    const id = devSeed();
    const secret = id ? ("dl2|" + id + "|" + salt) : CRYPT_PASS;
    const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
    outerKey2 = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64ToBytes(salt), iterations: 120000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return outerKey2;
  }

  /* 双层加密：内层随机密钥，随机密钥被外层密钥包住，所以只用外层就能解。
     统一走这里，换外层密钥（dl1 → dl2）不用动别处。 */
  async function outerEncrypt(text, prefix, key) {
    const enc = new TextEncoder();
    const inner = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const iv1 = crypto.getRandomValues(new Uint8Array(12));
    const c1 = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv1 }, inner, enc.encode(text)));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", inner));
    const wrap = enc.encode(JSON.stringify({ k: bytesToB64(raw), i1: bytesToB64(iv1), d: bytesToB64(c1) }));
    const iv2 = crypto.getRandomValues(new Uint8Array(12));
    const c2 = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv2 }, key, wrap));
    return prefix + bytesToB64(iv2) + ":" + bytesToB64(c2);
  }
  /* 解不开（密文损坏 / 密钥不对）一律返 null，绝不向调用方抛异常 */
  async function outerDecrypt(str, prefixLen, key) {
    const parts = str.slice(prefixLen).split(":");
    if (parts.length !== 2) return null;
    try {
      const wrap = JSON.parse(new TextDecoder().decode(new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64ToBytes(parts[0]) }, key, b64ToBytes(parts[1])))));
      const inner = await crypto.subtle.importKey("raw", b64ToBytes(wrap.k), { name: "AES-GCM" }, false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(wrap.i1) }, inner, b64ToBytes(wrap.d));
      return new TextDecoder().decode(plain);
    } catch (e) { return null; }
  }
  /* 新写入一律 dl2（设备密钥） */
  async function encryptMem(text) {
    if (!cryptoOk()) return "";
    return outerEncrypt(text, ENC_V2, await outerAesKey2());
  }
  /* 两代都能解：dl2 用设备密钥，dl1 用老口令 */
  async function decryptMem(str) {
    if (!cryptoOk() || typeof str !== "string") return null;
    if (str.slice(0, 4) === ENC_V2) return outerDecrypt(str, 4, await outerAesKey2());
    if (str.slice(0, 4) === ENC_V1) return outerDecrypt(str, 4, await outerAesKey());
    return null;
  }
  /* 会话级私密字段：跟记忆一起进【同一个】加密载荷。
     这三项（当前场景 / 当前关系 / 共同经历）以前是明文存在会话 JSON 里的，
     所以升级时必须把老明文并进密文 —— 见 unlockMemory 的升级段。 */
  const MEM_EXTRA = ["scene", "relation", "shared"];
  function memExtraOf(s) {
    const o = {};
    for (let i = 0; i < MEM_EXTRA.length; i++) { const k = MEM_EXTRA[i]; o[k] = (s && s[k]) || ""; }
    return o;
  }
  function memPlainOf(s) {
    return JSON.stringify(Object.assign(
      { memory: (s && s.memory) || null, cognition: (s && s.cognition) || "" },
      memExtraOf(s)));
  }
  /* ── 弱加密：没有 WebCrypto 时的退路 ───────────────────────
     **不是加密，是混淆**：口令派生一条字节流做异或，挡的是「捡到文件随手打开」。
     前缀 dlpw1: 必须保留 —— 导入端靠它认路线，界面靠 canEncrypt() 提示用户这是弱保护。 */
  function weakStream(pass, len) {
    const p = String(pass || "\u0000");
    const n = p.length || 1;
    const out = new Uint8Array(len);
    let h = 0x811c9dc5;
    for (let i = 0; i < len; i++) {
      h ^= p.charCodeAt(i % n) || 0x27;
      h = (h * 16777619) >>> 0;
      h ^= (i * 131) & 0xff;
      h = (h * 16777619) >>> 0;
      out[i] = h & 0xff;
    }
    return out;
  }
  function weakSeal(text, pass) {
    const raw = new TextEncoder().encode(String(text == null ? "" : text));
    const ks = weakStream(pass, raw.length);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw[i] ^ ks[i];
    return "dlpw1:" + bytesToB64(buf);
  }
  function weakOpen(str, pass) {
    try {
      const buf = b64ToBytes(String(str).slice(6));
      const ks = weakStream(pass, buf.length);
      const raw = new Uint8Array(buf.length);
      for (let i = 0; i < buf.length; i++) raw[i] = buf[i] ^ ks[i];
      return new TextDecoder().decode(raw);
    } catch (e) { return null; }
  }

  /* 用「用户自设口令」加密（口令不存进 App，用于导出文件、只有本人能解） */
  async function sealWithPass(text, pass) {
    /* 没有 WebCrypto（非安全上下文 / 老内核）时不再直接失败：
       导出是换机的唯一手段，直接拒绝等于这台机器无法迁移数据。
       降级成「口令混淆」，用 dlpw1: 前缀**明确标记**，导入时按标记走弱路线；
       界面另外提示一句，不让人以为这是真加密。 */
    if (!cryptoOk()) return weakSeal(text, pass);
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 150000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(text)));
    return "dlp1:" + bytesToB64(salt) + ":" + bytesToB64(iv) + ":" + bytesToB64(ct);
  }
  async function openWithPass(str, pass) {
    /* 弱加密（没有 WebCrypto 时导出的）按前缀识别，走同一条还原路径 */
    if (typeof str === "string" && str.slice(0, 6) === "dlpw1:") return weakOpen(str, pass);
    if (!cryptoOk() || typeof str !== "string" || str.slice(0, 5) !== "dlp1:") return null;
    const parts = str.slice(5).split(":");
    if (parts.length !== 3) return null;
    try {
      const enc = new TextEncoder();
      const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64ToBytes(parts[0]), iterations: 150000, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(parts[1]) }, key, b64ToBytes(parts[2]));
      return new TextDecoder().decode(plain);
    } catch (e) { return null; }
  }
  function persistedSessions(list) {
    return (list || []).map((s) => {
      const o = Object.assign({}, s);
      /* 只有【既解开了、又确实有密文可替换】时才把明文换成密文：
         plainMem 有值 = 这条解密开了；但若本机没有 WebCrypto（queueMemEncrypt 会直接
         return，永远不会产出密文），或加密还没跑出密文，那就【没有东西能替换明文】——
         此时删掉明文，等于把记忆/场景/关系/经历直接从磁盘抹掉（重启即丢）。
         宁可让明文多留这一轮（下一趟加密完成的二次落盘会把它换掉），也绝不丢内容。 */
      const enc = cipherMem[s.id] || o.memEnc || "";
      if (s && plainMem[s.id] && enc) {
        delete o.memory;
        delete o.cognition;
        for (let i = 0; i < MEM_EXTRA.length; i++) delete o[MEM_EXTRA[i]];
      }
      o.memEnc = enc;
      return o;
    });
  }
  async function queueMemEncrypt(list) {
    if (!cryptoOk()) return;
    const seq = ++memSeq;
    const jobs = [];
    (list || []).forEach((s) => {
      if (!s || !s.id || brokenMem[s.id]) return;   /* 解不开的会话：绝不重新加密，否则老密文会被盖掉 */
      /* M1：有密文、却没有本轮的明文 → 说明还没解（启动未完成 / 刚从备份恢复）。
         这时 memPlainOf 只能拼出 {memory:null, cognition:""} 的空载荷，
         加密下去就把磁盘上的真记忆盖掉了。brokenMem 只挡「解不开」，挡不住「这轮还没解」。 */
      if (!plainMem[s.id] && !s.memory && (cipherMem[s.id] || s.memEnc)) return;
      const text = memPlainOf(s);
      if (encPlain[s.id] === text && cipherMem[s.id]) return;
      jobs.push({ id: s.id, text: text });
    });
    if (!jobs.length) return;
    for (let i = 0; i < jobs.length; i++) {
      let c = "";
      try { c = await encryptMem(jobs[i].text); } catch (e) { c = ""; }
      if (seq !== memSeq) return;
      if (c) { cipherMem[jobs[i].id] = c; encPlain[jobs[i].id] = jobs[i].text; }
    }
    if (seq !== memSeq) return;
    try { writeRaw(K_SESSIONS, JSON.stringify(persistedSessions(Store.getSessions()))); } catch (e) { /* ignore */ }
  }

  /* 把老的 dl1 密文换成 dl2（设备密钥）。逐条来，换成功的才写回；
     换不动就【去掉缓存、留着原密文】—— 下次启动照样用老口令解开，绝不让记忆变砖。 */
  async function migrateLegacyMem(ids) {
    if (!cryptoOk() || !ids || !ids.length) return 0;
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const text = encPlain[id];
      if (text === undefined) continue;
      let c = "";
      try { c = await encryptMem(text); } catch (e) { c = ""; }
      if (c && c.slice(0, 4) === ENC_V2) { cipherMem[id] = c; n++; }
      else { delete cipherMem[id]; }
    }
    if (n) {
      try { writeRaw(K_SESSIONS, JSON.stringify(persistedSessions(Store.getSessions()))); } catch (e) { /* ignore */ }
    }
    return n;
  }

  /* ── 角色卡加密（整份 characters 一份密文）────────────────────────
     characters 以前是【裸 JSON 数组】直接躺在磁盘上：年龄 / 你的性格、外貌、背景、喜好、
     说话风格 / 我的性格、外貌、背景、喜好 / 世界观 / 共同经历 / 当前关系 / AI 指令，全在里面。
     现在整份并进加密载荷（跟记忆同一把钥匙）。
     磁盘两种形态，靠「是不是数组」自动认，老数据不用手动迁移：
       老（明文）： [ {...}, {...} ]
       新（密文）： {"v":1,"enc":"dl2:..."}
     内存里【始终留明文】charsPlain，getCharacters() 同步返回 ——
     启动时 unlockChars() 已在 app.js 的 await 链里解完，渲染不会拿到空。
     底线：解不开时 charsBroken=true，此后一律拒绝覆盖写入（绝不变砖）。 */
  let charsPlain = null;      /* 内存明文；null = 尚未解锁（异常路径） */
  let charsCipher = "";       /* 最近一次密文，写盘优先复用 */
  let charsEncText = "";      /* 上面那份密文对应的明文，用来判断内容有没有变 */
  let charsBroken = false;    /* 磁盘上是解不开的密文 → 禁止覆盖 */
  let charsUnlocked = false;
  let charsSeq = 0;
  let charsPending = Promise.resolve();
  let charsWriteFail = 0;     /* 加密失败导致没落盘的次数（诊断用，见 charsKeyInfo） */

  async function encryptChars(text) {
    if (!cryptoOk()) return "";
    return outerEncrypt(text, ENC_V2, await outerAesKey2());
  }
  async function decryptChars(enc) {
    if (!cryptoOk() || typeof enc !== "string") return null;
    if (enc.slice(0, 4) === ENC_V2) return outerDecrypt(enc, 4, await outerAesKey2());
    if (enc.slice(0, 4) === ENC_V1) return outerDecrypt(enc, 4, await outerAesKey());
    return null;
  }

  /* 启动时解一次（在 unlockMemory 里被 await）。认老明文格式并自动排队换成密文。 */
  async function unlockChars() {
    if (charsUnlocked) return;
    charsUnlocked = true;
    let raw;
    try { raw = readRaw(K_CHARS); } catch (e) { raw = undefined; }
    /* M2：主键读不到 → 试备份。口径与会话完全一致：只有 null / undefined / "" 视为「键丢了」，
       "[]" 是用户真的清空，绝不回滚。以前这里直接 charsPlain = [] 就返回，
       于是 BAK_MAP 给角色卡留的那份备份只写不读 —— 纯成本、零收益。 */
    if (raw === undefined || raw === null || raw === "") {
      let bak = null;
      try { bak = readRaw(K_BAK_CHARS); } catch (e) { bak = null; }
      if (bak && String(bak).length > 2) {
        console.warn("[Sekulum] 角色卡主键读不到，已从备份恢复");
        raw = bak;
      }
    }
    if (raw === undefined || raw === null || raw === "") { charsPlain = []; return; }
    const v = safeParse(raw, null);
    if (Array.isArray(v)) {
      charsPlain = v;                      /* 老明文 → 直接用，并排队换成密文 */
      queueCharsEncrypt();
      return;
    }
    if (v && typeof v === "object" && typeof v.enc === "string") {
      if (!v.enc) { charsPlain = []; return; }
      let txt = null;
      try { txt = await decryptChars(v.enc); } catch (e) { txt = null; }
      if (txt == null) { charsBroken = true; charsPlain = []; return; }
      let arr = null;
      try { arr = JSON.parse(txt); } catch (e) { arr = null; }
      if (!Array.isArray(arr)) { charsBroken = true; charsPlain = []; return; }
      charsPlain = arr;
      charsCipher = v.enc;
      charsEncText = txt;
      return;
    }
    charsPlain = [];
  }

  /* 写盘：内容没变就补写一次现有密文；变了就【先加密、成功才落盘】。
     ⚠️ 这里原来是「先原样写明文兜底，再异步换密文」—— 好处是任何时刻磁盘上都有能用的数据，
     代价是每次改角色卡都有一段明文落盘，而 .bak 还会把这份明文再备份一份。
     用户的威胁模型是「捡到手机的人翻存储」，那这个窗口就是实打实的漏洞，所以改成方案 A：
     加密失败就这次不写（内存里的改动还在，下次保存会再试），宁可不落盘也不落明文。
     没有 WebCrypto 的机器只能写明文 —— 那种机器本来就没有加密能力（界面已提示是弱保护），
     不写等于角色卡永远存不进去。 */
  function queueCharsEncrypt() {
    if (charsPlain === null) return;
    const text = JSON.stringify(charsPlain);
    if (charsEncText === text && charsCipher) {
      try { writeRaw(K_CHARS, JSON.stringify({ v: 1, enc: charsCipher })); } catch (e) { /* ignore */ }
      return;
    }
    if (!cryptoOk()) {
      try { writeRaw(K_CHARS, JSON.stringify(charsPlain)); } catch (e) { /* ignore */ }
      return;
    }
    const seq = ++charsSeq;
    charsPending = (async () => {
      let c = "";
      try { c = await encryptChars(text); } catch (e) { c = ""; }
      if (seq !== charsSeq) return;         /* 又被改了：这次的结果已过时，交给后面那次 */
      if (!c) {
        /* 加密失败：整个不写。内存里的改动还在，下一次保存会重试；
           磁盘上保留上一版密文，不会出现「明文 + 密文混着」的中间态。 */
        charsWriteFail++;
        console.warn("[Sekulum] 角色卡加密失败，本次未落盘（磁盘保留上一版）");
        try { if (window.UI && window.UI.toast) window.UI.toast("角色卡没保存：加密失败，请重试", true); } catch (e) { /* ignore */ }
        return;
      }
      charsCipher = c;
      charsEncText = text;
      try { writeRaw(K_CHARS, JSON.stringify({ v: 1, enc: c })); } catch (e) { /* ignore */ }
    })().catch(() => {});
  }

  /* 启动时解一次记忆密文（异步）；解不开的就当空，绝不把密文当明文用。
     顺手把老的 dl1 记下来，解完统一换成 dl2。
     ⚠️ 并发语义（原来是错的）：整段只跑一次，后来者拿【同一个 Promise】。
        老写法 `if (memUnlocked) return;` 会让第二条调用立刻「成功返回」，而第一条的
        PBKDF2（12 万次迭代）和解密还在路上 —— 谁 await 谁就被骗。表现出来就是同一份
        代码连跑两次、红了不同断言，看着随机，其实是等错了对象。 */
  async function memUnlockWork() {
    if (memUnlocked) return;
    const raw = readRaw(K_SESSIONS);
    const arr = raw === undefined ? [] : safeParse(raw, []);
    const list = Array.isArray(arr) ? arr : [];
    const legacy = [];
    let upgraded = 0;   /* 本次把「老明文三项」并进载荷的条数 → 解完统一回写成密文 */
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || typeof s !== "object") continue;
      let hasPlain = false;
      for (let k = 0; k < MEM_EXTRA.length; k++) { if (s[MEM_EXTRA[k]]) { hasPlain = true; break; } }
      const hasPlainMem = s.memory !== undefined || s.cognition !== undefined;
      if (!s.memEnc && !hasPlain && !hasPlainMem) continue;   /* 这条没东西要管 */
      let p = null;
      if (s.memEnc) {
        try {
          const txt = await decryptMem(s.memEnc);
          if (txt) {
            p = JSON.parse(txt);
            cipherMem[s.id] = s.memEnc;
            encPlain[s.id] = txt;
            if (isLegacyEnc(s.memEnc)) legacy.push(s.id);
          }
        } catch (e) { p = null; }   /* 解不开：保持空，绝不把密文当明文用 */
        /* 有密文却解不出来 → 打标记，后面一律不许覆盖（见 brokenMem 注释） */
        if (!p) brokenMem[s.id] = true;
      }
      if (p) {
        /* 老密文只装了记忆 → 把还留在明文里的三项并进来（并完由下面统一回写） */
        for (let k = 0; k < MEM_EXTRA.length; k++) {
          const key = MEM_EXTRA[k];
          if ((p[key] === undefined || p[key] === "") && s[key]) { p[key] = s[key]; upgraded++; }
        }
        plainMem[s.id] = p;
      } else if (!s.memEnc) {
        /* 老版从没加密过（没密文）→ 记忆 + 三项一起组个新载荷 */
        plainMem[s.id] = Object.assign(
          { memory: s.memory || null, cognition: s.cognition || "" }, memExtraOf(s));
        upgraded++;
      }
    }
    memUnlocked = true;
    sessionsCache = null;
    /* 角色卡跟记忆同一把钥匙，一并解开；解完渲染前一定拿到明文 */
    try { await unlockChars(); } catch (e) { /* ignore */ }
    /* dl1→dl2 迁移、以及「老明文并进载荷」的回写，都要挂到 memPending 上：
       memReady() 才是「记忆真的换了密文并落盘」的准确信号，外面 await 它不会提前醒。
       以前这两步没登记，await memReady() 拿到的是上一轮的已决议 Promise。 */
    const tail = (async () => {
      if (legacy.length) { try { await migrateLegacyMem(legacy); } catch (e) { /* ignore */ } }
      if (upgraded) { try { await queueMemEncrypt(Store.getSessions()); } catch (e) { /* ignore */ } }
    })();
    memPending = tail.catch(() => {});
    await memPending;
  }

  const Store = {
    MAX_SETS: MAX_SETS,
    SET_FLAT: SET_FLAT,
    SET_KINDS: SET_KINDS,
    normalizeModelSets: normalizeModelSets,
    splitModelList: splitModelList,

    available: (function () {
      try {
        localStorage.setItem("__t", "1");
        localStorage.removeItem("__t");
        return true;
      } catch (e) { return false; }
    })(),

    getSettings() {
      const raw = readRaw(K_SETTINGS);
      const saved = raw === undefined ? {} : safeParse(raw, {});
      const merged = Object.assign({}, CONFIG.DEFAULT_SETTINGS, saved);
      const fromDisk = !!(saved.modelSets && typeof saved.modelSets === "object");
      const norm = normalizeModelSets(merged, fromDisk);
      merged.modelSets = norm.sets;
      merged.modelSetIndex = norm.index;
      return merged;
    },
    saveSettings(patch) {
      const next = Object.assign(this.getSettings(), patch);
      if (!readError) writeRaw(K_SETTINGS, JSON.stringify(next));
      return next;
    },

    getSessions() {
      if (sessionsCache) return sessionsCache;
      const raw = readRaw(K_SESSIONS);
      /* ⚠️ 读失败时**返回上一次的结果**，绝不返回空数组。
         空数组的语义是「一条会话都没有」，上层会照着它渲染空列表、
         甚至顺手 newSession() 再存一遍 —— 用户看到的就是「对话历史全空了」。
         读失败的正确语义是「这次没读到」，不是「没有」。 */
      if (readError) return sessionsCache || [];
      /* 主键彻底没了（不是「用户删空」——删空写的是 "[]"，会走到下面）→ 试试备份。
         以前这里直接返回空数组，然后上层渲染成「对话历史全空了」。
         注意：备份只在「读到 null/undefined」时用，"[]" 绝不动 —— 那是用户真的清空了。 */
      if (raw === undefined || raw === null) {
        let bk = null;
        try { bk = readRaw(K_BAK_SESSIONS); } catch (e) { bk = null; }
        if (bk && String(bk).length > 2) {
          const bakList = safeParse(bk, null);
          if (Array.isArray(bakList) && bakList.length) {
            console.warn("[Sekulum] 会话主键读不到，已从备份恢复 " + bakList.length + " 条");
            raw = bk;
          }
        }
      }
      if (raw === undefined) { sessionsCache = []; return sessionsCache; }
      const list = safeParse(raw, []);
      const arr = Array.isArray(list) ? list : [];
      arr.forEach((s) => {
        if (!s || typeof s !== "object") return;
        const p = plainMem[s.id];
        if (p) {
          s.memory = p.memory;
          s.cognition = p.cognition;
          for (let i = 0; i < MEM_EXTRA.length; i++) {
            const k = MEM_EXTRA[i];
            if (p[k] !== undefined) s[k] = p[k];
          }
        }
        /* 没缓存就保持原样：旧版存的是明文（需要保留待加密），新版存的是 memEnc（memory 本来就空） */
      });
      sessionsCache = arr;
      return sessionsCache;
    },
    saveSessions(list, opts) {
      const arr = list || [];
      /* allowEmpty：调用方明确知道自己在清空（用户主动删掉最后一条会话）。
         守卫要防的是「误清」，不是「合法删」——由调用方声明意图，别让守卫去猜。 */
      const allowEmpty = !!(opts && opts.allowEmpty);
      const prevCount = (sessionsCache || []).length;
      /* 防呆必须放在「更新缓存」之前：被拒的空写若已经把 sessionsCache 清空，
         下一步的 prevCount 就变 0，闸门失效，磁盘上的历史会被整个覆盖。 */
      if (!readError && !allowEmpty && !arr.length && prevCount > 0) {
        console.warn("[Sekulum] 会话列表将写为空白，已拒绝写入（疑似误清）");
        return false;
      }
      /* 读盘失败期间一律不写：这时 sessionsCache 可能是空的 / 半截的，
         写下去就是把磁盘上真正的那份覆盖成「我们这次看到的样子」。
         allowEmpty 也不放行 —— 连盘上有什么都不知道，凭什么清空。 */
      if (readError) return false;
      arr.forEach((s) => {
        if (!s || !s.id) return;
        if (brokenMem[s.id]) return;   /* 解不开的会话：不进缓存（进了就会被当「已解开」而清掉明文） */
        /* 只有调用方确实带了这几项时才刷新缓存：导入 / 恢复时，解不开密文的会话
           memory 是 undefined，无条件写会把缓存洗成 null，紧跟的 queueMemEncrypt
           就会用空载荷重新加密、把盘上的旧密文盖掉。 */
        if (s.memory !== undefined || s.cognition !== undefined || s.scene !== undefined ||
            s.relation !== undefined || s.shared !== undefined) {
          plainMem[s.id] = Object.assign(
            { memory: s.memory || null, cognition: s.cognition || "" }, memExtraOf(s));
        }
      });
      hoistImages(arr);   /* 把内联图片搬进文件（无桥 / 失败都原样留着，见上面三条底线 */
      /* allowEmpty = 用户在主动清空：这种写之前必须留一份上一版 */
      const ok = writeRaw(K_SESSIONS, JSON.stringify(persistedSessions(arr)), allowEmpty);
      /* 【关键】只有真写成了才认这份缓存。
         以前先 sessionsCache = arr 再写，写失败（配额满 / 桥被锁）时缓存已经是新的：
         getSessions() 命中缓存就再也不读盘，下一次任何保存都会把磁盘上那份
         覆盖成这次失败的内容 —— 一次写失败最终变成「历史只剩一条」。
         没写成 → 缓存保持原样，下次还会回盘上读真实数据。 */
      if (!ok) return false;
      sessionsCache = arr;
      memPending = queueMemEncrypt(arr).catch(() => {});
      return true;
    },

    /* 启动时解一次记忆密文（异步）。只跑一次，后来者拿到的是同一个 Promise ——
       「已经解完了」和「正在解」必须分得开，否则并发调用方会拿到假成功。 */
    unlockMemory() {
      if (!memUnlockPromise) memUnlockPromise = memUnlockWork();
      return memUnlockPromise;
    },
    decryptMem(enc) { return decryptMem(enc); },
    cipherFor(id) { return cipherMem[id] || ""; },
    /* 给备份/快照用：跟落盘【同一套】裁剪规则 —— 有密文才清明文，没有就原样留着。
       两处必须同规则，否则会出现「备份能恢复、但场景/关系/经历空了」。
       【判据①：作用要与注释一致】旧代码只判 plainMem，漏了「有没有密文可替换」这半句 ——
       本机没有 WebCrypto（拿不到设备标识 / 内核不支持）时永远产不出密文，
       这时清掉明文就是把记忆/场景/关系/经历从备份里抹掉，恢复出来是空的。
       【判据③：隐患】判据对齐 persistedSessions()，宁可让明文多留这一份也绝不丢内容。 */
    strippedCopy(s) {
      const o = Object.assign({}, s);
      const enc = cipherMem[s.id] || o.memEnc || "";
      if (s && plainMem[s.id] && enc) {
        delete o.memory;
        delete o.cognition;
        for (let i = 0; i < MEM_EXTRA.length; i++) delete o[MEM_EXTRA[i]];
      }
      o.memEnc = enc;
      return o;
    },
    canEncrypt() { return cryptoOk(); },
    /* 自检用：当前记忆密钥是谁派生的、盐有没有、还剩几条老格式没升级 */
    memKeyInfo() {
      let legacy = 0;
      try {
        (this.getSessions() || []).forEach((s) => {
          if (s && isLegacyEnc(this.cipherFor(s.id) || s.memEnc || "")) legacy++;
        });
      } catch (e) { /* ignore */ }
      const id = devSeed();
      return { device: !!id, deviceId: id, salt: devSalt(), legacy: legacy, chars: this.charsKeyInfo() };
    },
    sealWithPass(text, pass) { return sealWithPass(text, pass); },
    openWithPass(str, pass) { return openWithPass(str, pass); },
    /* 等最近一次记忆加密落盘（供“刚改完记忆就提示成功”的流程 await） */
    memReady() { return memPending; },

    /* ── 图片外置：对外的三个入口（消费点只用这三个）───────────── */

    /* 取一条附件「能直接用的地址」：内联优先生效；否则同步读一次文件（结果缓存）。
       返回空串 = 原图没了（上层显示「已过期」，只留文字描述）。 */
    imageURL(att) {
      if (!att) return "";
      if (att.dataUrl) return att.dataUrl;             /* 还没搬家（无桥 / 迁移失败） */
      const ref = att.imgRef;
      if (!ref) return "";
      if (imgCache[ref] !== undefined) return imgCache[ref];
      let back = "";
      try { back = String(callBridge("获取文件内容", ref) || ""); } catch (e) { back = ""; }
      if (!back) return "";                            /* 【故意不缓存失败】：下次还能再试 */
      const url = back.slice(0, 5) === "data:" ? back : ("data:" + (att.mime || "image/jpeg") + ";base64," + back);
      imgCachePut(ref, url);
      return url;
    },
    /* 这条附件还有没有图（内联或文件都算） */
    hasImage(att) { return !!(att && att.kind === "image" && (att.dataUrl || att.imgRef)); },
    /* 最近一次写盘是否成功（见 writeRaw 上面的注释）。界面在关键保存点查它 */
    writeOk() { return lastWriteOk; },

    /* 可写目录候选（10-23 提到这里，三处共用一份）。
       safe：**不需要额外申请存储权限**的 App 私有目录，外部优先（文件管理器能看见），
             外部拿不到再退内部。
       perm：需要权限的公共目录（Download），只作为用户明确要「存到相册/下载」时的备选。
       以前 settings.js 与 media.js 各拼一套，路径规则一改就得改两处。 */
    fileDirs() {
      const safe = [], perm = [];
      const add = (arr, v) => {
        const d = String(v || "").replace(/\/+$/, "");
        if (d && arr.indexOf(d) < 0) arr.push(d);
      };
      if (hasBridge("获取外部文件目录")) add(safe, callBridge("获取外部文件目录"));
      if (hasBridge("获取内部文件目录")) add(safe, callBridge("获取内部文件目录"));
      if (hasBridge("获取外部存储目录")) {
        const e = String(callBridge("获取外部存储目录") || "").replace(/\/+$/, "");
        if (e) add(perm, e + "/Download");
      }
      return { safe: safe, perm: perm };
    },

    /* 在候选目录里挑第一个真能写进去的，返回目录（全是空 = 没有写入能力）。
       判据比「桥返回非 false」硬一点：写完之后再用「判断指定文件」复核一次，
       因为部分封装里 save 失败是静默返回 undefined。 */
    pickWritableDir(probeName) {
      const name = String(probeName || ".dl_write_probe.txt");
      const dirs = Store.fileDirs().safe;
      for (let i = 0; i < dirs.length; i++) {
        const cand = dirs[i] + "/" + name;
        try {
          const w = callBridge("保存指定文件", cand,
            "data:text/plain;charset=utf-8," + encodeURIComponent("probe"));
          if (w === false) continue;
          if (hasBridge("判断指定文件") && callBridge("判断指定文件", cand) === false) continue;
          return dirs[i];
        } catch (e) { /* 换下一个 */ }
      }
      return "";
    },
    /* 背景图外置：返回落到哪个路径（空串 = 没桥 / 没写成，调用方就继续留 dataURL）。
       背景这类大图塞进 settings 会一路顶到 localStorage 配额，能不塞就不塞。 */
    saveBgImage(dataUrl) {
      try { return saveExternalImage(dataUrl, "dl_bg_"); } catch (e) { return ""; }
    },
    /* 单条附件外置：给手机模块用（把刚发的图立刻搬进文件，别撑 localStorage）。
       搬家失败 / 无桥 / 没写成 → 保持内联，绝不删内容（同三条底线）。 */
    hoistImage(att) { try { return hoistOne(att); } catch (e) { return false; } },
    /* 按轮数过期：删引用（以及没有别人再用时删文件），描述留着 */
    dropImage(att) {
      if (!att) return;
      const ref = att.imgRef;
      delete att.imgRef;
      delete att.dataUrl;
      if (!ref) return;
      /* 文件名是按内容哈希的 → 同一张图可能被多条消息共用。
         只有当【别处都不再引用】时才真删文件，免得删掉别人还在用的图。 */
      let still = false;
      const list = this.getSessions() || [];
      /* ⚠️ 两处都要扫：主消息 + 手机消息。手机发图同样会外置成 imgRef（见 hoistImages），
         只扫 messages 的话，手机里那张图会被「别人还在用」的判断漏掉而被误删。 */
      for (let i = 0; i < list.length && !still; i++) {
        const bags = [(list[i] && list[i].messages) || [], (list[i] && list[i].phone && list[i].phone.msgs) || []];
        for (let b = 0; b < bags.length && !still; b++) {
          const msgs = bags[b];
          for (let j = 0; j < msgs.length && !still; j++) {
            const as = (msgs[j] && msgs[j].attachments) || [];
            for (let k = 0; k < as.length; k++) { if (as[k] && as[k].imgRef === ref) { still = true; break; } }
          }
        }
      }
      if (still) return;
      try { callBridge("删除指定文件", ref); } catch (e) { /* ignore */ }
      imgCacheDrop(ref);
    },

    /* ── 角色个人图库：和「角色本人」相关的图，单独归档（六个入口）─────────
       生成这类图之前先 listCharImages / charImageLatestURL 看一眼，
       把「以前画过什么」带进提示词或当图生图参考，形象才不会前后对不上。 */

    /* 登记一张「角色本人」的图。dataUrl 必须是内联图（远程链接请先转成 dataUrl）。
       返回登记后的条目；无桥 / 写不成 → 回 null（调用方照旧把图挂在消息上即可）。 */
    saveCharImage(charId, dataUrl, meta) {
      if (!charId || !dataUrl) return null;
      const ref = saveExternalImage(dataUrl, CIMG_PREFIX);
      const m = meta || {};
      const entry = {
        id: "ci_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ref: ref,
        /* 没写进外置文件时不登记 —— 否则图库里会出现一堆「打不开」的条目 */
        url: ref ? "" : String(m.url || ""),
        mime: m.mime || "image/png",
        style: String(m.style || ""),
        styleName: String(m.styleName || ""),
        subject: String(m.subject || ""),
        desc: String(m.desc || ""),
        ts: Date.now()
      };
      if (!entry.ref && !entry.url) return null;
      const map = charImgAll();
      const list = Array.isArray(map[charId]) ? map[charId] : [];
      list.push(entry);
      while (list.length > CIMG_MAX) {
        const old = list.shift();
        if (old && old.ref) { try { callBridge("删除指定文件", old.ref); } catch (e) { /* ignore */ } }
      }
      map[charId] = list;
      charImgSaveAll(map);
      return entry;
    },
    /* 这个角色的图库（从旧到新） */
    listCharImages(charId) {
      if (!charId) return [];
      const map = charImgAll();
      const list = map[charId];
      return Array.isArray(list) ? list : [];
    },
    charImageCount(charId) { return this.listCharImages(charId).length; },
    /* 一张图库条目 → 可直接用的地址（外置文件读回 / 直接是远程链接） */
    charImageURL(entry) {
      if (!entry) return "";
      if (entry.ref) return readExternalImage(entry.ref, entry.mime);
      return String(entry.url || "");
    },
    /* 最近一张「能打开」的图（图生图参考用）。返回空串 = 还没有可用参考图 */
    charImageLatestURL(charId) {
      const list = this.listCharImages(charId);
      for (let i = list.length - 1; i >= 0; i--) {
        const u = this.charImageURL(list[i]);
        if (u) return u;
      }
      return "";
    },
    /* 图库摘要（写进提示词，让 AI 知道这个角色「以前是什么样子」）。
       max 默认取最近 6 条；一条都没有就回空串。 */
    charImageDigest(charId, max) {
      const list = this.listCharImages(charId);
      if (!list.length) return "";
      const n = max || 6;
      return list.slice(-n).map(function (e) {
        const tag = e.styleName || e.style;
        const body = e.subject || e.desc || "（未记录画面）";
        return "- " + (tag ? "[" + tag + "] " : "") + body;
      }).join("\n");
    },
    /* 删一条（文件也删）。 */
    dropCharImage(charId, id) {
      const map = charImgAll();
      const list = Array.isArray(map[charId]) ? map[charId] : [];
      const i = list.findIndex(function (e) { return e && e.id === id; });
      if (i < 0) return false;
      const gone = list.splice(i, 1)[0];
      if (gone && gone.ref) { try { callBridge("删除指定文件", gone.ref); } catch (e) { /* ignore */ } }
      map[charId] = list;
      charImgSaveAll(map);
      return true;
    },
    /* 清空某个角色的图库（文件全删） */
    clearCharImages(charId) {
      const map = charImgAll();
      const list = Array.isArray(map[charId]) ? map[charId] : [];
      list.forEach(function (e) { if (e && e.ref) { try { callBridge("删除指定文件", e.ref); } catch (err) { /* ignore */ } } });
      map[charId] = [];
      charImgSaveAll(map);
    },

    /* ── 导出 / 备份：图库跟着它的角色、会话一起走 ────────────────────
       为什么必须内联：外置文件是本机路径（dl_cimg_…），换台手机必然指不到。
       charIds 传数组就只导这几个角色；不传导全部。
       drop=true 只带文字（画过什么还在，图不要）——给「不含原图」的导出用。
       max>0 时每个角色只带最近 max 张（会话备份用它压体积）。 */
    dumpCharImages(charIds, drop, max) {
      const map = charImgAll();
      const out = {};
      const keys = Array.isArray(charIds) ? charIds : Object.keys(map);
      keys.forEach(function (id) {
        if (!id) return;
        let list = Array.isArray(map[id]) ? map[id].slice() : [];
        if (!list.length) return;
        if (max > 0) list = list.slice(-max);
        out[id] = list.map(function (e) {
          const b = {
            id: e.id, ts: e.ts, mime: e.mime, style: e.style, styleName: e.styleName,
            subject: e.subject, desc: e.desc
          };
          if (!drop) {
            const u = e.ref ? readExternalImage(e.ref, e.mime) : String(e.url || "");
            if (u) b.dataUrl = u;
          }
          return b;
        });
      });
      return out;
    },
    /* 把导出的图库装回本机：有图的重新写外置文件、重新登记；只剩文字的也登记
       （这样「以前画过什么」还在，提示词里的人物一致性仍然管用）。
       同 id 的条目跳过，重复导入不会翻倍。 */
    restoreCharImages(map) {
      if (!map || typeof map !== "object") return 0;
      let n = 0;
      const all = charImgAll();
      Object.keys(map).forEach(function (id) {
        if (!id || !Array.isArray(map[id])) return;
        const list = Array.isArray(all[id]) ? all[id] : [];
        const has = {};
        list.forEach(function (e) { if (e && e.id) has[e.id] = true; });
        map[id].forEach(function (e) {
          if (!e) return;
          const eid = String(e.id || ("ci_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)));
          if (has[eid]) return;
          const entry = {
            id: eid, ref: "", url: "",
            mime: e.mime || "image/png",
            style: String(e.style || ""), styleName: String(e.styleName || ""),
            subject: String(e.subject || ""), desc: String(e.desc || ""),
            ts: e.ts || Date.now()
          };
          if (e.dataUrl) {
            /* 远程 URL 形态（导出时 dumpCharImages 会把 e.url 当 dataUrl 带出来）：
               saveExternalImage 只认 "data:" 前缀，写不成就退回直接引用这个 URL ——
               否则这张图会丢、只剩文字。 */
            entry.ref = saveExternalImage(e.dataUrl, CIMG_PREFIX);
            if (!entry.ref && /^https?:\/\//i.test(e.dataUrl)) entry.url = e.dataUrl;
          }
          has[eid] = true;
          list.push(entry);
          n++;
        });
        while (list.length > CIMG_MAX) {
          const old = list.shift();
          if (old && old.ref) { try { callBridge("删除指定文件", old.ref); } catch (err) { /* ignore */ } }
        }
        all[id] = list;
      });
      charImgSaveAll(all);
      return n;
    },
    /* 首次迁移：把历史会话里还在内联的图片搬进文件。
       saveSessions 每次也会顺带做，这里给启动时一个显式入口，并返回统计供自检显示。
       注：逐条搬、逐条删内联；只要搬成功一条就写回一次 —— 没搬成的那些【原样保留内联】，
       所以「部分成功」也不会丢任何一张图（比「全部成功才写回」更安全，也不会留下永远搬不动的重试）。 */
    migrateImages() {
      if (!hasBridge("保存指定文件")) return { ok: false, why: "当前环境没有原生文件接口", hoisted: 0, left: 0 };
      const arr = this.getSessions();
      const hoisted = hoistImages(arr);
      if (hoisted) {
        try { writeRaw(K_SESSIONS, JSON.stringify(persistedSessions(arr))); } catch (e) { /* ignore */ }
      }
      let left = 0;
      arr.forEach((s) => {
        const bags = [(s && s.messages) || [], (s && s.phone && s.phone.msgs) || []];
        bags.forEach((msgs) => msgs.forEach((m) => {
          ((m && m.attachments) || []).forEach((a) => { if (a && a.kind === "image" && a.dataUrl) left++; });
        }));
      });
      return { ok: true, hoisted: hoisted, left: left };
    },
    /* 诊断用：内联图 / 外置图各多少张，目录拿没拿到 */
    imgStats() {
      const arr = this.getSessions();
      let inline = 0, refs = 0, bytes = 0;
      arr.forEach((s) => {
        const bags = [(s && s.messages) || [], (s && s.phone && s.phone.msgs) || []];
        bags.forEach((msgs) => msgs.forEach((m) => {
          ((m && m.attachments) || []).forEach((a) => {
            if (!a || a.kind !== "image") return;
            if (a.dataUrl) { inline++; bytes += a.dataUrl.length; }
            else if (a.imgRef) refs++;
          });
        }));
      });
      return { inline: inline, refs: refs, inlineBytes: bytes, dir: imgDir(), bridge: hasBridge("保存指定文件") };
    },

    readFailed() { return readError; },
    resetReadError() { readError = false; },

    getCharacters() {
      if (charsPlain !== null) return charsPlain;
      /* 极端路径（没走 unlockChars）：退回同步读一次，只认老明文格式；
         密文认不出来就返回空 —— 绝不把密文当明文用。 */
      const raw = readRaw(K_CHARS);
      if (readError) return [];
      if (raw === undefined) { charsPlain = []; return charsPlain; }
      const list = safeParse(raw, []);
      if (Array.isArray(list)) { charsPlain = list; return charsPlain; }
      return [];
    },
    saveCharacters(list) {
      if (charsBroken) return false;         /* 磁盘上是解不开的密文 → 别拿新数据把它盖掉 */
      if (charsPlain === null) return false;  /* 还没解锁 → 别拿空数组盖掉 */
      charsPlain = Array.isArray(list) ? list : [];
      if (readError) return false;
      queueCharsEncrypt();
      return true;
    },
    /* 诊断用：角色卡加密状态 */
    charsKeyInfo() { return { enc: !!charsCipher, broken: charsBroken, count: (charsPlain || []).length, fail: charsWriteFail }; },
    /* 等最近一次角色卡加密落盘（供导出前/自检 await） */
    charsReady() { return charsPending; },

    getUsage() {
      const raw = readRaw(K_USAGE);
      const u = raw === undefined ? null : safeParse(raw, null);
      return Object.assign({ prompt: 0, completion: 0, total: 0, cacheHit: 0, cacheMiss: 0, calls: 0 }, u || {});
    },
    saveUsage(u) {
      if (readError) return false;
      return writeRaw(K_USAGE, JSON.stringify(u || {}));
    },

    /* 按「消耗类型」分开记的用量：对话 / 记忆 / 日更 / 世界生成 / 状态量化 /
       群聊 / 动态筛选 / 总结 / 情绪日记 / 手机 / 其它。用于用量统计里按类型看花费。 */
    getUsageCats() {
      const raw = readRaw(K_USAGECAT);
      const v = raw === undefined ? null : safeParse(raw, null);
      return (v && typeof v === "object") ? v : {};
    },
    saveUsageCats(v) {
      if (readError) return false;
      return writeRaw(K_USAGECAT, JSON.stringify(v || {}));
    },

    /* 手机动态。读失败返回 []，绝不覆盖已有数据（同「读失败拒写」的口径）。 */
    getMoments() {
      const raw = readRaw(K_MOMENTS);
      const v = raw === undefined ? null : safeParse(raw, null);
      return Array.isArray(v) ? v : [];
    },
    saveMoments(list) {
      if (readError) return false;
      return writeRaw(K_MOMENTS, JSON.stringify(Array.isArray(list) ? list : []));
    },
    /* 好友申请队列（7.1）。读失败返回空队列，不覆盖。 */
    getSocial() {
      const raw = readRaw(K_SOCIAL);
      const v = raw === undefined ? null : safeParse(raw, null);
      if (!v || !Array.isArray(v.reqs)) return { reqs: [] };
      return { reqs: v.reqs };
    },
    saveSocial(obj) {
      if (readError) return false;
      const o = (obj && Array.isArray(obj.reqs)) ? obj : { reqs: [] };
      return writeRaw(K_SOCIAL, JSON.stringify(o));
    },

    getAssistantMemory() {
      const raw = readRaw(K_AMEM);
      const v = raw === undefined ? null : safeParse(raw, null);
      return Object.assign({ cognition: "", memory: {} }, v || {});
    },
    saveAssistantMemory(v) {
      if (readError) return false;
      return writeRaw(K_AMEM, JSON.stringify(v || {}));
    },

    getBackups() {
      const raw = readRaw(K_BACKUPS);
      const v = raw === undefined ? null : safeParse(raw, null);
      return (v && typeof v === "object") ? v : {};
    },
    saveBackups(v) {
      if (readError) return false;
      return writeRaw(K_BACKUPS, JSON.stringify(v || {}));
    },

    getCurrentId() { return readRaw(K_CURRENT) || ""; },
    setCurrentId(id) { writeRaw(K_CURRENT, id || ""); },

    /* noSelect=true：建完不把它设成「当前会话」——「纯手机角色」用它（那种线不该顶掉主对话）。 */
    createSession(characterId, noSelect) {
      const now = Date.now();
      const s = {
        id: "s_" + now.toString(36) + Math.random().toString(36).slice(2, 7),
        title: "新对话",
        createdAt: now,
        updatedAt: now,
        characterId: characterId || "",
        systemPrompt: "",
        alias: "",
        temperature: null,
        topP: null,
        avatarUser: "",
        avatarAi: "",
        /* 手机页专用头像：留空 = 用角色自己的头像（默认按角色，各线可单独设）。
           故意和 avatarAi 分开——聊天界面换的那张图不必跟着进手机。 */
        phoneAvatar: "",
        /* 这条线自己的昵称（10-18 用户口径）：角色叫什么、我被叫什么。
           都留空 = 用角色卡里的名字 / 全局「我的昵称」。 */
        nickChar: "",
        nickMe: "",
        usage: null,
        scene: "",
        cognition: "",
        memory: null,
        autoBackup: false,
        mainLine: false,
        pinned: false,
        ctxWash: null,
        /* 群聊：isGroup 为真时 characterId 留空，成员都在 members（角色 id 数组）里。
           单个角色的老会话这两项保持默认值，逻辑完全不受影响。 */
        isGroup: false,
        members: [],
        messages: []
      };
      const list = this.getSessions();
      list.unshift(s);
      this.saveSessions(list);
      if (!noSelect) this.setCurrentId(s.id);
      return s;
    },

    updateSession(id, patch) {
      const list = this.getSessions();
      const i = list.findIndex((s) => s.id === id);
      if (i < 0) return null;
      list[i] = Object.assign({}, list[i], patch, { updatedAt: Date.now() });
      this.saveSessions(list);
      return list[i];
    },

    deleteSession(id) {
      let list = this.getSessions();
      list = list.filter((s) => s.id !== id);
      /* 删掉最后一条时会写空数组 —— 这是用户的合法操作，显式放行 */
      this.saveSessions(list, { allowEmpty: true });
      /* 顺手清掉这条会话的备份快照：不清就是永久孤儿（每会话最多 2 份，白占存储、
         而且再也点不进去）。 */
      try {
        const bks = this.getBackups();
        if (bks && bks[id]) { delete bks[id]; this.saveBackups(bks); }
      } catch (e) { /* ignore */ }
      if (this.getCurrentId() === id) this.setCurrentId(list[0] ? list[0].id : "");
      return list;
    },

    clearAll() {
      try {
        removeRaw(K_SESSIONS);
        removeRaw(K_CURRENT);
        removeRaw(K_BACKUPS);
        /* OPT-01：以前漏了 K_CHARS —— 接上「清空数据」后角色卡会原样留着，
           用户以为清干净了，重启又冒出十几个角色和它们的记忆。 */
        removeRaw(K_CHARS);
        /* 备份必须一起删：只删主键不删备份，下次启动会从备份把「刚清空的东西」恢复回来 */
        removeRaw(K_BAK_SESSIONS);
        removeRaw(K_BAK_CHARS);
        /* 节流表也要清：不清的话下次写盘会以为「刚备份过」而跳过 */
        Object.keys(BAK_LAST).forEach(function (k) { delete BAK_LAST[k]; });
      } catch (e) { /* ignore */ }
      sessionsCache = null;
      memUnlocked = false;
      [plainMem, cipherMem, encPlain, brokenMem, imgCache].forEach((m) => { Object.keys(m).forEach((k) => { delete m[k]; }); });
      imgCacheKeys.length = 0;
    },
    /* 诊断用：当前存储后端 */
    storageBackend() { return pickBackend(); },
    storageKeys() { return NATIVE_KEYS.slice(); },
    callBridge(name) { return callBridge.apply(null, arguments); },
    hasBridge(name) { return hasBridge(name); },

    /* ── 原生权限守卫 ───────────────────────────────
       存储权限是唯一「JS 侧会撞上、而且必须主动申请」的一项：
       相机 / 录音走 WebView 自己的权限弹框，通知 / 电池优化 / 悬浮窗各有各的接口。
       回调接口是「存储权限回调("函数名")」—— 原生按名字去调一个全局函数，
       所以这里把一次性回调挂到 window 上。返回码：0 允许 / 1 拒绝 / 2 拒绝且不再询问。 */
    requestStorage(cb) {
      const done = (code) => { try { cb(Number(code)); } catch (e) { /* ignore */ } };
      if (!hasBridge("申请存储权限")) { done(1); return; }
      const name = "__dlStorageCb" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      window[name] = function (code) {
        window[name] = function () { /* 只用一次，之后空转 */ };
        done(code);
      };
      try {
        if (hasBridge("存储权限回调")) callBridge("存储权限回调", name);
        callBridge("申请存储权限");
      } catch (e) { done(1); }
    },

    /* 要往外部存储写东西之前先过一道：
       没有原生环境（浏览器 / 预览）无条件放行；有权限直接过；没有就弹系统申请。 */
    ensureStorage(cb) {
      if (!hasBridge("判断存储权限状态")) { cb(true); return; }
      let has = false;
      try { has = callBridge("判断存储权限状态") === true; } catch (e) { has = false; }
      if (has) { cb(true); return; }
      this.requestStorage((code) => cb(code === 0));
    },
    ensureStorageAsync() {
      return new Promise((resolve) => { this.ensureStorage(resolve); });
    },
    removeRaw(key) { return removeRaw(key); },
  };

  window.Store = Store;
})();
