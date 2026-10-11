/* DeepLink —— 扩展模型适配器：语音转文字 / 语音合成 / 文生图
   三类都按 OpenAI 兼容格式实现；地址与密钥留空时沿用主模型配置。 */
(function () {
  const SPEC = {
    asr: { enabled: "asrEnabled", base: "asrBaseUrl", key: "asrKey", model: "asrModel" },
    tts: { enabled: "ttsEnabled", base: "ttsBaseUrl", key: "ttsKey", model: "ttsModel" },
    img: { enabled: "imgEnabled", base: "imgBaseUrl", key: "imgKey", model: "imgModel" }
  };

  function cfg(kind, s) {
    const k = SPEC[kind];
    return {
      enabled: !!s[k.enabled],
      base: String(s[k.base] || s.baseUrl || "").replace(/\/+$/, ""),
      key: String(s[k.key] || s.apiKey || ""),
      /* 模型名留空同样嫁接到主模型（与设置页里那句说明一致） */
      model: String(s[k.model] || s.model || "")
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

  async function transcribe(blob, s, filename) {
    const c = cfg("asr", s);
    if (!c.base || !c.key) throw new Error("未配置语音转写接口地址或密钥");
    const form = new FormData();
    form.append("file", blob, filename || "audio.webm");
    form.append("model", c.model);
    if (s.asrLang) form.append("language", s.asrLang);
    const res = await fetch(c.base + "/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + c.key },
      body: form
    });
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    const text = String(data.text || (data.data && data.data.text) || "").trim();
    if (!text) throw new Error("转写结果为空");
    return text;
  }

  async function speak(text, s) {
    const c = cfg("tts", s);
    if (!c.base || !c.key) throw new Error("未配置语音合成接口地址或密钥");
    const res = await fetch(c.base + "/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key },
      body: JSON.stringify({ model: c.model, input: text, voice: s.ttsVoice || "FunAudioLLM/CosyVoice2-0.5B:alex" })
    });
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

  async function image(prompt, s) {
    const c = cfg("img", s);
    if (!c.base || !c.key) throw new Error("未配置文生图接口地址或密钥");
    const res = await fetch(c.base + "/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key },
      body: JSON.stringify({ model: c.model, prompt, n: 1, size: s.imgSize || "1024x1024" })
    });
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    const first = (data.data && data.data[0]) || (data.images && data.images[0]) || data;
    if (typeof first === "string") return first;
    if (first.b64_json || first.b64) return "data:image/png;base64," + (first.b64_json || first.b64);
    if (first.url) return first.url;
    throw new Error("文生图返回格式无法识别（既没有 b64_json 也没有 url）");
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
