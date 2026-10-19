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
    vision: { enabled: "visionEnabled", base: "visionBaseUrl", key: "visionKey", model: "visionModel" }
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
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

  window.Media = {
    capable,
    baseOf: (kind, s) => cfg(kind, s).base,
    transcribe,
    speak,
    image,
    recorder,
    pickMime,
    extOf
  };
})();
