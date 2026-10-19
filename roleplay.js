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
  var booted = false;  /* boot 幂等：DOMContentLoaded 与补拍 retry 各会调一次，别重复绑事件 / 分裂状态 */
  function boot() {
    if (booted) return true;
  var D = window.DL;
  if (!D) return false;
  booted = true;   /* 已真正初始化过，后续再被调用直接返回 */

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
  var readAvatarFile = D.readAvatarFile, genAvatarByAi = D.genAvatarByAi;
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
    ["age", "你的当前年龄（填数字，时间系统要用）", "text"],
    ["birth", "你的出生日期（时间系统用它算合法时段）", "date"],
    ["aiGender", "你的性别（男 / 女 / 其他，其他可自填；没写就按整套设定推断）", "text"],
    ["myPersona", "我的性格", "textarea"],
    ["myAppearance", "我的外貌", "textarea"],
    ["myBackground", "我的背景", "textarea"],
    ["myLikes", "我的喜好", "textarea"],
    ["aiPersona", "你的性格", "textarea"],
    ["aiAppearance", "你的外貌", "textarea"],
    ["aiBackground", "你的背景", "textarea"],
    ["aiLikes", "你的喜好", "textarea"],
    ["aiHealth", "你的身体状况（健康状况、身高体重、体型三围等，越详尽越好）", "textarea"],
    ["myHealth", "我的身体状况（健康状况、身高体重、体型三围等，越详尽越好）", "textarea"],
    ["aiPeriod", "你的生理期（女性填上次第一天，格式 2026-10-01；没填按 28 天规律推一个）", "date"],
    ["aiStyle", "你的说话风格", "textarea"],
    ["world", "世界观", "textarea"],
    ["shared", "共同经历（初始）", "textarea"],
    ["relation", "当前关系（初始）", "textarea"],
    ["aiDirective", "AI 指令（单独对 AI 说的注意事项）", "textarea"]
  ];

  /* 「关于我（你）」的字段：勾了「只拆角色相关」时这几栏**不交给 AI、也不写回**。
     ⚠️ 命名容易看反：**my\* 是「你」（用户）的，ai\* 才是「角色」的**
     （角色的名字单独在 #charName，所以「我的名称」指的是用户的名字）。 */
  const MY_FIELDS = ["myName", "aiCallMe", "myPersona", "myAppearance", "myBackground", "myLikes", "myHealth"];
  /* 发消息前的必填项（角色相关 + 共享）——缺任何一栏都不让发（见 chat.js 的 ensureCharReady）。
     不参与校验的：格式化 / 我的相关字段 / AI 筛选规则 / 对话名称（用户明确点过这几类）。
     age 例外：只在「时间系统」开着时必填。 */
  const CHAR_REQUIRED = ["aiName", "aiPersona", "aiAppearance", "aiBackground", "aiLikes", "aiStyle",
    "world", "shared", "relation", "aiDirective"];
  const CHAR_REQUIRED_AGE = "age";

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
      if (type === "textarea") input.rows = 2;
      else if (type === "date") {
        /* 出生日期也走自研滚轮（10-18：系统原生的太丑） */
        input.type = "text";
        input.readOnly = true;
        input.setAttribute("data-wheel", "date");
        input.placeholder = "点这里选日期";
      } else input.type = "text";
      input.id = "cf_" + key;
      l.appendChild(sp);
      l.appendChild(input);
      box.appendChild(l);
    });
    bindCharPhoneAvatar();
    bindPeriodField();
  }

  /* 角色卡的「默认手机头像」（10-19 用户要求）：手机页里这个人用哪张脸。
     留空 → 回落到角色头像（见 phone.js 的 avatarOf）。选图 / AI 生成都走同一份草稿。 */
  function bindCharPhoneAvatar() {
    const pick = $("#cfPhAvPick"), file = $("#cfPhAvInput");
    if (pick && file) pick.addEventListener("click", function () { file.click(); });
    if (file) file.addEventListener("change", async function (e) {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        const url = await readAvatarFile(f);
        avatarDraft.charPhone = url;
        renderAvatarPreview("#cfPhAvPreview", url, "assistant");
      } catch (err) { UI.toast(err.message || "头像读取失败", true); }
    });
    const clr = $("#cfPhAvClear");
    if (clr) clr.addEventListener("click", function () {
      avatarDraft.charPhone = "";
      renderAvatarPreview("#cfPhAvPreview", "", "assistant");
    });
    const ai = $("#cfPhAvAi");
    if (ai) ai.addEventListener("click", function () {
      const ch = curChar();
      const f = (ch && ch.fields) || {};
      const look = [f.aiName || (ch && ch.name) || "", f.age ? ("年龄：" + f.age) : "",
        f.aiAppearance || "", f.aiPersona || ""].filter(Boolean).join("；");
      genAvatarByAi("charPhone", "#cfPhAvPreview", "char", look);
    });
  }

  /* 生理期只在女性角色上出现；性别改了就跟着显隐（用户口径 10-19）。 */
  function syncPeriodField() {
    /* 这两栏是 buildCharForm 现场生成的（HTML 里没有），用 getElementById 取 */
    const g = document.getElementById("cf_aiGender"), p = document.getElementById("cf_aiPeriod");
    if (!g || !p) return;
    const lab = p.closest("label");
    if (lab) lab.hidden = String(g.value || "").indexOf("女") < 0;
  }
  function bindPeriodField() {
    const g = document.getElementById("cf_aiGender");
    if (!g || g.dataset.periodBound) return;
    g.dataset.periodBound = "1";
    g.addEventListener("input", syncPeriodField);
    g.addEventListener("change", syncPeriodField);
    syncPeriodField();
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
      if (avatar) { const im = document.createElement("img"); im.src = (D.avatarUrl ? D.avatarUrl(avatar) : avatar); av.appendChild(im); }
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
    /* 纯手机角色不进这一栏：它们只活在手机里，入口在侧栏「手机角色」那一栏。
       以前这里不过滤 → 点它会在主对话里打开那条 phoneOnly 的线，
       等于把「只活在手机里」这条设计从后门破掉了。 */
    Store.getCharacters().filter((c) => !c.phoneOnly).slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).forEach((c) => bar.appendChild(chip(c.id, c.name || "角色", c.avatar || "", aid === c.id)));
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
      if (avatar) { const im = document.createElement("img"); im.src = (D.avatarUrl ? D.avatarUrl(avatar) : avatar); av.appendChild(im); }
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
        fillCharacterForm(curChar());
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
    /* 默认一律折叠：以前主线那条是自动展开的，但记忆一多整个面板就被撑开、很难翻（用户反馈） */
    return '<details class="mem-session"><summary>' + title + "</summary>" + (lines.length ? memHtml(mem, s.cognition) : '<p class="hint">还没有记忆。</p>') + "</details>";
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
    const ch = curChar();
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

  /* 导入酒馆卡时的「草稿角色」：**不落库**，等用户点「保存设定」才写进本地
     （用户口径：导入后不能自动保存，必须手点 —— 原来是一导入就 saveCharacters）。
     这是 roleplay.js 内部的包装：凡是要「当前正在编辑的角色」的地方都走 curChar()，
     草稿存在时优先返回它 —— 于是表单回填、AI 拆分、必填校验都作用在这份草稿上。 */
  let charDraft = null;
  function curChar() { return charDraft || D["activeCharacter"](); }

  /* 发消息前的必填校验：返回「还缺哪几栏」（空数组 = 可以发）。
     只校验【角色相关 + 共享】那几栏；格式化 / 我的相关字段 / AI 筛选规则 / 对话名称不参与（用户口径）。
     「你的当前年龄」只在**这条对话开着时间系统**时才必填（没时间轴就不需要年龄）。
     「助手」（没有角色卡）不拦。 */
  function charMissingFields(s) {
    const ses = s || session();
    const ch = characterFor(ses);
    if (!ch) return [];
    /* 内置助手（听澜）不参与「字段填齐」校验：
       它是给所有人用的通用搭子，不是要摆设定才能聊的角色卡。
       否则老会话挂到它名下之后，用户会突然发不出消息（提示「还差 N 栏设定」）。 */
    if (ch.builtin) return [];
    /* 纯手机角色（手机页「+ → 新建联系人」建的）同样不参与：
       建的时候只填一个名字，本来就按「轻量联系人」设计；按 10 栏去卡，
       它连第一条消息都发不出去，而手机页又没有去填角色卡的路 —— 链路直接断头。 */
    /* 纯手机角色分两类（10-19）：功能型不校验；相熟型要按正常角色卡填齐。 */
    if (ch.phoneOnly && ch.phoneKind !== "close") return [];
    const f = ch.fields || {};
    const labelOf = function (k) {
      const hit = CHAR_FIELDS.filter(function (x) { return x[0] === k; })[0];
      return hit ? String(hit[1]).split("（")[0] : k;
    };
    const miss = [];
    if (!String(ch.name || "").trim()) miss.push("角色名");
    CHAR_REQUIRED.forEach(function (k) {
      if (!String(f[k] == null ? "" : f[k]).trim()) miss.push(labelOf(k));
    });
    const timelineOn = !!(ses && ses.time && typeof ses.time.start === "number");
    if (timelineOn && !String(f[CHAR_REQUIRED_AGE] == null ? "" : f[CHAR_REQUIRED_AGE]).trim()) {
      miss.push(labelOf(CHAR_REQUIRED_AGE));
    }
    return miss;
  }
  /* 把「还差哪几栏」写进角色弹窗的提示行（每次填表 / 保存都刷一次） */
  function renderCharReadyHint(ch) {
    /* 「升级为完整角色」只在选中的是纯手机角色时出现（10-17） */
    setHidden("#charUpgradeRow", !(ch && ch.phoneOnly));
    const el = $("#charReadyHint");
    if (!el) return;
    if (!ch) { el.textContent = ""; return; }
    const miss = charMissingFields(session());
    if (!miss.length) {
      el.className = "hint char-ready-ok";
      el.textContent = "设定齐了，可以开始对话。";
      return;
    }
    el.className = "hint char-ready-miss";
    el.textContent = "还差 " + miss.length + " 栏才能开始对话：" + miss.join("、")
      + "（格式化 / 关于「我」的几栏 / AI 筛选规则 / 对话名称不影响）";
  }

  /* ── 纯手机角色升级为完整角色（10-17）──────────────────
     去掉 phoneOnly 标记 → 它就从侧栏「手机角色」挪到「现实扮演角色」，
     能开主对话、参与日更 / 世界生成。手机里的消息**不搬**（用户口径），
     升级时让用户写一段「见面背景」，补进共同经历。 */
  let upgradeTarget = "";
  function openUpgrade() {
    const ch = curChar();
    if (!ch || !ch.phoneOnly) { UI.toast("只有手机角色能升级", true); return; }
    upgradeTarget = ch.id;
    setVal("#upgradeMeet", "");
    UI.openModal("upgradeModal");
  }
  function doUpgrade() {
    const id = upgradeTarget;
    upgradeTarget = "";
    if (!id) return;
    const list = Store.getCharacters();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) { UI.closeModal("upgradeModal"); return; }
    const c = list[i];
    const meet = String($v("#upgradeMeet") || "").trim();
    const f = Object.assign({}, c.fields || {});
    if (meet) {
      const old = String(f.shared || "").trim();
      f.shared = old ? (old + "\n" + meet) : meet;
    }
    const next = Object.assign({}, c, { fields: f, updatedAt: Date.now() });
    delete next.phoneOnly;      /* 显式删掉，别留个 false 字段 */
    list[i] = next;
    if (Store.saveCharacters(list) === false) { UI.toast("写入失败，没升级", true); return; }
    UI.closeModal("upgradeModal");
    UI.toast("已升级为完整角色，去侧栏「现实扮演角色」里找它");
    if (D.renderAll) D.renderAll();
  }

  function resetCharSplit() {
    setVal("#charSplitInput", "");
    setText("#charSplitState", "");
    setHidden("#charSplitHint", true);
    setHidden("#charSplitPanel", true);
  }

  /* 把当前表单里已有的内容拼成一段「设定原文」——给「再次拆分」当输入用，
     用户不用再把已经填好的东西抄一遍。label 去掉括号里的说明，省 token。 */
  function charFieldsDigest(onlyRole) {
    const lines = [];
    const nm = $v("#charName").trim();
    if (nm) lines.push("角色名：" + nm);
    CHAR_FIELDS.forEach(([key, label]) => {
      /* 勾了「只拆角色相关」时，源里**不能带**关于「我」的内容 ——
         否则 AI 会照着源把它们又抄一遍填回去，勾选框就白勾了。 */
      if (onlyRole && MY_FIELDS.indexOf(key) >= 0) return;
      const v = $v("#cf_" + key).trim();
      if (v) lines.push(String(label).split("（")[0] + "：" + v);
    });
    return lines.join("\n");
  }

  /* again = true 走「再次拆分」：源 = 输入框里写的内容（如果有）+ 当前各字段里已有的内容，
     让 AI 重新整理、重新归位一遍（这次的内容与原有冲突时以这次的为准，见 config.js 的 splitChar）。 */
  async function runCharSplit(again) {
    const ch = curChar();
    if (!ch) { UI.toast("请先选择或新建一个角色", true); return; }
    /* 「只拆角色相关」：勾上后关于「我」的那几栏既不交给 AI、也不写回表单 */
    const onlyRole = checkedOf("#charSplitRoleOnly");
    const keys = onlyRole ? CHAR_FIELDS.filter(([k]) => MY_FIELDS.indexOf(k) < 0) : CHAR_FIELDS;
    const typed = $v("#charSplitInput").trim();
    let raw = typed;
    if (again) {
      const cur = charFieldsDigest(onlyRole);
      if (!cur.trim() && !typed) { UI.toast("现在还没有可拆的内容，先随便写点", true); return; }
      raw = (typed ? typed + "\n\n" : "") + (cur ? "——以下是当前已经填好的设定——\n" + cur : "");
    } else if (!raw) {
      UI.toast("先把你想写的都写进来", true); return;
    }
    if (!state.settings.apiKey) { UI.toast("先去设置里填 API Key", true); return; }
    setDisabled("#charSplitRun", true);
    setDisabled("#charSplitAgain", true);
    setText("#charSplitState", again ? "AI 正在按现有设定重新拆分…" : "AI 正在拆分…");
    try {
      const fields = [{ key: "charName", label: "角色名（用于列表显示）", current: $v("#charName") }]
        .concat(keys.map(([key, label]) => ({ key: key, label: label, current: $v("#cf_" + key) })));
      const r = await Memory.splitCharacterFields(state.settings, raw, fields);
      if (r.usage) recordUsage(null, r.usage, ch.id);
      let n = 0;
      if (typeof r.fields.charName === "string" && r.fields.charName.trim()) { setVal("#charName", r.fields.charName.trim()); n++; }
      /* 只写 keys 里的：勾了「只拆角色相关」时，AI 就算把关于「我」的内容也返回了，也不落进表单 */
      keys.forEach(([key]) => {
        const v = r.fields[key];
        if (typeof v === "string" && v.trim()) { setVal("#cf_" + key, v.trim()); n++; }
      });
      setText("#charSplitState", n
        ? ("已填入 " + n + " 项" + (onlyRole ? "（只拆了角色相关，关于「我」的几栏没动）" : "") + "，检查/修改后点「保存设定」")
        : "没拆出可用内容，写具体一点再试");
    } catch (e) {
      setText("#charSplitState", "拆分失败：" + (e.message || e));
    } finally {
      setDisabled("#charSplitRun", false);
      setDisabled("#charSplitAgain", false);
    }
  }

  function fillCharacterForm(ch) {
    try {
      resetCharSplit();
      /* 切到别的角色 → 丢掉未保存的草稿（草稿只在自己那次编辑流程里有效，免得张冠李戴） */
      if (charDraft && (!ch || ch.id !== charDraft.id)) charDraft = null;
      const has = !!ch;
      setDisplay("#charForm", has ? "" : "none");
      setDisplay("#charEmpty", has ? "none" : "");
      setDisplay("#charTools", has ? "" : "none");
      if (ch) {
        setVal("#charName", ch.name || "");
        CHAR_FIELDS.forEach(([key]) => setVal("#cf_" + key, (ch.fields && ch.fields[key]) || ""));
        avatarDraft.charPhone = ch.phoneAvatar || "";
        renderAvatarPreview("#cfPhAvPreview", avatarDraft.charPhone, "assistant", ch.avatar || "");
        syncPeriodField();
        setVal("#cfPhoneKind", ch.phoneKind === "close" ? "close" : "casual");
        const cf = Memory.ensureFilter(ch);
        setVal("#charFilterRule", cf.rule || "");
        setVal("#charFilterEvery", cf.every || 10);
      }
      renderCharUsage(ch);
      renderCharReadyHint(ch);
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
    const ch = curChar();
    if (!ch) { UI.toast("请先选择或新建一个角色", true); return; }
    const form = readCharacterForm();
    ch.name = form.name;
    ch.fields = form.fields;
    /* 女性角色没填生理期 → 按 28 天规律随机落一个近 28 天内的日期（用户口径：默认按月经规律算）。
       只在「本来就没填」时补，用户手填的不动。 */
    if (String(ch.fields.aiGender || "").indexOf("女") >= 0 && !String(ch.fields.aiPeriod || "").trim()) {
      const d = new Date(Date.now() - (2 + Math.floor(Math.random() * 26)) * 86400000);
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      ch.fields.aiPeriod = d.getFullYear() + "-" + mm + "-" + dd;
    }
    /* 手机页专用头像：空串 = 跟随角色头像（不要写成 ch.avatar，那样会锁死） */
    ch.phoneAvatar = avatarDraft.charPhone || "";
    ch.phoneKind = $v("#cfPhoneKind") === "close" ? "close" : "casual";
    const cf = Memory.ensureFilter(ch);
    cf.rule = $v("#charFilterRule").trim();
    cf.every = readFilterEvery();
    saveChar(ch);
    /* 草稿（导入酒馆卡来的）**在这一刻才落库** —— 用户口径：导入不自动保存，必须手点「保存设定」。
       落库同时把这条线切过去，并按需补一条主线对话。 */
    if (charDraft) {
      charDraft = null;
      const list = Store.getCharacters();
      if (!list.some(function (x) { return x.id === ch.id; })) { list.push(ch); Store.saveCharacters(list); }
      state.settings = Store.saveSettings({ roleplayEnabled: true, activeCharacterId: ch.id });
      const mine = Store.getSessions().filter(function (s) { return (s.characterId || "") === ch.id; });
      if (!mine.length) newSession();
    }
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
    const extra = [Memory.memoryText(m), Memory.recentTranscript(s.messages, m.coveredUntil, 40, s)].filter(Boolean).join("\n");
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

  /* 群聊「导入某条线的记忆」时用：从一条**多角色线**里挑出能算「共同经历」的部分，
     追加进群聊的共同经历（**只追加，绝不覆盖**群聊自己已有的）。
     判定口径由用户拍板：多个人共同参与 + 时间先后不冲突 + 前后讲得通。
     挑不出来（或 AI 返回「无」）就什么都不加 —— 宁可没有，也不污染。 */
  async function mergeGroupShared(groupId, from) {
    const gs = (Store.getSessions() || []).filter(function (x) { return x.id === groupId; })[0];
    if (!gs || !from) return null;
    if (!state.settings.apiKey) return null;
    try {
      const chars = Store.getCharacters();
      const nameOf = function (id) {
        for (let i = 0; i < chars.length; i++) { if (chars[i].id === id) return chars[i].name || "角色"; }
        return id ? "角色" : "助手";
      };
      const memberNames = (from.members || []).map(nameOf).filter(Boolean).join("、");
      const txt = Memory.recentTranscript(Memory.allMsgs(from), 0, 60, from);
      const body = [
        "这条线的成员：" + (memberNames || "（未记录）"),
        "这条线已有的共同经历：\n" + (((from.shared || "") + "").trim() || "（空）"),
        "这条线的对话（只看有没有「大家都参与、时间不冲突」的事）：\n" + (txt || "（无）")
      ].join("\n\n");
      const res = await Api.summarize(state.settings, [
        { role: "system", content: (CONFIG.COMPRESS_PROMPTS && CONFIG.COMPRESS_PROMPTS.groupShared) || "" },
        { role: "user", content: body }
      ], { maxTokens: 600 });
      const text = (((res && res.text) || "") + "").replace(/^\s+|\s+$/g, "");
      if (res && res.usage) { try { recordUsage(null, res.usage, "", "summary"); } catch (e) { /* 记账失败不影响功能 */ } }
      if (!text || text === "无") return null;
      const cur = ((gs.shared || "") + "").replace(/\s+$/g, "");
      Store.updateSession(groupId, { shared: cur ? (cur + "\n" + text) : text });
      return text;
    } catch (e) {
      return null;
    }
  }

  async function updateRelationSharedNow() {
    const s = session();
    if (!s || !(s.characterId || "")) { UI.toast("关系与经历只属于角色扮演对话", true); return; }
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    const m = Memory.ensureMemory(s);
    const extra = [Memory.memoryText(m), Memory.recentTranscript(s.messages, m.coveredUntil, 40, s)].filter(Boolean).join("\n");
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

  /* ── 预设角色（config.js 的 PRESET_CHARACTERS）──────────────
     只导入「AI 那半边」：myName / myPersona / myAppearance / myBackground / myLikes
     是用户自己的，预设一律不写，留给他到「当前设定」里补。 */
  function presetList() {
    return (CONFIG && CONFIG.PRESET_CHARACTERS) || [];
  }

  function openPresetPicker() {
    const box = $("#presetList");
    if (!box) return;
    const list = presetList();
    box.innerHTML = "";
    if (!list.length) {
      box.textContent = "没有可用的预设。";
    }
    list.forEach(function (p) {
      const card = document.createElement("div");
      card.className = "preset-card";
      const im = document.createElement("img");
      im.src = p.avatar || "";
      im.alt = "";
      card.appendChild(im);
      const nm = document.createElement("b");
      nm.textContent = p.name || "角色";
      card.appendChild(nm);
      const tg = document.createElement("span");
      tg.textContent = p.tag || "";
      card.appendChild(tg);
      card.addEventListener("click", function () { usePreset(p.key); });
      box.appendChild(card);
    });
    UI.openModal("presetModal");
  }

  function usePreset(key) {
    const p = presetList().filter(function (x) { return x.key === key; })[0];
    if (!p) return;
    const now = Date.now();
    const c = {
      id: "c_" + now.toString(36) + Math.random().toString(36).slice(2, 6),
      name: p.name || "新角色",
      avatar: p.avatar || "",
      fields: {},
      ctxFilter: { rule: "", every: 10 },
      usage: null,
      pinned: false,
      createdAt: now,
      updatedAt: now
    };
    /* 值全是字符串，浅拷贝就够；顺便挡掉 my* —— 万一以后有人往预设里写了也不生效 */
    Object.keys(p.fields || {}).forEach(function (k) {
      if (k.indexOf("my") === 0) return;
      c.fields[k] = p.fields[k];
    });
    const list = Store.getCharacters();
    list.push(c);
    Store.saveCharacters(list);
    state.settings = Store.saveSettings({ roleplayEnabled: true, activeCharacterId: c.id });
    UI.closeModal("presetModal");
    openCharacterModal();
    const existing = Store.getSessions().filter(function (s) { return (s.characterId || "") === c.id; });
    if (!existing.length) newSession();
    UI.toast("已按「" + (p.name || "角色") + "」建好，补上你自己那半边设定就能聊了");
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
    fillCharacterForm(curChar());
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
    const ch = curChar();
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
    const ch = curChar();
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
      Memory.updateScene(s, saveSession, state.settings, since).then((res) => {
        if (res && res.usage) recordUsage(null, res.usage, s.characterId || "");
        /* 只有真的产出了场景才推进 sceneAt；空输出照样推进的话，
           这一段对话的场景就永远补不上、也不会再重试。 */
        if (res && res.changed) {
          s.sceneAt = upto;
          saveSession();
          if (notify) UI.toast("当前场景已更新");
        } else if (notify) {
          UI.toast("这次没生成出场景，下次再试");
        }
      }).catch(() => {}).finally(() => { sceneBusy = false; });
    } catch (e) { sceneBusy = false; }
  }

  /* 日更：场景 / 共同经历 / 关系 每天各更新一次（默认开）。
     每条会话各自记 rec.dailyDay，所以「切到哪条线就以哪条线的今天为准」。
     只看角色扮演的会话（助手线没有角色卡，没有关系/经历可更）。 */
  let dailyBusy = false;
  function maybeDailyRefresh(s, ch) {
    try {
      if (!s || !ch) return;
      if (state.settings.dailyUpdate === false) return;
      if (!state.settings.apiKey) return;
      if (dailyBusy) return;
      const td = todayStr();
      if (s.dailySceneDay === td && s.dailyRelationDay === td) return;
      /* 兼容旧数据：只有 dailyDay 且等于今天（两条新水位线还没建立）→ 今天已经跑过，跳过 */
      if (s.dailyDay === td && s.dailySceneDay === undefined && s.dailyRelationDay === undefined) return;
      const base = { relation: (ch.fields && ch.fields.relation) || "", shared: (ch.fields && ch.fields.shared) || "" };
      const notify = !!state.settings.notifyTasks;
      dailyBusy = true;
      if (notify) UI.toast("正在按日更新场景 / 关系 / 经历…");
      Memory.dailyRefresh(s, saveSession, state.settings, base).then((usage) => {
        if (usage) recordUsage(null, usage, s.characterId || "", "daily");
        if (notify) UI.toast("本日场景 / 关系 / 经历已更新");
      }).catch(() => {}).finally(() => { dailyBusy = false; });
    } catch (e) { dailyBusy = false; }
  }

  function openCharacterModal() {
    buildCharForm();
    renderCharList();
    fillCharacterForm(curChar());
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

  /* 毫秒 → <input type="datetime-local"> 认的本地时间串（YYYY-MM-DDTHH:MM:SS） */
  function toLocalInput(ms) {
    const d = new Date(ms);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" +
      p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
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
      setVal("#setSessionFormat", s.adoptFormat || "");
      setVal("#setSessionTtsVoice", s.ttsVoice || "");
      setVal("#setSessionRelation", s.relation || "");
      setVal("#setSessionShared", s.shared || "");
      setVal("#setSessionCognition", s.cognition || "");
      setChecked("#setSessionAutoBackup", !!s.autoBackup);
      /* 主动发消息：跟随全局 / 允许 / 不允许 */
      setVal("#setSessionAutoMsg", s.autoMsgOn === true ? "on" : (s.autoMsgOn === false ? "off" : ""));
      /* 时间系统：把当前故事时间和「这家角色的合法时段」都摆出来，越界一眼能看见 */
      const tlOn = !!(Memory && Memory.hasTimeline && Memory.hasTimeline(s));
      const nowMs = tlOn ? Memory.nowOf(s) : Date.now();
      setVal("#setSessionTime", tlOn ? toLocalInput(nowMs) : "");
      setChecked("#setSessionTimeSync", tlOn && Math.abs(Memory.timeOffset(s)) < 60000);
      const rng = Memory && Memory.validRange ? Memory.validRange(characterFor(s)) : null;
      const tlLine = [];
      if (!tlOn) tlLine.push("当前：未启用（对话里走的就是现实时间）");
      else {
        const ck = Memory.checkTime(characterFor(s), nowMs);
        tlLine.push("当前故事时间：" + Memory.fmtStory(nowMs, true) + (ck.ok ? "" : "　⚠️ 已超出角色的合法时段"));
      }
      if (rng) tlLine.push("角色合法时段：" + Memory.fmtStory(rng.from).slice(0, 10) + " ~ " + Memory.fmtStory(rng.to).slice(0, 10));
      else tlLine.push("角色没填「出生日期」或「当前年龄」读不出数字 —— 时间不做限制");
      setText("#sessionTimeLine", tlLine.join("；"));
      setChecked("#setSessionStatusQuant", (typeof s.statusQuant === "boolean") ? s.statusQuant : (state.settings.statusQuant !== false));
      renderDiaryList(s);
      setText("#sessionSummaryOut", s.summaryText ? s.summaryText : "");
      setText("#sessionLineBadge", s.mainLine ? "主线" : "支线");
      renderBackupLine(s);
      renderSessionMemory();
    }
    /* 群聊专属：对彼此的认知 + 同步到各自线（10-18） */
    try { if (window.DL.renderGroupCog) window.DL.renderGroupCog(s); } catch (e) { console.warn("[DeepLink] 群聊认知区出错", e); }
    /* 聊天背景（本对话）：跟随全局时置勾、并显示全局图；单独设置时显示自己的图 */
    try {
      setChecked("#setSessionBgFollow", !(s && s.bgFollow === false));
      if (D.bgDraft) D.bgDraft.session = (s && s.bgImage) || "";
      if (D.renderBgPreview) D.renderBgPreview("#setSessionBgPreview", (s && s.bgImage) || "");
    } catch (e) { /* ignore */ }
    /* 离线原因（10-17）：选项来自设置里的全局清单，这里只能选不能改 */
    try {
      const rsel = document.getElementById("setSessionReason");
      if (rsel) {
        const reasons = (state.settings && state.settings.offlineReasons) || [];
        rsel.innerHTML = "";
        const o0 = document.createElement("option");
        o0.value = ""; o0.textContent = "（不指定）";
        rsel.appendChild(o0);
        reasons.forEach((r) => {
          const o = document.createElement("option");
          o.value = r.id; o.textContent = r.text;
          rsel.appendChild(o);
        });
        rsel.value = (s && s.offlineReasonId) || "";
        if (UI.pickRefreshAll) UI.pickRefreshAll();
      }
      setChecked("#setReasonLock", !!(s && s.offlineReasonLocked));
    } catch (e) { /* ignore */ }
    syncSessionParamFields();
  }

  /* ── 酒馆角色卡导入（SillyTavern：PNG chara / ccv3 + JSON）───────
     PNG 里的角色卡藏在 tEXt 块的「chara」/「ccv3」关键字下，值是 base64 的 JSON。
     只认未压缩的 tEXt（zTXt 压缩块极少见，遇到就跳过，不猜）。 */
  function bytesToStr(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
  function tavernPngText(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.length < 8 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return null;
    const dv = new DataView(buf);
    let off = 8;
    const out = {};
    while (off + 12 <= u8.length) {
      const len = dv.getUint32(off);
      const type = bytesToStr(u8.subarray(off + 4, off + 8));
      const data = u8.subarray(off + 8, off + 8 + len);
      off += 12 + len;   /* 4 长度 + 4 类型 + len 数据 + 4 CRC */
      if (type === "tEXt") {
        const s = bytesToStr(data);
        const z = s.indexOf("\u0000");
        if (z > 0) {
          const kw = s.slice(0, z);
          if (kw === "chara" || kw === "ccv3") out[kw] = s.slice(z + 1);
        }
      } else if (type === "IEND") break;
      if (out.chara && out.ccv3) break;
    }
    return (out.chara || out.ccv3) ? out : null;
  }
  function b64ToUtf8(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ""));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(u8);
  }
  /* v2 / v3 把资料放在 data 下；v1 是扁平结构 */
  function tavernCardData(o) {
    if (!o || typeof o !== "object") return null;
    return (o.data && typeof o.data === "object") ? o.data : o;
  }
  function joinArr(v) {
    if (Array.isArray(v)) return v.map((x) => String(x == null ? "" : x).trim()).filter(Boolean).join("\n");
    return typeof v === "string" ? v.trim() : "";
  }
  /* 映射到现有 17 项；没有对应字段的内容就近并入「世界观」或「共同经历」，不丢原文 */
  /* 酒馆卡里常夹 HTML（酒馆支持把角色卡里的代码渲染成「代码可视化」）。
     字段不该被标签污染：先粗清洗成纯文本 —— 块级标签换行、其余标签去掉、反转义常见实体。
     ⚠️ &amp; 必须最后替换，否则「&amp;lt;」会被提前解成「<」。 */
  /* 酒馆卡里写的是 {{user}} / {{char}} 这种占位符 —— 卡作者不知道你叫什么。
     不替换的话，模型会原样读到「{{user}}」，一句话都接不上（真机反馈就是这个）。
     {{char}} 用卡里的名字；{{user}} 用「设置 → 我的人设 → 我的名称」，没填就退回「你」。
     doIt 为假时原样返回（导入区那个勾选框不勾的情况）。 */
  function substPlaceholders(text, charName, doIt) {
    const raw = String(text == null ? "" : text);
    if (doIt === false) return raw;
    let my = "";
    try { my = String((Store.getSettings() || {}).myName || "").trim(); } catch (e) { my = ""; }
    if (!my) my = "你";
    return raw
      .replace(/\{\{\s*user\s*\}\}/gi, my)
      .replace(/\{\{\s*char\s*\}\}/gi, charName || "角色");
  }

  function htmlToText(s) {
    if (!s) return "";
    return String(s)
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function tavernToFields(card, opts) {
    const d = tavernCardData(card) || {};
    const doSubst = !(opts && opts.substUser === false);   /* 默认替换 */
    const fields = {};
    const put = (k, v) => { const s = htmlToText(joinArr(v)); if (s) fields[k] = s; };
    put("aiName", d.name || card.name);
    put("aiPersona", d.personality);
    put("aiBackground", d.description);
    put("aiStyle", d.mes_example || d.example_dialogue);
    put("aiDirective", d.system_prompt || d.post_history_instructions);
    let world = joinArr(d.scenario);
    const notes = joinArr(d.creator_notes || d.creatorcomment);
    if (notes) world += (world ? "\n\n" : "") + "【作者注】\n" + notes;
    put("world", world);
    /* 开场白不进「共同经历」：它是这条线要说的第一句话，不是你们经历过的事。
       以前塞进 shared，结果一整段被当成设定文本喂给模型、在聊天里还看不到。
       现在原文留在 intro（保留富文本），由 chat.js 落到会话的第一条消息里。 */
    const first = joinArr(d.first_mes || d.first_message);
    const alts = Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [];
    put("shared", "");   /* 酒馆卡没有「共同经历」这个字段，留空 */
    const tags = joinArr(d.tags);
    if (tags) fields.aiLikes = "（来自酒馆卡标签）\n" + tags;
    const name = String(d.name || card.name || "导入的角色").trim() || "导入的角色";
    /* 统一把 {{user}} / {{char}} 换掉（导入区那个勾选框不勾就原样留着） */
    Object.keys(fields).forEach(function (k) { fields[k] = substPlaceholders(fields[k], name, doSubst); });
    return {
      name: name,
      fields: fields,
      intro: substPlaceholders(first ? String(first) : "", name, doSubst),
      greetings: alts.map(function (x) {
        return substPlaceholders(String(joinArr(x) || ""), name, doSubst);
      }).filter(Boolean),
      count: Object.keys(fields).length
    };
  }
  function importTavernCard(file) {
    if (!file) return Promise.resolve(false);
    const isPng = /\.png$/i.test(file.name || "") || file.type === "image/png";
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          let card = null;
          if (isPng) {
            const txt = tavernPngText(fr.result);
            if (!txt) { UI.toast("这张 PNG 里没有角色卡数据（找不到 chara / ccv3 块）", true); resolve(false); return; }
            card = JSON.parse(b64ToUtf8(txt.ccv3 || txt.chara));
          } else {
            card = JSON.parse(String(fr.result || ""));
          }
          const mapped = tavernToFields(card, {
            /* 勾选框：把卡里的 {{user}} 换成「我的人设 → 我的名称」 */
            substUser: !(document.getElementById("charImportUser") && !document.getElementById("charImportUser").checked)
          });
          const now = Date.now();
          const c = {
            id: "c_" + now.toString(36) + Math.random().toString(36).slice(2, 6),
            name: mapped.name, avatar: "", fields: mapped.fields,
            /* 开场白原文（富文本）与备选开场：由 chat.js 落到会话的第一条消息 */
            intro: mapped.intro || "",
            greetings: mapped.greetings || [],
            ctxFilter: { rule: "", every: 10 }, usage: null, pinned: false,
            createdAt: now, updatedAt: now
          };
          /* ⚠️ **不落库**（用户口径：导入后必须手点「保存设定」才算数，不能自动保存）。
             先把卡片当「草稿」填进表单，点保存那一刻才写进本地（见 saveCharacter）。 */
          charDraft = c;
          openCharacterModal();
          fillCharacterForm(c);
          renderCharBar();
          /* 「导入后用 AI 拆分」（用户口径）：酒馆卡信息杂，交给 AI 归位更省事。
             走「再次拆分」那条（以刚填好的字段为源重新整理）—— 不会清空没提到的栏。 */
          const impAI = document.getElementById("charImportAI");
          if (impAI && impAI.checked) {
            UI.toast("已解析角色卡「" + mapped.name + "」，正在用 AI 拆分…");
            setText("#charSplitState", "AI 正在拆分（酒馆卡里的代码 / 格式会一起理解）…");
            resolve(true);
            runCharSplit(true);
          } else {
            UI.toast("已解析角色卡「" + mapped.name + "」（填入 " + mapped.count + " 项）。确认后点「保存设定」才存下来");
            resolve(true);
          }
        } catch (e) {
          UI.toast("角色卡解析失败：" + (e.message || e), true);
          resolve(false);
        }
      };
      fr.onerror = () => { UI.toast("文件读取失败", true); resolve(false); };
      if (isPng) fr.readAsArrayBuffer(file);
      else fr.readAsText(file);
    });
  }

  /* ── 自注册：把 app.js / chat.js 仍要用的入口挂到 window.DL ───────
     写法与 chat.js 一致：app.js 里保留同名的「转发壳」（只转发、不实现），
     运行时再转到这里来。⚠️ 这里挂的名字，app.js 的 window.DL 字面量里不能再写一遍，
     否则会转发到它自己、无限递归。

     外面套一层只为在每次进入公开入口前重取一遍模块（syncModules）——
     打包工具若不按 index.html 顺序执行脚本，这是唯一能兜住「模块晚到」的地方。 */
  /* ── 情绪日记（会话级）──────────────────────────────
     用户主动写才生效：有日记时，生成会把它当作「希望角色往哪儿靠」的软引导。
     数据存 session.diary = [{ts, date, text}]，最多留 30 条。 */
  function diaryOf(s) {
    return (s && Array.isArray(s.diary)) ? s.diary : [];
  }
  function renderDiaryList(s) {
    const el = $("#sessionDiaryList");
    if (!el) return;
    const list = diaryOf(s);
    if (!list.length) { el.textContent = "还没有日记。"; return; }
    el.innerHTML = "";
    list.slice(-3).reverse().forEach((d) => {
      const p = document.createElement("div");
      p.textContent = (d.date || "") + "：" + String(d.text || "");
      el.appendChild(p);
    });
  }
  function sessionDiarySave() {
    const s = session();
    if (!s) return;
    const txt = $v("#setSessionDiary").trim();
    if (!txt) { UI.toast("先写一句再记", true); return; }
    const list = diaryOf(s).slice();
    list.push({ ts: Date.now(), date: todayStr(), text: txt });
    Store.updateSession(s.id, { diary: list.slice(-30) });
    setVal("#setSessionDiary", "");
    renderDiaryList(sessionById2(s.id));
    UI.toast("记下了");
  }
  function sessionDiaryClear() {
    const s = session();
    if (!s) return;
    Store.updateSession(s.id, { diary: [] });
    renderDiaryList(sessionById2(s.id));
    UI.toast("日记已清空");
  }
  function sessionById2(id) {
    return Store.getSessions().find((x) => x.id === id) || null;
  }

  /* ── 助手总结：关系剖析报告（只在用户点的时候跑一次）──── */
  async function runAssistantSummary() {
    const s = session();
    if (!s) return;
    const out = $("#sessionSummaryOut");
    if (!state.settings.apiKey) { UI.toast("请先在「设置」里填写 API Key", true); return; }
    if (out) out.textContent = "正在读这条线的记忆…";
    try {
      const ch = characterFor(s);
      /* 群聊：一条线里多个角色，把成员名列出来，并给每条消息标上说话人 ——
         不标的话，AI 会把「小满做的事」写成「夏幽幽做的事」或者算到你头上。 */
      let memberNames = "";
      if (s.isGroup) {
        const chars = Store.getCharacters();
        memberNames = (s.members || []).map((id) => {
          for (let i = 0; i < chars.length; i++) { if (chars[i].id === id) return chars[i].name || "角色"; }
          return "";
        }).filter(Boolean).join("、");
      }
      const all = Memory.allMsgs(s).slice(-30).map((m) => {
        /* chat.js 提供 activeText（能拿到多版本里当前选中的那条正文）；没有就退回 m.content */
        const at = D.activeText || window.activeText;
        const body = at ? at(m) : (m.content || "");
        const who = m.role === "user" ? "我" : (m.speakerName ? String(m.speakerName) : "对方");
        return who + "：" + String(body || "").replace(/\s+/g, " ").slice(0, 200);
      }).filter(Boolean).join("\n");
      const body = [
        "角色：" + (s.isGroup ? ("群聊，成员：" + (memberNames || "（未记录）"))
                              : (ch ? (ch.name || "角色") : "（无角色卡）")),
        "当前关系：" + (s.relation || "（未记录）"),
        "共同经历：" + (s.shared || "（未记录）"),
        "对用户的认知：" + (s.cognition || "（未记录）"),
        "记忆摘要：" + (Memory.memoryText ? Memory.memoryText(s.memory) : "（空）"),
        "最近的对话：\n" + (all || "（还没聊过）")
      ].join("\n");
      const sys = "你是关系分析师。根据给出的对话与记忆，写一份简洁的关系剖析报告，包含：" +
        "① 目前的关系状态；② 对方（角色）对你的态度与在意程度；③ 最近的变化趋势；④ 一条具体的建议。" +
        "用中文，每个小标题一行，总长不超过 400 字。只依据给定内容，不要编造。" +
        "【多人时特别注意】对话里「我：」是用户本人，其他以名字开头的（如「夏幽幽：」）是各自独立的角色。" +
        "请严格区分是谁说的、谁做的，不要张冠李戴，也不要把某个角色做的事写成用户做的。";
      const res = await Api.summarize(state.settings, [
        { role: "system", content: sys },
        { role: "user", content: body }
      ], { maxTokens: 900 });
      if (res && res.usage) recordUsage(s.id, res.usage, s.characterId, "summary");
      const text = (res && res.text) ? res.text : "（模型没有给出内容）";
      Store.updateSession(s.id, { summaryText: text });
      if (out) out.textContent = text;
    } catch (e) {
      if (out) out.textContent = "生成失败：" + (e && e.message ? e.message : e);
    }
  }

  /* ── 世界生成：离线一阵子后，替角色补写这段空档 ─────────── */
  async function generateWorld(s) {
    if (!s) throw new Error("没有可用的对话");
    const ch = characterFor(s);
    if (!ch) throw new Error("这条线还没有角色卡");
    /* 「所隔时间」优先取这条会话自己的离线锚点（退出那一刻记的），没有才退回全局 */
    const raw = (Memory && Memory.awayGap) ? Memory.awayGap(s) : null;
    const gapMs = Math.max(0, (typeof raw === "number") ? raw : (Date.now() - (state.settings.lastSeenAt || Date.now())));
    const days = Math.max(1, Math.ceil(gapMs / 86400000));
    /* 空档期落在故事时间里的哪一段（给 AI 一个明确的日期范围，它才好按天铺） */
    const nowStory = Memory.nowOf(s);
    const fromTxt = Memory.fmtStory(nowStory - gapMs).slice(0, 10);
    const toTxt = Memory.fmtStory(nowStory).slice(0, 10);

    /* 用户口径（10-15）：**按日期级写、尽可能详尽** —— 哪天的早/午/下午/晚分别干了什么。
       所以这里是「逐天 + 逐时段」，不是原来那样三句概括。 */
    const sys = "你在为一段角色扮演补写「空档期剧情」——这段时间用户没上线，角色自己过日子。\n" +
      "要求：\n" +
      "1. 按天写，一天一段。每段**以序号 + 日期开头**，形如「1. 3月12日」；段内可以有好几行。\n" +
      "2. 每一天都要把各个时段交代到：早上 / 上午 / 中午 / 下午 / 傍晚 / 晚上 / 深夜。" +
      "有事发生的时段写细，没事的一句话带过就行。\n" +
      "3. 越具体越好：在哪儿、做了什么、吃了什么、碰见谁、说了哪句话、有没有想起对方。" +
      "**别写「过得还行」「挺忙的」这种空话。**\n" +
      "4. 贴合角色设定、当前关系与共同经历；用**第三人称平铺直叙**（这是旁白，不是角色对用户说话）。\n" +
      "5. 不要 Markdown 标题、不要加粗、不要列表符号，只靠「序号 + 日期」起头分段。";

    const tline = (Memory.timeLine ? Memory.timeLine(ch, s) : "");
    /* 离线原因（10-17）：会话里选的那条（有锁定就按锁定的算）——让 AI 知道用户为什么不在。
       只在「时间系统开着」的前提下才有意义（调用方已保证）。 */
    let rTxt = "";
    const rId = s.offlineReasonId || (s.time && s.time.leftReasonId) || "";
    if (rId) {
      const rs = (state.settings && state.settings.offlineReasons) || [];
      for (let i = 0; i < rs.length; i++) { if (rs[i].id === rId) rTxt = String(rs[i].text || ""); }
    }
    const body = [
      "角色：" + (ch.name || "角色"),
      "角色设定：" + (Memory.personaText ? Memory.personaText(ch) : ""),
      "当前关系：" + (s.relation || "（未记录）"),
      "当前场景：" + (s.scene || "（未记录）"),
      "共同经历：" + (s.shared || "（未记录）"),
      "记忆摘要：" + (Memory.memoryText ? Memory.memoryText(s.memory) : "（空）"),
      (tline ? tline + "\n" : "") +
      (rTxt ? ("用户这次离开的原因（就照着写他不在的这段时间）：" + rTxt + "\n") : "") +
        "空档期：" + fromTxt + " 到 " + toTxt + "，共 " + days + " 天。" +
        "请**逐天**写，每天把早 / 午 / 下午 / 晚都交代到，别只写三段概括。"
    ].join("\n");
    /* 天数越多、写得越细，给的额度越大（上限兜住成本） */
    const maxTokens = Math.max(900, Math.min(2600, 500 + days * 300));
    const res = await Api.summarize(state.settings, [
      { role: "system", content: sys },
      { role: "user", content: body }
    ], { maxTokens: maxTokens });
    if (res && res.usage) recordUsage(null, res.usage, s.characterId, "world");
    return (res && res.text) || "";
  }
  /* 采纳：作为一条「补写」消息放进这条线的末尾（用户看得见，也能删） */
  function applyWorld(sid, text) {
    const txt = String(text || "").trim();
    if (!sid || !txt) return;
    const list = Store.getSessions();
    const i = list.findIndex((x) => x.id === sid);
    if (i < 0) return;
    list[i].messages.push({ role: "assistant", ts: Date.now(), world: true, variants: [{ content: txt, q: 0 }], vi: 0 });
    list[i].updatedAt = Date.now();
    /* 离线这段时间已经用剧情交代过了 → 以此刻为新基准重新起算，旧锚点作废 */
    if (Memory && Memory.rebaseTime) Memory.rebaseTime(list[i], "world");
    Store.saveSessions(list);
    /* 剧情里若写了「角色用手机给你发了消息」，手机页也要补上对应时间点的文本（用户口径）。
       异步做、不挡采纳动作本身；出问题只打日志，绝不影响已经采纳的剧情。 */
    try { fillPhoneFromWorld(sid, txt); } catch (e) { console.warn("[DeepLink] 手机页同步失败", e); }
  }

  /* ── 世界生成 → 手机页同步（10-17 用户要求）────────────────
     剧情里常会写「他发了条消息」「微信问她」——这些内容在手机页也应该出现。
     做法：一次快速预筛（没有手机相关词就完全不发请求）→ 让 AI 逐条挑出来 →
     按顺序摊在「离线区间」里作为手机消息插入。
     时间点用区间内均匀分布（剧情里的「3月12日晚上」这种描述不强行解析成时间戳，
     免得和故事时间偏移打架；顺序对了就够用）。 */
  const PHONE_HINT_RE = /手机|微信|短信|发了条|发消息|发来|回了条|语音条/;
  async function fillPhoneFromWorld(sid, worldText) {
    if (!worldText || !PHONE_HINT_RE.test(worldText)) return 0;
    if (!state.settings.apiKey) return 0;
    const s0 = sessionById2(sid);
    if (!s0 || !characterFor(s0)) return 0;
    const sys = "你在整理一段「角色在用户离线期间做了什么」的剧情，要把其中**角色用手机 / 微信 / 短信给用户发过的消息**挑出来。\n" +
      "输出要求（严格）：\n" +
      "1. 一行一条，格式：`时间描述 | 消息内容`\n" +
      "2. 时间描述用剧情里的原话（如「3月12日 晚上」「第二天早上」），别编造。\n" +
      "3. 消息内容要像真人即时聊天：一两句、口语、短；是角色对用户说的话，不是旁白。\n" +
      "4. 一条都没有 → 只输出一个字：无\n" +
      "不要解释、不要 Markdown、不要序号。";
    let out = "";
    try {
      const r = await Api.summarize(state.settings, [
        { role: "system", content: sys },
        { role: "user", content: worldText }
      ], { maxTokens: 600 });
      out = String((r && r.text) || "").trim();
      /* 记账：这次挑手机消息也是一次真实请求，用量统计里要看得见（归到「手机」） */
      if (r && r.usage && typeof recordUsage === "function") {
        try { recordUsage(null, r.usage, "", "phone"); } catch (e) { /* ignore */ }
      }
    } catch (e) { return 0; }
    if (!out || out === "无" || /^无[。.]?$/.test(out)) return 0;
    const lines = out.split("\n").map((x) => x.trim()).filter(Boolean);
    const nowReal = Date.now();
    /* ⚠️ 别给区间设「最小值」：刚记完 leftAt 就回来说不定只隔了几十毫秒，
       强行抬到 1 分钟会让消息时间戳跑到【未来】。锚点也压到不晚于现在。 */
    const rawLeft = (s0.time && typeof s0.time.leftAt === "number") ? s0.time.leftAt : (nowReal - 3600000);
    const leftReal = Math.min(rawLeft, nowReal);
    const span = Math.max(0, nowReal - leftReal);
    const msgs = [];
    lines.forEach((ln, idx) => {
      const ix = ln.indexOf("|");
      const body = (ix >= 0 ? ln.slice(ix + 1) : ln).trim();
      if (!body || body === "无") return;
      const ts = Math.round(leftReal + span * ((idx + 1) / (lines.length + 1)));
      msgs.push({ role: "assistant", kind: "text", ts: ts, text: body });
    });
    if (!msgs.length) return 0;
    const cur = sessionById2(sid);
    if (!cur) return 0;
    const ph = (cur.phone && typeof cur.phone === "object") ? cur.phone : { msgs: [] };
    ph.msgs = (ph.msgs || []).concat(msgs).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    Store.updateSession(sid, { phone: ph });
    UI.toast("剧情里提到的手机消息，已同步到手机页（" + msgs.length + " 条）");
    return msgs.length;
  }

  /* ── 自动发信息（默认关）：按性格主动找你 ─────────── */
  /* 「先看场景再决定发不发」这条：只在会话里明确选了『允许』时才加（用户口径）。
     AI 判定你俩此刻在一块儿 → 只回 [[不打扰]]，这条就不发。 */
  const AUTO_SKIP_MARK = "[[不打扰]]";
  const AUTO_SCENE_RULE = "\n\n【先判断该不该发】看一眼上面的「当前场景」和最近的对话：" +
    "如果你和对方**此刻正在一起**（在同一个地方、正在相处、刚见面、就在身边），那就**不要发这条消息**，" +
    "只输出这五个字符：" + AUTO_SKIP_MARK + "，别写任何其它字。" +
    "只有在你们**不在一起**（分开了、各忙各的、对方不在你身边）时，才正常发一条。";

  /* 认得出「在一起」→ 回 true（这条不发） */
  function autoSkipped(text) {
    return String(text || "").indexOf(AUTO_SKIP_MARK) >= 0;
  }

  async function generateAutoMessage(s, opts) {
    if (!s) return "";
    const ch = characterFor(s);
    if (!ch) return "";
    const o = opts || {};
    const hours = Math.round(((Date.now() - (s.updatedAt || Date.now())) / 3600000) * 10) / 10;
    const sys = Memory.buildSystemText(ch, s, state.settings) +
      "\n\n【场景】你们有一阵子没联系了（大约 " + Math.max(0.1, hours) + " 小时）。请你【主动】发一条消息找对方，" +
      "像真人那样：一两句、口语、贴合你的性格与此刻的关系，可以带点情绪或小事。只输出你要发的那句话，不要旁白、不要 Markdown。" +
      (o.checkScene ? AUTO_SCENE_RULE : "");
    const res = await Api.summarize(state.settings, [
      { role: "system", content: sys },
      { role: "user", content: "（对方没有先说话，是你主动发的）" }
    ], { maxTokens: 300 });
    if (res && res.usage) recordUsage(s.id, res.usage, s.characterId, "auto");
    const t = ((res && res.text) || "").trim();
    if (autoSkipped(t)) return "";     /* AI 判定「在一块儿」→ 这条不发 */
    return t;
  }
  function applyAutoMessage(sid, text) {
    const txt = String(text || "").trim();
    if (!sid || !txt) return;
    const list = Store.getSessions();
    const i = list.findIndex((x) => x.id === sid);
    if (i < 0) return;
    list[i].messages.push({ role: "assistant", ts: Date.now(), auto: true, variants: [{ content: txt, q: 0 }], vi: 0 });
    list[i].updatedAt = Date.now();
    /* 主动发过消息 = 这段空白已有「动作」对应 → 重新起算 */
    if (Memory && Memory.rebaseTime) Memory.rebaseTime(list[i], "auto");
    Store.saveSessions(list);
  }

  /* ── 手机主动分享（「自动发信息 · 手机模式」）─────────────────────
     跟 generateAutoMessage 是一条链路的另一种投递方式：消息进【手机】而不是主对话。
     一次调用同时产出「文字」和「可选配图」：
       · 文字 —— 同主动发信息，按性格主动找你
       · 配图 —— 只有开了「手机里允许角色主动分享图片」且文生图可用时才让 AI 考虑；
                 AI 从画风目录里挑一个 id，再补一句「具体画什么」
     返回 { text, image: { style, styleName, subject, self } | null }
     解析用「整行标记」而不是 JSON —— 模型常夹带解释，整行标记最不容易被带崩。 */
  const IMG_MARK = "[[配图]]";

  /* 把画风目录拼成给 AI 看的清单（只列 id / 名字 / 什么时候用） */
  function styleMenuText() {
    const groups = (CONFIG && CONFIG.IMAGE_STYLES) || [];
    const lines = [];
    groups.forEach(function (g) {
      lines.push("◆ " + g.group);
      (g.items || []).forEach(function (it) {
        lines.push("  - " + it.id + "（" + it.name + "）：" + it.use);
      });
    });
    return lines.join("\n");
  }

  function shareRuleText() {
    return "\n\n【可选：顺带分享一张图片】\n" +
      "如果你此刻觉得发张图更合适（分享日常、风景、吃了什么、自拍、吐槽的梗图、随手画的东西…），" +
      "就在正文之后【单独另起一行】写一句：\n" +
      IMG_MARK + " 画风id | 一句话画面描述（越具体越好，写清画的是什么）\n" +
      "不想发图就【不要写这一行】——发不发、发什么，由你按性格和此刻心情决定，不要硬凑。" +
      "画风 id 只能从下面这份清单里挑，不要自己编：\n" + styleMenuText();
  }

  /* 拆出「正文」与「配图规格」。没有标记 / 规格不合法就只当纯文字。 */
  function parseShare(text) {
    const out = { text: String(text || ""), image: null };
    const raw = String(text || "");
    const idx = raw.indexOf(IMG_MARK);
    if (idx < 0) { out.text = raw.trim(); return out; }
    out.text = raw.slice(0, idx).trim();
    const tail = raw.slice(idx + IMG_MARK.length).split("\n")[0].trim();
    const bar = tail.indexOf("|");
    const id = (bar >= 0 ? tail.slice(0, bar) : tail).trim();
    const subject = (bar >= 0 ? tail.slice(bar + 1) : "").trim();
    const idx2 = (CONFIG && CONFIG.IMAGE_STYLE_INDEX) || {};
    const it = idx2[id];
    if (it && subject) {
      out.image = { style: it.id, styleName: it.name, subject: subject, self: !!it.self };
    }
    return out;
  }

  async function generatePhoneShare(s, opts) {
    if (!s) return { text: "", image: null };
    const ch = characterFor(s);
    if (!ch) return { text: "", image: null };
    const o = opts || {};
    const canImg = !!(state.settings.phoneShareImg && Media && Media.capable &&
      Media.capable("img", state.settings));
    const hours = Math.round(((Date.now() - (s.updatedAt || Date.now())) / 3600000) * 10) / 10;
    let sys = Memory.buildSystemText(ch, s, state.settings) +
      "\n\n【场景】你们有一阵子没联系了（大约 " + Math.max(0.1, hours) + " 小时）。" +
      "你现在用手机聊天软件【主动】发一条消息找对方，像真人发微信：一两句、口语、贴合你的性格与此刻的关系，" +
      "可以带点情绪或一件小事。不要自称 AI、不要旁白、不要 Markdown。";
    if (o.checkScene) sys += AUTO_SCENE_RULE;
    if (canImg) sys += shareRuleText();
    const res = await Api.summarize(state.settings, [
      { role: "system", content: sys },
      { role: "user", content: "（对方没有先说话，是你主动发的）" }
    ], { maxTokens: canImg ? 500 : 300 });
    if (res && res.usage) recordUsage(s.id, res.usage, s.characterId, "auto");
    const raw = (res && res.text) || "";
    if (autoSkipped(raw)) return { text: "", image: null };   /* 判定「在一块儿」→ 不发 */
    return parseShare(raw);
  }

  var api = {
    saveChar: saveChar, renderCharBar: renderCharBar, openRowMenu: openRowMenu,
    sessionDiarySave: sessionDiarySave, sessionDiaryClear: sessionDiaryClear,
    runAssistantSummary: runAssistantSummary,
    generateWorld: generateWorld, applyWorld: applyWorld,
    generateAutoMessage: generateAutoMessage, applyAutoMessage: applyAutoMessage,
    generatePhoneShare: generatePhoneShare,
    renderSettingsMemory: renderSettingsMemory, runCharSplit: runCharSplit,
    fillCharacterForm: fillCharacterForm, saveCharacter: saveCharacter,
    openUpgrade: openUpgrade, doUpgrade: doUpgrade,
    /* 给回归测试用的纯函数（也方便以后别处复用） */
    htmlToText: htmlToText, fillPhoneFromWorld: fillPhoneFromWorld,
    charMissingFields: charMissingFields, renderCharReadyHint: renderCharReadyHint,
    newCharacter: newCharacter, openPresetPicker: openPresetPicker, usePreset: usePreset,
    updateCognitionNow: updateCognitionNow,
    updateRelationSharedNow: updateRelationSharedNow, mergeGroupShared: mergeGroupShared,
    runMemoryCorrect: runMemoryCorrect, runReCompress: runReCompress,
    washFilterNow: washFilterNow, aiFilterRule: aiFilterRule,
    maybeAutoWash: maybeAutoWash, maybeAutoScene: maybeAutoScene, maybeDailyRefresh: maybeDailyRefresh, openCharacterModal: openCharacterModal,
    maybeAutoCompress: maybeAutoCompress, importTavernCard: importTavernCard,
    syncSessionParamFields: syncSessionParamFields, fillSessionForm: fillSessionForm
  };
  Object.keys(api).forEach(function (k) {
    D[k] = function () { syncModules(); return api[k].apply(null, arguments); };
  });

  (window.__dlScripts = window.__dlScripts || []).push("roleplay.js");
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
