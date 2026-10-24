/* DeepLink —— DeepSeek 对话（SSE 流式 + 思考解析 + 工具调用） */
(function () {
  const MAX_TOOL_ROUNDS = 4;
  /* 有些 OpenAI 兼容端点不认 stream_options（含用量统计），报 400 时自动去掉重试 */
  let streamUsageSupported = true;
  /* 端点认不认 tools：一旦某个 400 明确说是工具的问题，就不再带工具了（只在本进程内记忆） */
  let toolsSupported = true;
  /* 有些 OpenAI 兼容端点不认 thinking / reasoning_effort，会直接 400 —— 去掉重试一次并记住 */
  let thinkingSupported = true;

  const SEARCH_TOOL = {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索最新或需要核实的信息。返回若干网页标题、链接与摘要。当你需要实时信息、事实核查，或用户明确要求联网时调用。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，尽量具体" }
        },
        required: ["query"]
      }
    }
  };

  function endpoint(settings) {
    return String(settings.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "") + "/chat/completions";
  }

  function headers(settings) {
    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + (settings.apiKey || "")
    };
  }

  /* 错误详情里可能带中转端点回显的密钥 / 内部信息 —— 抹掉再抛给界面（详情只留前 300 字） */
  function sanitizeDetail(s) {
    return String(s || "").replace(/sk-[A-Za-z0-9_\-]{6,}/g, "sk-***").slice(0, 300);
  }

  function buildBody(settings, messages, opts) {
    const body = {
      model: settings.model || "deepseek-flash",
      messages,
      stream: true
    };
    if (streamUsageSupported) body.stream_options = { include_usage: true };
    if (typeof settings.temperature === "number") body.temperature = settings.temperature;
    if (typeof settings.topP === "number") body.top_p = settings.topP;

    if (thinkingSupported) {
      if (opts.thinking) {
        body.thinking = { type: "enabled" };
        body.reasoning_effort = opts.effort || "high";
      } else {
        body.thinking = { type: "disabled" };
      }
    }

    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }
    return body;
  }

  function mergeToolCall(acc, deltaCalls) {
    for (const tc of deltaCalls || []) {
      const idx = typeof tc.index === "number" ? tc.index : acc.length;
      if (!acc[idx]) {
        acc[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
      }
      if (tc.id) acc[idx].id = tc.id;
      if (tc.type) acc[idx].type = tc.type;
      const fn = tc.function || {};
      if (fn.name) acc[idx].function.name += fn.name;
      if (fn.arguments) acc[idx].function.arguments += fn.arguments;
    }
  }

  /* 统一用量形状 + 合并（供统计与预警用） */
  function normUsage(u) {
    if (!u) return null;
    const prompt = u.prompt_tokens || 0;
    const completion = u.completion_tokens || 0;
    const cacheHit = u.prompt_cache_hit_tokens || 0;
    const cacheMiss = typeof u.prompt_cache_miss_tokens === "number" ? u.prompt_cache_miss_tokens : Math.max(0, prompt - cacheHit);
    return { prompt, completion, total: u.total_tokens || (prompt + completion), cacheHit, cacheMiss, calls: 1 };
  }
  function sumUsage(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      prompt: a.prompt + b.prompt,
      completion: a.completion + b.completion,
      total: a.total + b.total,
      cacheHit: a.cacheHit + b.cacheHit,
      cacheMiss: a.cacheMiss + b.cacheMiss,
      calls: (a.calls || 0) + (b.calls || 0)
    };
  }

  /* 有些模型（或中转端点）会把**最终回答**也写进 reasoning_content，用行首一个
     「response」当分界：整段思考 + 正文挤在同一个字段里，delta.content 一路为空 ——
     用户看到的就是「只有一个思考框、正文什么都没有」。

     这里在**正文为空**时，把思考里 response 之后的部分提出来当正文。
     三条保守设定，宁可不切也不乱切：
     ① 只有在 content 为空时才切（真有正文就绝不碰）；
     ② 只认行首的 response（可选冒号/空白），后面必须直接跟内容；
     ③ 后面不能是字母（避免误伤 "responses" 之类）。
     英文思考里行首裸写 response 几乎不自然（正常会带 the），所以误判面很小。 */
  const RESP_SPLIT = /(?:^|\n)[ \t]*response(?![a-zA-Z])[ \t]*[:：]?[ \t\r\n]*(?=\S)/i;
  function splitReasoning(content, reasoning) {
    const keep = { content: content || "", reasoning: reasoning || "", split: false };
    if (String(content || "").trim()) return keep;
    const r = String(reasoning || "");
    const m = RESP_SPLIT.exec(r);
    if (!m) return keep;
    const head = r.slice(0, m.index).replace(/\s+$/, "");
    const tail = r.slice(m.index + m[0].length).trim();
    if (!tail) return keep;
    return { content: tail, reasoning: head, split: true };
  }

  /* 一次流式请求 */
  async function streamOnce(settings, messages, opts, cb, signal) {
    const res = await fetchRetry(endpoint(settings), {
      method: "POST",
      headers: headers(settings),
      body: JSON.stringify(buildBody(settings, messages, opts)),
      signal
    });

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 500); } catch (e) { /* ignore */ }
      if (res.status === 400 && streamUsageSupported && /stream_option|include_usage/i.test(detail)) {
        streamUsageSupported = false;
        return streamOnce(settings, messages, opts, cb, signal);
      }
      /* 有些 OpenAI 兼容端点不认 thinking / reasoning_effort，也会直接 400 ——
         去掉它重试一次，并记住（thinkingSupported），免得后续每次请求都先失败一遍。 */
      /* 端点不认 tools / tool_choice（老模型、部分国内中转）也会 400。
         去掉工具重试一次并记下来 —— 否则「让角色读自己的线」这个默认开关
         会直接让所有对话发不出去。 */
      if (res.status === 400 && toolsSupported && opts.tools && opts.tools.length &&
          /tool|function|tool_choice/i.test(detail)) {
        toolsSupported = false;
        return streamOnce(settings, messages, Object.assign({}, opts, { tools: [] }), cb, signal);
      }
      if (res.status === 400 && thinkingSupported && opts.thinking && /thinking|reasoning_effort/i.test(detail)) {
        thinkingSupported = false;
        return streamOnce(settings, messages, opts, cb, signal);
      }
      const err = new Error("请求失败 HTTP " + res.status + (detail ? "：" + sanitizeDetail(detail) : ""));
      err.status = res.status;
      throw err;
    }
    if (!res.body || !res.body.getReader) {
      throw new Error("当前环境不支持流式读取（res.body 为空）");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let content = "";
    let reasoning = "";
    const toolCalls = [];
    let finishReason = null;
    let usage = null;

    /* 读一段带空闲上限：服务端吊住连接（不发数据也不关）时 reader.read() 会永远挂着，
       界面就永久停在「生成中」，只能杀进程。每次读自己带一个 60 秒的计时器，读到就清掉——
       不共用全局 interval，省得异常路径上漏清理。 */
    function readWithTimeout(ms) {
      let t = 0;
      return Promise.race([
        reader.read(),
        new Promise((_, rej) => {
          t = setTimeout(() => {
            /* 超时不能只 reject：那条连接还挂着，主动 cancel 让服务端知道我们走了，
               也顺带让挂起的 read() 结束，不留一个永不 settle 的 promise。 */
            try { reader.cancel(); } catch (e) { /* ignore */ }
            rej(new Error("连接超时（" + Math.round(ms / 1000) + " 秒没有收到数据）"));
          }, ms);
        })
      ]).then((r) => { clearTimeout(t); return r; },
        (e) => { clearTimeout(t); throw e; });
    }

    let streamDone = false;
    while (!streamDone) {
      const { value, done } = await readWithTimeout(60000);
      if (done) {
        /* 收尾：解码器里剩下的字节、以及最后一行可能没有换行 —— 都得再走一遍解析。
           以前 done 就 break，末尾那几个 delta（常见于收尾包）会被直接丢掉。 */
        buffer += decoder.decode();
        if (buffer.trim() && buffer.slice(-1) !== "\n") buffer += "\n";
        streamDone = true;
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let json;
        try { json = JSON.parse(payload); } catch (e) { continue; }
        /* 不少兼容端点用 200 + {"error":{...}} 报限额 / 参数错。
           以前只读 usage 和 choices，于是这种响应表现成「空回答」，真实原因全丢。 */
        if (json && json.error) {
          const em = json.error.message || json.error.msg || json.error.type || json.error;
          throw new Error("接口返回错误：" + String(em).slice(0, 200));
        }
        if (json.usage) usage = json.usage;
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};

        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          if (cb.onReasoning) cb.onReasoning(delta.reasoning_content);
        }
        if (delta.content) {
          content += delta.content;
          if (cb.onContent) cb.onContent(delta.content);
        }
        if (delta.tool_calls) {
          mergeToolCall(toolCalls, delta.tool_calls);
        }
      }
    }

    return { content, reasoning, toolCalls: toolCalls.filter(Boolean), finishReason, usage };
  }

  /* 视觉模型：启用了独立视觉模型时才覆盖，且**逐字段**覆盖 ——
     地址/密钥/模型哪一项留空，那一项就自动嫁接到主模型。

     「模型兼容」开关（settings.mainCompat）打开时直接返回主模型设置：
     那代表主模型自己就是多模态，看图一律走它，视觉区那套配置不参与。 */
  function visionSettings(settings) {
    const s = Object.assign({}, settings);
    if (settings.mainCompat) return s;
    if (!settings.visionEnabled) return s;
    const base = String(settings.visionBaseUrl || "").trim();
    const key = String(settings.visionKey || "").trim();
    const model = String(settings.visionModel || "").trim();
    if (base) s.baseUrl = base;
    if (key) s.apiKey = key;
    if (model) s.model = model;
    return s;
  }

  const Api = {
    visionSettings: visionSettings,
    splitReasoning: splitReasoning,
    SEARCH_TOOL,
    normUsage,
    sumUsage,

    /* 压缩/摘要：一次非流式调用，返回正文与用量 */
    async summarize(settings, messages, opts) {
      const o = opts || {};
      const body = {
        model: settings.model || "deepseek-flash",
        messages,
        stream: false,
        thinking: { type: "disabled" }
      };
      if (o.maxTokens) body.max_tokens = o.maxTokens;
      const res = await fetchWithTimeout(endpoint(settings), {
        method: "POST",
        headers: headers(settings),
        body: JSON.stringify(body)
      }, 90000);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 500); } catch (e) { /* ignore */ }
        const err = new Error("请求失败 HTTP " + res.status + (detail ? "：" + sanitizeDetail(detail) : ""));
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      return {
        text: (choice && choice.message && choice.message.content) || "",
        usage: normUsage(data.usage),
        /* 截断判据：长任务（世界生成 / 记忆压缩）靠它知道自己被长度上限切了 */
        finishReason: (choice && choice.finish_reason) || ""
      };
    },

    /* 图片转文字：一次性描述调用。imageUrl 传的是「能直接用的地址」——
       可能是内联 dataUrl，也可能是从文件引用解出来的 dataUrl（见 Store.imageURL）。
       默认用主模型；配了独立视觉模型（且填了对应字段）就改用视觉模型，
       没填的字段自动嫁接到主模型。 */
    async describe(settings, imageUrl, maxTokens) {
      const v = visionSettings(settings);
      const body = {
        model: v.model || "deepseek-flash",
        stream: false,
        thinking: { type: "disabled" },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "用简洁中文描述这张图片：主体、场景、可见文字、以及值得记住的关键细节。只输出描述正文，不要客套。" },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }]
      };
      if (maxTokens) body.max_tokens = maxTokens;
      const res = await fetchWithTimeout(endpoint(v), { method: "POST", headers: headers(v), body: JSON.stringify(body) }, 90000);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
        const err = new Error("请求失败 HTTP " + res.status + (detail ? "：" + sanitizeDetail(detail) : ""));
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      return {
        text: (choice && choice.message && choice.message.content) || "",
        usage: normUsage(data.usage),
        /* 截断判据：长任务（世界生成 / 记忆压缩）靠它知道自己被长度上限切了 */
        finishReason: (choice && choice.finish_reason) || ""
      };
    },

    /* 完整对话（含搜索工具循环） */
    async run(params, cb) {
      const settings = params.settings;
      const messages = params.messages.slice();
      /* 工具清单（10-23）：联网搜索 + 调用方额外给的（比如「读自己的线」）。
         两套可以同时开：模型自己决定调哪个。 */
      const tools = [].concat(params.search ? [SEARCH_TOOL] : [], params.extraTools || []);
      const sources = [];
      let content = "";
      let reasoning = "";
      let rounds = 0;
      let usage = null;
      let finishReason = null;

      while (rounds < MAX_TOOL_ROUNDS) {
        rounds += 1;
        let roundContent = "";
        let roundReasoning = "";

        const step = await streamOnce(
          settings,
          messages,
          { thinking: params.thinking, effort: params.effort, tools },
          {
            onContent: (t) => { roundContent += t; if (cb.onContent) cb.onContent(t); },
            onReasoning: (t) => { roundReasoning += t; if (cb.onReasoning) cb.onReasoning(t); }
          },
          params.signal
        );

        content += roundContent;
        reasoning += roundReasoning;
        usage = sumUsage(usage, normUsage(step.usage));
        /* 只认最后一轮的结束原因：它才是「这一轮回答有没有被截断」的答案。
           思考模式下 finish_reason=length 很常见，且正文往往是空的 —— 上层据此提示用户。 */
        if (step.finishReason) finishReason = step.finishReason;

        const calls = step.toolCalls || [];
        const wantsTool = calls.length > 0;

        if (!wantsTool) break;

        messages.push({
          role: "assistant",
          content: step.content || "",
          tool_calls: calls
        });

        for (const call of calls) {
          const fnName = (call.function && call.function.name) || "";
          let argsObj = {};
          try { argsObj = JSON.parse((call.function && call.function.arguments) || "{}") || {}; }
          catch (e) { argsObj = {}; }
          let query = String(argsObj.query || "").trim();

          if (cb.onToolCall) cb.onToolCall(fnName, query);

          let resultText = "";
          /* 不是搜索工具 → 交给调用方注册的执行器（本项目的 tools.js）。
             执行器抛错只影响这一条工具结果，不进上层错误分支 ——
             读不到资料不该让整条回复变成「发送失败」。 */
          if (params.runTool && fnName !== SEARCH_TOOL.function.name) {
            try {
              resultText = String(await params.runTool(fnName, argsObj) || "");
            } catch (e) {
              resultText = "读取失败：" + (e && e.message ? e.message : "未知错误");
            }
            if (!resultText) resultText = "（没有读到内容）";
          } else if (query && params.search) {
            try {
              const out = await params.search(query);
              (out.results || []).forEach((r) => sources.push(r));
              resultText = window.Search.formatForModel(query, out.provider, out.results);
              if (cb.onSearchDone) cb.onSearchDone(query, out.provider, out.results);
            } catch (e) {
              resultText = "搜索失败：" + (e && e.message ? e.message : "未知错误");
              if (cb.onSearchDone) cb.onSearchDone(query, "失败", []);
            }
          } else {
            resultText = "未获得搜索结果。";
          }
          /* 上面两条路都可能已经写过 resultText，这里不再覆盖 */

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: resultText
          });
        }
      }

      return { content, reasoning, sources, usage, finishReason };
    },

    /* 连接自检：一次最小非流式请求 */
    async ping(settings) {
      const res = await fetchWithTimeout(endpoint(settings), {
        method: "POST",
        headers: headers(settings),
        body: JSON.stringify({
          model: settings.model || "deepseek-flash",
          messages: [{ role: "user", content: "回复：ok" }],
          thinking: { type: "disabled" },
          max_tokens: 8,
          stream: false
        })
      }, 90000);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
        throw new Error("HTTP " + res.status + (detail ? "：" + detail : ""));
      }
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      return {
        model: data.model || settings.model,
        reply: (choice && choice.message && choice.message.content) || ""
      };
    }
  };

  /* 明明有网却「Failed to fetch」：安卓 WebView 偶发把连接掐掉时就是这句。
     它同时也是「被跨域拦截」的文案，光看文字分不出来 —— 但重试一次是无害的：
     真被跨域拦还是照样失败（只多花一次空请求），是网络波动就能自愈。
     用户主动点停止抛的是 AbortError，不在这个名单里，绝不会被重试。 */
  function isNetErr(e) {
    return /Failed to fetch|NetworkError|Load failed|Network request failed|net::ERR/i.test(String((e && e.message) || e));
  }
  async function fetchRetry(url, init) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (!isNetErr(e)) throw e;
      await new Promise((r) => setTimeout(r, 600));
      return await fetch(url, init);
    }
  }
  /* 带超时的请求：摘要 / 看图 / 连接自检 这三个后台调用以前没有超时，
     弱网或接口不响应时 Promise 永不 settle —— 界面卡在「正在压缩…」，
     连带发送、日更整条链路都被堵住。默认 90 秒（长文本摘要一般 20~40 秒）。 */
  async function fetchWithTimeout(url, init, ms) {
    const c = new AbortController();
    const t = setTimeout(function () { try { c.abort(); } catch (e) { /* ignore */ } }, ms || 90000);
    try {
      return await fetchRetry(url, Object.assign({}, init, { signal: c.signal }));
    } finally {
      clearTimeout(t);
    }
  }

  window.Api = Api;
})();
