/* DeepLink —— 扩展模型适配器：语音转文字 / 语音合成 / 文生图
   三类都按 OpenAI 兼容格式实现；地址与密钥留空时沿用主模型配置。 */
(function () {
  const SPEC = {
    asr: { enabled: "asrEnabled", base: "asrBaseUrl", key: "asrKey", model: "asrModel" },
    tts: { enabled: "ttsEnabled", base: "ttsBaseUrl", key: "ttsKey", model: "ttsModel" },
    img: { enabled: "imgEnabled", base: "imgBaseUrl", key: "imgKey", model: "imgModel" },
    /* vision（10-19 补）：这张表原来没有它，于是 Media.capable("vision", …) 会
       在 cfg() 里读 undefined.enabled 直接抛 TypeError —— 表现是「加表情」整条链路
       静默失败（调用处没有 try/catch）。字段名与设置页、api.js 的 visionSettings 一致。 */
    vision: { enabled: "visionEnabled", base: "visionBaseUrl", key: "visionKey", model: "visionModel" },
    /* 视频 / 音乐：异步任务式，除了地址和密钥还要创建/查询路径，见 jobCfg */
    video: { enabled: "videoEnabled", base: "videoBaseUrl", key: "videoKey", model: "videoModel" },
    music: { enabled: "musicEnabled", base: "musicBaseUrl", key: "musicKey", model: "musicModel" }
  };

  function cfg(kind, s) {
    const k = SPEC[kind];
    const st = s || {};
    /* 能力名没登记就按「不支持」返回，绝不抛错 —— 调用点都在 if 条件里，抛出去等于整条链路静默失败 */
    if (!k) return { enabled: false, base: "", key: "", model: "" };
    return {
      enabled: !!st[k.enabled],
      base: String(st[k.base] || st.baseUrl || "").replace(/\/+$/, ""),
      key: String(st[k.key] || st.apiKey || ""),
      /* 模型名留空同样嫁接到主模型（与设置页里那句说明一致） */
      model: String(st[k.model] || st.model || "")
    };
  }

  function capable(kind, s) {
    const c = cfg(kind, s);
    return !!(c.enabled && c.base && c.key && c.model);
  }

  async function httpError(res) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
    return new Error("HTTP " + res.status + (detail ? "：" + detail : ""));
  }

  /* 加一个超时：弱网下 ASR / TTS / 文生图 会让 await 长时间挂住，界面只剩「正在输入…」。
     有 AbortController 就用它兜上限；没有（老环境）就原样请求，行为不变。 */
  function fetchTimeout(url, init, ms) {
    if (typeof AbortController === "undefined") return fetch(url, init);
    const ctrl = new AbortController();
    const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, ms || 60000);
    const init2 = Object.assign({}, init, { signal: ctrl.signal });
    return fetch(url, init2).then(function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; });
  }

  async function transcribe(blob, s, filename) {
    const c = cfg("asr", s);
    if (!c.base || !c.key) throw new Error("未配置语音转写接口地址或密钥");
    const form = new FormData();
    form.append("file", blob, filename || "audio.webm");
    form.append("model", c.model);
    if (s.asrLang) form.append("language", s.asrLang);
    const res = await fetchTimeout(c.base + "/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + c.key },
      body: form
    }, 120000);
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    const text = String(data.text || (data.data && data.data.text) || "").trim();
    if (!text) throw new Error("转写结果为空");
    return text;
  }

  async function speak(text, s) {
    const c = cfg("tts", s);
    if (!c.base || !c.key) throw new Error("未配置语音合成接口地址或密钥");
    const res = await fetchTimeout(c.base + "/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key },
      body: JSON.stringify({ model: c.model, input: text, voice: s.ttsVoice || "FunAudioLLM/CosyVoice2-0.5B:alex" })
    }, 120000);
    if (!res.ok) throw await httpError(res);
    const type = res.headers.get("content-type") || "";
    if (type.indexOf("json") >= 0) {
      const data = await res.json();
      const url = data.url || data.audio ||
        (data.data && data.data[0] && (data.data[0].url || data.data[0].audio));
      if (!url) throw new Error("语音合成返回的 JSON 里找不到音频地址");
      return url;
    }
    const blob = await res.blob();
    if (!blob.size) throw new Error("语音合成返回了空音频");
    return URL.createObjectURL(blob);
  }

  /* 各家返回格式不完全一样，统一从响应里抠出图片地址 / base64 */
  function pickImage(data) {
    const first = (data && data.data && data.data[0]) || (data && data.images && data.images[0]) || data || {};
    if (typeof first === "string") return first;
    if (first.b64_json || first.b64) return "data:image/png;base64," + (first.b64_json || first.b64);
    if (first.url) return first.url;
    throw new Error("文生图返回格式无法识别（既没有 b64_json 也没有 url）");
  }

  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ""));
    if (!m) return null;
    const mime = m[1] || "image/png";
    const bin = m[2]
      ? atob(m[3] || "")
      : decodeURIComponent(m[3] || "");
    const len = bin.length;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  /* 图生图：走 OpenAI 兼容的 /images/edits（multipart 传参考图）。
     用于「让角色形象保持一致」——参考图来自角色个人图库（外置文件读回）。 */
  async function imageEdit(prompt, c, size, ref) {
    const blob = dataUrlToBlob(ref);
    if (!blob) throw new Error("参考图不是可用的 data URL");
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("model", c.model);
    form.append("n", "1");
    form.append("size", size);
    form.append("image", blob, "ref.png");
    const res = await fetchTimeout(c.base + "/images/edits", {
      method: "POST",
      headers: { "Authorization": "Bearer " + c.key },
      body: form
    }, 180000);
    if (!res.ok) throw await httpError(res);
    return pickImage(await res.json());
  }

  /* opts.ref：参考图（data URL）。给了它、且设置里开了「图生图」，就先走 /images/edits，
     失败**自动回落**文生图 —— 一致性是加分项，不该因为平台没有 edits 接口就出不了图。 */
  async function image(prompt, s, opts) {
    const c = cfg("img", s);
    if (!c.base || !c.key) throw new Error("未配置文生图接口地址或密钥");
    const size = s.imgSize || "1024x1024";
    const ref = opts && opts.ref;
    if (ref && s.imgToImg) {
      try {
        return await imageEdit(prompt, c, size, ref);
      } catch (e) { /* 回落文生图 */ }
    }
    const res = await fetchTimeout(c.base + "/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key },
      body: JSON.stringify({ model: c.model, prompt, n: 1, size: size })
    }, 180000);
    if (!res.ok) throw await httpError(res);
    return pickImage(await res.json());
  }

  /* ── 录音 ─────────────────────────────────────── */
  const MIME_CANDIDATES = [
    "audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"
  ];

  function pickMime() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    for (let i = 0; i < MIME_CANDIDATES.length; i++) {
      if (MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
    }
    return "";
  }

  function recorderSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      typeof MediaRecorder !== "undefined");
  }

  function extOf(mime) {
    if (mime.indexOf("mp4") >= 0) return "m4a";
    if (mime.indexOf("ogg") >= 0) return "ogg";
    return "webm";
  }

  const recorder = {
    supported: recorderSupported,
    _stream: null,
    _rec: null,
    _chunks: [],
    _mime: "",

    get recording() { return !!this._rec && this._rec.state === "recording"; },

    async start() {
      if (!recorderSupported()) {
        const e = new Error("当前环境不支持录音");
        e.code = "UNSUPPORTED";
        throw e;
      }
      /* 重入保护：上一次还没收拾干净就又调 start（比如权限弹窗期间被连点两次），
         会把旧麦克风流直接覆盖掉、永不释放 → 话筒常亮。先收干净再开新的。 */
      if (this._rec || this._stream) { try { this.cancel(); } catch (e) { /* ignore */ } }
      /* 权限弹窗期间 _rec/_stream 都还是空的，上面那个判空挡不住连点：
         两次 getUserMedia 各自 resolve，后到的覆盖先到的、先到的那条流没人 stop → 话筒常亮。
         用序号认领，只认最后一次 start 拿到的那条流。 */
      const myStart = (this._startSeq = (this._startSeq || 0) + 1);
      const stream0 = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (myStart !== this._startSeq) {
        try { stream0.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
        throw new Error("录音已取消");
      }
      this._stream = stream0;
      this._mime = pickMime();
      this._rec = this._mime
        ? new MediaRecorder(this._stream, { mimeType: this._mime })
        : new MediaRecorder(this._stream);
      this._chunks = [];
      this._rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) this._chunks.push(ev.data); };
      this._rec.start();
    },

    _release() {
      if (this._stream) {
        this._stream.getTracks().forEach((t) => t.stop());
        this._stream = null;
      }
      this._rec = null;
    },

    stop() {
      const rec = this._rec;
      if (!rec || rec.state === "inactive") return Promise.resolve(null);
      return new Promise((resolve) => {
        rec.onstop = () => {
          const type = this._mime ? this._mime.split(";")[0] : "audio/webm";
          const blob = new Blob(this._chunks, { type });
          this._chunks = [];
          this._release();
          resolve(blob);
        };
        rec.onerror = () => { this._release(); resolve(null); };
        try { rec.stop(); } catch (e) { this._release(); resolve(null); }
      });
    },

    cancel() {
      if (this._rec && this._rec.state !== "inactive") {
        this._rec.onstop = null;
        try { this._rec.stop(); } catch (e) { /* ignore */ }
      }
      this._chunks = [];
      this._release();
    }
  };

  /* ── 视频 / 音乐：异步任务式接口（提交 → 轮询 → 取结果）──────────
     各家服务商的路径和字段名都不一样，所以「创建路径 / 查询路径 / 结果字段」
     全放在设置里填，这里只按同一套流程走完。 */
  function jobCfg(kind, s) {
    var st = s || {};
    var p = kind === "video" ? "video" : "music";
    return {
      base: String(st[p + "BaseUrl"] || "").replace(/\/+$/, ""),
      key: String(st[p + "Key"] || ""),
      model: String(st[p + "Model"] || ""),
      createPath: String(st[p + "CreatePath"] || ""),
      statusPath: String(st[p + "StatusPath"] || ""),
      resultField: String(st[p + "ResultField"] || ""),
      pollMs: Math.max(1000, Number(st[p + "PollMs"]) || 3000),
      pollMax: Math.max(1, Number(st[p + "PollMax"]) || 60)
    };
  }

  /* 按 "data.output.url" 这种点路径取值 */
  function pickPath(obj, path) {
    if (!obj || !path) return "";
    var cur = obj;
    var parts = String(path).split(".");
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return "";
      cur = cur[parts[i]];
    }
    return cur == null ? "" : cur;
  }

  /* 结果地址：先按用户填的字段取，取不到再试几套常见命名 */
  function pickJobResult(data, wanted) {
    var tries = [];
    if (wanted) tries.push(wanted);
    tries = tries.concat(["data.url", "url", "output.url", "data.output.url", "result.url",
      "video_url", "audio_url", "data.video_url", "data.audio_url", "data.0.url"]);
    for (var i = 0; i < tries.length; i++) {
      var v = pickPath(data, tries[i]);
      if (typeof v === "string" && v) return v;
      if (v && typeof v === "object" && v.url) return String(v.url);
    }
    return "";
  }

  /* 返回 true=完成 / "fail"=失败 / false=还在跑 */
  function jobState(data) {
    var s = String(pickPath(data, "status") || pickPath(data, "data.status") || "").toLowerCase();
    if (s === "succeeded" || s === "success" || s === "completed" || s === "done") return true;
    if (s === "failed" || s === "error" || s === "cancelled") return "fail";
    var p = Number(pickPath(data, "progress") || pickPath(data, "data.progress"));
    if (p >= 100) return true;
    return false;
  }

  async function runJob(kind, payload, s) {
    var label = kind === "video" ? "视频" : "音乐";
    var c = jobCfg(kind, s);
    if (!c.base || !c.key) throw new Error("没配置" + label + "接口地址或密钥");
    if (!c.createPath) throw new Error("没配置" + label + "的创建任务路径");

    var res = await fetchTimeout(c.base + c.createPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key },
      body: JSON.stringify(payload)
    }, 120000);
    if (!res.ok) throw await httpError(res);
    var created = await res.json();

    /* 少数服务同步就返回结果，不用进轮询 */
    var direct = pickJobResult(created, c.resultField);
    if (direct) return direct;

    var taskId = pickPath(created, "id") || pickPath(created, "data.id") ||
      pickPath(created, "task_id") || pickPath(created, "data.task_id") ||
      pickPath(created, "request_id") || pickPath(created, "data.request_id");
    if (!taskId) throw new Error("提交成功但没拿到任务号：检查接口返回格式，或直接填「结果字段」");
    if (!c.statusPath) throw new Error("没配置查询任务路径，没法等结果");

    var url = c.statusPath.replace("{id}", encodeURIComponent(String(taskId)));
    for (var i = 0; i < c.pollMax; i++) {
      await new Promise(function (r) { setTimeout(r, c.pollMs); });
      var r2 = await fetchTimeout(c.base + url, { method: "GET", headers: { "Authorization": "Bearer " + c.key } }, 60000);
      if (!r2.ok) {
        if (r2.status === 202 || r2.status === 404) continue;   /* 还没好 */
        throw await httpError(r2);
      }
      var st = await r2.json();
      var state = jobState(st);
      if (state === "fail") {
        throw new Error("任务失败：" + (pickPath(st, "error") || pickPath(st, "data.error") || "服务端返回失败"));
      }
      if (state === true) {
        var out = pickJobResult(st, c.resultField);
        if (out) return out;
        throw new Error("任务完成但取不到结果地址：检查「结果字段」");
      }
    }
    throw new Error("等了 " + c.pollMax + " 次还没好（可调大轮询次数，或等服务端出结果）");
  }

  async function makeVideo(prompt, s) {
    var st = s || {};
    var payload = {
      model: jobCfg("video", st).model,
      prompt: String(prompt || ""),
      duration: Number(st.videoDuration) || 5,
      size: st.videoSize || "1280x720",
      mode: st.videoMode || "text2video",
      fps: Number(st.videoFps) || 24,
      ratio: st.videoRatio || "16:9"
    };
    /* 模板：给高级用户直接写整段 JSON，{{prompt}} 会被替换成描述 */
    var tpl = String(st.videoTemplate || "").trim();
    if (tpl) {
      try {
        payload = JSON.parse(tpl.replace(/\{\{prompt\}\}/g, String(payload.prompt).replace(/["\\]/g, "\\$&")));
      } catch (e) { /* 模板写错就用默认拼装，不要因此整条链路失败 */ }
    }
    return runJob("video", payload, st);
  }

  async function makeMusic(prompt, s) {
    var st = s || {};
    var payload = {
      model: jobCfg("music", st).model,
      prompt: String(prompt || ""),
      duration: Number(st.musicDuration) || 30,
      format: st.musicFormat || "mp3"
    };
    if (st.musicWithLyrics) payload.with_lyrics = true;
    var tpl = String(st.musicTemplate || "").trim();
    if (tpl) {
      try {
        payload = JSON.parse(tpl.replace(/\{\{prompt\}\}/g, String(payload.prompt).replace(/["\\]/g, "\\$&")));
      } catch (e) { /* 同上 */ }
    }
    return runJob("music", payload, st);
  }

  /* ── 文档导出：把一条会话整理成 Markdown + HTML，用原生桥写进文件 ──
     完全本地生成，不依赖任何接口。写 .md 方便继续编辑，写 .html 方便直接看排版
     （Word / WPS 都能打开）。没有原生桥时返回 null，由调用方给提示。 */
  function docEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }

  function docDir() {
    var d = "";
    try {
      var S = window.Store;
      if (S && S.hasBridge && S.hasBridge("获取外部文件目录")) d = String(S.callBridge("获取外部文件目录") || "");
      if (!d && S && S.hasBridge && S.hasBridge("获取内部文件目录")) d = String(S.callBridge("获取内部文件目录") || "");
    } catch (e) { d = ""; }
    return d.replace(/\/+$/, "");
  }

  /* 只认纯文本：附件、图片、思考过程都不进文档，避免导出一堆无关内容 */
  function docTextOf(m) {
    if (!m) return "";
    var t = String(m.content || "").trim();
    if (!t) return "";
    return t.replace(/\[\[[^\]]*\]\]/g, "").trim();
  }

  function buildDoc(s, opts) {
    var o = opts || {};
    var msgs = (s && s.messages) || [];
    var title = String((s && s.title) || "对话").trim() || "对话";
    var when = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var stamp = when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate()) +
      " " + pad(when.getHours()) + ":" + pad(when.getMinutes());

    var md = ["# " + title, "", "导出时间：" + stamp, "消息数：" + msgs.length, ""];
    var rows = [];
    msgs.forEach(function (m) {
      if (!m) return;
      if (m.world || m.image || m.imageDesc) return;      /* 剧情卡 / 图片不进正文 */
      var t = docTextOf(m);
      if (!t) return;
      var who = m.role === "user" ? (o.myName || "我") : (o.aiName || "对方");
      md.push("**" + who + "**", "", t, "");
      rows.push('<div class="m ' + (m.role === "user" ? "me" : "ai") + '">' +
        '<div class="who">' + docEsc(who) + '</div>' +
        '<div class="body">' + docEsc(t).replace(/\n/g, "<br>") + "</div></div>");
    });

    var html = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>" + docEsc(title) + "</title><style>" +
      "body{margin:0;padding:24px 18px;background:#f6f6f8;color:#1b1b1f;" +
      "font:16px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans SC',sans-serif}" +
      ".wrap{max-width:760px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}" +
      ".meta{color:#8a8a92;font-size:13px;margin-bottom:22px}" +
      ".m{margin:0 0 16px;padding:12px 14px;border-radius:12px;background:#fff;" +
      "box-shadow:0 1px 3px rgba(0,0,0,.06)}.m.me{background:#eef2ff}" +
      ".who{font-size:12px;color:#6b6b75;margin-bottom:4px}.body{white-space:pre-wrap;word-break:break-word}" +
      "</style></head><body><div class=\"wrap\"><h1>" + docEsc(title) + "</h1>" +
      "<div class=\"meta\">导出时间 " + docEsc(stamp) + " · " + msgs.length + " 条消息</div>" +
      rows.join("") + "</div></body></html>";

    var safe = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "对话";
    var base = "DeepLink_" + safe + "_" + when.getFullYear() + pad(when.getMonth() + 1) + pad(when.getDate()) + "_" + pad(when.getHours()) + pad(when.getMinutes());
    return { md: md.join("\n"), html: html, base: base };
  }

  /* 模型已经改写成文章时的排版：不再逐条拼消息，直接按段落出 */
  function buildArticle(s, o) {
    var when = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var stamp = when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate()) +
      " " + pad(when.getHours()) + ":" + pad(when.getMinutes());
    var title = String((s && s.title) || "回忆").trim() || "回忆";
    var paras = String(o.body || "").split(/\n{2,}/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!paras.length) return buildDoc(s, o);

    var md = ["# " + title, "", "导出时间：" + stamp, ""].concat(paras).join("\n");
    var html = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>" + docEsc(title) + "</title><style>" +
      "body{margin:0;padding:36px 20px;background:#faf9f7;color:#26262b;" +
      "font:17px/1.95 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Serif SC',serif}" +
      ".wrap{max-width:640px;margin:0 auto}h1{font-size:21px;font-weight:600;letter-spacing:.02em;margin:0 0 6px}" +
      ".meta{color:#9a9a9a;font-size:13px;margin-bottom:28px}" +
      "p{margin:0 0 1.35em;text-align:justify}" +
      "</style></head><body><div class=\"wrap\"><h1>" + docEsc(title) + "</h1>" +
      "<div class=\"meta\">" + docEsc(stamp) + "</div>" +
      paras.map(function (p) { return "<p>" + docEsc(p).replace(/\n/g, "<br>") + "</p>"; }).join("") +
      "</div></body></html>";

    var safe = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "回忆";
    var base = "DeepLink_" + safe + "_" + when.getFullYear() + pad(when.getMonth() + 1) + pad(when.getDate()) + "_" + pad(when.getHours()) + pad(when.getMinutes());
    return { md: md, html: html, base: base };
  }

  /* 写盘。返回 { ok, dir, files, reason } —— 没有原生桥时 ok 为 false，调用方提示用户 */
  function exportDoc(s, opts) {
    var o = opts || {};
    /* 有 body（模型改写过的文章）就按文章排，没有就退回逐条消息排版 */
    var doc = o.body ? buildArticle(s, o) : buildDoc(s, o);
    var S = window.Store;
    if (!S || !S.hasBridge || !S.hasBridge("保存指定文件")) {
      return { ok: false, reason: "没有文件写入能力（需要装在封装工具里跑）", doc: doc };
    }
    /* 目录候选统一走 Store（10-23）：外部文件目录 → 内部文件目录，
       再逐个「写完复核」；第一个真能写进去的目录就锁定，两个文件都放它下面。
       以前只取一个目录，且不看写入结果 —— 外部目录不可写时会假报成功。 */
    var dirs = [];
    try { dirs = (S.fileDirs ? S.fileDirs().safe : []).slice(0, 3); } catch (e) { dirs = []; }
    if (!dirs.length) {
      var one = docDir();
      if (one) dirs = [one];
    }
    if (!dirs.length) return { ok: false, reason: "拿不到可写目录", doc: doc };

    var files = [];
    var usedDir = "";
    var put = function (path, text, mime) {
      try {
        var url = "data:" + mime + ";charset=utf-8," + encodeURIComponent(text);
        var r = S.callBridge("保存指定文件", path, url);
        if (r === false) return false;
        if (S.hasBridge("判断指定文件") && S.callBridge("判断指定文件", path) === false) return false;
        files.push(path);
        return true;
      } catch (e) { return false; }
    };
    var okMd = false, okHtml = false;
    for (var i = 0; i < dirs.length && !usedDir; i++) {
      var d = String(dirs[i]).replace(/\/+$/, "");
      if (put(d + "/" + doc.base + ".md", doc.md, "text/markdown")) {
        usedDir = d;
        okMd = true;
        okHtml = put(d + "/" + doc.base + ".html", doc.html, "text/html");
      }
    }
    /* 极端情况：两个都写不进去，但至少报告第一个目录，方便用户去翻 */
    return { ok: okMd || okHtml, dir: usedDir || dirs[0], files: files, doc: doc,
      reason: (okMd || okHtml) ? "" : "写入被拒绝（所有候选目录都写不进去）" };
  }

  /* 给系统提示用：告诉模型哪些多媒体标记可用。
     只在功能真的开启时才列 —— 没配接口却告诉模型「你可以生成视频」，
     它会照写标记，然后用户看到一堆失败的提示。 */
  function promptHint(s) {
    const st = s || {};
    const can = [];
    if (st.videoEnabled && st.videoBaseUrl && st.videoKey) {
      can.push("[[视频]] 一句话描述画面（会在下面生成一段视频）");
    }
    if (st.musicEnabled && st.musicBaseUrl && st.musicKey) {
      can.push("[[音乐]] 一句话描述风格与情绪（会在下面生成一段音乐）");
    }
    if (typeof window.Store !== "undefined" && window.Store && window.Store.hasBridge &&
        window.Store.hasBridge("保存指定文件")) {
      can.push("[[文档]] （把当前这段对话导出成本地文件，不用再写别的）");
    }
    if (!can.length) return "";
    return "【多媒体】需要时你可以单独用一行写下面这些标记，界面会照着去做：" +
      can.join("；") + "。只在用户明确提出时用，一条回复最多各一个；" +
      "写标记的那一行不要跟别的句子混在一起。";
  }

  window.Media = {
    capable,
    baseOf: (kind, s) => cfg(kind, s).base,
    transcribe,
    speak,
    image,
    makeVideo,
    makeMusic,
    exportDoc,
    buildDoc,
    buildArticle,
    promptHint,
    recorder,
    pickMime,
    extOf
  };
})();
