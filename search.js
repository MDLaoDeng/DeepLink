/* Sekulum —— 可插拔联网搜索（免 Key 优先） */
(function () {
  function withTimeout(ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, done: () => clearTimeout(timer) };
  }

  /* signal：调用方的取消信号（用户点「停止」）。
     Chrome 83 没有 AbortSignal.any，这里手工并两个信号：任一触发就中断。
     收尾时两个监听都要摘掉，否则反复搜索会一直累积监听。 */
  async function fetchJson(url, options, timeoutMs, signal) {
    const ms = timeoutMs || 12000;
    const t = withTimeout(ms);
    let ctl = null, onTimeout = null, onOuter = null;
    const stop = function () { try { ctl.abort(); } catch (e) { /* ignore */ } };
    const outerOk = signal && typeof signal.addEventListener === "function";
    if (outerOk) {
      ctl = new AbortController();
      onTimeout = stop;
      onOuter = stop;
      t.signal.addEventListener("abort", onTimeout);
      if (signal.aborted) stop();
      else signal.addEventListener("abort", onOuter);
    }
    const useSignal = ctl ? ctl.signal : t.signal;
    try {
      const res = await fetch(url, Object.assign({ signal: useSignal }, options || {}));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err) {
      /* M4：AbortError 有两个来源，必须分开 ——
         · 用户点停止 → 保持 AbortError，上层按「已停止」静默处理
         · 自己超时   → 改名 TimeoutError，上层要如实报错，别冒充用户操作 */
      if (err && err.name === "AbortError" && !(signal && signal.aborted)) {
        const te = new Error("请求超时（" + Math.round(ms / 1000) + " 秒）");
        te.name = "TimeoutError";
        throw te;
      }
      throw err;
    } finally {
      t.done();
      if (ctl) {
        try { t.signal.removeEventListener("abort", onTimeout); } catch (e) { /* ignore */ }
        try { signal.removeEventListener("abort", onOuter); } catch (e) { /* ignore */ }
      }
    }
  }

  function stripTags(html) {
    return String(html || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  }

  function clean(results) {
    return (results || [])
      .filter((r) => r && r.url && /^https?:\/\//i.test(r.url))
      .slice(0, 6)
      .map((r) => ({
        title: stripTags(r.title) || r.url,
        url: r.url,
        snippet: (r.snippet || "").slice(0, 400)
      }));
  }

  /* 并发竞速：取第一个有结果的；全部失败才 reject */
  function firstWithResults(tasks) {
    return new Promise((resolve, reject) => {
      let pending = tasks.length;
      let lastErr = null;
      let settled = false;
      if (!pending) return reject(new Error("没有可用的搜索源"));
      tasks.forEach((task) => {
        Promise.resolve(task).then((results) => {
          if (settled) return;
          if (results && results.length) { settled = true; resolve(results); return; }
          if (--pending === 0) { settled = true; reject(lastErr || new Error("没有搜索结果")); }
        }).catch((err) => {
          if (settled) return;
          lastErr = err;
          if (--pending === 0) { settled = true; reject(lastErr); }
        });
      });
    });
  }

  /* 优先序竞速：各源并行发出，在窗口内按 tasks 顺序择优；全失败才 reject */
  function racePrefer(tasks, windowMs) {
    return new Promise((resolve, reject) => {
      const got = [];
      const order = tasks.map((t) => t.name);
      let pending = tasks.length;
      let settled = false;
      let lastErr = null;
      let timer = null;

      if (!pending) return reject(new Error("没有可用的搜索源"));

      function best() {
        return got.slice().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))[0];
      }
      function maybeSettle(final) {
        if (settled) return;
        if (got.length) { settled = true; clearTimeout(timer); resolve(best()); return; }
        if (final) { settled = true; clearTimeout(timer); reject(lastErr || new Error("没有搜索结果")); }
      }

      timer = setTimeout(() => maybeSettle(false), windowMs);
      tasks.forEach(({ name, promise }) => {
        Promise.resolve(promise).then((results) => {
          if (settled) return;
          if (results && results.length) got.push({ name, results });
          if (--pending === 0) maybeSettle(true);
        }).catch((err) => {
          if (settled) return;
          lastErr = err;
          if (--pending === 0) maybeSettle(true);
        });
      });
    });
  }

  function searxng(query, settings, signal) {
    const list = String(settings.searxngInstances || "")
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const tasks = list.map((base) => {
      const url = base.replace(/\/+$/, "") +
        "/search?format=json&safesearch=0&language=zh-CN&q=" + encodeURIComponent(query);
      return fetchJson(url, { method: "GET" }, 8000, signal).then((data) =>
        clean((data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })))
      );
    });
    return firstWithResults(tasks);
  }

  async function duckduckgo(query, signal) {
    const url = "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" +
      encodeURIComponent(query);
    const data = await fetchJson(url, { method: "GET" }, 10000, signal);
    const out = [];
    if (data.AbstractText && data.AbstractURL) {
      out.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText });
    }
    (data.RelatedTopics || []).forEach(function walk(t) {
      if (!t) return;
      if (Array.isArray(t.Topics)) return t.Topics.forEach(walk);
      if (t.FirstURL && t.Text) out.push({ title: t.Text.split(" - ")[0], url: t.FirstURL, snippet: t.Text });
    });
    return clean(out);
  }

  async function wikipedia(query, signal) {
    const url = "https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*" +
      "&srlimit=5&srsearch=" + encodeURIComponent(query);
    const data = await fetchJson(url, { method: "GET" }, 10000, signal);
    const hits = (data.query && data.query.search) || [];
    return clean(hits.map((h) => ({
      title: h.title,
      url: "https://zh.wikipedia.org/wiki/" + encodeURIComponent(h.title.replace(/ /g, "_")),
      snippet: stripTags(h.snippet)
    })));
  }

  async function tavily(query, settings, signal) {
    if (!settings.tavilyKey) throw new Error("未配置 Tavily Key");
    const data = await fetchJson("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + settings.tavilyKey
      },
      body: JSON.stringify({ query, max_results: 6, search_depth: "basic" })
    }, 15000, signal);
    return clean((data.results || []).map((r) => ({
      title: r.title, url: r.url, snippet: r.content
    })));
  }

  function pickItems(data) {
    if (Array.isArray(data)) return data;
    for (const key of ["results", "items", "data", "hits", "list"]) {
      if (data && Array.isArray(data[key])) return data[key];
    }
    if (data && data.data && Array.isArray(data.data.results)) return data.data.results;
    return [];
  }

  async function custom(query, settings, signal) {
    if (!settings.customSearchUrl) throw new Error("未配置自定义搜索接口");
    const url = settings.customSearchUrl.replace(/\{query\}/g, encodeURIComponent(query));
    const headers = {};
    if (settings.customSearchKey) headers["Authorization"] = "Bearer " + settings.customSearchKey;
    const data = await fetchJson(url, { method: "GET", headers }, 15000, signal);
    return clean(pickItems(data).map((r) => ({
      title: r.title || r.name,
      url: r.url || r.link || r.href,
      snippet: r.snippet || r.content || r.description || r.text || ""
    })));
  }

  /* DeepSeek 自家搜索（2026-10-17 上线的 /v1/tools/search）。
     用主模型那套 baseUrl + apiKey，不用额外填 Key —— 这是它比 Tavily 省事的地方。
     计费：每次 0.005 元，**只有返回非空结果才收钱**，失败和空结果免费。
     结果里带 summary（600~800 字，本来就是写给模型看的），拿它当 snippet
     比那 100 字的 description 有用得多。 */
  async function deepseek(query, settings, signal) {
    const key = String(settings.apiKey || "");
    if (!key) throw new Error("主模型没有 API Key，用不了 DeepSeek 搜索");
    const root = String(settings.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
    if (!/deepseek\.com/i.test(root)) throw new Error("主模型不是 DeepSeek，接不了它的搜索");
    const data = await fetchJson(root + "/v1/tools/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ query: String(query || "").slice(0, 128), count: 6, need_content: false })
    }, 20000, signal);
    const rows = clean((data.results || []).map((r) => ({
      title: r.title || r.site_name || "",
      url: r.url,
      snippet: r.summary || r.description || r.content || ""
    })));
    if (rows.length) return rows;
    /* 老接口没给结果 —— 走官方兼容通道再试一次 */
    return await deepseekViaMessages(query, settings, signal);
  }
  /* 官方通道：Anthropic 兼容 Messages + web_search_20250305 服务端工具。
     返回结构是 content 块数组：text 块是答案，web_search_tool_result 里才是来源。
     每次搜索等于一次完整模型轮次（官方没有单独的检索端点），所以只在老路失败时才走它。 */
  async function deepseekViaMessages(query, settings, signal) {
    const key = String(settings.apiKey || "");
    const root = String(settings.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
    if (!key || !/deepseek\.com/i.test(root)) throw new Error("主模型不是 DeepSeek，用不了这条通道");
    const model = String(settings.searchModel || settings.model || "deepseek-flash");
    const data = await fetchJson(root + "/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: String(query || "") + "\n\n请先联网检索最新信息，再给结论；如果检索不到就说检索不到。" }]
      })
    }, 90000, signal);
    const blocks = data.content || [];
    const out = [];
    blocks.forEach(function (b) {
      if (!b) return;
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        b.content.forEach(function (r) {
          if (!r || r.type !== "web_search_result") return;
          out.push({
            title: r.title || r.url || "",
            url: r.url || "",
            snippet: String(r.cited_text || r.page_age || "").slice(0, 400)
          });
        });
      }
    });
    /* 顺序很重要（10-19 修）：clean() 要求 url 必须是 http，
       所以「只拿到答案、没拿到来源块」那条会被它整条滤掉 —— 而那正是兜底要保的东西。
       因此先做正常清洗，清洗完是空，再把答案正文作为最后一条结果带回去。 */
    const rows = clean(out);
    if (rows.length) return rows;
    const text = blocks.filter(function (b) { return b && b.type === "text"; })
      .map(function (b) { return String(b.text || ""); }).join("\n").trim();
    return text ? [{ title: "DeepSeek 联网答复", url: "", snippet: text.slice(0, 400) }] : [];
  }

  function deepseekReady(settings) {
    return !!String(settings.apiKey || "") && /deepseek\.com/i.test(String(settings.baseUrl || ""));
  }

  const Search = {
    /* 返回 { provider, results:[{title,url,snippet}] } */
    async search(query, settings, signal) {
      const mode = settings.searchProvider || "auto";

      if (mode === "off") return { provider: "off", results: [] };

      if (mode === "deepseek") {
        return { provider: "DeepSeek", results: await deepseek(query, settings, signal) };
      }
      if (mode === "tavily") {
        return { provider: "Tavily", results: await tavily(query, settings, signal) };
      }
      if (mode === "custom") {
        return { provider: "自定义", results: await custom(query, settings) };
      }

      /* auto：主模型就是 DeepSeek 时**先走它自己的搜索** —— 质量比免费源稳、带长摘要，
         代价是每次 0.005 元。失败或没结果再往下面的免费源退，用户永远拿得到东西。 */
      let lastErr = null;
      if (deepseekReady(settings)) {
        try {
          const results = await deepseek(query, settings, signal);
          if (results.length) return { provider: "DeepSeek", results };
        } catch (e) { lastErr = e; }
      }

      // 免 Key 源并行，按 SearXNG > DuckDuckGo > Wikipedia 优先级择优
      try {
        const hit = await racePrefer([
          { name: "SearXNG", promise: searxng(query, settings, signal) },
          { name: "DuckDuckGo", promise: duckduckgo(query, signal) },
          { name: "Wikipedia", promise: wikipedia(query, signal) }
        ], 650);
        if (hit.results.length) return { provider: hit.name, results: hit.results };
      } catch (e) { lastErr = e; }

      if (settings.tavilyKey) {
        try {
          const results = await tavily(query, settings, signal);
          if (results.length) return { provider: "Tavily", results };
        } catch (e) { lastErr = e; }
      }

      if (lastErr) throw lastErr;
      return { provider: "none", results: [] };
    },

    formatForModel(query, provider, results) {
      if (!results.length) return "搜索“" + query + "”未获得有效结果。";
      const lines = results.map((r, i) =>
        "[" + (i + 1) + "] " + r.title + "\n    " + r.url + "\n    " + r.snippet
      );
      return "以下是关于“" + query + "”的联网搜索结果（来源：" + provider + "）：\n\n" +
        lines.join("\n\n");
    }
  };

  window.Search = Search;
})();
