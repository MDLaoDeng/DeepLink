/* live2d.js —— live2D 视频通话渲染（Cubism 2.1 / live2d.min.js）
 * 从 0 新增（6.0.0 · 手机视频通话的「最小可行性验证」）。
 *
 * 设计原则（跟本项目其它模块一致）：
 *  - 纯前端、无构建；lib 与模型都放在本文件同级的 live2d/ 目录下，按需懒加载。
 *  - 整条链路任何一步失败（无 WebGL / lib 没下到 / 模型 404 / 解析异常）都【不抛给调用方】，
 *    而是 reject → 由 phone.js 退回「静态头像图通话」。所以真机上就算 live2D 跑不起来，
 *    通话功能照常可用，用户不会看到白屏或报错。
 *  - 不依赖 window.DL 的加载时快照；只在调用时取。
 */
(function () {
  var booted = false;  /* boot 幂等：DOMContentLoaded 与补拍 retry 各会调一次，别重复绑事件 / 分裂状态 */
  function boot() {
    if (booted) return true;
    var D = window.DL;
    if (!D) return false;
    booted = true;   /* 已真正初始化过，后续再被调用直接返回 */

    var libLoaded = false;
    var libPromise = null;
    var rafId = 0;
    var cur = null; /* 当前渲染中的 { gl, model, tex:[], matrix, motionMgr, dead } */
    var attachSeq = 0; /* 每次 attach 递增；用来作废「已超时 / 已被替换」的在途加载 */

    /* model.json 与 lib 都相对本页（mirror/ 根）取；live2dModel 设置里存的是相对路径 */
    var LIB_SRC = "live2d/live2d.min.js";
    var DEFAULT_MODEL = "live2d/model/shizuku.model.json";

    function baseDir(url) {
      var s = String(url || "");
      var i = s.lastIndexOf("/");
      return i >= 0 ? s.slice(0, i + 1) : "";
    }
    function fileUrl(url) {
      var s = String(url || "");
      try { return encodeURI(s); } catch (e) { return s; }
    }

    function loadScript(src) {
      if (libLoaded && window.Live2DModelWebGL) return Promise.resolve();
      if (libPromise) return libPromise;
      libPromise = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = fileUrl(src);
        s.onload = function () { libLoaded = true; resolve(); };
        s.onerror = function () {
          libPromise = null;   /* 别把失败缓存住：一次网络抖动会让本次会话内 live2D 永久不可用 */
          reject(new Error("live2d.min.js 加载失败"));
        };
        document.head.appendChild(s);
      });
      return libPromise;
    }

    /* ── 取数通道（10-18 补：真机 file:// 下 fetch 必然被拒）───────────
       三条通道按顺序试，任何一条成功就停：
         ① 原生桥「获取文件内容」—— 同步读本地文件，不受协议限制。
            上传到内部目录的模型（/data/data/…/files/live2d/…）只能靠它读。
         ② XHR —— 相对路径（随包发出的 assets）在部分内核可用。
         ③ fetch —— 只在浏览器预览 / http 环境走得到这里。
       ① 和 ② 都会因为「文件不存在」和「通道被拦」失败，报错信息必须分开写，
       否则真机上又回到「Failed to fetch 分不清是没文件还是没权限」。 */
    function bridgeReadRaw(url) {
      var s = String(url || "");
      if (!s) return null;
      try {
        /* 走 Store 的桥封装（项目规矩：不直连 window.webapp）。
           Store 还没挂上时退回 window.webapp，别让 live2D 因为加载顺序而读不到文件。 */
        var St = window.Store;
        if (St && St.hasBridge) {
          if (!St.hasBridge("获取文件内容")) return null;
          var r1 = St.callBridge("获取文件内容", s);
          return r1 ? String(r1) : null;
        }
        var w = window.webapp;
        if (!w || typeof w["获取文件内容"] !== "function") return null;
        var raw = w["获取文件内容"](s);
        if (!raw) return null;
        return String(raw);
      } catch (e) { return null; }
    }
    function b64ToBytes(b64) {
      var s = String(b64 || "").replace(/[\s\r\n]/g, "");
      if (!s) return null;
      var bin = window.atob(s);
      var n = bin.length;
      var out = new Uint8Array(n);
      for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    function bytesToB64(u8) {
      var s = "";
      var CH = 0x8000;                      /* 分块，避免 apply 参数过多爆栈 */
      for (var i = 0; i < u8.length; i += CH) {
        s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
      }
      return window.btoa(s);
    }
    function bytesToText(u8) {
      try { if (window.TextDecoder) return new window.TextDecoder("utf-8").decode(u8); }
      catch (e) { /* 老内核没有 TextDecoder：退回下面 */ }
      var s = "";
      for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
    }
    function xhrBytes(url) {
      return new Promise(function (resolve, reject) {
        try {
          var x = new XMLHttpRequest();
          x.open("GET", fileUrl(url), true);
          try { x.responseType = "arraybuffer"; } catch (e) { /* ignore */ }
          try { x.timeout = 12000; } catch (e) { /* ignore */ }
          x.onload = function () {
            /* file:// 下成功时 status 常见为 0，不能当成失败 */
            if (x.status && x.status !== 200) { reject(new Error("HTTP " + x.status + " " + url)); return; }
            var r = x.response;
            if (!r) { reject(new Error("空响应 " + url)); return; }
            resolve(new Uint8Array(r));
          };
          x.onerror = function () { reject(new Error("请求被拦 " + url)); };
          x.ontimeout = function () { reject(new Error("超时 " + url)); };
          x.send();
        } catch (e) { reject(e); }
      });
    }
    /* 最近一次取数到底走了哪条通道（真机「测试模型」要显示出来，
       否则光看「加载成功」不知道是桥生效还是碰巧 fetch 能用） */
    var lastChannel = "";
    function readBytes(url) {
      var raw = bridgeReadRaw(url);
      if (raw) {
        if (raw.slice(0, 5) === "data:") {
          var m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(raw);
          var b = m ? b64ToBytes(m[1]) : null;
          if (b) { lastChannel = "原生桥"; return Promise.resolve(b); }
        } else {
          var b2 = b64ToBytes(raw);
          if (b2) { lastChannel = "原生桥"; return Promise.resolve(b2); }
        }
      }
      return xhrBytes(url).then(function (u8) {
        lastChannel = "XHR";
        return u8;
      }).catch(function () {
        return fetch(fileUrl(url)).then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
          return r.arrayBuffer();
        }).then(function (ab) {
          lastChannel = "fetch";
          return new Uint8Array(ab);
        });
      });
    }
    function fetchArrayBuffer(url) {
      return readBytes(url).then(function (u8) {
        /* loadModel 要的是干净的 ArrayBuffer，不能带视图偏移 */
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      });
    }
    function fetchJSON(url) {
      return readBytes(url).then(function (u8) {
        var txt = bytesToText(u8);
        if (!txt) throw new Error("模型 JSON 是空的：" + url);
        return JSON.parse(txt);
      });
    }
    function loadImage(url) {
      return new Promise(function (resolve, reject) {
        var im = new Image();
        /* 打包后是本地（file://）环境，**绝不能加 crossOrigin**：
           加了就会让浏览器按跨域规则去要文件，而 file:// 给不出 CORS 响应头 → 图片直接被拒。
           同理下的本地文件本来就不需要这个标记（http 同源时也是多余的）。 */
        im.onload = function () { resolve(im); };
        im.onerror = function () {
          /* 图片通道也被拦（内部目录里的贴图常见）：改走桥读 → data URL 再试一次 */
          var raw = bridgeReadRaw(url);
          if (!raw) { reject(new Error("贴图加载失败 " + url)); return; }
          var im2 = new Image();
          im2.onload = function () { resolve(im2); };
          im2.onerror = function () { reject(new Error("贴图解码失败 " + url)); };
          im2.src = raw.slice(0, 5) === "data:" ? raw : ("data:image/png;base64," + raw);
        };
        im.src = fileUrl(url);
      });
    }

    /* ── 动作文件（.mtn）：这才是「真的会动」的那部分 ──────────────
       呼吸 / 眨眼只是参数驱动的死板效果；模型自带 idle 动作才有真实的抬手、转头。
       逐个 fetch → Live2DMotion.loadMotion(ArrayBuffer)；任何一个挂了都只是少一段动作，
       不影响别的。注意：本版 live2d.min.js 【不含物理类】，所以头发 / 裙子不会飘。 */
    function loadMotionList(urls) {
      return Promise.all((urls || []).map(function (u) {
        return fetchArrayBuffer(u).then(function (buf) {
          return window.Live2DMotion.loadMotion(buf);
        }).catch(function () { return null; });
      })).then(function (arr) { return arr.filter(Boolean); });
    }
    function parseMotionUrls(base, json) {
      var groups = (json && json.motions) || {};
      function files(name) {
        var arr = groups[name];
        return (arr || []).map(function (it) { return it && it.file ? (base + it.file) : null; }).filter(Boolean);
      }
      return { idle: files("idle"), tap: files("tap_body") };
    }
    function loadMotions(base, json) {
      var u = parseMotionUrls(base, json);
      if (!u.idle.length && !u.tap.length) return Promise.resolve(null);
      return Promise.all([loadMotionList(u.idle), loadMotionList(u.tap)]).then(function (r) {
        if (!r[0].length && !r[1].length) return null;
        return { idle: r[0], tap: r[1], any: r[0].concat(r[1]), oneShot: null };
      });
    }

    /* ── 物理（头发 / 裙子摆动）──────────────────────────────
       本版 live2d.min.js 只给了底层 PhysicsHair，没有官方的 Live2DPhysics 包装，
       所以照 Cubism 2.1 的算法自己把 physics.json 接上：每根「物理链」= setup(长度/阻尼/质量)
       + 若干 src(读哪些参数) + 若干 targets(写哪些参数)。 */
    function createPhysics(json) {
      var P = window.PhysicsHair;
      if (!P || !json) return null;
      var groups = json.physics_hair || json.physicsHair;
      if (!Array.isArray(groups) || !groups.length) return null;
      /* 权重口径自适应：官方 SDK 一律 weight/100，但不少模型（含 shizuku）直接写 1 表示 100%。
         按整份文件的最大权重判断，两种写法都能得到正常幅度。 */
      var maxW = 0;
      groups.forEach(function (g) {
        (g.src || []).forEach(function (s) { maxW = Math.max(maxW, Number(s.weight) || 0); });
        (g.targets || g.target || []).forEach(function (t) { maxW = Math.max(maxW, Number(t.weight) || 0); });
      });
      var wDiv = maxW > 1 ? 100 : 1;
      var hairs = [];
      groups.forEach(function (g) {
        var su = g.setup || {};
        var hair = new P();
        try { hair.setup(Number(su.length) || 0, Number(su.regist) || 0, Number(su.mass) || 0); }
        catch (e) { return; }
        (g.src || []).forEach(function (s) {
          var t = P.Src.SRC_TO_X;
          if (s.ptype === "y") t = P.Src.SRC_TO_Y;
          else if (s.ptype === "angle") t = P.Src.SRC_TO_G_ANGLE;
          try { hair.addSrcParam(t, s.id, Number(s.scale) || 0, (Number(s.weight) || 0) / wDiv); } catch (e) { /* ignore */ }
        });
        (g.targets || g.target || []).forEach(function (tg) {
          var t = P.Target.TARGET_FROM_ANGLE;
          if (tg.ptype === "y") t = P.Target.TARGET_FROM_ANGLE_V;
          try { hair.addTargetParam(t, tg.id, Number(tg.scale) || 0, (Number(tg.weight) || 0) / wDiv); } catch (e) { /* ignore */ }
        });
        hairs.push(hair);
      });
      if (!hairs.length) return null;
      return {
        list: hairs,
        update: function (model) {
          for (var i = 0; i < hairs.length; i++) { try { hairs[i].update(model); } catch (e) { /* 单条挂了不影响别的 */ } }
        }
      };
    }
    function loadPhysics(base, json) {
      var f = json && json.physics;
      if (!f) return Promise.resolve(null);
      return fetchJSON(base + f).then(function (j) { return createPhysics(j); }).catch(function () { return null; });
    }

    function createTexture(gl, img) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      /* 不用 mipmap：部分安卓驱动在 generateMipmap 之后采样会出错误颜色（整块色斑），
         而且 mipmap 对 2D 立绘没有收益（总是 1:1 附近采样）。10-21 修。 */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      return t;
    }

    /* 把模型画布 (0..W,0..H，y 向下) 映射到 canvas：保持比例、居中、留边距。
       正交投影 + 缩放平移（列主序）。x' = sx*x + tx, y' = sy*y + ty，再归一化到 [-1,1]。 */
    function buildMatrix(cw, ch, W, H) {
      var pad = 0.92;
      var scale = Math.min(cw / W, ch / H) * pad;
      var sx = scale, sy = -scale;                 /* y 翻转 */
      var tx = (cw - W * scale) / 2;               /* 左对齐留边 */
      var ty = (ch + H * scale) / 2;               /* 底部对齐（y 向下） */
      return new Float32Array([
        (2 / cw) * sx, 0, 0, 0,
        0, (2 / ch) * sy, 0, 0,
        0, 0, -1, 0,
        (2 / cw) * tx - 1, (2 / ch) * ty - 1, 0, 1
      ]);
    }

    /* ── 环境探测（真机定位用）────────────────────────────
       打包后是 file://，而 fetch 在 file:// 下必然失败 —— 但「文件没进包」和
       「协议被拒」报的是同一句 Failed to fetch，光看提示分不出来。
       这里用三条彼此独立的通道各试一次，一趟真机就能定性：
         · <img> 能否加载贴图    → 文件在不在包里、子资源通道通不通
         · 该图能否 texImage2D   → 会不会被当成跨域图片污染画布（WebGL 会直接抛错）
         · XHR 能否读 model.json → 决定「轻改取数方式」还是「把资源内联」 */
    function probe() {
      var tex = baseDir(DEFAULT_MODEL) + "texture_00.png";
      var info = { prot: "?", href: "?", img: "未测", gl: "未测", xhr: "未测" };
      try { info.prot = String(location.protocol); } catch (e) { /* ignore */ }
      try { info.href = String(location.href).slice(0, 72); } catch (e) { /* ignore */ }
      var hasBridgeRead = "无";
      try {
        if (window.Store && window.Store.hasBridge) hasBridgeRead = window.Store.hasBridge("获取文件内容") ? "有" : "无";
        else hasBridgeRead = (window.webapp && typeof window.webapp["获取文件内容"] === "function") ? "有" : "无";
      } catch (e) { hasBridgeRead = "无"; }
      return new Promise(function (resolve) {
        var done = false;
        var finish = function () {
          if (done) return;
          done = true;
          resolve([
            "协议：" + info.prot,
            "地址：" + info.href,
            "读文件桥：「获取文件内容」" + hasBridgeRead,
            "贴图 <img> 加载：" + info.img,
            "贴图上传 WebGL：" + info.gl,
            "读 model.json：" + info.xhr
          ].join("\n"));
        };
        setTimeout(finish, 9000);   /* 兜底：任何一步卡住，也要把已有结果交出去 */
        loadImage(tex).then(function (im) {
          info.img = "可以（" + im.naturalWidth + "×" + im.naturalHeight + "）";
          try {
            var cv = document.createElement("canvas");
            cv.width = 2; cv.height = 2;
            var g = cv.getContext("webgl") || cv.getContext("experimental-webgl");
            if (!g) { info.gl = "无 WebGL"; }
            else {
              var t = g.createTexture();
              g.bindTexture(g.TEXTURE_2D, t);
              g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, im);
              info.gl = "不污染（能上传）";
            }
          } catch (e) { info.gl = "会污染：" + (e && e.message ? e.message : e); }
          probeRead(DEFAULT_MODEL, function (r) { info.xhr = r; finish(); });
        }).catch(function (e) {
          info.img = "失败：" + (e && e.message ? e.message : e);
          probeRead(DEFAULT_MODEL, function (r) { info.xhr = r; finish(); });
        });
      });
    }
    /* 探测「读 model.json」走的是哪条通道 —— 直接复用正式取数逻辑，
       免得探测说能读、真加载又读不到。 */
    function probeRead(url, cb) {
      readBytes(url).then(function (u8) {
        cb("可以（走" + (lastChannel || "?") + "，长度 " + u8.length + "）");
      }, function (e) {
        cb("失败：" + (e && e.message ? e.message : e));
      });
    }

    function capable() {
      try {
        if (typeof WebGLRenderingContext === "undefined") return false;
        var c = document.createElement("canvas");
        return !!(c.getContext("webgl") || c.getContext("experimental-webgl"));
      } catch (e) { return false; }
    }

    function detach() {
      attachSeq++; /* 作废在途的 attach 链，避免它晚到后又把画面点亮 */
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (cur) {
        try {
          if (cur.model && cur.gl) cur.model.setGL(null);
        } catch (e) { /* ignore */ }
        /* 释放纹理：视频通话反复开关会不断 createTexture，不删会累积 GPU 纹理 */
        try {
          if (cur.gl && cur.tex) {
            for (var ti = 0; ti < cur.tex.length; ti++) { try { cur.gl.deleteTexture(cur.tex[ti]); } catch (e) { /* ignore */ } }
          }
        } catch (e) { /* ignore */ }
        cur.dead = true;
        cur = null;
      }
    }

    /* 在 canvas 上渲染模型。成功 resolve()，任何失败 reject(err)。 */
    function attach(canvas, modelUrl) {
      detach();
      var my = ++attachSeq;
      if (!canvas) return Promise.reject(new Error("没有画布"));
      var url = String(modelUrl || "").trim() || DEFAULT_MODEL;
      var base = baseDir(url);
      var gl = null;
      try {
        /* 【试过但没用，别再试】Cubism 的遮罩理论上要 stencil buffer（WebGL 默认不给），
           加 { stencil: true, depth: true } 之后画面**一模一样**（同一模型前后截图字节级相同），
           反而更容易把渲染进程卡住（视频通话回落静态兜底）。所以维持不带 stencil。
           若真机上人物仍然「烂成一锅粥」，再从这里入手（换 OpenGL/WebGL 后端或换库）。 */
        /* 必须带 stencil：Cubism 2.1 的遮罩（头发压脸、眼睛遮挡）全靠 stencil，
           没有的话遮罩区会被画成实心色块 —— 就是"烂成一锅粥"那个样子。10-21 补。 */
        var glOpts = { alpha: true, premultipliedAlpha: true, stencil: true, depth: true, antialias: false, preserveDrawingBuffer: false };
        gl = canvas.getContext("webgl", glOpts) || canvas.getContext("experimental-webgl", glOpts);
      } catch (e) { gl = null; }
      if (!gl) return Promise.reject(new Error("WebGL 不可用"));

      var chain = loadScript(LIB_SRC).then(function () {
        if (!window.Live2D || !window.Live2DModelWebGL) throw new Error("Live2D 运行时缺失");
        window.Live2D.init();
        window.Live2D.setGL(gl);
        return fetchJSON(url);
      }).then(function (json) {
        var mocUrl = base + (json.model || "");
        return fetchArrayBuffer(mocUrl).then(function (buf) {
          var model = window.Live2DModelWebGL.loadModel(buf);
          if (!model) throw new Error("模型解析失败");
          model.setGL(gl);
          /* 贴图（顺序即 setTexture 的索引） */
          var texes = json.textures || [];
          return Promise.all(texes.map(function (tp) {
            return loadImage(base + tp).then(function (img) { return createTexture(gl, img); });
          })).then(function (ts) {
            ts.forEach(function (t, i) { model.setTexture(i, t); });
            return { model: model, tex: ts, json: json };
          });
        });
      }).then(function (r) {
        if (my !== attachSeq) {
          /* 已被超时或新的 attach 作废：别再点亮画面，但要把刚建好的纹理释放掉，否则一直泄漏 */
          try {
            for (var ti = 0; ti < (r.tex || []).length; ti++) { try { gl.deleteTexture(r.tex[ti]); } catch (e) { /* ignore */ } }
          } catch (e) { /* ignore */ }
          return;
        }
        var model = r.model;
        /* 尺寸：优先用模型自报画布尺寸，没有就退回 canvas 尺寸 */
        var W = 0, H = 0;
        try { W = model.getCanvasWidth(); H = model.getCanvasHeight(); } catch (e) { /* ignore */ }
        if (!W || !H) { W = canvas.width; H = canvas.height; }
        var matrix = buildMatrix(canvas.width, canvas.height, W, H);

        cur = { gl: gl, model: model, tex: r.tex, matrix: matrix, dead: false, motions: null, mv: null, mt: 0, physics: null };
        /* 动作 / 物理都放后台加载：先把画面点亮再说，加载好再让它动、让头发飘 */
        loadMotions(base, r.json).then(function (sets) {
          if (cur && !cur.dead) cur.motions = sets;
        }).catch(function () { /* 没有动作也照样能看 */ });
        loadPhysics(base, r.json).then(function (ph) {
          if (cur && !cur.dead) cur.physics = ph;
        }).catch(function () { /* 没有物理也不影响 */ });

        /* 一点点「活着」的感觉：呼吸 + 眨眼。参数名是 Cubism 2.1 标准名。 */
        var t0 = Date.now();
        var blinkT = 0, nextBlink = 2 + Math.random() * 3;
        function frame() {
          if (!cur || cur.dead) return;
          var now = Date.now();
          var dt = (now - t0) / 1000; t0 = now;
          try {
            /* 先推动作（模型自带的 idle / tap），再压呼吸与眨眼 —— 后者显式覆盖，
               保证就算动作没加载上，「活着的感觉」也一定在。 */
            stepMotion(model, dt * 1000);
            /* 呼吸：PARAM_BREATH */
            var breath = (Math.sin(now / 1200) + 1) / 2 * 0.6;
            trySet(model, "PARAM_BREATH", breath);
            trySet(model, "PARAM_ANGLE_X", Math.sin(now / 2600) * 8);
            trySet(model, "PARAM_ANGLE_Y", Math.sin(now / 3100) * 5);
            trySet(model, "PARAM_ANGLE_Z", Math.sin(now / 3300) * 3);
            /* 眨眼 */
            blinkT += dt;
            var eye = 1;
            if (blinkT > nextBlink) {
              var p = (blinkT - nextBlink) / 0.12;
              if (p < 1) eye = Math.abs(1 - p * 2);
              else { blinkT = 0; nextBlink = 2 + Math.random() * 3; }
            }
            trySet(model, "PARAM_EYE_L_OPEN", eye);
            trySet(model, "PARAM_EYE_R_OPEN", eye);
            /* 物理放在最后：它读上面设好的角度参数（PARAM_ANGLE_*）、写头发参数，
               所以必须在这些参数设完之后、model.update() 之前跑。 */
            if (cur.physics) cur.physics.update(model);
            if (typeof model.setMatrix === "function") model.setMatrix(matrix);
            /* 每帧显式设 viewport 并清屏：canvas 尺寸变了（视频通话会改）而 viewport 不会自动跟着变，
               表现就是画面被按旧尺寸裁成一块一块的。10-21 补。 */
            try {
              gl.viewport(0, 0, canvas.width, canvas.height);
              gl.clearColor(0, 0, 0, 0);
              gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            } catch (e2) { /* ignore */ }
            model.update();
            model.draw();
          } catch (e) {
            /* 画一帧出错：停掉，别刷屏。attach 已经 resolve，上层不会因此挂掉。 */
            cur.dead = true;
            return;
          }
          rafId = requestAnimationFrame(frame);
        }
        rafId = requestAnimationFrame(frame);
      });
      return withTimeout(chain, 15000, function () {
        if (my === attachSeq) { attachSeq++; detach(); }
      });
    }

    /* 给异步加载加超时：软件渲染 / 弱设备上若卡住，别让上层永远等下去
       （超时后上面那条链即便晚到也会因 attachSeq 变化而放弃渲染） */
    function withTimeout(p, ms, onTimeout) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var t = setTimeout(function () {
          if (done) return;
          done = true;
          try { if (onTimeout) onTimeout(); } catch (e) { /* ignore */ }
          reject(new Error("live2D 加载超时（" + ms + "ms）"));
        }, ms);
        p.then(function (v) { if (done) return; done = true; clearTimeout(t); resolve(v); },
               function (e) { if (done) return; done = true; clearTimeout(t); reject(e); });
      });
    }

    function trySet(model, id, v) {
      try { model.setParamFloat(id, v); } catch (e) { /* 参数不存在就算了 */ }
    }

    /* 挑一段动作：有「插播」（tap）就先播它，否则随机挑一段 idle */
    function pickMotion(mm) {
      if (mm.oneShot) { var o = mm.oneShot; mm.oneShot = null; return o; }
      var list = (mm.idle && mm.idle.length) ? mm.idle : mm.any;
      if (!list || !list.length) return null;
      return list[Math.floor(Math.random() * list.length)];
    }
    /* 推进当前动作。播完就置空，下一帧自动换一段 —— 不依赖 SDK 的 isFinished（本版没有）。 */
    function stepMotion(model, dtMs) {
      var c = cur;
      if (!c || c.dead || !c.motions) return;
      if (!c.mv) {
        c.mv = pickMotion(c.motions);
        c.mt = 0;
        if (!c.mv) return;
        try { c.mv.setFadeIn(700); c.mv.setFadeOut(700); } catch (e) { /* ignore */ }
      }
      c.mt += dtMs;
      var dur = 0;
      try { dur = c.mv.getDurationMSec() || 0; } catch (e) { dur = 0; }
      try { c.mv.updateParam(model, c.mt); } catch (e) { c.mv = null; return; }
      if (dur > 0 && c.mt >= dur) c.mv = null;
    }
    /* 点一下画面：插播一段 tap_body 动作（没有就在返回 false，调用方不用管） */
    /* 渲染诊断（10-21）：真机上"色块"分不清是 stencil 没要到、viewport 没跟上、
       还是驱动采样出错。把这几项打出来，一趟真机就能定性。 */
    function diag() {
      if (!cur || !cur.gl) return "（当前没有在渲染的模型）";
      var g = cur.gl;
      var out = [];
      try { out.push("画布 " + g.drawingBufferWidth + "×" + g.drawingBufferHeight); } catch (e) { /* ignore */ }
      try { out.push("stencil " + g.getParameter(g.STENCIL_BITS) + " 位"); } catch (e) { /* ignore */ }
      try { out.push("depth " + g.getParameter(g.DEPTH_BITS) + " 位"); } catch (e) { /* ignore */ }
      try {
        var er = g.getError();
        out.push("GL 错误 " + (er === 0 ? "无" : er));
      } catch (e) { /* ignore */ }
      return out.join(" · ");
    }

    function tap() {
      var c = cur;
      if (!c || c.dead || !c.motions || !c.motions.tap || !c.motions.tap.length) return false;
      c.motions.oneShot = c.motions.tap[Math.floor(Math.random() * c.motions.tap.length)];
      c.mv = null;   /* 打断当前动作，下一帧立刻播这段 */
      return true;
    }

    /* 统一挂在 window.DL.live2d 下，便于 phone.js 取用。
       readBytes / channel 是给「测试模型」与回归测试用的：能单独验取数通道，
       不必真的建出 WebGL 上下文。 */
    D.live2d = {
      capable: capable, attach: attach, detach: detach, defaultModel: DEFAULT_MODEL,
      tap: tap, createPhysics: createPhysics, probe: probe, diag: diag,
      readBytes: readBytes,
      channel: function () { return lastChannel; }
    };

    window.__dlScripts = window.__dlScripts || [];
    (window.__dlScripts = window.__dlScripts || []).push("live2d.js");
    return true;
  }

  if (!boot()) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    var tries = 0;
    var retry = function () { if (boot()) return; if (++tries < 20) setTimeout(retry, 150); };
    setTimeout(retry, 150);
  }
})();
