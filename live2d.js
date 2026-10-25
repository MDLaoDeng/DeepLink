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
    function bytesToText(buf) {
      /* 入参可能是 Uint8Array（fetchJSON 走这条），也可能是 ArrayBuffer（fetchArrayBuffer → parseMtn）。
         ArrayBuffer 没有 length / 下标，必须先包一层视图；否则下面手工解码那条路会得到空串，
         而空串会让 parseMtn 直接返回 null —— 表现是「动作全没了，但不报错」。 */
      var u8 = buf;
      try {
        if (typeof ArrayBuffer !== "undefined" && buf instanceof ArrayBuffer) u8 = new Uint8Array(buf);
      } catch (e0) { u8 = buf; }
      try { if (window.TextDecoder) return new window.TextDecoder("utf-8").decode(u8); }
      catch (e) { /* 老内核没有 TextDecoder：退回下面 */ }
      var s = "";
      var n = (u8 && typeof u8.length === "number") ? u8.length : 0;
      for (var i = 0; i < n; i++) s += String.fromCharCode(u8[i]);
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
    /* 自己解析 .mtn。
       ⚠️ 不能用运行时的 Live2DMotion.updateParam(model, 时间) —— 它第二个参数要的是
       「队列项对象」（内部 MotionQueueEnt），传数字会在第一行 `if (!aN._$AT) return;` 直接返回，
       动作永远不生效，而且一声不响。我们之前就是这么写了很久：画面只有呼吸+眨眼在动，
       模型自带的抬手、转头、以及 VISIBLE: 部件切换参数全都没进来（nico 的眼睛因此一直是「白眼球」）。
       .mtn 的格式很简单：`参数名=v1,v2,...`（按 $fps 的采样序列），所以自己插值最省事。 */
    function parseMtn(buf) {
      var txt = bytesToText(buf);
      if (!txt) {
        /* 以前这里静默 return null：动作没了但没人知道。宁可吵一点。 */
        try { console.warn("[DeepLink] 动作文件解码为空，已跳过该段（检查编码 / TextDecoder）"); } catch (e0) { /* ignore */ }
        return null;
      }
      var fps = 30, params = {}, frames = 0;
      txt.split(/\r?\n/).forEach(function (line) {
        line = line.replace(/^\s+|\s+$/g, "");
        if (!line || line.charAt(0) === "#") return;
        var mv = /^\$([A-Za-z0-9_]+)\s*=\s*([\d.\-]+)/.exec(line);
        if (mv) {
          if (mv[1] === "fps") fps = parseFloat(mv[2]) || 30;
          return;
        }
        /* 有些导出器把部件可见性参数粘在别的行尾上（shizuku 的 flickHead 就是
           `PARAM_TERE=0.60VISIBLE:PARTS_01_ARM_L_01=1VISIBLE:...`），先抠出来 */
        var visRe = /VISIBLE:[A-Za-z0-9_]+\s*=\s*-?[\d.]+/g;
        var vis = line.match(visRe);
        if (vis) {
          vis.forEach(function (seg) {
            var p = seg.split("=");
            var nm = p[0].replace(/\s+/g, "");
            var val = parseFloat(p[1]);
            if (nm && isFinite(val)) params[nm] = [val];
          });
          line = line.replace(visRe, "");
        }
        var eq = line.indexOf("=");
        if (eq < 0) return;
        var name = line.slice(0, eq).replace(/\s+/g, "");
        if (!name) return;
        var parts = line.slice(eq + 1).split(",");
        var arr = [];
        for (var i = 0; i < parts.length; i++) {
          var v = parseFloat(parts[i]);
          if (!isFinite(v)) return;      /* 这行不是数值序列（比如残留的其它标记），整行丢掉 */
          arr.push(v);
        }
        if (!arr.length) return;
        params[name] = arr;
        if (arr.length > frames) frames = arr.length;
      });
      if (!frames) return null;
      return { fps: fps, params: params, frames: frames, duration: frames / fps * 1000 };
    }
    function loadMotionList(urls) {
      return Promise.all((urls || []).map(function (u) {
        return fetchArrayBuffer(u).then(parseMtn).catch(function () { return null; });
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
      var skipped = 0;
      groups.forEach(function (g) {
        var su = g.setup || {};
        var len = Number(su.length) || 0;
        /* setup 的三个值按原样喂（对照 pixi-live2d-display 的 Live2DPhysics：它也是原值直传，
           不做任何单位换算）。曾有一版把 length<1 当成「归一化」直接跳过 —— 那是误判：
           当时画面上的「头发被甩散」其实是贴图没翻转造成的采样错位。 */
        var hair = new P();
        try { hair.setup(len, Number(su.regist) || 0, Number(su.mass) || 0); }
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
      if (!hairs.length) return { list: [], skipped: skipped, update: function () {} };
      return {
        list: hairs,
        skipped: skipped,
        update: function (model, elapsed) {
          /* elapsed 传秒：参考实现（pixi）也是 physicsHair.update(model, elapsed)，
             不传的话弹簧拿不到步长，摆动会不自然。 */
          for (var i = 0; i < hairs.length; i++) {
            try { hairs[i].update(model, elapsed); } catch (e) { /* 单条挂了不影响别的 */ }
          }
        }
      };
    }
    function loadPhysics(base, json) {
      var f = json && json.physics;
      if (!f) return Promise.resolve(null);
      return fetchJSON(base + f).then(function (j) { return createPhysics(j); }).catch(function () { return null; });
    }

    /* ── 姿势 / 部件可见性（10-25 补）──────────────────────────────
       pose.json 的 parts_visible 是把「同一条手臂的几种姿态」分组的互斥组：
       每组同一时刻只该有一套可见。我们以前完全没读它，两套都按默认不透明度画出来，
       所以模型会出现四只手（两条手臂各画了两份）。
       切换信号来自动作文件里的 VISIBLE:<部件名> 参数（idle 里写的是 *_01=1 / *_02=0），
       这里照 Cubism 2.1 的 Live2DPose 做归一化：每组找第一个参数非 0 的部件，
       让它的透明度趋近 1、同组其余趋近 0；整组都没有这个参数时退回第 0 个。
       不这么做的另一个后果是：动作里切姿态时手会「跳」，因为旧的那套没有淡出。 */
    function createPose(json) {
      var raw = (json && json.parts_visible) || [];
      if (!Array.isArray(raw) || !raw.length) return null;
      var gs = [];
      raw.forEach(function (g) {
        var list = (g && g.group) ? g.group : g;
        if (!Array.isArray(list)) return;
        var items = [];
        list.forEach(function (it) {
          var id = typeof it === "string" ? it : (it && it.id);
          if (!id) return;
          /* link：主部件下面挂的联动部件，透明度必须跟着主部件走。
             典型是 nico —— 它的眼睛拆成「主部件 + 4 个镜像/分层部件」，
             不处理 link 就只显示主部件、把眼睛整片藏掉（脸是空的）。 */
          var links = [];
          if (it && Array.isArray(it.link)) {
            it.link.forEach(function (l) {
              var lid = typeof l === "string" ? l : (l && l.id);
              if (lid) links.push(String(lid));
            });
          }
          items.push({ id: String(id), links: links });
        });
        /* 只有一个部件的组没有互斥意义，跳过 */
        if (items.length > 1) gs.push(items);
      });
      if (!gs.length) return null;
      var primed = false;   /* 第一帧直接给终态：开场不做渐变 */
      return {
        groups: gs,
        update: function (model, dt) {
          /* 250ms 过渡：姿态切换时淡出旧的、淡入新的，而不是硬切。
             但【第一帧不能渐变】—— 部件初始不透明度都是 1，若从这里开始慢慢降，
             视频通话刚打开的头半秒会看到两套手臂半透明地叠在一起（像四条胳膊的鬼影），
             正好是截图的时机。所以第一帧直接落到终态。 */
          var step = primed ? Math.min(1, Math.max(0.08, (dt || 0.016) / 0.25)) : 1;
          primed = true;
          for (var gi = 0; gi < gs.length; gi++) {
            var items = gs[gi], vis = 0;
            for (var i = 0; i < items.length; i++) {
              var pi = -1, v = 0;
              try { pi = model.getParamIndex("VISIBLE:" + items[i].id); } catch (e) { pi = -1; }
              if (pi >= 0) { try { v = model.getParamFloat(pi); } catch (e) { v = 0; } }
              if (v) { vis = i; break; }
            }
            for (var j = 0; j < items.length; j++) {
              var target = (j === vis) ? 1 : 0;
              var o = target;
              try {
                var now = model.getPartsOpacity(items[j].id);
                /* 部件名不存在时这个调用可能给出 undefined，直接参与运算会算出 NaN，
                   而 NaN 写进透明度会把整个部件的变换搞坏（表现为部件消失或乱飞）。 */
                if (typeof now !== "number" || !isFinite(now)) now = target;
                o = now + (target - now) * step;
                if (Math.abs(o - target) < 0.02) o = target;
              } catch (e) { o = target; }
              try { model.setPartsOpacity(items[j].id, o); } catch (e) { /* 部件名不存在就跳过 */ }
              /* 联动部件跟着主部件同一个透明度：眼睛、手臂这类模型会把一层拆成好几片 */
              var lk = items[j].links;
              for (var k = 0; k < lk.length; k++) {
                try { model.setPartsOpacity(lk[k], o); } catch (e2) { /* ignore */ }
              }
            }
          }
        }
      };
    }
    function loadPose(base, json) {
      var f = json && json.pose;
      if (!f) return Promise.resolve(null);
      return fetchJSON(base + f).then(function (j) { return createPose(j); })
        .catch(function () { return null; });   /* 没有 pose.json 也能看，只是姿态不会互斥 */
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
      /* 【2026-10-25 关键修复】Cubism 2 的 UV 原点在左下，而 <img>/canvas 上传时原点在左上。
         不翻转就会整张图上下颠倒地采样：头发采到皮肤、瞳孔采到空白，
         表现是「每块网格都错位、细的地方碎成丝」——被误判成「渲染碎片 / 驱动问题」很久。
         只加这一行，同一份模型立刻和官方示例图一致。
         顺序要紧：两个 pixelStorei 都必须在 texImage2D 之前，且每次上传都要设（状态是全局的）。 */
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);   /* 还原，别影响后续别的贴图上传 */
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

    /* ── 自动取景 ────────────────────────────────────────────
       有的模型画布开得极大、人物只占中间一小块（nico 是 1280×1380，人不到画布的六成），
       按画布算矩阵就只能得到「人物小小一只、还偏在一边」。这里在首帧后整幅读一次像素，
       按「非透明内容的包围盒」把模型放大到铺满。
       box 存的是归一化包围盒（0~1，y 向上 —— 与 readPixels 的坐标系同向）。
       只做一次；之后每帧仍从 buildMatrix 重算基础矩阵，再把这份 box 叠上去，
       所以转屏 / 视频通话改画布尺寸都不会破坏它。 */
    function applyFrameBox(m, box) {
      if (!box) return m;
      var bw = Math.max(0.02, box.w), bh = Math.max(0.02, box.h);
      var k = Math.min(0.92 / bw, 0.92 / bh);
      if (!isFinite(k) || k <= 0) return m;
      if (k > 2.4) k = 2.4;                        /* 只剩几个像素时别放大到离谱 */
      var cx = 2 * box.cx - 1, cy = 2 * box.cy - 1;
      /* NDC 空间：x' = k*(x - cx)，直接改缩放与平移分量 */
      m[0] *= k;
      m[5] *= k;
      m[12] = k * (m[12] - cx);
      m[13] = k * (m[13] - cy);
      return m;
    }
    /* 读一帧的包围盒；不需要调（已经铺满 / 只小一点点）就返回 null。
       成本：整幅 readPixels（720×1520 ≈ 1.1M 像素，手机上几十毫秒），
       只在首帧跑一次，且画布特别大时直接跳过 —— 宁可显示小一点，也别让人等。 */
    function measureBox(gl, cw, ch) {
      if (!cw || !ch || cw * ch > 1600 * 1600) return null;
      var buf = new Uint8Array(cw * ch * 4);
      try { gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, buf); }
      catch (e) { return null; }
      var x0 = cw, x1 = -1, y0 = ch, y1 = -1;
      for (var y = 0; y < ch; y++) {
        var row = y * cw * 4;
        for (var x = 0; x < cw; x++) {
          if (buf[row + x * 4 + 3] > 16) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < x0 || y1 < y0) return null;         /* 全透明：这幅画面本身就是坏的，别动 */
      var bw = (x1 - x0 + 1) / cw, bh = (y1 - y0 + 1) / ch;
      if (bw > 0.96 && bh > 0.96) return null;     /* 本来就铺满（带背景层的模型会走到这里） */
      var k = Math.min(0.92 / bw, 0.92 / bh);
      if (!(k > 1.15)) return null;                /* 只放大「明显偏小」的，免得为了 10% 抖动 */
      return { cx: (x0 + x1 + 1) / 2 / cw, cy: (y0 + y1 + 1) / 2 / ch, w: bw, h: bh };
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
              /* 探测用完立刻释放上下文：Chrome 每页活跃 WebGL 上下文有限（约 16 个），
                 连点几次「测试」会把正式渲染用的那个挤掉，表现为画面忽然变黑。 */
              try {
                var lose = g.getExtension("WEBGL_lose_context");
                if (lose) lose.loseContext();
              } catch (e0) { /* 老内核没有这个扩展就算了 */ }
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

    /* ── 渲染自检（10-24）──────────────────────────────
       有些机器/驱动的 WebGL 就是画不对：模型出来是色块、碎片、糊成一团。
       以前是「照样画」，用户只看到一团乱码，也不知道能不能用。
       做法：画起来之后取三帧采样，颜色种类极少（一片纯色）或几乎没有非透明像素
       就判定渲染失败 → 停止循环 → 通知上层换成首帧静态图。 */
    function sampleSanity(gl, w, h) {
      try {
        /* 整幅读一次，不再抽 9 块。
           抽样对「颜色数」这种统计太稀疏：黑猫 hijiki 的 9 块里只有黑和透明两种颜色，
           会被当成「一片平涂」直接退静态图（实测踩到了）。整幅读一次，统计才准。
           代价是一次性读 + 遍历，所以：像素多的画布隔行隔列取，且只在开图前三帧跑。 */
        var W = Math.max(1, w | 0), H = Math.max(1, h | 0);
        var px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        var step = (W * H > 400000) ? 2 : 1;
        var solid = 0, total = 0, diff = 0, dn = 0, colors = {};
        for (var y = 0; y < H; y += step) {
          for (var x = 0; x < W; x += step) {
            var o = (y * W + x) * 4;
            var r = px[o], g = px[o + 1], b = px[o + 2], a = px[o + 3];
            total++;
            if (r || g || b || a) solid++;
            /* 颜色键必须带 alpha：黑色(0,0,0,255) 和透明(0,0,0,0) 的 RGB 一样，
               不带 alpha 就会合并成一种颜色，黑猫被算成「1 色」。 */
            colors[(r >> 3) + "," + (g >> 3) + "," + (b >> 3) + "," + (a >> 3)] = 1;
            if (x + step < W) {
              var o2 = (y * W + x + step) * 4;
              diff += Math.abs(px[o] - px[o2]) + Math.abs(px[o + 1] - px[o2 + 1]) + Math.abs(px[o + 2] - px[o2 + 2]);
              dn += 3;
            }
          }
        }
        return { ratio: total ? (solid / total) : 0, colors: Object.keys(colors).length, edge: dn ? (diff / dn) : 0 };
      } catch (e) { return null; }
    }

    /* 渲染坏了要有人知道（通话页据此换回静态头像）。默认空，调用方按需设置。 */
    var onBrokenHook = null;
    /* 最后一次「判定坏」的采样值。cur 已经 detach，真机上只能靠它解释为什么退静态图。 */
    var lastBroken = null;

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

        cur = { gl: gl, model: model, tex: r.tex, matrix: matrix, W: W, H: H, dead: false, broken: false, samples: [], motions: null, mv: null, mt: 0, physics: null, pose: null, box: null, framed: false };
        cur.onBroken = onBrokenHook;
        /* 动作 / 物理都放后台加载：先把画面点亮再说，加载好再让它动、让头发飘 */
        loadMotions(base, r.json).then(function (sets) {
          if (cur && !cur.dead) cur.motions = sets;
        }).catch(function () { /* 没有动作也照样能看 */ });
        loadPhysics(base, r.json).then(function (ph) {
          if (cur && !cur.dead) cur.physics = ph;
        }).catch(function () { /* 没有物理也不影响 */ });
        /* 姿势和物理一样放后台：先把画面点亮，加载好再让手臂互斥 */
        loadPose(base, r.json).then(function (pz) {
          if (cur && !cur.dead) cur.pose = pz;
        }).catch(function () { /* 没有姿势文件也不影响 */ });

        /* 一点点「活着」的感觉：呼吸 + 眨眼。参数名是 Cubism 2.1 标准名。 */
        var t0 = Date.now();
        var blinkT = 0, nextBlink = 2 + Math.random() * 3;
        function frame() {
          if (!cur || cur.dead) return;
          var now = Date.now();
          var dt = (now - t0) / 1000; t0 = now;
          /* 帧间隔必须限幅：视频通话中切后台 / 息屏 / 主线程被长任务占住时，
             dt 可能是几秒。物理弹簧（PhysicsHair）按 dt 积分，秒级步长会把头发甩飞，
             而且【弹簧状态有记忆】—— 下一帧 dt 正常了它还在往回弹，看着像模型炸了。
             动作播放也按 dt 前进，过大的 dt 会直接跳到段尾。
             下限 8ms：防止 0/负数（时钟回拨）让插值和积分除零。 */
          if (!isFinite(dt) || dt <= 0) dt = 0.016;
          else if (dt > 0.05) dt = 0.05;
          try {
            /* 先铺「活着」的基础层（呼吸 + 微转头 + 眨眼），再让动作覆盖。
               动作是作者编的，优先级更高；动作没加载上时基础层也保证画面不是死的。 */
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
            /* 动作层：模型自带的抬手 / 转头 / 部件可见性（VISIBLE:…）都在这里进来 */
            stepMotion(model, dt * 1000);
            /* 物理放在最后：它读上面设好的角度参数（PARAM_ANGLE_*）、写头发参数，
               所以必须在这些参数设完之后、model.update() 之前跑。 */
            if (cur.physics) cur.physics.update(model, dt);
            /* 部件可见性放在最后、update 之前：它读动作刚写好的 VISIBLE: 参数，
               再折算成各部件的不透明度。少了这一步，同一条手臂的两套姿态会同时不透明，
               看起来就是「四只手」（两条手臂各两份）。 */
            if (cur.pose) cur.pose.update(model, dt);
            /* 矩阵必须按「当前画布尺寸」重算：视频通话会改 canvas 大小，
               而 viewport 是每帧设的、矩阵却只在加载时算过一次 —— 两者不一致，
               表现就是画面被拉伸（不是裁剪，是长宽比错了）。 */
            if (typeof model.setMatrix === "function") {
              cur.matrix = buildMatrix(canvas.width, canvas.height,
                cur.W || canvas.width, cur.H || canvas.height);
              /* 自动取景：只对「画布大、人物小」的模型叠一层放大（见 measureBox） */
              if (cur.box) applyFrameBox(cur.matrix, cur.box);
              model.setMatrix(cur.matrix);
            }
            /* 每帧显式设 viewport 并清屏：canvas 尺寸变了（视频通话会改）而 viewport 不会自动跟着变，
               表现就是画面被按旧尺寸裁成一块一块的。10-21 补。 */
            try {
              gl.viewport(0, 0, canvas.width, canvas.height);
              gl.clearColor(0, 0, 0, 0);
              gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            } catch (e2) { /* ignore */ }
            model.update();
            model.draw();
            /* 每帧画完立刻采样（readPixels 必须在同一帧的 draw 之后读，
               隔帧读会因为缓冲区被清而拿到空的）。前三帧只观察不下结论，
               避免把「还没画完」误判成坏。 */
            if (cur.samples.length < 3) {
              var sn = sampleSanity(gl, canvas.width, canvas.height);
              if (sn) cur.samples.push(sn);
              if (cur.samples.length === 3) {
                /* 原来按「颜色数最少」挑一帧，再拿这一帧套三条阈值 —— 语义不一致：
                   某帧空白但颜色多、另一帧颜色少但画面正常时，空白那帧会被漏掉。
                   现在三条判据各自跨帧取最坏值。 */
                var worst = { ratio: 1, colors: 1e9, edge: 0 };
                for (var si3 = 0; si3 < cur.samples.length; si3++) {
                  var s3 = cur.samples[si3];
                  if (s3.ratio < worst.ratio) worst.ratio = s3.ratio;
                  if (s3.colors < worst.colors) worst.colors = s3.colors;
                  if (s3.edge > worst.edge) worst.edge = s3.edge;
                }
                /* 判据：非透明像素不到 3%（基本空白）或颜色不到 8 种（一片平涂）。
                   正常的角色立绘颜色几百种，绝不会踩到这两条。 */
                /* 三条判据任中其一就算坏：
                   · 非透明不到 3%（基本空白）
                   · 颜色不到 3 种（一片平涂）。原来是 8，会把「近乎单色的模型」误杀 ——
                     实测黑猫 hijiki、白猫 tororo 曾被当成渲染失败直接退静态头像。
                     现在颜色键带 alpha（透明与纯黑分开算），纯色填充只会有 1 种，3 是安全线。
                   · 相邻像素平均差 > 40（碎片 / 色块拼贴 —— 就是真机截图那种）
                   实测：shizuku 34（五官细节密）、nico 7、z16 13；碎片画面是随机跳变，会到 60 以上。
                   阈值定在 40（不是 60）：34 距 40 只剩 6，已经是最紧的一条，再抬就兜不住了。
                   这条只是粗筛，真正兜底的是 ratio。 */
                if (worst.ratio < 0.03 || worst.colors < 3 || worst.edge > 40) {
                  /* 自己收尾：停循环 + 删纹理 + 摘 GL。以前只置 dead 就等调用方 detach，
                     别处接 onBroken 忘了 detach 就是每通电话泄漏 6 张 1024² 纹理。 */
                  var hook = cur.onBroken, info = worst;
                  lastBroken = { ratio: info.ratio, colors: info.colors, edge: info.edge, at: Date.now() };
                  try { detach(); } catch (e4) { /* ignore */ }
                  try {
                    if (typeof hook === "function") hook(info);
                  } catch (e3) { /* ignore */ }
                  return;
                }
                /* 三帧都判正常 → 顺手做一次自动取景。
                   放在这里而不是 attach 之后立刻做：要等姿势文件的部件透明度落到终态，
                   否则量到的包围盒可能包含还没隐藏的那套手臂。 */
                if (!cur.framed) {
                  cur.framed = true;
                  try { cur.box = measureBox(gl, canvas.width, canvas.height); }
                  catch (e6) { cur.box = null; }
                }
              }
            }
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
    /* 推进当前动作：按帧号线性插值，把每个参数写进模型。播完置空，下一帧换一段。 */
    function stepMotion(model, dtMs) {
      var c = cur;
      if (!c || c.dead || !c.motions) return;
      if (!c.mv) {
        c.mv = pickMotion(c.motions);
        c.mt = 0;
        c.fadeFrom = null;   /* 换段：下一帧重新记录起点 */
        if (!c.mv) return;
      }
      c.mt += dtMs;
      var mo = c.mv;
      var idx = c.mt / 1000 * (mo.fps || 30);
      /* 换段时 250ms 交叉淡化：起点取「换段那一刻参数的实际值」。
         不这么做的话，上一段末值不是 0、或 tap 插播被打断时，参数会硬跳一下。
         .mtn 里的 $fadein/$fadeout 我们没解析，统一 250ms，行为可预期。 */
      var w = Math.min(1, c.mt / 250);
      if (w < 1 && !c.fadeFrom) c.fadeFrom = {};
      var from = c.fadeFrom;
      for (var name in mo.params) {
        if (!mo.params.hasOwnProperty(name)) continue;
        var arr = mo.params[name];
        var v;
        if (arr.length === 1) v = arr[0];
        else {
          var i0 = Math.floor(idx);
          if (i0 < 0) i0 = 0;
          if (i0 >= arr.length - 1) v = arr[arr.length - 1];
          else {
            var f = idx - i0;
            v = arr[i0] + (arr[i0 + 1] - arr[i0]) * f;
          }
        }
        if (w < 1 && from) {
          if (from[name] === undefined) {
            var now0 = NaN;
            try { now0 = model.getParamFloat(name); } catch (e1) { now0 = NaN; }
            from[name] = (typeof now0 === "number" && isFinite(now0)) ? now0 : v;
          }
          v = from[name] + (v - from[name]) * w;
        }
        try { model.setParamFloat(name, v); } catch (e) { /* 参数不存在就算了 */ }
      }
      if (mo.duration > 0 && c.mt >= mo.duration) c.mv = null;
    }
    /* 点一下画面：插播一段 tap_body 动作（没有就在返回 false，调用方不用管） */
    /* 渲染诊断（10-21）：真机上"色块"分不清是 stencil 没要到、viewport 没跟上、
       还是驱动采样出错。把这几项打出来，一趟真机就能定性。 */
    function diag() {
      if (!cur || !cur.gl) {
        if (lastBroken) {
          return "（已退静态图 · 上次判定坏：非透明 " + (lastBroken.ratio * 100).toFixed(0) +
            "% · 颜色 " + lastBroken.colors + " · 边缘 " + lastBroken.edge.toFixed(1) + "）";
        }
        return "（当前没有在渲染的模型）";
      }
      var g = cur.gl;
      var out = [];
      try { out.push("画布 " + g.drawingBufferWidth + "×" + g.drawingBufferHeight); } catch (e) { /* ignore */ }
      try { out.push("stencil " + g.getParameter(g.STENCIL_BITS) + " 位"); } catch (e) { /* ignore */ }
      try { out.push("depth " + g.getParameter(g.DEPTH_BITS) + " 位"); } catch (e) { /* ignore */ }
      /* 下面这几项是排查「画成一锅色块」用的：
         如果 模型画布 和 缓冲区 的比例差很远，或者矩阵里出现 NaN / 0，
         问题就在矩阵那一层，不在着色器；两者正常却仍然碎片，才该怀疑 GPU / 运行时。 */
      try {
        var cw = cur.model.getCanvasWidth(), chh = cur.model.getCanvasHeight();
        out.push("模型画布 " + Math.round(cw) + "×" + Math.round(chh));
        out.push("比例 " + (cw && chh ? (cw / chh).toFixed(3) : "?") + " / 缓冲 " +
          (g.drawingBufferHeight ? (g.drawingBufferWidth / g.drawingBufferHeight).toFixed(3) : "?"));
      } catch (e) { /* ignore */ }
      try {
        var m = cur.matrix || [];
        var bad = false;
        for (var i = 0; i < m.length; i++) { if (!isFinite(m[i])) { bad = true; break; } }
        out.push("矩阵 " + (bad ? "含非法值!" : "正常"));
        out.push("缩放 " + (m[0] !== undefined ? Number(m[0]).toFixed(4) : "?") +
                 "," + (m[5] !== undefined ? Number(m[5]).toFixed(4) : "?"));
        out.push("平移 " + (m[12] !== undefined ? Number(m[12]).toFixed(3) : "?") +
                 "," + (m[13] !== undefined ? Number(m[13]).toFixed(3) : "?"));
      } catch (e) { /* ignore */ }
      try { out.push("DPR " + (window.devicePixelRatio || 1)); } catch (e) { /* ignore */ }
      try {
        var sw = null;
        for (var si2 = 0; si2 < (cur.samples || []).length; si2++) {
          var x2 = cur.samples[si2];
          if (!sw || x2.ratio < sw.ratio) sw = x2;
        }
        out.push("采样 " + (cur.broken ? "判定坏" : "正常") +
          (sw ? ("（非透明 " + (sw.ratio * 100).toFixed(0) + "% · 颜色 " + sw.colors +
                 " · 边缘 " + sw.edge.toFixed(1) + "）") : "（还没采到）"));
      } catch (e) { /* ignore */ }
      try {
        /* 自动取景：模型画布大、人物只占中间一块时，按包围盒放大过一次 */
        var bx = cur.box;
        out.push("取景 " + (bx
          ? ("放大 " + Math.min(0.92 / Math.max(0.02, bx.w), 0.92 / Math.max(0.02, bx.h)).toFixed(2) +
             "×（内容占 " + (bx.w * 100).toFixed(0) + "% × " + (bx.h * 100).toFixed(0) + "%）")
          : (cur.framed ? "原样（本来就满幅）" : "待测")));
      } catch (e) { /* ignore */ }
      try {
        var ph = cur.physics;
        out.push("物理 " + (ph ? (((ph.list ? ph.list.length : 0) + " 条" +
          (ph.skipped ? "（跳过 " + ph.skipped + " 条归一化参数）" : ""))) : "未启用"));
      } catch (e) { /* ignore */ }
      try {
        var mo = cur.motions;
        out.push("动作 " + (mo
          ? ("idle " + ((mo.idle && mo.idle.length) || 0) + " / tap " + ((mo.tap && mo.tap.length) || 0) +
             (cur.mv ? " · 播放中" : " · 停"))
          : "未加载"));
      } catch (e) { /* ignore */ }
      try {
        out.push("姿势 " + (cur.pose ? (cur.pose.groups.length + " 组互斥：" +
          cur.pose.groups.map(function (g) {
            var v = 0;
            for (var i = 0; i < g.length; i++) {
              var pi = -1, x = 0;
              try { pi = cur.model.getParamIndex("VISIBLE:" + g[i].id); } catch (e) { pi = -1; }
              if (pi >= 0) { try { x = cur.model.getParamFloat(pi); } catch (e) { x = 0; } }
              if (x) { v = i; break; }
            }
            return String(g[v].id).replace(/^PARTS_0?\d_/, "");
          }).join(" / ")) : "未启用"));
      } catch (e) { /* ignore */ }
      /* 渲染器字符串：这一项能一眼分开「软件渲染」和「硬件驱动」。
         看到 SwiftShader / llvmpipe = WebView 退回了软渲染，碎片是软栅格化的锅；
         看到 Mali / Adreno / PowerVR = 走的是真 GPU，问题在驱动或渲染器内部。
         注意：部分 WebView 会屏蔽这个扩展，读不到属于正常，不要当成故障。 */
      try {
        var dbg = g.getExtension("WEBGL_debug_renderer_info");
        if (dbg) {
          out.push("渲染器 " + String(g.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).slice(0, 42));
          out.push("厂商 " + String(g.getParameter(dbg.UNMASKED_VENDOR_WEBGL)).slice(0, 28));
        } else {
          out.push("渲染器 不可读（扩展被屏蔽）");
        }
      } catch (e) { out.push("渲染器 读取失败"); }
      try { out.push("WebGL " + String(g.getParameter(g.VERSION)).slice(0, 30)); } catch (e) { /* ignore */ }
      try { out.push("最大纹理 " + g.getParameter(g.MAX_TEXTURE_SIZE)); } catch (e) { /* ignore */ }
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
      channel: function () { return lastChannel; },
      /* 用法：D.live2d.onBroken(function (info) { ... })，info = { ratio, colors } */
      onBroken: function (fn) { onBrokenHook = (typeof fn === "function") ? fn : null; }
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
