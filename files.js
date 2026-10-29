/* Sekulum —— 文件与图片读取 */
(function () {
  const MAX_TEXT = 60000;
  const IMAGE_MAX_SIDE = 1600;

  const TEXT_EXT = [
    "txt", "md", "markdown", "json", "csv", "tsv", "log", "xml", "yml", "yaml",
    "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "kt",
    "py", "rb", "go", "rs", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bat",
    "ini", "conf", "env", "sql", "toml", "vue", "svelte", "swift", "dart"
  ];

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  function isImage(file) {
    return /^image\//.test(file.type) || ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(extOf(file.name));
  }

  function isText(file) {
    return /^text\//.test(file.type) || TEXT_EXT.includes(extOf(file.name)) ||
      file.type === "application/json";
  }

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(fr.error || new Error("读取失败"));
      fr.readAsText(file);
    });
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(fr.error || new Error("读取失败"));
      fr.readAsDataURL(file);
    });
  }

  function shrink(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const max = Math.max(img.width, img.height);
        if (max <= IMAGE_MAX_SIDE) return resolve(dataUrl);
        const scale = IMAGE_MAX_SIDE / max;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        /* 按原图类型选编码（10-29 修）：JPEG 没有 alpha，`toDataURL("image/jpeg")`
           会把透明像素合成为黑色 —— 贴纸、带透明边的立绘一放大就变黑块，
           而同一条消息里小于 1600px 的同款图却是正常的（走的是上面那条原样返回）。 */
        try {
          const src = String(dataUrl || "");
          const keepAlpha = src.indexOf("data:image/png") === 0 ||
            src.indexOf("data:image/webp") === 0 ||
            src.indexOf("data:image/gif") === 0;
          resolve(keepAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85));
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  const Files = {
    humanSize,
    kindOf(file) {
      if (isImage(file)) return "image";
      if (isText(file)) return "text";
      return "unsupported";
    },

    async read(file) {
      const kind = this.kindOf(file);
      if (kind === "image") {
        const raw = await readAsDataUrl(file);
        const dataUrl = await shrink(raw);
        return { name: file.name, kind: "image", size: file.size, dataUrl, mime: file.type || "image/png" };
      }
      if (kind === "text") {
        let text = await readAsText(file);
        let truncated = false;
        if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
        return { name: file.name, kind: "text", size: file.size, text, truncated };
      }
      throw new Error("暂不支持的文件类型：" + (file.name || "未知"));
    },

    /* 把附件转成发给模型的 content 片段。
       opts.inlineImage === false：图片不内联（主模型是纯文字模型时），改用文字描述。
       描述由 chat.js 在发送前先跑一遍（ensureImageDescriptions）——
       所以正常情况下走到这里时 a.desc 已经在了；万一没描述成功，就留一句说明。 */
    async toMessageParts(attachments, opts) {
      const o = opts || {};
      const inlineImage = o.inlineImage !== false;
      const parts = [];
      const notes = [];
      for (const a of attachments || []) {
        if (a.kind === "image") {
          /* 图片可能存成内联 dataUrl，也可能存成文件引用（imgRef）——统一问 Store 要地址 */
          const url = inlineImage ? Store.imageURL(a) : "";
          if (url) parts.push({ type: "image_url", image_url: { url: url } });
          else if (a.desc) notes.push("【图片" + (a.name ? "：" + a.name : "") + "（以下为图片的文字描述）】\n" + a.desc);
          else notes.push("【用户发来一张图片" + (a.name ? "：" + a.name : "") + "，但当前没有可用的文字描述】");
        } else if (a.kind === "text") {
          notes.push(
            "【文件：" + a.name + (a.truncated ? "（内容过长，已截断）" : "") + "】\n```\n" + a.text + "\n```"
          );
        }
      }
      return { parts, notes };
    }
  };

  window.Files = Files;
})();
