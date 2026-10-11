/* roleplay.js —— 角色扮演 / 上下文筛选 / 会话设置表单 / 上线补压
 * 从 app.js 拆出（见 HANDOFF.md 4.9 拆分计划）。
 *
 * 为什么这么写：
 *  - 本文件在 index.html 里排在 app.js 之后 —— 执行时 window.DL 一定已存在。
 *  - 搬运时【没有改函数体】，只在下面把 DL 里的同名成员解构成局部变量，
 *    所以搬过来的代码与在 app.js 里逐字一致。
 *  - 末尾自注册并登记 window.__dlScripts（连接自检的「附加脚本」会显示）。
 *
 * 本文件不新增依赖、不改行为、不动版号。
 */
(function () {
  /* 打包工具不一定按 index.html 的顺序执行脚本：app.js 可能晚于本文件。
     那时 window.DL 还不存在 —— 等它就绪后再初始化一次。返回 false = 还没就绪。 */
  function boot() {
  var D = window.DL;
  if (!D) return false;

  /* 共享件解构（名字与 app.js 内保持一致，保证搬来的代码不用改一个字）。
     这些都是 app.js 的 window.DL 在初始化时就一次性备齐的（D 一旦存在，这些键就都在），
     所以可以直接取值 —— 它们不是「别的子模块提供的入口」，不存在晚到的问题。 */
  var $ = D.$, $v = D.$v, state = D.state, setText = D.setText, setVal = D.setVal;
  var setHidden = D.setHidden, setDisabled = D.setDisabled, setDisplay = D.setDisplay;
  var setChecked = D.setChecked, checkedOf = D.checkedOf;
  var session = D.session, agentId = D.agentId, activeCharacter = D.activeCharacter, characterFor = D.characterFor;
  var saveSession = D.saveSession;
  var newSession = D.newSession, renderAll = D.renderAll;
  var avatarDraft = D.avatarDraft, renderAvatarPreview = D.renderAvatarPreview;
  /* recordUsage / renderCharUsage / renderBackupLine 在阶段④被搬进了 settings.js，
     而 settings.js 排在 roleplay.js 之后加载 —— 所以它们不能在这里快照，见下面 syncModules。 */

  /* ⚠️ 下面这些【不在加载时快照】：它们是「模块」或「别的子模块提供的入口」。
     打包工具不一定按 index.html 的顺序执行脚本；若相关文件排在本文件之后执行，
     快照会把它永久钉死在 undefined，而且【不报错】（真机踩过：发消息报
     Cannot read property 'run' of undefined）。改成进公开入口时重取一次。 */
  var UI, Store, Memory, Files, Media, Search, Api, CONFIG, exitSelect;
  var recordUsage, renderCharUsage, renderBackupLine;
  function syncModules() {
    UI = D.UI || window.UI;
    Store = D.Store || window.Store;
    Memory = D.Memory || window.Memory;
    Files = D.Files || window.Files;
    Media = D.Media || window.Media;
    Search = D.Search || window.Search;
    Api = D.Api || window.Api;
    CONFIG = D.CONFIG || window.CONFIG;
    exitSelect = D.exitSelect || window.exitSelect;
    recordUsage = D.recordUsage || window.recordUsage;
    renderCharUsage = D.renderCharUsage || window.renderCharUsage;
    renderBackupLine = D.renderBackupLine || window.renderBackupLine;
  }
  syncModules();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncModules);
  else setTimeout(syncModules, 0);

  function saveChar(ch) {
    const list = Store.getCharacters();
    const i = list.findIndex((c) => c.id === ch.id);
    if (i < 0) return;
    /* 只合并角色档案字段，保留列表里最新的 usage（避免与用量记录互相覆盖） */
    list[i] = Object.assign({}, list[i], {
      name: ch.name,
      avatar: ch.avatar,
      fields: ch.fields,
      ctxFilter: ch.ctxFilter,
      updatedAt: Date.now()
    });
    Store.saveCharacters(list);
  }

  /* ── 角色扮演 ──────────────────────────────────── */
  const CHAR_FIELDS = [
    ["myName", "我的名称", "text"],
    ["aiCallMe", "你对我的称呼", "text"],
    ["aiName", "你的名称", "text"],
    ["age", "当前年龄", "text"],
    ["myPersona", "我的性格", "textarea"],
    ["myAppearance", "我的外貌", "textarea"],
    ["myBackground", "我的背景", "textarea"],
    ["myLikes", "我的喜好", "textarea"],
    ["aiPersona", "你的性格", "textarea"],
    ["aiAppearance", "你的外貌", "textarea"],
    ["aiBackground", "你的背景", "textarea"],
    ["aiLikes", "你的喜好", "textarea"],
    ["aiStyle", "你的说话风格", "textarea"],
    ["world", "世界观", "textarea"],
    ["shared", "共同经历（初始）", "textarea"],
    ["relation", "当前关系（初始）", "textarea"],
    ["aiDirective", "AI 指令（单独对 AI 说的注意事项）", "textarea"]
  ];

  function buildCharForm() {
    const box = $("#charForm");
    if (!box || box.dataset.built) return;
    box.dataset.built = "1";
    CHAR_FIELDS.forEach(([key, label, type]) => {
      const l = document.createElement("label");
      l.className = "field";
      const sp = document.createElement("span");
      sp.textContent = label;
      const input = type === "textarea" ? document.createElement("textarea") : document.createElement("input");
      if (type === "textarea") input.rows = 2; else input.type = "text";
      input.id = "cf_" + key;
      l.appendChild(sp);
      l.appendChild(input);
      box.appendChild(l);
    });
  }

  function renderCharBar() {
    const bar = $("#charBar");
    if (!bar) return;
    if (!state.settings.roleplayEnabled) { bar.hidden = true; bar.innerHTML = ""; return; }
    bar.hidden = false;
    bar.innerHTML = "";
    const chip = (id, name, avatar, active) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "char-chip" + (active ? " on" : "");
      const av = document.createElement("span");
      av.className = "c-av";
      if (avatar) { const im = document.createElement("img"); im.src = avatar; av.appendChild(im); }
      else av.innerHTML = UI.iconSvg(id ? "account" : "creation");
      const nm = document.createElement("span");
      nm.className = "c-nm";
      nm.textContent = name;
      b.appendChild(av); b.appendChild(nm);
      b.addEventListener("click", () => pickAgent(id));
      return b;
    };
    const aid = agentId();
    bar.appendChild(chip("", "助手", state.settings.avatarAi || "", aid === ""));
    Store.getCharacters().slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).forEach((c) => bar.appendChild(chip(c.id, c.name || "角色", c.avatar || "", aid === c.id)));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "char-chip add";
    add.innerHTML = UI.iconSvg("plus") + "<span>新角色</span>";
    add.addEventListener("click", newCharacter);
    bar.appendChild(add);
  }

  function pickAgent(id) {
    state.settings = Store.saveSettings({ roleplayEnabled: true, activeCharacterId: id });
    exitSelect();
    const list = Store.getSessions().filter((s) => (s.characterId || "") === (id || ""));
    state.sessionId = list[0] ? list[0].id : "";
    if (!state.sessionId) { newSession(); return; }
    Store.setCurrentId(state.sessionId);
    renderAll();
  }

  function renderCharList() {
    const box = $("#charList");
    if (!box) return;
    box.innerHTML = "";
    const item = (id, name, avatar, pinned) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "char-item" + ((state.settings.activeCharacterId || "") === id ? " active" : "");
      const av = document.createElement("span");
      av.className = "c-av";
      if (avatar) { const im = document.createElement("img"); im.src = avatar; av.appendChild(im); }
      else av.innerHTML = UI.iconSvg(id ? "account" : "creation");
      const nm = document.createElement("span");
      nm.className = "c-name";
      nm.textContent = name;
      b.appendChild(av); b.appendChild(nm);
      if (pinned) {
        const pb = document.createElement("span");
        pb.className = "c-pin";
        pb.innerHTML = UI.iconSvg("pin");
        pb.title = "已置顶";
        b.appendChild(pb);
      }
      if (id) {
        const del = document.createElement("span");
        del.className = "c-del";
        del.innerHTML = UI.iconSvg("close");
        del.title = "删除角色";
        del.addEventListener("click", (e) => { e.stopPropagation(); removeCharacter(id); });
        b.appendChild(del);
      }
      let cLpTimer = null, cLpFired = false;
      const cLpEnd = () => { if (cLpTimer) { clearTimeout(cLpTimer); cLpTimer = null; } };
      b.addEventListener("touchstart", () => { cLpFired = false; cLpTimer = setTimeout(() => { cLpFired = true; openRowMenu("char", id); }, 480); }, { passive: true });
      b.addEventListener("touchmove", cLpEnd, { passive: true });
      b.addEventListener("touchend", (e) => { cLpEnd(); if (cLpFired) { e.preventDefault(); cLpFired = false; } }, { passive: false });
      b.addEventListener("click", () => {
        if (cLpFired) { cLpFired = false; return; }
        state.settings = Store.saveSettings({ roleplayEnabled: true, activeCharacterId: id });
        /* 切角色必须同时切换当前会话与重渲染，否则侧栏/主视图会与当前角色对不上 */
        const list = Store.getSessions().filter((s) => (s.characterId || "") === id);
        state.sessionId = list[0] ? list[0].id : "";
        if (state.sessionId) Store.setCurrentId(state.sessionId);
        renderCharList();
        fillCharacterForm(activeCharacter());
        renderAll();
      });
      return b;
    };
    box.appendChild(item("", "助手（无角色卡）", state.settings.avatarAi || "", false));
    Store.getCharacters().slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).forEach((c) => box.appendChild(item(c.id, c.name || "角色", c.avatar || "", c.pinned)));
  }

  function rowArray(kind) { return kind === "char" ? Store.getCharacters() : Store.getSessions(); }

  function saveRowArray(kind) { if (kind === "char") Store.saveCharacters(Store.getCharacters()); else Store.saveSessions(Store.getSessions()); }

  /* 上移/下移只在【同一个可见分组】里找相邻项。
     【判据②：会不会和其他功能冲突】会话列表是按当前角色过滤后再渲染的，
       全局数组里别的角色的会话是「看不见的」；不跳过它们，就会出现
       「点了几次上移，界面上毫无反应」——因为跟一个看不见的项换了位。
     visible 传 null 时行为与旧版完全一致（角色列表用得到）。 */
  function moveInList(arr, i, dir, visible) {
    if (i < 0) return false;
    const pinned = !!arr[i].pinned;
    let j = i + dir;
    while (j >= 0 && j < arr.length && (!!arr[j].pinned !== pinned || (visible && !visible(arr[j])))) j += dir;
    if (j < 0 || j >= arr.length) return false;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    return true;
  }

  function setRowPinned(kind, id, v) {
    const item = rowArray(kind).find((x) => x.id === id);
    if (!item) return;
    item.pinned = !!v;
    saveRowArray(kind);
    afterRowChange(kind);
  }

  function moveRow(kind, id, dir) {
    const arr = rowArray(kind);
    const cur = arr.find((x) => x.id === id);
    if (!cur) return;
    /* 会话只跟【同角色】的相邻项交换（列表按角色过滤显示，别的角色项看不见）；
       角色列表不做过滤，visible 传 null。见 moveInList 注释。 */
    const cid = cur.characterId || "";
    const visible = kind === "char" ? null : (x) => ((x.characterId || "") === cid);
    if (!moveInList(arr, arr.findIndex((x) => x.id === id), dir, visible)) return;
    saveRowArray(kind);
    afterRowChange(kind);
  }

  function afterRowChange(kind) {
    if (kind === "char") { renderCharList(); renderCharBar(); }
    renderAll();
  }

  function openRowMenu(kind, id) {
    const item = rowArray(kind).find((x) => x.id === id);
    if (!item) return;
    const isChar = kind === "char";
    setText("#rowMenuTitle", isChar ? (item.name || "角色") : (item.title || "对话"));
    const box = $("#rowMenuList");
    if (!box) return;
    box.innerHTML = "";
    const actions = [
      item.pinned
        ? { name: "unpin", icon: "pin-off", label: "取消置顶", run: () => setRowPinned(kind, id, false) }
        : { name: "pin", icon: "pin", label: "置顶", run: () => setRowPinned(kind, id, true) },
      { name: "up", icon: "arrow-up", label: "上移", run: () => moveRow(kind, id, -1) },
      { name: "down", icon: "arrow-down", label: "下移", run: () => moveRow(kind, id, 1) }
    ];
    actions.forEach((a) => {
      const b = UI.actionBtn(a.name, a.icon, a.label, "menu-btn");
      b.addEventListener("click", () => { UI.closeModal("rowMenuModal"); a.run(); });
      box.appendChild(b);
    });
    UI.openModal("rowMenuModal");
  }

  function memLines(mem, cognition) {
    const out = [];
    if (cognition && cognition.trim()) out.push(["对我的认知", cognition.trim()]);
    if (mem) {
      if (mem.core) out.push(["精华", mem.core]);
      (mem.months || []).forEach((x) => out.push(["月 · " + (x.key || ""), x.summary]));
      (mem.weeks || []).forEach((x) => out.push(["周 · " + (x.key || ""), x.summary]));
      (mem.days || []).forEach((x) => out.push([x.date || "", x.summary]));
    }
    return out;
  }

  function memHtml(mem, cognition, emptyText) {
    const lines = memLines(mem, cognition);
    if (!lines.length) return '<p class="hint">' + (emptyText || "还没有记忆，聊一阵子后会自动压出 日/周/月 摘要。") + "</p>";
    return lines.map(([k, v]) => '<div class="mem-item"><div class="mem-k">' + UI.escapeHtml(k) + '</div><div class="mem-v">' + UI.escapeHtml(v) + "</div></div>").join("");
  }

  function memSessionHtml(s) {
    const mem = Memory.ensureMemory(s);
    const lines = memLines(mem, s.cognition);
    const title = UI.escapeHtml(s.title || "未命名") + (s.mainLine ? " · 主线" : "");
    return '<details class="mem-session"' + (s.mainLine ? " open" : "") + "><summary>" + title + "</summary>" + (lines.length ? memHtml(mem, s.cognition) : '<p class="hint">还没有记忆。</p>') + "</details>";
  }

  function renderSessionMemory() {
    const el = $("#sessionMemoryBox");
    if (!el) return;
    const s = session();
    /* 这里只铺「记忆摘要」：认知在正上方有独立输入框，再塞进来就是同段文字看两遍。
       （角色弹窗 / 设置里的总览没有独立认知框，那两处仍带认知。） */
    el.innerHTML = s ? memHtml(Memory.ensureMemory(s), null) : "";
  }

  function renderCharMemory() {
    const el = $("#charMemoryBox");
    if (!el) return;
    const ch = activeCharacter();
    if (!ch) { el.innerHTML = ""; return; }
    const mine = Store.getSessions().filter((s) => (s.characterId || "") === ch.id);
    el.innerHTML = mine.length ? mine.map((s) => memSessionHtml(s)).join("") : '<p class="hint">这个角色还没有对话。</p>';
  }

  function renderSettingsMemory() {
    const box = $("#setMemoryList");
    if (!box) return;
    const sessions = Store.getSessions();
    const blocks = [];
    Store.getCharacters().forEach((c) => {
      const mine = sessions.filter((s) => (s.characterId || "") === c.id);
      blocks.push('<div class="mem-block"><div class="mem-title">' + UI.escapeHtml(c.name || "角色") + "</div>" + (mine.length ? mine.map((s) => memSessionHtml(s)).join("") : '<p class="hint">（还没有对话）</p>') + "</div>");
    });
    const asst = sessions.filter((s) => !(s.characterId || ""));
    if (asst.length) blocks.push('<div class="mem-block"><div class="mem-title">助手（无角色卡）</div>' + asst.map((s) => memSessionHtml(s)).join("") + "</div>");
    box.innerHTML = blocks.length ? blocks.join("") : '<p class="hint">还没有角色或对话。</p>';
  }

  function resetCharSplit() {
    setVal("#charSplitInput", "");
    setText("#charSplitState", "");
    setHidden("#charSplitHint", true);
    setHidden("#charSplitPanel", true);
  }

  async function runCharSplit() {
    const ch = activeCharacter();
    if (!ch) { UI.toast("请先选择或新建一个角色", true); return; }
    const raw = $v("#charSplitInput").trim();
    if (!raw) { UI.toast("先把你想写的都写进来", true); return; }
    if (!state.settings.apiKey) { UI.toast("先去设置里填 API Key", true); return; }
    setDisabled("#charSplitRun", true);
    setText("#charSplitState", "AI 正在拆分…");
    try {
      const fields = [{ key: "charName", label: "角色名（用于列表显示）", current: $v("#charName") }]
        .concat(CHAR_FIELDS.map(([key, label]) => ({ key: key, label: label, current: $v("#cf_" + key) })));
      const r = await Memory.splitCharacterFields(state.settings, raw, fields);
      if (r.usage) recordUsage(null, r.usage, ch.id);
      let n = 0;
      if (typeof r.fields.charName === "string" && r.fields.charName.trim()) { setVal("#charName", r.fields.charName.trim()); n++; }
      CHAR_FIELDS.forEach(([key]) => {
        const v = r.fields[key];
        if (typeof v === "string" && v.trim()) { setVal("#cf_" + key, v.trim()); n++; }
      });
      setText("#charSplitState", n ? ("已填入 " + n + " 项，检查/修改后点「保存设定」") : "没拆出可用内容，写具体一点再试");
    } catch (e) {
      setText("#charSplitState", "拆分失败：" + (e.message || e));
    } finally {
      setDisabled("#charSplitRun", false);
    }
  }

  function fillCharacterForm(ch) {
    try {
      resetCharSplit();
      const has = !!ch;
      setDisplay("#charForm", has ? "" : "none");
      setDisplay("#charEmpty", has ? "none" : "");
      setDisplay("#charTools", has ? "" : "none");
      if (ch) {
        setVal("#charName", ch.name || "");
        CHAR_FIELDS.forEach(([key]) => setVal("#cf_" + key, (ch.fields && ch.fields[key]) || ""));
        const cf = Memory.ensureFilter(ch);
        setVal("#charFilterRule", cf.rule || "");
        setVal("#charFilterEvery", cf.every || 10);
      }
      renderCharUsage(ch);
      renderFilterState(ch);
      renderCharMemory();
    } catch (e) { console.warn("[DeepLink] fillCharacterForm 出错", e); }
  }

  function readCharacterForm() {
    const fields = {};
    CHAR_FIELDS.forEach(([key]) => { fields[key] = $v("#cf_" + key); });
    return { name: $v("#charName").trim() || "未命名角色", fields };
  }

  function saveCharacter() {
    const ch = activeCharacter();
    if (!ch) { UI.toast("请先选择或新建一个角色", true); return; }
    const form = readCharacterForm();
    ch.name = form.name;
    ch.fields = form.fields;
    const cf = Memory.ensureFilter(ch);
    cf.rule = $v("#charFilterRule").trim();
    cf.every = readFilterEvery();
    saveChar(ch);
    UI.toast("角色已保存");
    renderCharList();
    renderCharBar();
    const s = session();
    if (s && (s.characterId || "") === ch.id) renderAll();
  }

  async function updateCognitionNow() {
    const s = session();
    if (!s || !(s.characterId || "")) { UI.toast("认知只属于角色扮演对话", true); return; }
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    const m = Memory.ensureMemory(s);
    const extra = [Memory.memoryText(m), Memory.recentTranscript(s.messages, m.coveredUntil, 40)].filter(Boolean).join("\n");
    if (!extra.trim()) { UI.toast("还没有可参考的对话或记忆，先聊几句再试", true); return; }
    s.cognition = $v("#setSessionCognition");
    UI.toast("正在更新认知…");
    try {
      const usage = await Memory.updateCognition(s, saveSession, state.settings, extra);
      await Store.memReady();
      if (usage) recordUsage(null, usage, s.characterId);
      fillSessionForm(session());
      UI.toast("认知已更新");
    } catch (e) {
      UI.toast("更新认知失败：" + (e.message || e), true);
    }
  }

  async function updateRelationSharedNow() {
    const s = session();
    if (!s || !(s.characterId || "")) { UI.toast("关系与经历只属于角色扮演对话", true); return; }
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    const m = Memory.ensureMemory(s);
    const extra = [Memory.memoryText(m), Memory.recentTranscript(s.messages, m.coveredUntil, 40)].filter(Boolean).join("\n");
    if (!extra.trim()) { UI.toast("还没有可参考的对话或记忆，先聊几句再试", true); return; }
    const ch = characterFor(s);
    const base = ch ? { relation: (ch.fields && ch.fields.relation) || "", shared: (ch.fields && ch.fields.shared) || "" } : null;
    UI.toast("正在更新关系与经历…");
    try {
      const r = await Memory.updateRelationShared(s, saveSession, state.settings, base, extra);
      await Store.memReady();
      if (r && r.usage) recordUsage(null, r.usage, s.characterId);
      fillSessionForm(session());
      /* 以前无论更新到没有都报「已更新」，只更新一半也报成功，用户以为是玄学。
         现在按实际拿到的字段说实话。 */
      if (!r || !r.changed) UI.toast("没能读出可用的关系/经历，稍后再点一次", true);
      else if (r.relation && r.shared) UI.toast("关系与经历已更新");
      else if (r.relation) UI.toast("这次只更新到「关系」，「经历」再点一次", true);
      else UI.toast("这次只更新到「经历」，「关系」再点一次", true);
    } catch (e) {
      UI.toast("更新失败：" + (e.message || e), true);
    }
  }

  function newCharacter() {
    const now = Date.now();
    const c = {
      id: "c_" + now.toString(36) + Math.random().toString(36).slice(2, 6),
      name: "新角色",
      avatar: "",
      fields: {},
      ctxFilter: { rule: "", every: 10 },
      usage: null,
      pinned: false,
      createdAt: now,
      updatedAt: now
    };
    const list = Store.getCharacters();
    list.push(c);
    Store.saveCharacters(list);
    state.settings = Store.saveSettings({ roleplayEnabled: true, activeCharacterId: c.id });
    openCharacterModal();
    const existing = Store.getSessions().filter((s) => (s.characterId || "") === c.id);
    if (!existing.length) newSession();
    UI.toast("已新建角色，填好「当前设定」后开始对话");
  }

  async function removeCharacter(id) {
    if (!id) { UI.toast("助手不能删除", true); return; }
    const ch = Store.getCharacters().find((c) => c.id === id);
    if (!ch) return;
    const ok = await UI.confirmDialog("删除角色", "删除角色「" + (ch.name || "") + "」及其「对我的认知」档案？该角色的对话会归到助手名下（记录保留）。");
    if (!ok) return;
    Store.saveCharacters(Store.getCharacters().filter((c) => c.id !== id));
    const all = Store.getSessions();
    all.forEach((s) => { if ((s.characterId || "") === id) s.characterId = ""; });
    Store.saveSessions(all);
    if ((state.settings.activeCharacterId || "") === id) state.settings = Store.saveSettings({ activeCharacterId: "" });
    renderCharList();
    fillCharacterForm(activeCharacter());
    renderCharBar();
    renderAll();
  }

  async function runMemoryCorrect() {
    const s = session();
    if (!s || !(s.characterId || "")) { UI.toast("记忆纠偏只作用于角色扮演对话", true); return; }
    const txt = $v("#sessionCorrectInput").trim();
    if (!txt) { UI.toast("先写下要纠正或补充的内容", true); return; }
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    setDisabled("#sessionCorrectRun", true);
    UI.toast("AI 正在纠正记忆…");
    try {
      const r = await Memory.correctMemory(s, txt, saveSession, state.settings);
      await Store.memReady();
      if (r.usage) recordUsage(null, r.usage, s.characterId);
      if (!r.changed) { UI.toast("没读出可用的记忆，换个说法再试", true); return; }
      setVal("#sessionCorrectInput", "");
      fillSessionForm(session());
      UI.toast("记忆已纠正");
    } catch (e) {
      UI.toast("纠偏失败：" + (e.message || e), true);
    } finally {
      setDisabled("#sessionCorrectRun", false);
    }
  }

  async function runReCompress() {
    const s = session();
    if (!s || !(s.characterId || "")) { UI.toast("再压缩只作用于角色扮演对话", true); return; }
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    UI.toast("正在提纯记忆…");
    try {
      /* 【判据①：作用要与承诺一致】reCompress 现在返回 { ok, usage }：
         模型没给出摘要时 ok=false，此刻记忆【一点没动】—— 这时不能报「已再压缩」骗人。 */
      const r = await Memory.reCompress(s, saveSession, state.settings);
      await Store.memReady();
      if (r && r.usage) recordUsage(null, r.usage, s.characterId);   /* 这轮 token 确实花了，照记 */
      fillSessionForm(session());
      if (!r || !r.ok) { UI.toast("再压缩没成功：模型没有返回摘要，记忆保持原样，稍后再试", true); return; }
      UI.toast("已再压缩，上下文已提纯");
    } catch (e) {
      UI.toast("再压缩失败：" + (e.message || e), true);
    }
  }

  /* ── 上下文筛选（只影响“角色读取端”，聊天记录不变）──────── */
  function readFilterEvery() {
    const n = Number($v("#charFilterEvery"));
    return (isFinite(n) && n >= 1) ? Math.floor(n) : 10;
  }

  function renderFilterState(ch) {
    const el = $("#charFilterState");
    if (!el) return;
    const cf = ch && ch.ctxFilter;
    if (!cf || !cf.rule) { el.textContent = "未设置筛选规则。"; return; }
    const s = session();
    const n = (s && s.ctxWash && Array.isArray(s.ctxWash.turns)) ? s.ctxWash.turns.length : 0;
    el.textContent = "规则已设置（每 " + (cf.every || 10) + " 轮自动洗一次）；当前对话已精简 " + n + " 轮。";
  }

  async function washSession(s, ch, silent) {
    if (!state.settings.apiKey) { if (!silent) UI.toast("请先在「设置」里填写 API Key", true); return null; }
    const cf = Memory.ensureFilter(ch);
    if (!cf.rule) { if (!silent) UI.toast("先写筛选规则", true); return null; }
    if (!silent) UI.toast("正在按规则精简近期对话…");
    const res = await Memory.applyFilter(s, cf.rule, saveSession, state.settings);
    if (res && res.usage) recordUsage(null, res.usage, ch.id);
    return res;
  }

  async function washFilterNow() {
    const ch = activeCharacter();
    if (!ch) { UI.toast("先选一个角色", true); return; }
    const cf = Memory.ensureFilter(ch);
    cf.rule = $v("#charFilterRule").trim();
    cf.every = readFilterEvery();
    if (!cf.rule) { UI.toast("先写筛选规则", true); return; }
    saveChar(ch);
    const s = session();
    if (!s || (s.characterId || "") !== ch.id) { UI.toast("请先切到该角色的对话再洗", true); return; }
    try {
      const res = await washSession(s, ch, false);
      if (res && res.ok) { UI.toast("已精简 " + res.count + " 轮近期对话"); renderFilterState(ch); }
      else if (res && res.reason === "empty") UI.toast("暂无可筛选的近期对话", true);
    } catch (e) { UI.toast("筛选失败：" + (e.message || e), true); }
  }

  async function aiFilterRule() {
    const ch = activeCharacter();
    if (!ch) { UI.toast("先选一个角色", true); return; }
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    const draft = $v("#charFilterRule").trim();
    if (!draft) { UI.toast("先写一句你想排除什么，再点 AI 筛选", true); return; }
    UI.toast("AI 正在整理规则…");
    try {
      const out = await Memory.generateFilterRule(state.settings, draft);
      if (out.usage) recordUsage(null, out.usage, ch.id);
      const rule = (out.text || "").trim() || draft;
      setVal("#charFilterRule", rule);
      const ok = await UI.confirmDialog("AI 筛选规则", "AI 理解为：\n\n" + rule + "\n\n采用并立即按它精简近期对话？");
      if (!ok) { UI.toast("已填入规则框，可修改后点「按规则洗一次」"); return; }
      const cf = Memory.ensureFilter(ch);
      cf.rule = rule;
      cf.every = readFilterEvery();
      saveChar(ch);
      const s = session();
      if (!s || (s.characterId || "") !== ch.id) { UI.toast("规则已保存；请切到该角色的对话再洗", true); return; }
      const res = await washSession(s, ch, true);
      if (res && res.ok) { UI.toast("已采用规则并精简 " + res.count + " 轮"); renderFilterState(ch); }
      else if (res && res.reason === "empty") UI.toast("规则已保存，但暂无可筛选的近期对话");
    } catch (e) { UI.toast("AI 筛选失败：" + (e.message || e), true); }
  }

  function maybeAutoWash(s, ch) {
    try {
      const cf = Memory.ensureFilter(ch);
      if (!cf.rule) return;
      const every = cf.every >= 1 ? cf.every : 10;
      const cw = s.ctxWash || {};
      const since = Math.max((s.memory && s.memory.coveredUntil) || 0, cw.washedUntil || 0);
      let n = 0;
      (s.messages || []).forEach((m) => { if (m.role === "user" && m.ts && m.ts > since) n += 1; });
      if (n >= every) {
        const notify = !!state.settings.notifyTasks;
        if (notify) UI.toast("正在按规则自动精简近期对话…");
        washSession(s, ch, true).then((res) => {
          if (notify && res && res.ok) UI.toast("自动筛选完成（精简 " + res.count + " 轮）");
        }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }

  let sceneBusy = false;
  function maybeAutoScene(s, ch) {
    try {
      if (sceneBusy) return;
      const every = (s.sceneEvery >= 1) ? s.sceneEvery : 10;
      const since = s.sceneAt || 0;
      let n = 0;
      (s.messages || []).forEach((m) => { if (m.role === "user" && m.ts && m.ts > since) n += 1; });
      if (n < every) return;
      const last = (s.messages || []).filter((m) => m.ts).slice(-1)[0];
      const upto = last ? last.ts : Date.now();
      const notify = !!state.settings.notifyTasks;
      if (notify) UI.toast("正在更新当前场景…");
      sceneBusy = true;
      Memory.updateScene(s, saveSession, state.settings, since).then((usage) => {
        if (usage) recordUsage(null, usage, s.characterId || "");
        s.sceneAt = upto;
        saveSession();
        if (notify) UI.toast("当前场景已更新");
      }).catch(() => {}).finally(() => { sceneBusy = false; });
    } catch (e) { sceneBusy = false; }
  }

  function openCharacterModal() {
    buildCharForm();
    renderCharList();
    fillCharacterForm(activeCharacter());
    UI.openModal("characterModal");
  }

  /* ── 上线补压：久未上线则以天为单位补压历史 ─────── */
  function todayStr() {
    const d = new Date();
    const p = (n) => (n < 10 ? "0" : "") + n;
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function maybeAutoCompress() {
    if (!state.settings.apiKey) return;
    const today = todayStr();
    if (state.settings.lastActiveDate === today) return;
    state.settings = Store.saveSettings({ lastActiveDate: today });
    const tasks = [];
    const chars = Store.getCharacters();
    Store.getSessions().forEach((sess) => {
      const isRoleplay = !!(sess.characterId || "");
      if (!isRoleplay && !state.settings.assistantCompress) return;
      const ch = isRoleplay ? chars.find((c) => c.id === sess.characterId) : null;
      const seed = ch ? { relation: (ch.fields && ch.fields.relation) || "", shared: (ch.fields && ch.fields.shared) || "" } : null;
      tasks.push(async () => {
        try {
          const res = await Memory.runCompression(sess, saveSession, state.settings, { cognition: isRoleplay, seed: seed }, null);
          if (res && res.usage) recordUsage(null, res.usage, sess.characterId || "");
          return res ? res.days : 0;
        } catch (e) { console.warn("[DeepLink] 会话压缩失败", sess.id, e); return 0; }
      });
    });
    if (!tasks.length) return;
    setTimeout(async () => {
      const notify = !!state.settings.notifyTasks;
      if (notify) UI.toast("正在整理历史记忆…");
      let days = 0;
      for (const t of tasks) { try { days += (await t()) || 0; } catch (e) { /* ignore */ } }
      if (notify) UI.toast(days > 0 ? ("记忆压缩完成（" + days + " 天，含认知更新）") : "记忆已是最新");
    }, 2000);
  }

  /* ── 会话设置表单 ──────────────────────────────── */
  function syncSessionParamFields() {
    const follow = checkedOf("#setSessionFollow");
    setDisabled("#setSessionTemperature", follow);
    setDisabled("#setSessionTopP", follow);
    setText("#setSessionTempVal", Number($v("#setSessionTemperature")).toFixed(2));
    setText("#setSessionTopPVal", Number($v("#setSessionTopP")).toFixed(2));
  }

  function fillSessionForm(s) {
    try { fillSessionFormInner(s); } catch (e) { console.warn("[DeepLink] fillSessionForm 出错", e); }
  }

  function fillSessionFormInner(s) {
    setVal("#setSessionTitle", s ? (s.title || "") : "");
    setVal("#setSessionAlias", s ? (s.alias || "") : "");
    setVal("#setSessionPrompt", s ? (s.systemPrompt || "") : "");
    avatarDraft.sessionUser = s ? (s.avatarUser || "") : "";
    avatarDraft.sessionAi = s ? (s.avatarAi || "") : "";
    renderAvatarPreview("#setSessionAvatarUserPreview", avatarDraft.sessionUser, "user", state.settings.avatarUser);
    renderAvatarPreview("#setSessionAvatarAiPreview", avatarDraft.sessionAi, "assistant", state.settings.avatarAi);
    const hasOwn = !!(s && (typeof s.temperature === "number" || typeof s.topP === "number"));
    setChecked("#setSessionFollow", !hasOwn);
    setVal("#setSessionTemperature", (s && typeof s.temperature === "number") ? s.temperature : state.settings.temperature);
    setVal("#setSessionTopP", (s && typeof s.topP === "number") ? s.topP : state.settings.topP);
    const role = !!(s && (s.characterId || ""));
    setDisplay("#sessionRoleWrap", role ? "" : "none");
    if (role) {
      setVal("#setSessionScene", s.scene || "");
      setVal("#setSessionSceneEvery", (s.sceneEvery >= 1) ? s.sceneEvery : 10);
      setVal("#setSessionRelation", s.relation || "");
      setVal("#setSessionShared", s.shared || "");
      setVal("#setSessionCognition", s.cognition || "");
      setChecked("#setSessionAutoBackup", !!s.autoBackup);
      setText("#sessionLineBadge", s.mainLine ? "主线" : "支线");
      renderBackupLine(s);
      renderSessionMemory();
    }
    syncSessionParamFields();
  }

  /* ── 自注册：把 app.js / chat.js 仍要用的入口挂到 window.DL ───────
     写法与 chat.js 一致：app.js 里保留同名的「转发壳」（只转发、不实现），
     运行时再转到这里来。⚠️ 这里挂的名字，app.js 的 window.DL 字面量里不能再写一遍，
     否则会转发到它自己、无限递归。

     外面套一层只为在每次进入公开入口前重取一遍模块（syncModules）——
     打包工具若不按 index.html 顺序执行脚本，这是唯一能兜住「模块晚到」的地方。 */
  var api = {
    saveChar: saveChar, renderCharBar: renderCharBar, openRowMenu: openRowMenu,
    renderSettingsMemory: renderSettingsMemory, runCharSplit: runCharSplit,
    fillCharacterForm: fillCharacterForm, saveCharacter: saveCharacter,
    newCharacter: newCharacter, updateCognitionNow: updateCognitionNow,
    updateRelationSharedNow: updateRelationSharedNow,
    runMemoryCorrect: runMemoryCorrect, runReCompress: runReCompress,
    washFilterNow: washFilterNow, aiFilterRule: aiFilterRule,
    maybeAutoWash: maybeAutoWash, maybeAutoScene: maybeAutoScene, openCharacterModal: openCharacterModal,
    maybeAutoCompress: maybeAutoCompress,
    syncSessionParamFields: syncSessionParamFields, fillSessionForm: fillSessionForm
  };
  Object.keys(api).forEach(function (k) {
    D[k] = function () { syncModules(); return api[k].apply(null, arguments); };
  });

  window.__dlScripts.push("roleplay.js");
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
