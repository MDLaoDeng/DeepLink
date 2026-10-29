/* camera.js —— 相机模块（从 app.js 拆出，拆分计划阶段①，见 HANDOFF.md 4.9）
 *
 * 为什么这么写：
 *  - 本文件在 index.html 里排在 app.js 之后、activity.js 之前 —— 执行时 window.DL 一定已存在。
 *  - 相机段原本依赖 $ / $v / UI / Files / state 等外部符号，搬运时【没有改函数体】，
 *    只在下面把 DL 里的同名成员解构成局部变量，所以搬过来的代码与在 app.js 里逐字一致。
 *  - 事件绑定原本在 app.js 的 bind() 里，一并搬来（见 bindCam）。
 *  - 末尾自注册 D.camera 给外界用，并向 window.__dlScripts 登记自己（连接自检的「附加脚本」会显示）。
 *
 * 本文件不新增依赖、不改行为、不动版号；缺什么共享件请写进 WORKLOG-PC.md 的「需补暴露」，不要改 app.js。
 */
(function () {
  /* 打包工具不一定按 index.html 的顺序执行脚本（app.js 可能晚于本文件）。
     那时 window.DL 还不存在 —— 等它就绪后再初始化一次。返回 false = 还没就绪。 */
  var booted = false;  /* boot 幂等：DOMContentLoaded 与补拍 retry 各会调一次，别重复绑事件 / 分裂状态 */
  function boot() {
    if (booted) return true;
  var D = window.DL;
  if (!D) return false;   /* 尚未就绪，由文件末尾安排重试 */
  booted = true;   /* 已真正初始化过，后续再被调用直接返回 */

  /* 共享件解构（名字与 app.js 内保持一致，保证搬来的代码不用改一个字） */
  var $ = D.$, $v = D.$v, state = D.state;
  var setText = D.setText, setVal = D.setVal;
  var checkedOf = D.checkedOf, setChecked = D.setChecked;
  var on = D.on;
  /* ⚠️ 模块（UI / Files）与 chat.js 提供的入口（renderAttachments / syncChip /
     syncPlaceholder / send）【不在加载时快照】：打包工具若把相关文件排到 app.js 或
     chat.js 之后执行，快照会永久停在 undefined —— 表现是相机「直接发送」点了没反应、
     附件栏不刷新，而且【不报错】。见 chat.js 顶部注释。 */
  var UI, Files, renderAttachments, syncChip, syncPlaceholder, send;
  function syncModules() {
    UI = D.UI || window.UI; Files = D.Files || window.Files;
    renderAttachments = D.renderAttachments; syncChip = D.syncChip;
    syncPlaceholder = D.syncPlaceholder; send = D.send;
  }
  syncModules();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncModules);
  else setTimeout(syncModules, 0);

  /* ── 相机（自研预览 + 裁剪/旋转/圈画/箭头/文字）──── */
  /* 工作画布最长边上限。原图 3000~4000px 时每帧 clearRect + drawImage 都是全尺寸，真机掉帧。
     生成底图的地方（camCapture / camImageFrom）统一等比缩到 ≤ CAM_MAX_SIDE。
     注意 camFlatten() 基于 cam.base，所以导出图最长边也是 CAM_MAX_SIDE —— 有意取舍。 */
  const CAM_MAX_SIDE = 1600;
  /* 画笔采样阈值（canvas 坐标）。与上一个采样点距离不足它的事件丢弃，避免长笔画堆到几千个点 */
  const CAM_PT_EPS = 1.5;
  const cam = {
    stream: null, facing: "environment",
    original: null, base: null, snapshot: null,
    shapes: [], drag: null, cropRect: null, textPoint: null,
    tool: null, color: "#ffffff", width: 5,
    torch: false, focusTimer: null, loadTimer: null, startTimer: null,
    /* 拍完交给谁。null = 老行为（塞进主聊天的附件栏）；
       设了函数就走回调，用于「拍完直接发动态」这类外部用途。 */
    onDone: null
  };
  /* 屏幕→底图的换算比缓存（见 camUnit），0 = 未算/需重算 */
  let camUnitPx = 0;
  /* 旋转动画是否在进行中（防止连点转两次） */
  let camRotating = false;
  /* 旋转动画的失效令牌：动画期间若底图被别的原因换掉（关闭 / 重拍 / 撤销），
     挂起的回调必须作废，否则它会在几百毫秒后把画面又覆盖回去。 */
  let camRotToken = 0;

  /* 启动相机时用转圈动画盖住（而不是视频自身的占位播放图标） */
  function camLoading(show) {
    const el = $("#camLoading");
    if (el) el.hidden = !show;
  }

  /* 未真正播出前把 <video> 藏起来，避免安卓 WebView 的原生播放占位露出来 */
  function camShowVideo(on) {
    const v = $("#camVideo");
    if (v) v.classList.toggle("ready", !!on);
  }

  function camTrack() {
    if (!cam.stream) return null;
    const t = cam.stream.getVideoTracks();
    return t && t.length ? t[0] : null;
  }

  function camCaps() {
    const t = camTrack();
    if (!t || !t.getCapabilities) return {};
    try { return t.getCapabilities() || {}; } catch (e) { return {}; }
  }

  function camApplyConstraint(c) {
    const t = camTrack();
    if (!t || !t.applyConstraints) return Promise.reject(new Error("当前环境不支持调节相机"));
    return t.applyConstraints({ advanced: [c] });
  }

  /* 每次开流后按设备能力配置补光/曝光控件 */
  function camSetupControls() {
    cam.torch = false;
    const tb = $("#camTorch");
    if (tb) {
      tb.classList.remove("on");
      tb.setAttribute("aria-pressed", "false");
      tb.innerHTML = UI.iconSvg("flashlight") + "<span>补光</span>";
    }
    const caps = camCaps();
    const wrap = $("#camExposureWrap");
    const ex = caps.exposureCompensation;
    if (!wrap) return;
    if (ex && typeof ex.min === "number" && typeof ex.max === "number" && ex.max > ex.min) {
      wrap.hidden = false;
      const sl = $("#camExposure");
      if (sl) {
        sl.min = String(ex.min);
        sl.max = String(ex.max);
        sl.step = String(ex.step || 0.1);
        sl.value = "0";
      }
    } else {
      wrap.hidden = true;
    }
  }

  async function camToggleTorch() {
    if (!cam.stream) return;
    if (!camCaps().torch) { UI.toast("此设备不支持手电筒补光", true); return; }
    cam.torch = !cam.torch;
    try {
      await camApplyConstraint({ torch: cam.torch });
      const b = $("#camTorch");
      if (b) {
        b.classList.toggle("on", cam.torch);
        b.setAttribute("aria-pressed", cam.torch ? "true" : "false");
        b.innerHTML = UI.iconSvg(cam.torch ? "flashlight-off" : "flashlight") + "<span>" + (cam.torch ? "关闭补光" : "补光") + "</span>";
      }
    } catch (e) {
      cam.torch = false;
      UI.toast("手电筒切换失败：" + (e.message || e), true);
    }
  }

  function camVideoPoint(ev) {
    const v = $("#camVideo");
    const r = v.getBoundingClientRect();
    const t = (ev.touches && ev.touches[0]) || ev;
    const px = t.clientX - r.left;
    const py = t.clientY - r.top;
    const vw = v.videoWidth || r.width;
    const vh = v.videoHeight || r.height;
    const scale = Math.min(r.width / vw, r.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const x = (px - (r.width - dw) / 2) / dw;
    const y = (py - (r.height - dh) / 2) / dh;
    return { px: px, py: py, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  /* 点哪聚哪：先给对焦框反馈，再尝试把焦点搬过去（不支持就只留框） */
  async function camFocusAt(ev) {
    if (!cam.stream) return;
    if (ev.target && ev.target.closest && ev.target.closest("button, input")) return;
    const p = camVideoPoint(ev);
    const f = $("#camFocus");
    if (f) {
      f.hidden = false;
      f.style.left = p.px + "px";
      f.style.top = p.py + "px";
      clearTimeout(cam.focusTimer);
      cam.focusTimer = setTimeout(() => { f.hidden = true; }, 1300);
    }
    try {
      const t = camTrack();
      if (!t) return;
      await t.applyConstraints({ advanced: [{ pointsOfInterest: [{ x: p.x, y: p.y }], focusMode: "single-shot" }] });
    } catch (e) { /* 不支持点击对焦的设备就只留对焦框 */ }
  }

  /* 帧节流：touchmove 比帧率密得多，直接重绘会在一次屏幕刷新里白画好几遍。
     拖动类动作走它；离散动作（按下/抬手/切工具/旋转/裁剪/撤销/重置）仍走 camRender() 立即出画面。 */
  let camRaf = 0;
  function camRenderSoon() {
    if (camRaf) return;
    camRaf = requestAnimationFrame(() => { camRaf = 0; camRender(); });
  }

  /* 运行画布的位图尺寸：只要「够屏幕显示」就行，不必等于底图。
     之前位图直接等于底图（最长边 1600 → 192 万像素），每次触摸移动都要
     clear + drawImage 全尺寸、再把约 7.7MB 的位图重新上传，真机明显掉帧；
     而屏幕上实际只显示 ~40 万像素。这里把位图收到「显示所需像素」，
     笔迹坐标仍统一按【底图坐标】记（camPos 用 cam.base 换算），绘制时用 setTransform 缩放
     —— 导出走 camFlatten（底图尺寸），画质不受影响。 */
  function camFitCanvas() {
    const c = $("#camCanvas");
    if (!c || !cam.base) return;
    const iw = cam.base.width, ih = cam.base.height;
    if (!(iw > 0 && ih > 0)) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    /* 依次取三个来源，用第一个量得到的：
       ① 容器（最准）② 画布自己 ③ 按视口估算（兜底）
       —— 绝不退回「底图尺寸」：那等于把上百万像素当画布用，正是真机卡顿的根因。
         量不到只说明此刻还没布局完，估一个数量级正确的值远好过多算 5 倍。 */
    const pick = (el) => {
      if (!el) return null;
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { return null; }
      return (r && r.width > 8 && r.height > 8) ? { width: r.width, height: r.height } : null;
    };
    const box = pick(c.parentNode) || pick(c) || {
      width: Math.max(120, (window.innerWidth || 360) - 20),
      height: Math.max(160, (window.innerHeight || 640) - 190)
    };
    /* k 是 contain 比例：显示宽 = iw*k、显示高 = ih*k。
       位图 = 显示尺寸 × dpr，像素量刚好够清晰、不多算。 */
    const k = Math.min(box.width / iw, box.height / ih);
    const s = Math.min(k * dpr, 1);
    c.width = Math.max(1, Math.round(iw * s));
    c.height = Math.max(1, Math.round(ih * s));
  }

  /* 布局刚变化（画布由隐藏转显示）时可能还量不到尺寸，下一帧再贴合一次纠正 */
  function camFitSoon() {
    setTimeout(() => {
      const e = $("#camEdit");
      if (!cam.base || !e || e.hidden) return;
      camFitCanvas();
      camRender();
    }, 80);
  }

  /* 屏幕尺寸变了（横竖屏切换等）重新贴合一次，否则位图与显示会错位 */
  window.addEventListener("resize", () => {
    const e = $("#camEdit");
    if (!cam.base || !e || e.hidden) return;
    camUnitPx = 0;    /* 屏幕尺寸变了，手柄/容差的换算比跟着变 */
    camFitCanvas();
    camRender();
  });

  function camRender() {
    const c = $("#camCanvas");
    if (!c || !cam.base) return;
    const ctx = c.getContext("2d");
    const sx = c.width / cam.base.width;
    const sy = c.height / cam.base.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    /* 往后的绘制一律按【底图坐标】来，缩放交给 transform；
       笔画线宽也跟着同比例缩，视觉粗细与改造前一致。 */
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.drawImage(cam.base, 0, 0);
    camShapesInto(ctx, cam.shapes);
    if (cam.drag && cam.drag.type !== "crop" && cam.drag.type !== "cropEdit") camShapesInto(ctx, [cam.drag]);
    if (cam.tool === "crop") {
      /* 三种情况：已有框（可能正在被拖动调整）、正在新拖一个框、什么都没 */
      const d = cam.drag;
      let rect = cam.cropRect;
      if (d && d.type === "crop") rect = camNorm(d.from, d.to);
      else if (d && d.type === "cropEdit") rect = camCropDrag(d.mode, d.from, d.to, d.orig);
      camDrawCrop(ctx, rect);
    }
  }

  function camShapesInto(ctx, list) {
    (list || []).forEach((s) => {
      if (!s) return;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (s.type === "draw") {
        ctx.beginPath();
        s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      } else if (s.type === "arrow") {
        const dx = s.to.x - s.from.x;
        const dy = s.to.y - s.from.y;
        if (Math.sqrt(dx * dx + dy * dy) < 2) return;
        ctx.beginPath();
        ctx.moveTo(s.from.x, s.from.y);
        ctx.lineTo(s.to.x, s.to.y);
        ctx.stroke();
        const ang = Math.atan2(dy, dx);
        const hl = Math.max(14, s.width * 3.4);
        ctx.beginPath();
        ctx.moveTo(s.to.x, s.to.y);
        ctx.lineTo(s.to.x - hl * Math.cos(ang - 0.42), s.to.y - hl * Math.sin(ang - 0.42));
        ctx.lineTo(s.to.x - hl * Math.cos(ang + 0.42), s.to.y - hl * Math.sin(ang + 0.42));
        ctx.closePath();
        ctx.fill();
      } else if (s.type === "text") {
        ctx.font = "bold " + s.size + "px sans-serif";
        ctx.textBaseline = "top";
        ctx.fillText(s.text, s.x, s.y);
      }
    });
  }

  function camNorm(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  /* ── 裁剪框：可拖可调 ────────────────────────────────
     位图可以比底图小（camFitCanvas），所以「手指在屏幕上感受到的容差」
     必须按【底图px/屏幕px】换算，否则手感会随位图缩放变化。
     camUnit() 返回这个比值并缓存；底图变化 / 旋转屏时清掉重算。 */
  function camUnit() {
    if (camUnitPx > 0) return camUnitPx;
    const c = $("#camCanvas");
    if (!c || !cam.base) return 1;
    let w = 0;
    try { w = c.getBoundingClientRect().width; } catch (e) { /* ignore */ }
    if (!(w > 8)) return 1;                 /* 还没布局/隐藏着 → 退回 1，别算出 0 或 Infinity */
    const u = cam.base.width / w;
    if (!isFinite(u) || u <= 0) return 1;
    camUnitPx = u;
    return u;
  }

  const CROP_HIT = 24;      /* 手指命中容差（屏幕 px） */
  const CROP_MIN = 26;      /* 框的最小边长（屏幕 px） */

  function camRectCopy(r) {
    return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
  }

  /* 点下去落在哪：四角/四边中点 → "nw" "e" 之类；框内 → "move"；框外 → null（当作重新拖一个新框） */
  function camCropHit(p) {
    const r = cam.cropRect;
    if (!r || r.w < 2 || r.h < 2) return null;
    const tol = CROP_HIT * camUnit();
    const L = r.x, T = r.y, R = r.x + r.w, B = r.y + r.h;
    if (p.x < L - tol || p.x > R + tol || p.y < T - tol || p.y > B + tol) return null;
    const dL = Math.abs(p.x - L), dR = Math.abs(p.x - R);
    const dT = Math.abs(p.y - T), dB = Math.abs(p.y - B);
    const nearL = dL <= tol, nearR = dR <= tol, nearT = dT <= tol, nearB = dB <= tol;
    /* 角优先，且**不受 tiny 影响**：角的判据是「离两条边都近」，框越小这个判据越明确。
       之前把角一起塞进 tiny 的排除里，结果框缩到 72px 以下就再也拖不大 —— 死锁。 */
    if ((nearL || nearR) && (nearT || nearB)) {
      return (nearT ? "n" : "s") + (nearL ? "w" : "e");
    }
    /* 只对「边」降级：小框里四边的容差会占满整个框，那时点哪都在拖边，框反而挪不动 */
    const tiny = (r.w < tol * 3) || (r.h < tol * 3);
    if (!tiny) {
      if (nearL || nearR) return nearL ? "w" : "e";
      if (nearT || nearB) return nearT ? "n" : "s";
    }
    if (p.x > L && p.x < R && p.y > T && p.y < B) return "move";
    return null;
  }

  /* 始终以【按下那一刻的框】为基准做增量 —— 连续拖动不累积误差，也不怕手指飘出去。
     上下界用 Number.MAX_SAFE_INTEGER 而不是 1e9：自由变量反查脚本的词法分析会把
     「1e9」拆成「1」和「e9」，凭空多出一条假告警，掩盖以后真正的漏符号。 */
  function camCropDrag(mode, from, to, orig) {
    const W = cam.base ? cam.base.width : Number.MAX_SAFE_INTEGER;
    const H = cam.base ? cam.base.height : Number.MAX_SAFE_INTEGER;
    const u = camUnit();
    const MIN = CROP_MIN * u;
    const dx = to.x - from.x, dy = to.y - from.y;
    let L = orig.x, T = orig.y, R = orig.x + orig.w, B = orig.y + orig.h;
    if (mode === "move") {
      const nx = Math.max(0, Math.min(W - orig.w, L + dx));   /* 整体拖动不许拖出画布 */
      const ny = Math.max(0, Math.min(H - orig.h, T + dy));
      return { x: nx, y: ny, w: orig.w, h: orig.h };
    }
    if (mode.indexOf("w") >= 0) L = Math.min(L + dx, R - MIN);
    if (mode.indexOf("e") >= 0) R = Math.max(R + dx, L + MIN);
    if (mode.indexOf("n") >= 0) T = Math.min(T + dy, B - MIN);
    if (mode.indexOf("s") >= 0) B = Math.max(B + dy, T + MIN);
    L = Math.max(0, L); T = Math.max(0, T);
    R = Math.min(W, R); B = Math.min(H, B);
    if (R - L < MIN) { if (mode.indexOf("w") >= 0) L = Math.max(0, R - MIN); else R = Math.min(W, L + MIN); }
    if (B - T < MIN) { if (mode.indexOf("n") >= 0) T = Math.max(0, B - MIN); else B = Math.min(H, T + MIN); }
    return camNorm({ x: L, y: T }, { x: R, y: B });
  }

  /* 进裁剪模式先给一个内缩的框：直接就能拖角微调，不必每次重新拖一遍 */
  /* ── 记住上次的构图（10-25 用户反馈：每次进裁剪都要重新拖一遍）──
     按「相对底图的比例」存，换一张不同尺寸的照片也能按同样构图套上去。
     放 localStorage 而不是 settings：它是个纯前端的操作习惯，不进导出、不参与迁移。 */
  /* 走 Store 而不是 localStorage：这个项目的持久化统一由 Store 管（原生 KV 或 storage 适配），
     file:// WebView 里 localStorage 有可能被封装禁掉 —— 那种情况下 try/catch 会把异常吞掉，
     用户看到的就是「记忆功能做了但没生效」，还查不出原因。 */
  function cropStore() { return (D && D.Store) || window.Store || null; }

  function cropReadKeep() {
    try {
      const S = cropStore();
      if (!S) return null;
      const v = S.getSettings().cropKeep;
      if (v && typeof v.l === "number" && typeof v.t === "number"
        && v.r > v.l && v.b > v.t && v.r <= 1.001 && v.b <= 1.001 && v.l >= -0.001 && v.t >= -0.001) return v;
    } catch (e) { /* 坏数据当没有 */ }
    return null;
  }
  function cropSaveKeep(r) {
    if (!r || !cam.base) return;
    const W = cam.base.width || 1, H = cam.base.height || 1;
    try {
      const S = cropStore();
      if (!S) return;
      S.saveSettings({ cropKeep: {
        l: r.x / W, t: r.y / H, r: (r.x + r.w) / W, b: (r.y + r.h) / H
      } });
    } catch (e) { /* 存不上就算了，不影响裁剪 */ }
  }
  function cropForgetKeep() {
    try {
      const S = cropStore();
      if (S) S.saveSettings({ cropKeep: null });
    } catch (e) { /* ignore */ }
  }

  function camDefaultCrop() {
    const W = cam.base ? cam.base.width : 100;
    const H = cam.base ? cam.base.height : 100;
    /* 上次裁过就套上次的构图：同一张照片反复裁同一块时不用每次重拖 */
    const keep = cropReadKeep();
    if (keep) {
      const x = keep.l * W, y = keep.t * H;
      const w = (keep.r - keep.l) * W, h = (keep.b - keep.t) * H;
      if (w > 4 && h > 4) return { x: x, y: y, w: w, h: h };
    }
    const iw = W * 0.84, ih = H * 0.84;
    return { x: (W - iw) / 2, y: (H - ih) / 2, w: iw, h: ih };
  }

  /* 绘制裁剪框。注意此刻 ctx 已按【底图坐标】缩放（setTransform），
     所以：几何用底图宽高；线宽/手柄边长要乘 camUnit() 才能在屏幕上保持恒定粗细
     —— 位图缩到 0.25 倍时，写死的 lineWidth=2 在屏幕上只有 0.5px，细到看不见。 */
  function camDrawCrop(ctx, r) {
    if (!r || r.w < 2 || r.h < 2) return;
    const W = cam.base.width, H = cam.base.height;
    const u = camUnit();
    ctx.save();
    /* 框外压暗 */
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(0, 0, W, r.y);
    ctx.fillRect(0, r.y + r.h, W, H - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, W - r.x - r.w, r.h);
    /* 三分构图辅助线（淡淡的，不喧宾夺主） */
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = Math.max(0.6, 1 * u);
    for (let i = 1; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(r.x + r.w * i / 3, r.y);
      ctx.lineTo(r.x + r.w * i / 3, r.y + r.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(r.x, r.y + r.h * i / 3);
      ctx.lineTo(r.x + r.w, r.y + r.h * i / 3);
      ctx.stroke();
    }
    /* 边框：先描一层深色再描白，亮背景上也能看清（纯白框在浅色照片上会“消失”） */
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.lineWidth = Math.max(2, 3.5 * u);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = Math.max(1, 1.6 * u);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    /* 四角方块 + 四边中点短线（10-25 改）：
       原来八个手柄画成一样大，方块在屏幕上只有 8px、又分不清哪是角哪是边，手指很难对准。
       现在角=实心大方块（屏幕 ~15px），边=细短线，一眼能分出「拖角改大小 / 拖边改一边」。 */
    const hs = Math.max(2.5, 7.5 * u);          /* 角手柄半边长（屏幕约 7.5px） */
    const cs = [r.x, r.y, r.x + r.w, r.y + r.h];
    const corners = [[cs[0], cs[1]], [cs[2], cs[1]], [cs[0], cs[3]], [cs[2], cs[3]]];
    corners.forEach((c) => {
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.lineWidth = Math.max(1, 1.6 * u);
      ctx.beginPath();
      ctx.rect(c[0] - hs, c[1] - hs, hs * 2, hs * 2);
      ctx.fill();
      ctx.stroke();
    });
    /* 边中点：短横线 / 短竖线，长度是角块的 1.6 倍、粗细取半 */
    const el = hs * 1.6, et = Math.max(1.2, 2 * u);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.fillRect(r.x + r.w / 2 - el, r.y - et / 2, el * 2, et);          /* 上 */
    ctx.fillRect(r.x + r.w / 2 - el, r.y + r.h - et / 2, el * 2, et);    /* 下 */
    ctx.fillRect(r.x - et / 2, r.y + r.h / 2 - el, et, el * 2);          /* 左 */
    ctx.fillRect(r.x + r.w - et / 2, r.y + r.h / 2 - el, et, el * 2);    /* 右 */
    /* 尺寸标注：贴在框内左上角，告诉用户裁出来多少像素 */
    const label = Math.round(r.w) + " × " + Math.round(r.h);
    const fs = Math.max(10, 26 * u);
    ctx.font = "600 " + fs + "px sans-serif";
    const tw = ctx.measureText(label).width + fs * 0.7;
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(r.x, r.y, tw, fs * 1.5);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, r.x + fs * 0.35, r.y + fs * 0.78);
    ctx.restore();
  }

  function camFlatten() {
    const c = document.createElement("canvas");
    c.width = cam.base.width;
    c.height = cam.base.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(cam.base, 0, 0);
    camShapesInto(ctx, cam.shapes);
    return c;
  }

  /* 清掉旋转动画留在画布上的 CSS，并作废挂起的动画回调。
     换底图 / 关相机 / 重拍时都要调，否则残留的 rotate 会让下次进来画面是歪的。 */
  function camClearRotAnim() {
    camRotToken++;
    camRotating = false;
    const c = $("#camCanvas");
    if (!c) return;
    c.style.transition = "none";
    c.style.transform = "none";
  }

  function camSetBase(canvas) {
    cam.base = canvas;
    camUnitPx = 0;    /* 底图换了 → 屏幕换算比要重算 */
    camClearRotAnim();
    const c = $("#camCanvas");
    if (!c) return;
    camFitCanvas();   /* 位图按「显示所需像素」定尺寸，而不是直接等于底图 */
    camRender();
  }

  function camSetOriginal(canvas) {
    cam.original = canvas;
    cam.shapes = [];
    cam.snapshot = null;
    cam.cropRect = null;
    cam.drag = null;
    cam.textPoint = null;
    camSetTool(null);
    camSetBase(canvas);
  }

  function camSetTool(t) {
    const prev = cam.tool;
    cam.tool = t;
    /* 进裁剪模式先给个框：有记忆的构图就套记忆的，没有才内缩 84%。
       切到别的工具【保留】这个框（切回来还能接着调，不必重拖），只是不显示。
       换底图的地方（裁剪确定 / 旋转 / 重置 / 重拍 / 关闭）会显式清掉，因为坐标全变了。 */
    if (t === "crop") {
      if (prev === "crop") {
        /* 再点一次裁剪 = 重置回默认：拖歪了、或想换构图，总得有个出路。
           连记忆一起清，否则「重置」立刻又被记忆拉回去。 */
        cropForgetKeep();
        cam.cropRect = camDefaultCrop();
      } else if (!cam.cropRect) {
        cam.cropRect = camDefaultCrop();
      }
    }
    cam.drag = null;   /* 切工具时丢掉没抬手的拖动，免得残留 drag 在新工具下继续算 */
    document.querySelectorAll(".cam-tool").forEach((b) => b.classList.toggle("on", b.getAttribute("data-cam") === t));
    const colors = $("#camColors");
    if (colors) colors.hidden = !(t === "draw" || t === "arrow" || t === "text");
    const ca = $("#camCropActions");
    if (ca) ca.hidden = t !== "crop";
    camRender();
  }

  function camPos(ev) {
    const c = $("#camCanvas");
    const r = c.getBoundingClientRect();
    const t = (ev.touches && ev.touches[0]) || ev;
    /* 换算到【底图坐标】：运行位图可以比底图小，笔迹坐标必须统一按底图记，导出才不错位 */
    const bw = cam.base ? cam.base.width : c.width;
    const bh = cam.base ? cam.base.height : c.height;
    return { x: (t.clientX - r.left) * (bw / r.width), y: (t.clientY - r.top) * (bh / r.height) };
  }

  function camDown(e) {
    if (!cam.base || !cam.tool) return;
    const p = camPos(e);
    if (cam.tool === "draw") cam.drag = { type: "draw", color: cam.color, width: cam.width, pts: [p] };
    else if (cam.tool === "arrow") cam.drag = { type: "arrow", color: cam.color, width: cam.width, from: p, to: p };
    else if (cam.tool === "crop") {
      /* 先看是不是落在已有框的手柄/框内 —— 是就调整它，不是才当作重新拖一个新框。
         这条就是「不用每次都重拖一遍」的关键。 */
      const hit = camCropHit(p);
      if (hit) cam.drag = { type: "cropEdit", mode: hit, from: p, to: p, orig: camRectCopy(cam.cropRect) };
      else cam.drag = { type: "crop", from: p, to: p };
    }
    else if (cam.tool === "text") {
      cam.textPoint = p;
      const bar = $("#camTextBar");
      if (bar) bar.hidden = false;
      setTimeout(() => { const i = $("#camTextInput"); if (i) i.focus(); }, 60);
    }
    e.preventDefault();
  }

  /* 抬手瞬间的落点。touchend 的 e.touches 是空数组，必须读 changedTouches，
     否则 camPos() 会拿到 undefined 的 clientX 算出 NaN 坐标；
     末尾的 || e 是给鼠标事件兜底（MouseEvent 既没有 changedTouches 也没有 touches）。 */
  function camLastPos(e) {
    if (!e) return null;
    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]) || e;
    if (!t || typeof t.clientX !== "number") return null;
    return camPos({ clientX: t.clientX, clientY: t.clientY });
  }

  function camMove(e) {
    if (!cam.drag) return;
    const p = camPos(e);
    if (cam.drag.type === "draw") {
      const last = cam.drag.pts[cam.drag.pts.length - 1];
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      /* 稀疏化：太近的点丢掉。长笔画原本会累积几千个点，每帧都要全部遍历重描，越画越卡 */
      if (dx * dx + dy * dy > CAM_PT_EPS * CAM_PT_EPS) cam.drag.pts.push(p);
    } else {
      cam.drag.to = p;
    }
    camRenderSoon();
    e.preventDefault();
  }

  function camUp(e) {
    const d = cam.drag;
    if (!d) return;
    cam.drag = null;
    if (d.type === "draw") {
      /* 末点可能被稀疏化滤掉了，抬手时补回来让笔画末端跟手；
         但与末点重合就不补 —— 否则"单击不动"会从什么都不画变成画一个圆点 */
      const p = camLastPos(e);
      if (p) {
        const last = d.pts[d.pts.length - 1];
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        if (dx * dx + dy * dy > CAM_PT_EPS * CAM_PT_EPS) d.pts.push(p);
      }
      if (d.pts.length > 1) cam.shapes.push(d);
    }
    else if (d.type === "arrow") cam.shapes.push(d);
    else if (d.type === "crop") {
      /* 在框外按下再拖 = 重新框一个。但「点一下没拖」也走这条路 ——
         那种情况别把已有的框弄没（新框会变成 0×0），当作误触忽略。 */
      const nr = camNorm(d.from, d.to);
      const min = CROP_MIN * camUnit();
      if (nr.w >= min && nr.h >= min) cam.cropRect = nr;
    }
    else if (d.type === "cropEdit") {
      /* 只是「点一下没动」时 to 仍等于 from，算出来就是原框 —— 不会把框弄没 */
      cam.cropRect = camCropDrag(d.mode, d.from, d.to, d.orig);
    }
    /* 队列里可能还压着一帧没画，先撤掉再立即画，保证抬手后画面一定是最新的 */
    if (camRaf) { cancelAnimationFrame(camRaf); camRaf = 0; }
    camRender();
    if (e) e.preventDefault();
  }

  /* ── 旋转（带动画）────────────────────────────────────
     之前是「算完直接换底图」，真机上就是「啪」地一下换了张图，眼睛跟不上。
     现在分两步：① 给画布挂 CSS transform 转 90°（动画，不改位图）；
     ② 动画结束再真正旋转位图并重排。旋转过程中包围盒会短暂超过容器，
     所以顺手缩到 .86，转完回 1 —— 全程都看得见。 */
  function camRotate() {
    if (!cam.base || camRotating) return;
    const c = $("#camCanvas");
    const token = ++camRotToken;
    /* 一张就够（10-29 修）：两次 camFlatten() 内容完全一样，1600 边的画布每张约 7.7MB，
       一次旋转瞬时多占十几兆。apply 里只读 src、snapshot 只留引用，不会互相改。 */
    const keep = camFlatten();     /* 旋转前的画面（含笔画），留给「撤销」还原 */
    const src = keep;              /* 要旋转的那张：笔画一并烤进去，和改造前行为一致 */
    cam.shapes = [];
    cam.cropRect = null;           /* 坐标全变了，裁剪框必须重来 */
    cam.drag = null;
    camRotating = true;
    const apply = () => {
      if (token !== camRotToken) { camRotating = false; return; }   /* 已被别处作废 */
      const nc = document.createElement("canvas");
      nc.width = src.height;
      nc.height = src.width;
      const ctx = nc.getContext("2d");
      ctx.translate(nc.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(src, 0, 0);
      cam.snapshot = keep;
      camSetBase(nc);      /* 里面会清掉动画留下的 transform，并把 camRotating 复位 */
    };
    if (!c) { apply(); return; }
    c.style.transition = "transform 280ms ease";
    c.style.transform = "rotate(90deg) scale(.86)";
    let done = false;
    const once = () => { if (done) return; done = true; apply(); };
    c.addEventListener("transitionend", once, { once: true });
    /* transitionend 偶尔收不到（元素被隐藏 / 动画被打断）→ 兜底 */
    setTimeout(once, 360);
  }

  function camCropApply() {
    const r = cam.cropRect;
    /* 阈值按屏幕算，和拖动时的最小边长保持一致 */
    const min = CROP_MIN * camUnit();
    if (!r || r.w < min || r.h < min) { UI.toast("裁剪框太小了，拖大一点再裁剪", true); return; }
    /* 裁过一次就把构图记下来：下一张图、下一次编辑都直接套这个比例 */
    cropSaveKeep(r);
    /* OPT-08：以前这里连续调两次 camFlatten()，各生成一张全尺寸画布
       （1600×1200 下每张约 7.7MB），内容却完全一样。只留一张，snapshot 复用同一份。 */
    const flat = camFlatten();
    cam.snapshot = flat;
    const nc = document.createElement("canvas");
    nc.width = Math.max(1, Math.round(r.w));
    nc.height = Math.max(1, Math.round(r.h));
    nc.getContext("2d").drawImage(flat, -r.x, -r.y);
    cam.shapes = [];
    cam.cropRect = null;    /* 换底图了，旧框坐标失效（camSetTool 现在会保留框，所以这里必须显式清） */
    cam.drag = null;
    camSetTool(null);
    camSetBase(nc);
  }

  function camUndo() {
    if (cam.shapes.length) { cam.shapes.pop(); camRender(); return; }
    if (cam.snapshot) { const s = cam.snapshot; cam.snapshot = null; cam.shapes = []; camSetBase(s); return; }
    UI.toast("没有可撤销的步骤");
  }

  function camReset() {
    if (!cam.original) return;
    cam.shapes = [];
    cam.snapshot = null;
    cam.cropRect = null;
    cam.drag = null;
    camSetTool(null);
    camSetBase(cam.original);
  }

  /* 每次停流都递增（10-29 修）：getUserMedia 是异步的，连点「翻转」或关掉再开时，
     先发的那次请求可能后返回 —— 以前拿到流就直接 cam.stream = stream，
     被覆盖掉的那条流永远没人 stop，摄像头指示灯常亮、下次也打不开。
     用令牌保证「只有最后一次请求的结果才准上屏」。 */
  var camStreamToken = 0;

  function camStopStream() {
    camStreamToken++;
    if (cam.loadTimer) { clearInterval(cam.loadTimer); cam.loadTimer = null; }
    if (cam.focusTimer) { clearTimeout(cam.focusTimer); cam.focusTimer = null; }
    if (cam.startTimer) { clearTimeout(cam.startTimer); cam.startTimer = null; }
    if (cam.stream) {
      cam.stream.getTracks().forEach((t) => t.stop());
      cam.stream = null;
    }
    const v = $("#camVideo");
    if (v) {
      v.onplaying = null;
      v.onloadeddata = null;
      v.srcObject = null;
      try { v.removeAttribute("src"); v.load(); } catch (e) { /* 老内核 load() 可能抛异常 */ }
    }
    camShowVideo(false);
  }

  function camFallback(why) {
    camStopStream();
    camLoading(false);
    setText("#camHint", why + "，已改用系统相机；拍完仍可在这里裁剪 / 旋转 / 圈画。");
    UI.toast("已改用系统相机", true);
    setTimeout(() => {
      /* 400ms 里用户可能已经关掉相机：这时别再弹系统相机（同样只判 hidden） */
      const m = document.getElementById("cameraModal");
      if (!m || m.hidden) return;
      const i = $("#camFallbackInput");
      if (i) i.click();
    }, 400);
  }

  async function camStartStream() {
    camStopStream();
    camLoading(true);
    $("#camTorch").classList.remove("on");
    $("#camExposureWrap").hidden = true;
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { camFallback("当前环境不支持自研相机"); return; }
    const myToken = camStreamToken;
    try {
      const stream = await md.getUserMedia({ video: { facingMode: cam.facing }, audio: false });
      /* 等权限期间又被 stop 过一次（换了镜头 / 关了相机）→ 这条流已经过期，
         立刻放掉，绝不能接上去。 */
      if (myToken !== camStreamToken) {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
        return;
      }
      /* 等权限的这段时间用户可能已经把相机关了：这时流不能接上，
         否则弹窗都没了、摄像头指示灯还亮着（track 泄漏）。
         ⚠️ 只能判 hidden：相机层是用 `hidden = false` 打开的，**没有** .modal 的 show 类
         （上一版按 `.show` 判，结果每次启动都被当成「已关闭」，流立刻 stop → 永远转圈）。 */
      const camUi = document.getElementById("cameraModal");
      if (!camUi || camUi.hidden) {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
        return;
      }
      cam.stream = stream;
      const v = $("#camVideo");
      if (!v) { camFallback("相机界面缺失"); return; }
      v.muted = true;
      v.setAttribute("muted", "");
      v.setAttribute("playsinline", "");
      v.playsInline = true;
      v.autoplay = true;
      const tryPlay = () => { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); };
      /* 只有真正在播（未暂停且已有画面）才揭开视频；否则保留转圈层，绝不露出原生播放占位 */
      const reveal = () => {
        if (v.paused || !v.videoWidth) return false;
        camShowVideo(true);
        camLoading(false);
        if (cam.loadTimer) { clearInterval(cam.loadTimer); cam.loadTimer = null; }
        if (cam.startTimer) { clearTimeout(cam.startTimer); cam.startTimer = null; }
        return true;
      };
      v.onplaying = reveal;
      v.onloadeddata = () => { if (!reveal()) tryPlay(); };
      v.srcObject = stream;
      tryPlay();
      setText("#camHint", "");
      if (cam.loadTimer) clearInterval(cam.loadTimer);
      cam.loadTimer = setInterval(() => { if (v.videoWidth && v.paused) tryPlay(); reveal(); }, 250);
      if (cam.startTimer) clearTimeout(cam.startTimer);
      cam.startTimer = setTimeout(() => { if (!reveal()) camFallback("相机没有画面"); }, 6000);
      camSetupControls();
    } catch (e) {
      camFallback("相机打不开（" + ((e && (e.name || e.message)) || "未知原因") + "）");
    }
  }

  function camOpen(opts) {
    /* 外部调用：DL.camera.open({ onDone: fn }) —— 拍完把 dataUrl 交给 fn，不进附件栏 */
    cam.onDone = (opts && typeof opts.onDone === "function") ? opts.onDone : null;
    $("#cameraModal").hidden = false;
    $("#camStage").hidden = false;
    $("#camEdit").hidden = true;
    setText("#camHint", "");
    camStartStream();
  }

  function camClose() {
    camStopStream();
    camClearRotAnim();
    $("#cameraModal").hidden = true;
    $("#camStage").hidden = false;
    $("#camEdit").hidden = true;
    setText("#camHint", "");
    cam.original = null;
    cam.base = null;
    cam.shapes = [];
    cam.snapshot = null;
    cam.drag = null;
    cam.cropRect = null;
    cam.textPoint = null;
    cam.tool = null;
  }

  function camImageFrom(img) {
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    const scale = Math.min(1, CAM_MAX_SIDE / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function camCapture() {
    const v = $("#camVideo");
    if (!v || !v.videoWidth) { UI.toast("相机还没准备好", true); return; }
    const scale = Math.min(1, CAM_MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    camStopStream();
    $("#camStage").hidden = true;
    $("#camEdit").hidden = false;
    camSetOriginal(c);
    camFitSoon();   /* 刚显示出来可能量不到尺寸，下一帧再贴合纠正 */
  }

  async function camUseFile(file) {
    try {
      const a = await Files.read(file);
      if (!a || a.kind !== "image" || !a.dataUrl) throw new Error("不是图片");
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("图片解码失败")); img.src = a.dataUrl; });
      camStopStream();
      $("#camStage").hidden = true;
      $("#camEdit").hidden = false;
      camSetOriginal(camImageFrom(img));
      camFitSoon();   /* 刚显示出来可能量不到尺寸，下一帧再贴合纠正 */
    } catch (e) {
      UI.toast("读取照片失败：" + (e.message || e), true);
    }
  }

  function camTextOk() {
    const t = $v("#camTextInput").trim();
    setVal("#camTextInput", "");
    const bar = $("#camTextBar");
    if (bar) bar.hidden = true;
    if (!t || !cam.textPoint || !cam.base) { cam.textPoint = null; return; }
    cam.shapes.push({
      type: "text", color: cam.color, width: cam.width,
      size: Math.max(18, Math.round(cam.base.width / 18)),
      x: cam.textPoint.x, y: cam.textPoint.y, text: t
    });
    cam.textPoint = null;
    camRender();
  }

  function camFinish(mode) {
    syncModules();
    if (!cam.base) return;
    let dataUrl;
    try { dataUrl = camFlatten().toDataURL("image/jpeg", 0.9); }
    catch (e) { UI.toast("图片编码失败", true); return; }
    /* 有外部回调（发动态）就先交出去，且不碰主聊天的附件栏 ——
       否则拍个动态会在输入框上多挂一张图，看着像要发给角色。 */
    if (cam.onDone) {
      var cb = cam.onDone;
      cam.onDone = null;
      camClose();
      try { cb(dataUrl); } catch (e) { /* 回调自己的错不该炸相机 */ }
      return;
    }
    state.attachments.push({
      name: "photo_" + Date.now() + ".jpg",
      kind: "image", mime: "image/jpeg",
      size: Math.round(dataUrl.length * 0.75),
      dataUrl
    });
    renderAttachments();
    camClose();
    if (mode === "send") {
      if (checkedOf("#imgToggle")) { setChecked("#imgToggle", false); syncChip($("#imgToggle")); syncPlaceholder(); }
      send();
    } else {
      UI.toast("已附带在消息上");
    }
  }

  function camRetake() {
    camClearRotAnim();
    cam.original = null;
    cam.base = null;
    cam.shapes = [];
    cam.snapshot = null;
    cam.cropRect = null;
    cam.drag = null;
    $("#camEdit").hidden = true;
    $("#camStage").hidden = false;
    camStartStream();
  }

  /* ── 相机相关的事件绑定（原在 app.js 的 bind() 内，一并搬来）──── */
  let camBound = false;
  function bindCam() {
    if (camBound) return;   /* boot() 可能被调用多次，绑定只做一次 */
    camBound = true;
    on("#camTorch", "click", camToggleTorch);
    on("#camExposure", "input", (e) => { camApplyConstraint({ exposureCompensation: Number(e.target.value) }).catch(() => {}); });
    on("#camStage", "click", camFocusAt);
    /* 拍照入口现在是加号浮窗里的那一项，选完顺手把浮窗收掉 */
    on("#plusCamera", "click", () => { if (window.DL && window.DL.popoverClose) window.DL.popoverClose(); camOpen(); });
    on("#camClose", "click", camClose);
    on("#camClose2", "click", camClose);
    on("#camFlip", "click", () => { cam.facing = cam.facing === "environment" ? "user" : "environment"; camStartStream(); });
    on("#camShutter", "click", camCapture);
    on("#camRetake", "click", camRetake);
    on("#camAttach", "click", () => camFinish("attach"));
    on("#camSend", "click", () => camFinish("send"));
    on("#camCropOk", "click", camCropApply);
    on("#camCropCancel", "click", () => camSetTool(null));
    on("#camTextOk", "click", camTextOk);
    on("#camTextCancel", "click", () => { const b = $("#camTextBar"); if (b) b.hidden = true; cam.textPoint = null; });
    on("#camTextInput", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); camTextOk(); } });
    on("#camFallbackInput", "change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) await camUseFile(f);
    });
    document.querySelectorAll(".cam-tool").forEach((b) => {
      b.addEventListener("click", () => {
        const t = b.getAttribute("data-cam");
        if (t === "rotate") { camRotate(); return; }
        if (t === "undo") { camUndo(); return; }
        if (t === "reset") { camReset(); return; }
        camSetTool(cam.tool === t ? null : t);
      });
    });
    document.querySelectorAll(".cam-color").forEach((b) => {
      b.addEventListener("click", () => {
        cam.color = b.getAttribute("data-color");
        document.querySelectorAll(".cam-color").forEach((x) => x.classList.toggle("on", x === b));
      });
    });
    const camCanvasEl = $("#camCanvas");
    if (camCanvasEl) {
      camCanvasEl.addEventListener("touchstart", camDown, { passive: false });
      camCanvasEl.addEventListener("touchmove", camMove, { passive: false });
      camCanvasEl.addEventListener("touchend", camUp);
      camCanvasEl.addEventListener("mousedown", camDown);
      camCanvasEl.addEventListener("mousemove", camMove);
      camCanvasEl.addEventListener("mouseup", camUp);
    }
  }

  /* 绑定时机【不能】只挂在 DOMContentLoaded 上：
     如果 boot() 恰好是在 DOMContentLoaded 派发【过程中】才成功的
     （打包工具打乱脚本顺序时会这样），那时再注册监听已经晚了 —— 事件不会再触发，
     结果就是整个相机按钮失灵（点拍照毫无反应），而且不报任何错。
     改成三条腿一起走：① 能查到元素就立刻绑；② 每 50ms 再看一次，最多 4 秒；
     ③ 另外挂一个 DOMContentLoaded（若那时还没就绪）。谁先到算谁的，camBound 保证只绑一次。 */
  function bindWhenReady(n) {
    if (camBound) return;
    if (document.getElementById("camCanvas")) { bindCam(); return; }
    if (n < 80) setTimeout(() => bindWhenReady(n + 1), 50);
  }
  bindWhenReady(0);
  if (!camBound && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { if (!camBound) bindWhenReady(0); });
  }

  /* ── 自注册：给外界用的入口（HANDOFF.md 4.9 要求）──── */
  D.camera = {
    open: camOpen,
    close: camClose,
    useFile: camUseFile,
    isOpen: function () { var m = $("#cameraModal"); return !!(m && !m.hidden); }
  };

  /* 登记到连接自检的「附加脚本」（照 probe.js 的写法） */
  try {
    window.__dlScripts = window.__dlScripts || [];
    window.__dlScripts.push("camera.js");
  } catch (e) { /* ignore */ }
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
