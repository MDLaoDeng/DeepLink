/* DeepLink —— 可插拔联网搜索（免 Key 优先） */
(function () {
  function withTimeout(ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, done: () => clearTimeout(timer) };
  }

  async function fetchJson(url, options, timeoutMs) {
    const t = withTimeout(timeoutMs || 12000);
    try {
      const res = await fetch(url, Object.assign({ signal: t.signal }, options || {}));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      t.done();
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

  function searxng(query, settings) {
    const list = String(settings.searxngInstances || "")
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const tasks = list.map((base) => {
      const url = base.replace(/\/+$/, "") +
        "/search?format=json&safesearch=0&language=zh-CN&q=" + encodeURIComponent(query);
      return fetchJson(url, { method: "GET" }, 8000).then((data) =>
        clean((data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })))
      );
    });
    return firstWithResults(tasks);
  }

  async function duckduckgo(query) {
    const url = "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" +
      encodeURIComponent(query);
    const data = await fetchJson(url, { method: "GET" }, 10000);
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

  async function wikipedia(query) {
    const url = "https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*" +
      "&srlimit=5&srsearch=" + encodeURIComponent(query);
    const data = await fetchJson(url, { method: "GET" }, 10000);
    const hits = (data.query && data.query.search) || [];
    return clean(hits.map((h) => ({
      title: h.title,
      url: "https://zh.wikipedia.org/wiki/" + encodeURIComponent(h.title.replace(/ /g, "_")),
      snippet: stripTags(h.snippet)
    })));
  }

  async function tavily(query, settings) {
    if (!settings.tavilyKey) throw new Error("未配置 Tavily Key");
    const data = await fetchJson("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + settings.tavilyKey
      },
      body: JSON.stringify({ query, max_results: 6, search_depth: "basic" })
    }, 15000);
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

  async function custom(query, settings) {
    if (!settings.customSearchUrl) throw new Error("未配置自定义搜索接口");
    const url = settings.customSearchUrl.replace(/\{query\}/g, encodeURIComponent(query));
    const headers = {};
    if (settings.customSearchKey) headers["Authorization"] = "Bearer " + settings.customSearchKey;
    const data = await fetchJson(url, { method: "GET", headers }, 15000);
    return clean(pickItems(data).map((r) => ({
      title: r.title || r.name,
      url: r.url || r.link || r.href,
      snippet: r.snippet || r.content || r.description || r.text || ""
    })));
  }

  const Search = {
    /* 返回 { provider, results:[{title,url,snippet}] } */
    async search(query, settings) {
      const mode = settings.searchProvider || "auto";

      if (mode === "off") return { provider: "off", results: [] };

      if (mode === "tavily") {
        return { provider: "Tavily", results: await tavily(query, settings) };
      }
      if (mode === "custom") {
        return { provider: "自定义", results: await custom(query, settings) };
      }

      // auto：免 Key 源并行，按 SearXNG > DuckDuckGo > Wikipedia 优先级择优
      let lastErr = null;
      try {
        const hit = await racePrefer([
          { name: "SearXNG", promise: searxng(query, settings) },
          { name: "DuckDuckGo", promise: duckduckgo(query) },
          { name: "Wikipedia", promise: wikipedia(query) }
        ], 650);
        if (hit.results.length) return { provider: hit.name, results: hit.results };
      } catch (e) { lastErr = e; }

      if (settings.tavilyKey) {
        try {
          const results = await tavily(query, settings);
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
