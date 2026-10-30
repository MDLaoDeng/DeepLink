/* Sekulum —— 界面渲染与交互 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  /* 头像解析由 app.js 注入（会话级 → 全局 → 内置图标） */
  let avatarResolver = null;
  function setAvatarResolver(fn) { avatarResolver = fn; }
  /* 群聊里每条消息可能来自不同成员 —— 按发言人取头像（同样由 app.js 注入） */
  let speakerResolver = null;
  function setSpeakerResolver(fn) { speakerResolver = fn; }
  function fillAvatar(box, role, sessionObj, msg) {
    let url = "";
    if (msg && msg.speaker && speakerResolver) url = speakerResolver(msg.speaker, sessionObj) || "";
    if (!url) url = avatarResolver ? avatarResolver(role, sessionObj) : "";
    box.innerHTML = "";
    if (url) {
      const im = document.createElement("img");
      im.src = url;
      im.alt = "";
      box.appendChild(im);
    } else {
      box.innerHTML = iconSvg(role === "user" ? "account" : "creation");
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function safeUrl(url) {
    const u = String(url || "").trim();
    return /^https?:\/\//i.test(u) ? u : "";
  }

  /* ── 图标（Material Design Icons，内联 SVG） ─────── */
  /* 图标路径取自 Material Design Icons（MDI，社区版 / Pictogrammers）。
     授权：**Apache 2.0**（图标与字体）＋ MIT（代码），可商用、GPL 友好、无强制署名；
     只有「品牌 / Logo」那一类不在此授权内 —— 这里一个都没用。
     项目主页：https://github.com/Templarian/MaterialDesign　许可证全文见上方链接。
     新增图标照抄 `d` 属性即可（24×24 视图框、单条 path）。
     ⚠️ 这个对象里**不要夹注释** —— deep_check.py 是按「逗号开头/行首」这一套正则扫 key 的，
     中间插一行注释会让紧跟其后的那个图标扫不到，误报「用到但 ICONS 里没有」。
     要写说明就写在对象外面（就像这里）。 */
  const ICONS = {
    menu: "M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z",
    plus: "M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z",
    /* 横排三点（10-19）：消息操作条收起后的入口，同时也是通用「更多」 */
    /* 表情入口：一个笑脸轮廓，比三个点更直白（10-19） */
    "emoticon-outline": "M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M9,9.5A1.5,1.5 0 0,1 10.5,11A1.5,1.5 0 0,1 9,12.5A1.5,1.5 0 0,1 7.5,11A1.5,1.5 0 0,1 9,9.5M15,9.5A1.5,1.5 0 0,1 16.5,11A1.5,1.5 0 0,1 15,12.5A1.5,1.5 0 0,1 13.5,11A1.5,1.5 0 0,1 15,9.5M12,15C14,15 15.7,14 16.5,12.5C16.3,14.9 14.4,17 12,17C9.6,17 7.7,14.9 7.5,12.5C8.3,14 10,15 12,15Z",
    "dots-horizontal": "M16,12A2,2 0 0,1 18,10A2,2 0 0,1 20,12A2,2 0 0,1 18,14A2,2 0 0,1 16,12M10,12A2,2 0 0,1 12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12M4,12A2,2 0 0,1 6,10A2,2 0 0,1 8,12A2,2 0 0,1 6,14A2,2 0 0,1 4,12Z",
    "arrow-left": "M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z",
    "book-outline": "M18,2A2,2 0 0,1 20,4V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V4A2,2 0 0,1 6,2H18M6,4V20H18V4H6M11,6H16V13L13.5,11.75L11,13V6Z",
    "settings-outline": "M19.43,12.98C19.47,12.66 19.5,12.34 19.5,12C19.5,11.66 19.47,11.34 19.43,11.02L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11.02C4.53,11.34 4.5,11.66 4.5,12C4.5,12.34 4.53,12.66 4.57,12.98L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.04 4.95,18.95L7.44,17.95C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.95L19.05,18.95C19.27,19.04 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.98M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5Z",
    paperclip: "M16.5,6V17.5A4,4 0 0,1 12.5,21.5A4,4 0 0,1 8.5,17.5V5A2.5,2.5 0 0,1 11,2.5A2.5,2.5 0 0,1 13.5,5V15.5A1,1 0 0,1 12.5,16.5A1,1 0 0,1 11.5,15.5V6H10V15.5A2.5,2.5 0 0,0 12.5,18A2.5,2.5 0 0,0 15,15.5V5A4,4 0 0,0 11,1A4,4 0 0,0 7,5V17.5A5.5,5.5 0 0,0 12.5,23A5.5,5.5 0 0,0 18,17.5V6H16.5Z",
    "arrow-up": "M13,20H11V8L5.5,13.5L4.08,12.08L12,4.16L19.92,12.08L18.5,13.5L13,8V20Z",
    "arrow-down": "M11,4H13V16L18.5,10.5L19.92,11.92L12,19.84L4.08,11.92L5.5,10.5L11,16V4Z",
    pin: "M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z",
    "pin-off": "M2,5.27L3.28,4L20,20.72L18.73,22L12.8,16.07V22H11.2V16H6V14L8,12V11.27L2,5.27M16,12L18,14V16H17.82L8,6.18V4H7V2H17V4H16V12Z",
    stop: "M18,18H6V6H18V18Z",
    close: "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z",
    "content-copy": "M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z",
    "file-document-outline": "M6,2A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2H6M6,4H13V9H18V20H6V4M8,12V14H16V12H8M8,16V18H13V16H8Z",
    "cog-outline": "M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10M10,22C9.75,22 9.54,21.82 9.5,21.58L9.13,18.93C8.5,18.68 7.96,18.34 7.44,17.94L4.95,18.95C4.73,19.03 4.46,18.95 4.34,18.73L2.34,15.27C2.21,15.05 2.27,14.78 2.46,14.63L4.57,12.97L4.5,12L4.57,11L2.46,9.37C2.27,9.22 2.21,8.95 2.34,8.73L4.34,5.27C4.46,5.05 4.73,4.96 4.95,5.05L7.44,6.05C7.96,5.66 8.5,5.32 9.13,5.07L9.5,2.42C9.54,2.18 9.75,2 10,2H14C14.25,2 14.46,2.18 14.5,2.42L14.87,5.07C15.5,5.32 16.04,5.66 16.56,6.05L19.05,5.05C19.27,4.96 19.54,5.05 19.66,5.27L21.66,8.73C21.79,8.95 21.73,9.22 21.54,9.37L19.43,11L19.5,12L19.43,13L21.54,14.63C21.73,14.78 21.79,15.05 21.66,15.27L19.66,18.73C19.54,18.95 19.27,19.04 19.05,18.95L16.56,17.95C16.04,18.34 15.5,18.68 14.87,18.93L14.5,21.58C14.46,21.82 14.25,22 14,22H10M11.25,4L10.88,6.61C9.68,6.86 8.62,7.5 7.85,8.39L5.44,7.35L4.69,8.65L6.8,10.2C6.4,11.37 6.4,12.64 6.8,13.8L4.68,15.36L5.43,16.66L7.86,15.62C8.63,16.5 9.68,17.14 10.87,17.38L11.24,20H12.76L13.13,17.39C14.32,17.14 15.37,16.5 16.14,15.62L18.57,16.66L19.32,15.36L17.2,13.81C17.6,12.64 17.6,11.37 17.2,10.2L19.31,8.65L18.56,7.35L16.15,8.39C15.38,7.5 14.32,6.86 13.12,6.62L12.75,4H11.25Z",
    "palette-outline": "M12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2C17.5,2 22,6 22,11A6,6 0 0,1 16,17H14.2C13.9,17 13.7,17.2 13.7,17.5C13.7,17.6 13.8,17.7 13.8,17.8C14.2,18.3 14.4,18.9 14.4,19.5C14.5,20.9 13.4,22 12,22M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C12.3,20 12.5,19.8 12.5,19.5C12.5,19.3 12.4,19.2 12.4,19.1C12,18.6 11.8,18.1 11.8,17.5C11.8,16.1 12.9,15 14.3,15H16A4,4 0 0,0 20,11C20,7.1 16.4,4 12,4M6.5,10C7.3,10 8,10.7 8,11.5C8,12.3 7.3,13 6.5,13C5.7,13 5,12.3 5,11.5C5,10.7 5.7,10 6.5,10M9.5,6C10.3,6 11,6.7 11,7.5C11,8.3 10.3,9 9.5,9C8.7,9 8,8.3 8,7.5C8,6.7 8.7,6 9.5,6M14.5,6C15.3,6 16,6.7 16,7.5C16,8.3 15.3,9 14.5,9C13.7,9 13,8.3 13,7.5C13,6.7 13.7,6 14.5,6M17.5,10C18.3,10 19,10.7 19,11.5C19,12.3 18.3,13 17.5,13C16.7,13 16,12.3 16,11.5C16,10.7 16.7,10 17.5,10Z",
    web: "M16.36,14C16.44,13.34 16.5,12.68 16.5,12C16.5,11.32 16.44,10.66 16.36,10H19.74C19.9,10.64 20,11.31 20,12C20,12.69 19.9,13.36 19.74,14M14.59,19.56C15.19,18.45 15.65,17.25 15.97,16H18.92C17.96,17.65 16.43,18.93 14.59,19.56M14.34,14H9.66C9.56,13.34 9.5,12.68 9.5,12C9.5,11.32 9.56,10.65 9.66,10H14.34C14.43,10.65 14.5,11.32 14.5,12C14.5,12.68 14.43,13.34 14.34,14M12,19.96C11.17,18.76 10.5,17.43 10.09,16H13.91C13.5,17.43 12.83,18.76 12,19.96M8,8H5.08C6.03,6.34 7.57,5.06 9.4,4.44C8.8,5.55 8.35,6.75 8,8M5.08,16H8C8.35,17.25 8.8,18.45 9.4,19.56C7.57,18.93 6.03,17.65 5.08,16M4.26,14C4.1,13.36 4,12.69 4,12C4,11.31 4.1,10.64 4.26,10H7.64C7.56,10.66 7.5,11.32 7.5,12C7.5,12.68 7.56,13.34 7.64,14M12,4.03C12.83,5.23 13.5,6.57 13.91,8H10.09C10.5,6.57 11.17,5.23 12,4.03M18.92,8H15.97C15.65,6.75 15.19,5.55 14.59,4.44C16.43,5.07 17.96,6.34 18.92,8M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z",
    "lightbulb-on-outline": "M20,11H23V13H20V11M1,11H4V13H1V11M13,1V4H11V1H13M4.92,3.5L7.05,5.64L5.63,7.05L3.5,4.93L4.92,3.5M16.95,5.63L19.07,3.5L20.5,4.93L18.37,7.05L16.95,5.63M12,6A6,6 0 0,1 18,12C18,14.22 16.79,16.16 15,17.2V19A1,1 0 0,1 14,20H10A1,1 0 0,1 9,19V17.2C7.21,16.16 6,14.22 6,12A6,6 0 0,1 12,6M14,21V22A1,1 0 0,1 13,23H11A1,1 0 0,1 10,22V21H14M11,18H13V15.87C14.73,15.43 16,13.86 16,12A4,4 0 0,0 12,8A4,4 0 0,0 8,12C8,13.86 9.27,15.43 11,15.87V18Z",
    creation: "M19,1L17.74,3.75L15,5L17.74,6.26L19,9L20.25,6.26L23,5L20.25,3.75M9,4L6.5,9.5L1,12L6.5,14.5L9,20L11.5,14.5L17,12L11.5,9.5M19,15L17.74,17.74L15,19L17.74,20.25L19,23L20.25,20.25L23,19L20.25,17.74",
    account: "M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z",
    "account-group": "M12,5.5A3.5,3.5 0 0,1 15.5,9A3.5,3.5 0 0,1 12,12.5A3.5,3.5 0 0,1 8.5,9A3.5,3.5 0 0,1 12,5.5M5,8C5.56,8 6.08,8.15 6.53,8.42C6.38,9.85 6.8,11.27 7.66,12.38C7.16,13.34 6.16,14 5,14A3,3 0 0,1 2,11A3,3 0 0,1 5,8M19,8A3,3 0 0,1 22,11A3,3 0 0,1 19,14C17.84,14 16.84,13.34 16.34,12.38C17.2,11.27 17.62,9.85 17.47,8.42C17.92,8.15 18.44,8 19,8M5.5,18.25C5.5,16.18 8.41,14.5 12,14.5C15.59,14.5 18.5,16.18 18.5,18.25V20H5.5V18.25M0,20V18.5C0,17.11 1.89,15.94 4.45,15.6C3.86,16.28 3.5,17.22 3.5,18.25V20H0M24,20H20.5V18.25C20.5,17.22 20.14,16.28 19.55,15.6C22.11,15.94 24,17.11 24,18.5V20Z",
    "chart-box-outline": "M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M19,19H5V5H19V19M7,15H9V17H7V15M11,15H13V17H11V15M15,15H17V17H15V15M7,11H9V13H7V11M11,11H13V13H11V11M15,11H17V13H15V11M7,7H9V9H7V7M11,7H13V9H11V7M15,7H17V9H15V7Z",
    "link-variant": "M10.59,13.41C11,13.8 11,14.44 10.59,14.83C10.2,15.22 9.56,15.22 9.17,14.83C7.22,12.88 7.22,9.71 9.17,7.76V7.76L12.71,4.22C14.66,2.27 17.83,2.27 19.78,4.22C21.73,6.17 21.73,9.34 19.78,11.29L18.29,12.78C18.3,11.96 18.17,11.14 17.89,10.36L18.36,9.88C19.54,8.71 19.54,6.81 18.36,5.64C17.19,4.46 15.29,4.46 14.12,5.64L10.59,9.17C9.41,10.34 9.41,12.24 10.59,13.41M13.41,9.17C13.8,8.78 14.44,8.78 14.83,9.17C16.78,11.12 16.78,14.29 14.83,16.24V16.24L11.29,19.78C9.34,21.73 6.17,21.73 4.22,19.78C2.27,17.83 2.27,14.66 4.22,12.71L5.71,11.22C5.7,12.04 5.83,12.86 6.11,13.65L5.64,14.12C4.46,15.29 4.46,17.19 5.64,18.36C6.81,19.54 8.71,19.54 9.88,18.36L13.41,14.83C14.59,13.66 14.59,11.76 13.41,10.59C13,10.2 13,9.56 13.41,9.17Z",
    "open-in-new": "M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z",
    "alert-circle-outline": "M11,15H13V17H11V15M11,7H13V13H11V7M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20Z",
    "check-circle-outline": "M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M12 20C7.59 20 4 16.41 4 12S7.59 4 12 4 20 7.59 20 12 16.41 20 12 20M16.59 7.58L10 14.17L7.41 11.59L6 13L10 17L18 9L16.59 7.58Z",
    "white-balance-sunny": "M3.55,18.54L4.96,19.95L6.76,18.16L5.34,16.74M11,22.45C11.32,22.45 13,22.45 13,22.45V19.5H11M12,5.5A6,6 0 0,0 6,11.5A6,6 0 0,0 12,17.5A6,6 0 0,0 18,11.5C18,8.18 15.31,5.5 12,5.5M20,12.5H23V10.5H20M17.24,18.16L19.04,19.95L20.45,18.54L18.66,16.74M20.45,4.46L19.04,3.05L17.24,4.84L18.66,6.26M13,0.55H11V3.5H13M4,10.5H1V12.5H4M6.76,4.84L4.96,3.05L3.55,4.46L5.34,6.26L6.76,4.84Z",
    "weather-night": "M17.75,4.09L15.22,6.03L16.13,9.09L13.5,7.28L10.87,9.09L11.78,6.03L9.25,4.09L12.44,4L13.5,1L14.56,4L17.75,4.09M21.25,11L19.61,12.25L20.2,14.23L18.5,13.06L16.8,14.23L17.39,12.25L15.75,11L17.81,10.95L18.5,9L19.19,10.95L21.25,11M18.97,15.95C19.8,15.87 20.69,17.05 20.16,17.8C19.84,18.25 19.5,18.67 19.08,19.07C15.17,23 8.84,23 4.94,19.07C1.03,15.17 1.03,8.83 4.94,4.93C5.34,4.53 5.76,4.17 6.21,3.85C6.96,3.32 8.14,4.21 8.06,5.04C7.79,7.9 8.75,10.87 10.95,13.06C13.14,15.26 16.1,16.22 18.97,15.95M17.33,17.97C14.5,17.81 11.7,16.64 9.53,14.5C7.36,12.31 6.2,9.5 6.04,6.68C3.23,9.82 3.34,14.64 6.35,17.66C9.37,20.67 14.19,20.78 17.33,17.97Z",
    "chevron-down": "M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z",
    "check": "M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z",
    "chevron-right": "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z",
    "chevron-left": "M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z",
    "alert-outline": "M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16Z",
    "alert-octagon-outline": "M8.27,3L3,8.27V15.73L8.27,21H15.73C17.5,19.24 21,15.73 21,15.73V8.27L15.73,3M9.1,5H14.9L19,9.1V14.9L14.9,19H9.1L5,14.9V9.1M11,15H13V17H11V15M11,7H13V13H11V7Z",
    "camera-outline": "M20,4H16.83L15,2H9L7.17,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V6A2,2 0 0,0 20,4M20,18H4V6H8.05L9.88,4H14.12L15.95,6H20V18M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15Z",
    "camera-flip-outline": "M20 5H16.83L15 3H9L7.17 5H4C2.9 5 2 5.9 2 7V19C2 20.11 2.9 21 4 21H20C21.11 21 22 20.11 22 19V7C22 5.9 21.11 5 20 5M20 19H4V7H8.05L9.88 5H14.12L16 7H20V19M5 12H7.1C7.65 9.29 10.29 7.55 13 8.1C13.76 8.25 14.43 8.59 15 9L13.56 10.45C13.11 10.17 12.58 10 12 10C10.74 10 9.6 10.8 9.18 12H11L8 15L5 12M16.91 14C16.36 16.71 13.72 18.45 11 17.9C10.25 17.74 9.58 17.41 9 17L10.44 15.55C10.9 15.83 11.43 16 12 16C13.27 16 14.41 15.2 14.83 14H13L16 11L19 14H16.91Z",
    "crop": "M7,17V1H5V5H1V7H5V17A2,2 0 0,0 7,19H17V23H19V19H23V17M17,15H19V7C19,5.89 18.1,5 17,5H9V7H17V15Z",
    "rotate-right": "M16.89,15.5L18.31,16.89C19.21,15.73 19.76,14.39 19.93,13H17.91C17.77,13.87 17.43,14.72 16.89,15.5M13,17.9V19.92C14.39,19.75 15.74,19.21 16.9,18.31L15.46,16.87C14.71,17.41 13.87,17.76 13,17.9M19.93,11C19.76,9.61 19.21,8.27 18.31,7.11L16.89,8.53C17.43,9.28 17.77,10.13 17.91,11M15.55,5.55L11,1V4.07C7.06,4.56 4,7.92 4,12C4,16.08 7.05,19.44 11,19.93V17.91C8.16,17.43 6,14.97 6,12C6,9.03 8.16,6.57 11,6.09V10L15.55,5.55Z",
    "draw": "M9.75 20.85C11.53 20.15 11.14 18.22 10.24 17C9.35 15.75 8.12 14.89 6.88 14.06C6 13.5 5.19 12.8 4.54 12C4.26 11.67 3.69 11.06 4.27 10.94C4.86 10.82 5.88 11.4 6.4 11.62C7.31 12 8.21 12.44 9.05 12.96L10.06 11.26C8.5 10.23 6.5 9.32 4.64 9.05C3.58 8.89 2.46 9.11 2.1 10.26C1.78 11.25 2.29 12.25 2.87 13.03C4.24 14.86 6.37 15.74 7.96 17.32C8.3 17.65 8.71 18.04 8.91 18.5C9.12 18.94 9.07 18.97 8.6 18.97C7.36 18.97 5.81 18 4.8 17.36L3.79 19.06C5.32 20 7.88 21.47 9.75 20.85M20.84 5.25C21.06 5.03 21.06 4.67 20.84 4.46L19.54 3.16C19.33 2.95 18.97 2.95 18.76 3.16L17.74 4.18L19.82 6.26M11 10.92V13H13.08L19.23 6.85L17.15 4.77L11 10.92Z",
    "arrow-top-right": "M5,17.59L15.59,7H9V5H19V15H17V8.41L6.41,19L5,17.59Z",
    "format-text": "M18.5,4L19.66,8.35L18.7,8.61C18.25,7.74 17.79,6.87 17.26,6.43C16.73,6 16.11,6 15.5,6H13V16.5C13,17 13,17.5 13.33,17.75C13.67,18 14.33,18 15,18V19H9V18C9.67,18 10.33,18 10.67,17.75C11,17.5 11,17 11,16.5V6H8.5C7.89,6 7.27,6 6.74,6.43C6.21,6.87 5.75,7.74 5.3,8.61L4.34,8.35L5.5,4H18.5Z",
    "undo-variant": "M13.5,7A6.5,6.5 0 0,1 20,13.5A6.5,6.5 0 0,1 13.5,20H10V18H13.5C16,18 18,16 18,13.5C18,11 16,9 13.5,9H7.83L10.91,12.09L9.5,13.5L4,8L9.5,2.5L10.92,3.91L7.83,7H13.5M6,18H8V20H6V18Z",
    "flashlight": "M9,10L6,5H18L15,10H9M18,4H6V2H18V4M9,22V11H15V22H9M12,13A1,1 0 0,0 11,14A1,1 0 0,0 12,15A1,1 0 0,0 13,14A1,1 0 0,0 12,13Z",
    "flashlight-off": "M2,5.27L3.28,4L20,20.72L18.73,22L15,18.27V22H9V12.27L2,5.27M18,5L15,10H11.82L6.82,5H18M18,4H6V2H18V4M15,11V13.18L12.82,11H15Z",
    microphone: "M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z",
    "microphone-off": "M19,11C19,12.19 18.66,13.3 18.1,14.28L16.87,13.05C17.14,12.43 17.3,11.74 17.3,11H19M15,11.16L9,5.18V5A3,3 0 0,1 12,2A3,3 0 0,1 15,5V11L15,11.16M4.27,3L21,19.73L19.73,21L15.54,16.81C14.77,17.27 13.91,17.58 13,17.72V21H11V17.72C7.72,17.23 5,14.41 5,11H6.7C6.7,14 9.24,16.1 12,16.1C12.81,16.1 13.6,15.91 14.31,15.58L12.65,13.92L12,14A3,3 0 0,1 9,11V10.28L3,4.27L4.27,3Z",
    "image-outline": "M19,19H5V5H19M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M13.96,12.29L11.21,15.83L9.25,13.47L6.5,17H17.5L13.96,12.29Z",
    "volume-high": "M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16C15.5,15.29 16.5,13.76 16.5,12M3,9V15H7L12,20V4L7,9H3Z",
    "volume-off": "M12,4L9.91,6.09L12,8.18M4.27,3L3,4.27L7.73,9H3V15H7L12,20V13.27L16.25,17.53C15.58,18.04 14.83,18.46 14,18.7V20.77C15.38,20.45 16.63,19.82 17.68,18.96L19.73,21L21,19.73L12,10.73M19,12C19,12.94 18.8,13.82 18.46,14.64L19.97,16.15C20.62,14.91 21,13.5 21,12C21,7.72 18,4.14 14,3.23V5.29C16.89,6.15 19,8.83 19,12M16.5,12C16.5,10.23 15.5,8.71 14,7.97V10.18L16.45,12.63C16.5,12.43 16.5,12.21 16.5,12Z",
    "information-outline": "M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z",
    "message-text-outline": "M20,2A2,2 0 0,1 22,4V16A2,2 0 0,1 20,18H6L2,22V4C2,2.89 2.9,2 4,2H20M4,4V17.17L5.17,16H20V4H4M6,7H18V9H6V7M6,11H15V13H6V11Z",
    "message-dots-outline": "M20,2A2,2 0 0,1 22,4V16A2,2 0 0,1 20,18H6L2,22V4C2,2.89 2.9,2 4,2H20M4,4V17.17L5.17,16H20V4H4M7,8A1.5,1.5 0 0,1 8.5,9.5A1.5,1.5 0 0,1 7,11A1.5,1.5 0 0,1 5.5,9.5A1.5,1.5 0 0,1 7,8M12,8A1.5,1.5 0 0,1 13.5,9.5A1.5,1.5 0 0,1 12,11A1.5,1.5 0 0,1 10.5,9.5A1.5,1.5 0 0,1 12,8M17,8A1.5,1.5 0 0,1 18.5,9.5A1.5,1.5 0 0,1 17,11A1.5,1.5 0 0,1 15.5,9.5A1.5,1.5 0 0,1 17,8Z",
    "message-plus-outline": "M20,2A2,2 0 0,1 22,4V16A2,2 0 0,1 20,18H6L2,22V4C2,2.89 2.9,2 4,2H20M4,4V17.17L5.17,16H20V4H4M11,5H13V8H16V10H13V13H11V10H8V8H11V5Z",
    "clock-outline": "M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z",
    "pencil-outline": "M14.06,9L15,9.94L5.92,19H5V18.08L14.06,9M17.66,3C17.41,3 17.15,3.1 16.96,3.29L15.13,5.12L18.88,8.87L20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18.17,3.09 17.92,3 17.66,3M14.06,6.19L3,17.25V21H6.75L17.81,9.94L14.06,6.19Z",
    "magnify": "M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z",
    "refresh": "M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z",
    "delete-outline": "M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H16V19H8V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z",
    "select-multiple": "M18 12H20V14H18V12M14 16H16V18H14V16M20 17C20 17.55 19.55 18 19 18H18V16H20V17M7 4H8V6H6V5C6 4.45 6.45 4 7 4M19 4C19.55 4 20 4.45 20 5V6H18V4H19M14 6V4H16V6H14M10 6V4H12V6H10M10 18V16H12V18H10M7 18C6.45 18 6 17.55 6 17V16H8V18H7M6 12H8V14H6V12M6 8H8V10H6V8M20 8V10H18V8H20M3 8H4V20H16V21C16 21.54 15.57 22 15.03 22H15L3 22C2.45 22 2 21.55 2 21V9C2 8.45 2.45 8 3 8Z",
    "lock-outline": "M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z",
    "lock-open-variant-outline": "M18 1C15.24 1 13 3.24 13 6V8H4C2.9 8 2 8.89 2 10V20C2 21.11 2.9 22 4 22H16C17.11 22 18 21.11 18 20V10C18 8.9 17.11 8 16 8H15V6C15 4.34 16.34 3 18 3C19.66 3 21 4.34 21 6V8H23V6C23 3.24 20.76 1 18 1M16 10L16 20H4V10H16M10 17C11.1 17 12 16.1 12 15C12 13.9 11.1 13 10 13C8.9 13 8 13.9 8 15C8 16.1 8.9 17 10 17Z",
    "shield-key-outline": "M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,3.18L19,6.3V11.22C19,12.92 18.5,14.65 17.65,16.17C16,17.5 13.9,18.4 12,18.75C10.1,18.4 8,17.5 6.35,16.17C5.5,14.65 5,12.92 5,11.22V6.3L12,3.18M12,9A2,2 0 0,1 14,11C14,11.74 13.6,12.37 13,12.72V16H11V12.72C10.4,12.37 10,11.74 10,11A2,2 0 0,1 12,9Z",
    "help-circle-outline": "M11,18H13V16H11V18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,6A4,4 0 0,0 8,10H10A2,2 0 0,1 12,8A2,2 0 0,1 14,10C14,12 11,11.75 11,15H13C13,12.75 16,12.5 16,10A4,4 0 0,0 12,6Z",
    "exit-to-app": "M19,3H5C3.89,3 3,3.9 3,5V9H5V5H19V19H5V15H3V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.9 20.1,3 19,3M10.08,15.58L11.5,17L16.5,12L11.5,7L10.08,8.41L12.67,11H3V13H12.67L10.08,15.58Z",
    "cellphone": "M17,19H7V5H17M17,1H7C5.89,1 5,1.89 5,3V21A2,2 0 0,0 7,23H17A2,2 0 0,0 19,21V3A2,2 0 0,0 17,1Z",
    "phone-outline": "M20,15.5C18.75,15.5 17.55,15.3 16.43,14.93C16.08,14.82 15.69,14.9 15.41,15.18L13.21,17.38C10.38,15.94 8.06,13.62 6.62,10.79L8.82,8.59C9.1,8.31 9.18,7.92 9.07,7.57C8.7,6.45 8.5,5.25 8.5,4A1,1 0 0,0 7.5,3H4A1,1 0 0,0 3,4A17,17 0 0,0 20,21A1,1 0 0,0 21,20V16.5A1,1 0 0,0 20,15.5Z",
    "phone-hangup": "M12,9C10.4,9 8.85,9.25 7.4,9.72V12.82C7.4,13.22 7.17,13.56 6.84,13.72C5.86,14.21 4.97,14.84 4.17,15.59C4,15.75 3.79,15.83 3.56,15.83C3.33,15.83 3.12,15.75 2.95,15.58L0.44,13.07C0.28,12.91 0.2,12.7 0.2,12.47C0.2,12.24 0.28,12.03 0.44,11.87C3.28,9.08 7.39,7.5 12,7.5C16.61,7.5 20.72,9.08 23.56,11.87C23.72,12.03 23.8,12.24 23.8,12.47C23.8,12.7 23.72,12.91 23.56,13.07L21.05,15.58C20.88,15.75 20.67,15.83 20.44,15.83C20.21,15.83 20,15.75 19.83,15.58C19.03,14.83 18.14,14.2 17.16,13.71C16.83,13.55 16.6,13.21 16.6,12.81V9.72C15.15,9.25 13.6,9 12,9Z",
    "cash": "M3,6H21V18H3V6M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9M7,8A2,2 0 0,1 5,10V14A2,2 0 0,1 7,16H17A2,2 0 0,1 19,14V10A2,2 0 0,1 17,8H7Z",
    "map-marker-outline": "M12,6.5A2.5,2.5 0 0,1 14.5,9A2.5,2.5 0 0,1 12,11.5A2.5,2.5 0 0,1 9.5,9A2.5,2.5 0 0,1 12,6.5M12,2A7,7 0 0,1 19,9C19,14.25 12,22 12,22C12,22 5,14.25 5,9A7,7 0 0,1 12,2M12,4A5,5 0 0,0 7,9C7,10 7,12 12,18.71C17,12 17,10 17,9A5,5 0 0,0 12,4Z",
    "video-outline": "M15,8V16H5V8H15M16,6H4C3.45,6 3,6.45 3,7V17C3,17.55 3.45,18 4,18H16C16.55,18 17,17.55 17,17V13.5L21,17.5V6.5L17,10.5V7C17,6.45 16.55,6 16,6Z"
  };

  function iconSvg(name) {
    const d = ICONS[name];
    if (!d) return "";
    return '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  function applyIcons(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((el) => {
      const svg = iconSvg(el.getAttribute("data-icon"));
      if (svg) el.innerHTML = svg;
    });
  }

  /* 把文本里的表情字符 / [[s:id]] 换成图片。只在气泡里跑，pre、code 里跳过。 */
  /* ── 表情正则缓存（OPT-07）──────────────────────────────────
     以前每条气泡都重编译一遍：48 个字符交替 + 逐个转义 + new RegExp。
     一屏 20 条气泡就是 20 次编译，纯浪费。按「表情字符清单」做 key 缓存，
     表情包变了才重建。re 带 g 标志，但只用于 String.replace（replace 结束会把
     lastIndex 归零），复用是安全的。 */
  var emojiCache = { key: "", re: null, charMap: null, alts: null };

  function emojiCompiled(pack) {
    const charMap = {};
    const alts = [];
    pack.forEach((it) => { if (it.e && it.src) { charMap[it.e] = it; alts.push(it.e); } });
    /* key 必须带上 src：只按字符做 key 的话，同一个字符换了图片时缓存不失效，
       界面会一直显示旧图（现在 EMOJI_PACK 是静态的所以碰不到，将来支持编辑就会踩）。 */
    const key = pack.filter((it) => it && it.e && it.src)
      .map((it) => it.e + "\u0001" + String(it.src).length + ":" + String(it.src).slice(-24))
      .join("|");
    if (emojiCache.key === key && emojiCache.re) return emojiCache;
    /* 长的放前面，避免短字符先匹配掉半个组合 */
    alts.sort((x, y) => y.length - x.length);
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const src = "\\[\\[s:[a-z0-9]+\\]\\]|\\[表情:[^\\]]+\\]" + (alts.length ? "|" + alts.map(esc).join("|") : "");
    emojiCache = { key: key, re: new RegExp("(" + src + ")", "g"), charMap: charMap, alts: alts };
    return emojiCache;
  }

  function stickerize(root) {
    if (!root) return;
    const pack = (window.CONFIG && window.CONFIG.EMOJI_PACK) || [];
    const stickers = (window.DL && window.DL.state && window.DL.state.settings && window.DL.state.settings.stickers) || [];
    if (!pack.length && !stickers.length) return;
    const compiled = emojiCompiled(pack);
    const charMap = compiled.charMap;
    const alts = compiled.alts;
    if (!alts.length && !stickers.length) return;
    const stickMap = {};
    stickers.forEach((st) => { if (st && st.id) stickMap[st.id] = st; });
    /* 存的是外置文件路径就换成可用 URL（10-19：贴纸也开始外置了） */
    const toUrl = (v) => {
      const x = String(v || "");
      if (!x || x.slice(0, 5) === "data:") return x;
      try { return (window.DL && window.DL.avatarUrl && window.DL.avatarUrl(x)) || ""; } catch (e) { return ""; }
    };
    const re = compiled.re;
    re.lastIndex = 0;      /* 复用同一个正则，保险起见每次从头开始 */

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const jobs = [];
    let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue || "";
      if (!t) continue;
      if (t.indexOf("[[s:") < 0 && t.indexOf("[表情") < 0 && !alts.some((ch) => t.indexOf(ch) >= 0)) continue;
      const p = node.parentNode;
      if (p && p.closest && p.closest("pre, code, .code-block")) continue;
      jobs.push(node);
    }
    jobs.forEach((nd) => {
      const text = nd.nodeValue || "";
      const frag = document.createDocumentFragment();
      let last = 0;
      text.replace(re, (m, _hit, offset) => {
        if (offset > last) frag.appendChild(document.createTextNode(text.slice(last, offset)));
        const tok = /^\[\[s:([a-z0-9]+)\]\]$/.exec(m);
        if (tok) {
          const st = stickMap[tok[1]];
          if (st && st.src) {
            const im = document.createElement("img");
            im.className = "stk-big";
            im.src = toUrl(st.src);
            im.alt = st.name || "表情";
            frag.appendChild(im);
          } else {
            frag.appendChild(document.createTextNode(m));
          }
        } else if (m.slice(0, 3) === "[表情") {
          /* 模型按提示词写的 [表情:名字] —— 先查自添加（提示词里也列了它们），
             再查内置包；都查不到才原样留着。
             10-19 修：原来只查内置包，模型照提示词发自添加表情的名字会变成一串文字。 */
          const nm = m.replace(/^\[表情:/, "").replace(/\]$/, "").trim();
          const mine = stickers.filter((x) => x && x.name === nm && (x.scope || "both") !== "me")[0];
          const hit = mine || pack.filter((x) => x.n === nm)[0];
          if (hit && hit.src) {
            const im = document.createElement("img");
            im.className = mine ? "stk-big" : "stk";
            im.src = toUrl(hit.src);
            im.alt = hit.name || hit.n || nm;
            frag.appendChild(im);
          } else {
            frag.appendChild(document.createTextNode(m));
          }
        } else {
          const it = charMap[m];
          const im = document.createElement("img");
          im.className = "stk";
          im.src = toUrl(it.src);
          im.alt = it.n || m;
          frag.appendChild(im);
        }
        last = offset + m.length;
        return m;
      });
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      if (nd.parentNode) nd.parentNode.replaceChild(frag, nd);
    });
  }

  /* GitHub 提醒框的图标 */
  const ALERT_ICON = {
    note: "information-outline",
    tip: "lightbulb-on-outline",
    important: "alert-circle-outline",
    warning: "alert-outline",
    caution: "alert-octagon-outline"
  };

  const ACTIONS = {
    assistant: [
      ["edit", "pencil-outline", "修改"],
      ["read", "volume-high", "朗读"],
      ["search", "magnify", "搜索"],
      ["copy", "content-copy", "复制"],
      ["regen", "refresh", "重新说"],
      ["rollback", "undo-variant", "回溯到此刻"],
      ["delete", "delete-outline", "删除"]
    ],
    user: [
      ["edit", "pencil-outline", "修改消息"],
      ["resend", "refresh", "重新说"],
      ["read", "volume-high", "朗读"],
      ["search", "magnify", "搜索"],
      ["copy", "content-copy", "复制"],
      ["rollback", "undo-variant", "回溯到此刻"],
      ["delete", "delete-outline", "删除"],
      ["multi", "select-multiple", "多选"]
    ]
  };

  function actionBtn(name, icon, label, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls || ("act-btn" + (name === "read" ? " read-act" : ""));
    b.setAttribute("data-act", name);
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = iconSvg(icon);
    return b;
  }

  function msgActionsEl(msg) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    /* 10-19 用户口径：一排按钮收成一个「⋯」，点开才浮出来。
       按钮仍是 .msg-actions 的直接子节点 —— test_r9 / test_r13 有断言依赖 parentNode
       就是这条栏，套一层容器会把那些断言弄红。 */
    const more = document.createElement("button");
    more.type = "button";
    more.className = "act-btn act-more";
    more.setAttribute("data-more", "1");
    more.setAttribute("aria-label", "更多操作");
    more.title = "更多操作";
    more.innerHTML = iconSvg("dots-horizontal");
    bar.appendChild(more);
    more.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = bar.classList.contains("open");
      closeActMenus();
      if (!open) bar.classList.add("open");
    });
    /* 开场白那条：只留「修改 / 朗读 / 复制」。
       它是角色卡带来的第一句，重说、回溯、删除都没有意义（删了还找不回来）。 */
    const all = msg.role === "user" ? ACTIONS.user : ACTIONS.assistant;
    const list = msg.intro ? all.filter(function (a) {
      return a[0] === "edit" || a[0] === "read" || a[0] === "copy";
    }) : all;
    list.forEach((a) => bar.appendChild(actionBtn(a[0], a[1], a[2])));
    return bar;
  }

  /* 收起所有展开的操作条。点空白、点某一项操作、或点另一条的「⋯」都收。 */
  function closeActMenus() {
    const open = document.querySelectorAll(".msg-actions.open");
    for (let i = 0; i < open.length; i++) open[i].classList.remove("open");
  }
  /* 只挂一次（ui.js 加载时就挂）。用捕获阶段：先收菜单，再让 app.js 的
     [data-act] 委派去执行具体操作，顺序不会互相挡。 */
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const bar = t.closest(".msg-actions");
    if (!bar) { closeActMenus(); return; }
    /* 点了菜单里的某一项（不是「⋯」本身）→ 收起来 */
    if (t.closest(".act-btn") && !t.closest(".act-more")) closeActMenus();
  }, true);

  /* 多版本时的 ‹ n/m › 切换（点击由 app.js 的事件委派处理） */
  function variantsEl(msg) {
    const box = document.createElement("div");
    box.className = "variants";
    const mk = (step, icon, label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "variant-btn";
      b.setAttribute("data-vstep", String(step));
      b.setAttribute("aria-label", label);
      b.title = label;
      b.innerHTML = iconSvg(icon);
      return b;
    };
    const count = document.createElement("span");
    count.className = "variant-count";
    count.textContent = (msg.variantIndex + 1) + "/" + msg.variantCount;
    const prev = mk(-1, "chevron-left", "上一版本");
    const next = mk(1, "chevron-right", "下一版本");
    prev.disabled = msg.variantIndex <= 0;
    next.disabled = msg.variantIndex >= msg.variantCount - 1;
    box.appendChild(prev);
    box.appendChild(count);
    box.appendChild(next);
    return box;
  }

  /* ── Markdown ──────────────────────────────────── */
  function inline(raw) {
    const codes = [];
    let s = escapeHtml(raw).replace(/`([^`\n]+)`/g, (m, c) => {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    /* 图片（必须在链接之前） */
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g, (m, alt, url) => {
      const u = safeUrl(url.replace(/&amp;/g, "&"));
      return u ? '<img src="' + escapeHtml(u) + '" alt="' + alt + '" loading="lazy">' : alt;
    });
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)[^)]*\)/g, (m, t, url) => {
      const u = safeUrl(url.replace(/&amp;/g, "&"));
      return u ? '<a href="' + escapeHtml(u) + '" target="_blank" rel="noopener">' + t + "</a>" : t;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    /* 自动链接 <https://…> */
    s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g,
      (m, url) => '<a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>");
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      (m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>");
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + codes[+i] + "</code>");
    return s;
  }

  function renderBlocks(text) {
    const lines = String(text || "").split("\n");
    let out = "";
    let para = [];
    const stack = [];   /* 列表栈：{ type, indent } */

    function flushPara() {
      if (para.length) { out += "<p>" + para.map((l) => inline(l.replace(/\\$/, ""))).join("<br>") + "</p>"; para = []; }
    }
    function closeAllLists() { while (stack.length) out += "</" + stack.pop().type + ">"; }
    function openList(type, indent, start) {
      while (stack.length && indent < stack[stack.length - 1].indent) out += "</" + stack.pop().type + ">";
      const top = stack[stack.length - 1];
      if (top && top.indent === indent) {
        if (top.type === type) return;
        out += "</" + stack.pop().type + ">";
      }
      out += "<" + type + (type === "ol" && start && start !== 1 ? ' start="' + start + '"' : "") + ">";
      stack.push({ type, indent });
    }
    /* 列表项（支持 - [ ] / - [x] 任务列表） */
    function listItem(content) {
      const t = /^\[([ xX])\]\s+/.exec(content);
      if (!t) return "<li>" + inline(content) + "</li>";
      return '<li class="md-task"><input type="checkbox" disabled' + (t[1] === " " ? "" : " checked") + "><span>" + inline(content.slice(t[0].length)) + "</span></li>";
    }
    /* 表格分隔行，如 | --- | :--: | */
    function isTableDelim(line) {
      const t = line.trim();
      return t.indexOf("|") >= 0 && t.indexOf("-") >= 0 && /^\|?[\s:|-]+\|?$/.test(t);
    }
    function tableCells(line) {
      let s = line.trim();
      if (s.charAt(0) === "|") s = s.slice(1);
      if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
      return s.split("|").map((c) => c.trim());
    }

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].replace(/\s+$/, "");
      if (!line.trim()) { flushPara(); closeAllLists(); continue; }

      let m;
      if (line.indexOf("|") >= 0 && li + 1 < lines.length && isTableDelim(lines[li + 1])) {
        flushPara(); closeAllLists();
        const head = tableCells(line);
        const aligns = tableCells(lines[li + 1]).map((c) => {
          const l = c.charAt(0) === ":";
          const r = c.charAt(c.length - 1) === ":";
          return l && r ? "center" : (r ? "right" : (l ? "left" : ""));
        });
        const rows = [];
        li += 2;
        while (li < lines.length && lines[li].trim() && lines[li].indexOf("|") >= 0) {
          rows.push(tableCells(lines[li]));
          li++;
        }
        li--;
        const al = (k) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "");
        out += '<div class="table-wrap"><table><thead><tr>' +
          head.map((h, k) => "<th" + al(k) + ">" + inline(h) + "</th>").join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + head.map((_, k) => "<td" + al(k) + ">" + inline(r[k] || "") + "</td>").join("") + "</tr>").join("") +
          "</tbody></table></div>";
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flushPara(); closeAllLists();
        const lv = Math.min(m[1].length, 3);
        out += "<h" + lv + ">" + inline(m[2]) + "</h" + lv + ">";
        continue;
      }
      /* Setext 标题：上一行是普通段落时，=== / --- 变成标题 */
      if (para.length && /^=+\s*$/.test(line)) { const t = para.join(" "); para = []; closeAllLists(); out += "<h1>" + inline(t) + "</h1>"; continue; }
      if (para.length && /^-+\s*$/.test(line)) { const t = para.join(" "); para = []; closeAllLists(); out += "<h2>" + inline(t) + "</h2>"; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); closeAllLists(); out += "<hr>"; continue; }
      /* 引用，支持多行、嵌套与 GitHub 提醒框 */
      if (/^\s*>/.test(line)) {
        flushPara(); closeAllLists();
        const bq = [];
        while (li < lines.length && /^\s*>/.test(lines[li])) { bq.push(lines[li].replace(/^\s*>\s?/, "")); li++; }
        li--;
        const am = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec((bq[0] || "").trim());
        if (am) {
          const type = am[1].toLowerCase();
          out += '<div class="md-alert ' + type + '"><div class="md-alert-title">' + iconSvg(ALERT_ICON[type]) + "<span>" + am[1].toUpperCase() + '</span></div><div class="md-alert-body">' + renderBlocks(bq.slice(1).join("\n")) + "</div></div>";
        } else {
          out += "<blockquote>" + renderBlocks(bq.join("\n")) + "</blockquote>";
        }
        continue;
      }
      if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
        flushPara();
        openList("ul", m[1].replace(/\t/g, "  ").length);
        out += listItem(m[2]);
        continue;
      }
      if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        openList("ol", m[1].replace(/\t/g, "  ").length, Number(m[2]));
        out += listItem(m[3]);
        continue;
      }
      closeAllLists();
      para.push(line);
    }
    flushPara(); closeAllLists();
    return out;
  }

  function codeBlockHtml(lang, code, unterminated) {
    const label = escapeHtml(lang || "code");
    return '<div class="code-block">' +
      '<div class="code-head"><span>' + label + (unterminated ? " …" : "") + "</span>" +
      '<button class="copy-btn" type="button" aria-label="复制">' + iconSvg("content-copy") + "复制</button></div>" +
      "<pre><code>" + escapeHtml(code.replace(/\n$/, "")) + "</code></pre></div>";
  }

  /* ── 富文本：酒馆卡里的 HTML 在聊天气泡里渲染 ──────────────
     用户口径（10-17）：原卡的富文本要在**聊天界面**看到渲染效果，不再被剥成纯文本。
     做法是「白名单重建」——解析成 DOM，只保留认识的标签和属性，其余连内容一起丢。
     绝不对原始字符串直接 innerHTML：那等于把角色卡当代码执行。
     原卡的 CSS 也一律不带进来（只保留结构），否则会污染整个界面。 */
  /* 酒馆卡里常带行内样式（颜色、字号）。全丢会让作者做的排版消失，
     全留又是注入面 —— 所以只放行这几个属性，值里出现 url(/expression/javascript: 一律丢。 */
  const RICH_CSS_OK = ["color", "background-color", "font-size", "font-weight", "font-style",
    "text-align", "text-decoration", "line-height", "font-family", "letter-spacing"];
  function safeStyle(v) {
    const s = String(v || "");
    if (!s) return "";
    const out = [];
    s.split(";").forEach(function (one) {
      const i = one.indexOf(":");
      if (i < 0) return;
      const k = one.slice(0, i).trim().toLowerCase();
      const val = one.slice(i + 1).trim();
      if (RICH_CSS_OK.indexOf(k) < 0) return;
      if (!val || /[<>\\{}]|url\s*\(|expression|javascript:/i.test(val)) return;
      if (val.length > 60) return;
      out.push(k + ":" + val);
    });
    return out.join(";");
  }
  /* <font color="red"> 是酒馆卡的老写法，映射成 span 的 color */
  function safeColor(v) {
    const c = String(v || "").trim();
    if (!c) return "";
    if (/^#[0-9a-f]{3,8}$/i.test(c)) return c;
    if (/^[a-z]{3,20}$/i.test(c)) return c;
    if (/^rgba?\(\s*[\d\s.,%]{3,40}\)$/i.test(c)) return c;
    return "";
  }

  const RICH_TAGS = {
    P: 1, BR: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, DEL: 1, SUB: 1, SUP: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, HR: 1, CODE: 1, PRE: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1,
    DETAILS: 1, SUMMARY: 1, SPAN: 1, DIV: 1, A: 1, IMG: 1
  };
  /* 这些标签整块丢掉（连里面的文字一起）——保留内容反而会把脚本源码显示出来 */
  const RICH_DROP = {
    SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1,
    FORM: 1, INPUT: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1,
    SVG: 1, VIDEO: 1, AUDIO: 1, SOURCE: 1, CANVAS: 1, TEMPLATE: 1, NOSCRIPT: 1
  };

  function sanitizeRich(html) {
    let parsed = null;
    try { parsed = new DOMParser().parseFromString(String(html || ""), "text/html"); }
    catch (e) { return escapeHtml(html); }
    const body = parsed && parsed.body;
    if (!body) return escapeHtml(html);
    const out = [];
    (function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) { out.push(escapeHtml(node.nodeValue)); return; }
      if (node.nodeType !== 1) return;
      const tag = String(node.tagName || "").toUpperCase();
      if (RICH_DROP[tag]) return;                       /* 整块丢弃 */
      /* <font color> 单独处理：它不在白名单里，但直接拆壳会把颜色丢掉 */
      if (tag === "FONT") {
        const c = safeColor(node.getAttribute("color"));
        if (c) out.push('<span style="color:' + escapeHtml(c) + '">');
        const kf = node.childNodes;
        for (let i = 0; i < kf.length; i++) walk(kf[i]);
        if (c) out.push("</span>");
        return;
      }
      if (!RICH_TAGS[tag]) {                            /* 不认识的标签：拆壳留字 */
        const kids = node.childNodes;
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
        return;
      }
      if (tag === "A") {
        const href = safeUrl(node.getAttribute("href"));
        out.push('<a class="dl-rich-a"');
        if (href) out.push(' href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"');
        out.push(">");
        const kids = node.childNodes;
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
        out.push("</a>");
        return;
      }
      if (tag === "IMG") {
        const src = String(node.getAttribute("src") || "").trim();
        /* 只放行网络图与内联图；本机路径、file:// 一律不渲染 */
        if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) {
          /* alt 保留（10-20）：图挂了还能看到作者写的说明 */
          const alt = String(node.getAttribute("alt") || "").slice(0, 120);
          out.push('<img class="dl-rich-img" src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '">');
        }
        return;
      }
      const lower = tag.toLowerCase();
      const st = safeStyle(node.getAttribute("style"));
      out.push("<" + lower + (st ? ' style="' + escapeHtml(st) + '"' : "") + ">");
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
      out.push("</" + lower + ">");
    })(body);
    return out.join("");
  }

  /* 像不像一段富文本：至少两个标签，或者**一个自闭合标签**（br / hr / img）也算。
     10-20 修：酒馆卡里「一句话 + 一个 <br>」很常见，阈值卡 2 会被当成普通文本，
     结果把 &lt;br&gt; 原样显示出来。 */
  function looksRich(src) {
    const s = String(src || "");
    if (s.indexOf("<") < 0) return false;
    const m = s.match(/<\/?(p|div|h[1-6]|br|hr|img|b|strong|i|em|u|ul|ol|li|blockquote|table|span|details|summary|font)\b[^>]*>/gi);
    if (!m || !m.length) return false;
    if (m.length >= 2) return true;
    return /^<\s*(br|hr|img|font)\b/i.test(m[0]);
  }

  function renderRich(src) {
    return '<div class="dl-rich">' + sanitizeRich(src) + "</div>";
  }

  function renderMarkdown(src) {
    /* 富文本优先：含代码块的跳过（代码里的 HTML 不该被渲染） */
    const raw = String(src == null ? "" : src);
    if (raw.indexOf("```") < 0 && looksRich(raw)) return renderRich(raw);
    const text = raw.replace(/\r\n/g, "\n");
    let out = "";
    let pos = 0;
    while (true) {
      const open = text.indexOf("```", pos);
      if (open < 0) { out += renderBlocks(text.slice(pos)); break; }
      out += renderBlocks(text.slice(pos, open));
      const lineEnd = text.indexOf("\n", open);
      const lang = (lineEnd < 0 ? "" : text.slice(open + 3, lineEnd)).trim();
      const codeStart = lineEnd < 0 ? text.length : lineEnd + 1;
      const close = text.indexOf("```", codeStart);
      if (close < 0) {
        out += codeBlockHtml(lang, text.slice(codeStart), true);
        break;
      }
      out += codeBlockHtml(lang, text.slice(codeStart, close), false);
      pos = close + 3;
    }
    return out;
  }

  /* 思考面板的折叠动画：原生 <details> 展开会重放 .body 的 fade-slide，
     收起却是瞬时的 —— 不对称。这里拦一次：展开态点击先播收起动画，
     动画结束（或 260ms 兜底）再真正把 open 关掉。关闭态照走原生展开。 */
  function wireReasoningToggle(det) {
    const sum = det.querySelector("summary");
    if (!sum || sum.__foldWired) return;
    sum.__foldWired = true;
    sum.addEventListener("click", function (ev) {
      if (!det.open) return;                       /* 关闭态 → 交给原生展开 */
      ev.preventDefault();
      if (det.classList.contains("closing")) return;
      det.classList.add("closing");
      const body = det.querySelector(".body");
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        if (body) body.removeEventListener("animationend", finish);
        det.classList.remove("closing");
        det.open = false;
      };
      if (body) body.addEventListener("animationend", finish);
      setTimeout(finish, 260);
    });
  }

  /* 把正文里的（…）与 (…) 染成灰色：旁白 / 动作 / 括号备注和正话要能一眼分开。
     做法是**渲染完之后处理 DOM 文本节点**，不去动 Markdown 解析器 ——
     否则代码块里的括号、行内代码都会被误伤。
     只认单行内、长度 ≤ 60 的括号内容（跨行的多半是正文里的正规括号，别乱灰）。 */
  const PAREN_RE = /[（(][^（()）\n]{1,60}[）)]/g;
  function grayParens(root) {
    if (!root || !root.childNodes) return;
    const SKIP = { CODE: 1, PRE: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1 };
    const texts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n = walker.nextNode();
    while (n) {
      const p = n.parentNode;
      const val = n.nodeValue || "";
      PAREN_RE.lastIndex = 0;
      if (p && !SKIP[p.nodeName] && !(p.className === "paren") && PAREN_RE.test(val)) texts.push(n);
      n = walker.nextNode();
    }
    texts.forEach(function (t) {
      const src = t.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      PAREN_RE.lastIndex = 0;
      while ((m = PAREN_RE.exec(src))) {
        if (m.index > last) frag.appendChild(document.createTextNode(src.slice(last, m.index)));
        const sp = document.createElement("span");
        sp.className = "paren";
        sp.textContent = m[0];
        frag.appendChild(sp);
        last = m.index + m[0].length;
      }
      if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));
      if (t.parentNode) t.parentNode.replaceChild(frag, t);
    });
  }

  /* ── 消息元素 ──────────────────────────────────── */
  function attachmentHtml(list) {
    return (list || []).map((a) => {
      /* 图片可能有两种形态：还没搬家的内联 dataUrl、或搬进文件后的 imgRef。
         统一问 Store.imageURL()，它两种都认（搬进文件的会同步读一次并缓存）。 */
      const imgUrl = a.kind === "image" ? window.Store.imageURL(a) : "";
      if (imgUrl) {
        /* 地址也要转义（10-29 修）：别的字段都过了 escapeHtml，只有 src 直接拼，
           一旦 dataURL / 图片引用里带上引号就能把属性断开（自闭环的注入面）。 */
        return '<div class="att"><img src="' + escapeHtml(imgUrl) + '" alt="' + escapeHtml(a.name) + '"><span class="a-name">' +
          escapeHtml(a.name) + '</span><button class="a-save" type="button" data-save-img="" aria-label="保存">保存</button></div>';
      }
      if (a.kind === "image") {
        const d = a.desc ? String(a.desc) : "";
        const t = d ? (d.slice(0, 24) + (d.length > 24 ? "…" : "")) : a.name;
        return '<div class="att att-expired" title="' + escapeHtml(d || a.name) + '">' + iconSvg("image-outline") +
          '<span class="a-name">图片·' + escapeHtml(t) + "</span></div>";
      }
      return '<div class="att">' + iconSvg("file-document-outline") +
        '<span class="a-name">' + escapeHtml(a.name) + "</span></div>";
    }).join("");
  }

  /* ── 双线：手机聊天的「线下侧写」────────────────────────
     手机上聊的那一轮，她在现实里是什么样子。做成一段旁白而不是对话气泡：
     不带头像、没有操作菜单、左边一条细线、斜体灰字。 */
  function offlineEl(msg) {
    const el = document.createElement("div");
    el.className = "msg offline";
    el.__msg = msg;
    const box = document.createElement("div");
    box.className = "offline-text";
    box.textContent = String(msg.content || "");
    el.appendChild(box);
    return el;
  }

  function msgEl(msg, sessionObj) {
    /* 剧情卡（世界生成采纳的那段）：不挂在任何一方身上，居中一张卡片；
       点一下铺满全屏看全文。渲染时不带头像、不带操作栏。 */
    if (msg.world) return worldCardEl(msg);

    /* 双线：手机里那一轮对应的「她此刻线下的样子」。不带头像、不参与操作，
       当成一段旁白排在对话流里（样式见 .msg.offline）。 */
    if (msg.offline) return offlineEl(msg);

    const el = document.createElement("div");
    el.className = "msg " + (msg.role === "user" ? "user" : "ai");
    el.__msg = msg;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    fillAvatar(avatar, msg.role, sessionObj || null, msg);
    /* 7.1：点角色头像进资料页（还原微信）。群聊按这条的说话人取，自己的头像不进去。 */
    if (msg.role !== "user") {
      avatar.classList.add("av-click");
      avatar.addEventListener("click", function (e) {
        e.stopPropagation();
        const d = window.DL || {};
        const id = msg.speaker || (sessionObj && sessionObj.characterId) || "";
        if (id && d.profile && d.profile.open) d.profile.open(id);
      });
    }
    el.appendChild(avatar);

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    el.appendChild(bubble);

    /* 群聊：这条话是谁说的，标在气泡上方 */
    if (msg.role !== "user" && msg.speakerName) {
      const who = document.createElement("div");
      who.className = "msg-speaker";
      who.textContent = msg.speakerName;
      bubble.appendChild(who);
    }

    if (msg.role === "user") {
      if (msg.attachments && msg.attachments.length) {
        const wrap = document.createElement("div");
        wrap.className = "attachment-bar";
        wrap.innerHTML = attachmentHtml(msg.attachments);
        bubble.appendChild(wrap);
      }
      const content = document.createElement("div");
      content.className = "content";
      content.innerHTML = renderMarkdown(msg.content || "");
      grayParens(content);   /* （…）里的旁白/动作染灰，和正话分开 */
      bubble.appendChild(content);
      if (msg.variantCount > 1) bubble.appendChild(variantsEl(msg));
      return el;
    }

    if (msg.reasoning) {
      const det = document.createElement("details");
      det.className = "reasoning";
      det.innerHTML = '<summary><span class="spark">' + iconSvg("creation") +
        '</span><span class="r-label">已完成思考</span><span class="caret">' +
        iconSvg("chevron-right") + "</span></summary><div class=\"body\">" +
        escapeHtml(msg.reasoning) + "</div>";
      wireReasoningToggle(det);
      bubble.appendChild(det);
    }

    if (msg.image) {
      const wrap = document.createElement("div");
      wrap.className = "gen-img-wrap";
      const img = document.createElement("img");
      img.className = "gen-img";
      img.src = msg.image;
      img.alt = msg.content || "生成的图片";
      wrap.appendChild(img);
      const sv = document.createElement("button");
      sv.type = "button";
      sv.className = "img-save";
      sv.setAttribute("data-save-img", "");
      sv.textContent = "保存";
      wrap.appendChild(sv);
      bubble.appendChild(wrap);
    } else if (msg.video) {
      /* 对话里生成的视频：给原生控件，能播能全屏，不自造播放器 */
      const wrap = document.createElement("div");
      wrap.className = "gen-video-wrap";
      const v = document.createElement("video");
      v.className = "gen-video";
      v.src = msg.video;
      v.controls = true;
      v.playsInline = true;
      v.setAttribute("webkit-playsinline", "true");
      v.preload = "metadata";
      wrap.appendChild(v);
      bubble.appendChild(wrap);
    } else if (msg.audio) {
      /* 对话里生成的音乐：同上，用原生音频控件 */
      const wrap = document.createElement("div");
      wrap.className = "gen-audio-wrap";
      const a = document.createElement("audio");
      a.className = "gen-audio";
      a.src = msg.audio;
      a.controls = true;
      a.preload = "metadata";
      wrap.appendChild(a);
      bubble.appendChild(wrap);
    } else if (msg.imageDesc) {
      const note = document.createElement("div");
      note.className = "img-expired";
      note.textContent = "图片（原图已过期）· " + msg.imageDesc;
      bubble.appendChild(note);
    }

    const content = document.createElement("div");
    content.className = "content";
    /* 带块级 HTML 的内容进影子根渲染（卡里的样式出不来、脚本不执行，见 card.js）。
       判定交给 Card.shouldUseCard：有 html 标记的必走，没标记的要求成对闭合，
       免得模型「讲解 HTML」时被误当卡片（那样 Markdown 和旁白灰化都会失效）。 */
    if (window.Card && Card.shouldUseCard(msg)) {
      content.appendChild(Card.render(msg.content));
    } else {
      content.innerHTML = msg.content ? renderMarkdown(msg.content) : "";
      grayParens(content);
    }
    bubble.appendChild(content);

    /* 状态量化：折叠框放在气泡下方（默认收起，点开是各项数值条） */
    if (msg.status && typeof msg.status === "object") bubble.appendChild(statusEl(msg.status, msg.statusCarry));

    /* 只出了思考、正文是空的：常见于「思考把长度上限吃满」或「模型把话都写在思考里」。
       以前这种气泡既没有提示、也点不出操作栏（操作栏挂了 msg.content 的条件），
       看着就像发了条空消息，还没法重试。这里补一条说明，并把操作栏放出来。
       （已经有 error 说明的就不再补提示，免得一个气泡里两段话打架 —— 但操作栏照给。） */
    const noBody = !msg.content && !!msg.reasoning;
    if (noBody && !msg.error) {
      const note = document.createElement("div");
      note.className = "msg-note";
      note.innerHTML = iconSvg("alert-circle-outline") + "<span>这一轮只输出了思考、没有正文" +
        (msg.trunc ? "（达到长度上限被截断）" : "") + "。点下面的「重新说」可以再试一次。</span>";
      bubble.appendChild(note);
    }

    if (msg.sources && msg.sources.length) {
      bubble.appendChild(sourcesEl(msg.sources));
    }
    if (msg.variantCount > 1) bubble.appendChild(variantsEl(msg));
    /* 图片消息的 content 恒为空 —— 不加 msg.image 的话，AI 画的图就完全没有操作栏
       （「重新说 / 复制 / 删除」对它是断的）。 */
    if (msg.content || noBody || msg.error || msg.image) bubble.appendChild(msgActionsEl(msg));
    /* 表情画成图片（Fluent 内置 / 自添加的图） */
    try { stickerize(bubble); } catch (e) { /* ignore */ }
    if (msg.error) {
      const e = document.createElement("div");
      e.className = "msg-error";
      e.innerHTML = iconSvg("alert-circle-outline") + "<span>" + escapeHtml(msg.error) + "</span>";
      bubble.appendChild(e);
    }
    return el;
  }

  /* 剧情卡：居中、无头像、无操作栏。点它 → 铺满全屏看全文（绑定在 chat.js）。 */
  function worldCardEl(msg) {
    const el = document.createElement("div");
    el.className = "msg world-card";
    el.__msg = msg;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "world-card-btn";
    b.setAttribute("data-world-view", "1");
    b.setAttribute("aria-label", "查看剧情全文");
    b.innerHTML = '<span class="wc-ic">' + iconSvg("book-outline") + "</span>" +
      '<span class="wc-text">选择的剧情</span>' +
      '<span class="wc-caret">' + iconSvg("chevron-right") + "</span>";
    el.appendChild(b);
    return el;
  }

  /* 附带卡片：气泡下方的一条可折叠数值卡（冷静值 72 · 开心值 40 …）
     项目名由用户自己配（见 chat.js 的 statusCardsFor），值固定 0~100。 */
  function statusEl(st, carry) {
    const names = Object.keys(st || {});
    const det = document.createElement("details");
    det.className = "msg-status";
    const head = names.slice(0, 3).map((k) => escapeHtml(k) + " " + st[k]).join("　");
    /* carry：这条回复没写卡片行，数值是从上一条沿用来的 —— 必须标出来，别让人当成新数据 */
    det.innerHTML = '<summary><span class="st-ic">' + iconSvg("chart-box-outline") +
      '</span><span class="st-label">卡片' + (carry ? '<span class="st-carry">延续上一条</span>' : "") +
      (head ? " · " + head : "") +
      '</span><span class="caret">' + iconSvg("chevron-right") + "</span></summary>";
    const body = document.createElement("div");
    body.className = "st-body";
    names.forEach((k) => {
      const row = document.createElement("div");
      row.className = "st-row";
      const nm = document.createElement("span");
      nm.className = "st-name";
      nm.textContent = k;
      const bar = document.createElement("span");
      bar.className = "st-bar";
      const fill = document.createElement("i");
      fill.className = "st-fill";
      fill.style.width = Math.max(0, Math.min(100, Number(st[k]) || 0)) + "%";
      bar.appendChild(fill);
      const vl = document.createElement("span");
      vl.className = "st-val";
      vl.textContent = String(st[k]);
      row.appendChild(nm); row.appendChild(bar); row.appendChild(vl);
      body.appendChild(row);
    });
    det.appendChild(body);
    return det;
  }

  function sourcesEl(sources) {
    const box = document.createElement("div");
    box.className = "sources";
    const head = document.createElement("div");
    head.className = "src-title";
    head.innerHTML = iconSvg("link-variant") + "<span>来源 · " + sources.length + "</span>";
    box.appendChild(head);
    sources.forEach((s) => {
      const u = safeUrl(s.url);
      if (!u) {
        /* 没有网址的来源（DeepSeek 兼容通道只给了答案、没给来源块时就是这样）：
           渲染成不可点的普通条目，别做成 href="#" 的假链接（点了没反应，还带个外链图标）。 */
        const d = document.createElement("div");
        d.className = "src-plain";
        d.innerHTML = "<span>" + escapeHtml(s.title || "（无来源）") + "</span>";
        box.appendChild(d);
        return;
      }
      const a = document.createElement("a");
      a.href = u;
      a.target = "_blank";
      a.rel = "noopener";
      a.innerHTML = "<span>" + escapeHtml(s.title || s.url) + "</span>" + iconSvg("open-in-new");
      box.appendChild(a);
    });
    return box;
  }

  /* 流式视图 */
  function createStreamView(sessionObj) {
    const el = msgEl({ role: "assistant", content: "" }, sessionObj);
    const bubble = el.querySelector(".bubble");
    const contentBox = el.querySelector(".content");

    const det = document.createElement("details");
    det.className = "reasoning thinking";
    det.open = true;
    det.innerHTML = '<summary><span class="spark">' + iconSvg("creation") +
      '</span><span class="r-label">深度思考中…</span><span class="caret">' +
      iconSvg("chevron-right") + "</span></summary><div class=\"body\"></div>";
    wireReasoningToggle(det);
    bubble.insertBefore(det, contentBox);

    const rBody = det.querySelector(".body");
    const rLabel = det.querySelector(".r-label");
    let reasoningText = "";
    let contentText = "";
    let started = false;
    let frame = null;
    let sources = [];

    let lastPaintAt = 0;
    let delayTimer = null;
    function paint() {
      frame = null; delayTimer = null;
      lastPaintAt = Date.now();
      rBody.textContent = reasoningText;
      /* 流式期间已经在输出块级 HTML：先剥标签给纯文字预览。
         否则用户盯着的是被转义的 &lt;div&gt;，生成结束又整块突变卡片。
         完整卡片交给生成结束后的 renderMessages（那时内容才稳定）。 */
      if (window.Card && Card.isHtml(contentText)) {
        const preview = contentText
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        contentBox.textContent = preview || "正在生成…";
        return;
      }
      contentBox.innerHTML = (contentText ? renderMarkdown(contentText) : "") +
        (started ? '<span class="cursor"></span>' : "");
    }
    /* 流式期间「每帧」都整篇重跑 renderMarkdown：长回答等于 O(n²)，Chrome 83 上跑到
       一两千字就明显掉帧、发热。改成最快约 90ms 画一次；不足 90ms 就排个定时器补上，
       保证最后一帧一定画得出来。 */
    function schedule() {
      const wait = 90 - (Date.now() - lastPaintAt);
      if (wait <= 0) {
        if (!frame && !delayTimer) frame = requestAnimationFrame(paint);
        return;
      }
      if (!delayTimer) {
        delayTimer = setTimeout(function () {
          delayTimer = null;
          if (!frame) frame = requestAnimationFrame(paint);
        }, wait);
      }
    }

    return {
      el,
      setReasoning(t) {
        reasoningText += t;
        schedule();
      },
      setContent(t) {
        if (!started) {
          started = true;
          det.classList.remove("thinking");
          rLabel.textContent = "已完成思考";
        }
        contentText += t;
        schedule();
      },
      showTyping() {
        if (!contentText && !reasoningText) {
          contentBox.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
        }
      },
      setSources(list) { sources = list || []; },
      /* 取一份当前累积值的快照（不改 DOM）：上层要据它判断「这轮到底有没有正文」 */
      snapshot() { return { content: contentText, reasoning: reasoningText }; },
      setError(text) {
        const e = document.createElement("div");
        e.className = "msg-error";
        e.innerHTML = iconSvg("alert-circle-outline") + "<span>" + escapeHtml(text || "") + "</span>";
        bubble.appendChild(e);
      },
      finish() {
        if (frame) { cancelAnimationFrame(frame); frame = null; }
        if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
        /* 先把 DOM 同步落一次：以前这里只 cancel 掉那一帧，最后一段思考可能压根没写进
           rBody。万一这个节点随后被别处的重渲染搬走/重建，就会留个「半截思考」，
           或者干脆看不到 —— 都属于「思考被吞」。 */
        paint();
        if (!started) { det.classList.remove("thinking"); rLabel.textContent = "已完成思考"; }
        else { rLabel.textContent = "已完成思考"; }
        contentBox.innerHTML = contentText ? renderMarkdown(contentText) : "";
        /* 收尾这一帧是最终显示态，把正常渲染的两步补上（旁白染灰 + 表情换图）。
           流式中间那帧（上面 paint 里）不补 —— 每帧都跑就会把 90ms 节流省下的性能全吃掉。 */
        try { grayParens(contentBox); } catch (e) { /* ignore */ }
        try { stickerize(contentBox); } catch (e) { /* ignore */ }
        if (!reasoningText && det.parentNode) det.parentNode.removeChild(det);
        return { content: contentText, reasoning: reasoningText, sources };
      }
    };
  }

  /* ── 提示条 / 对话框 ───────────────────────────── */
  /* 「减少动态效果」下退场动画被压到 0.01ms，但 JS 里「播完再 hidden」的定时器
     还在等 170~200ms —— 动画早演完了，人还得对着残留界面干等。
     所有带退场的关闭动作一律走 exitMs()，别再写死数字。 */
  function reduceMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { return false; }
  }
  function exitMs(ms) { return reduceMotion() ? 0 : ms; }

  function toast(text, isError) {
    const box = $("#toasts");
    /* 最多同时挂 3 条（10-27）：启动阶段的几条提示 + 一次生成失败 + 一次自动压缩失败，
       很容易同屏堆 4~5 条把输入框盖住。多了就先扔最旧的。 */
    while (box.children.length >= 3) box.removeChild(box.firstChild);
    const t = document.createElement("div");
    t.className = "toast" + (isError ? " err" : "");
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 320);
    }, 2200);
  }

  /* 二级浮层自动抬层：二级浮层的基准是 400（见 app.css 那段注释），
     但整页层的 z 后来一路涨上去了 —— 资料页 430、资料页编辑框 440、发布菜单 445、
     加号菜单 460。这些层里再弹确认框，400 就被压在下面：**看得见、点不到**，
     表现和「点了没反应」一模一样（10-17 和 P0-2 都是这个病）。

     与其维护一份「谁比谁高」的手册（迟早漏一个），不如打开时量一下现场：
     找出此刻还显示着的最高层，比它再高 10。没有更高的就清掉内联值，回到 CSS 的 400。 */
  const OVERLAY_SEL = [
    ".profile-layer", ".phone-layer", ".camera-layer", ".world-view.show",
    ".sticker-import", ".ph-pick-mask", "#plusMenu", ".wp-mask", ".modal.show"
  ].join(",");

  function raiseAboveTop(m) {
    let top = 0;
    let nodes = [];
    try { nodes = document.querySelectorAll(OVERLAY_SEL); } catch (e) { nodes = []; }
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el === m || el.contains(m)) continue;      /* 自己、或自己所在的父层不算 */
      if (el.hidden) continue;
      let st;
      try { st = window.getComputedStyle(el); } catch (e2) { continue; }
      if (st.display === "none" || st.visibility === "hidden") continue;
      /* 不拿 opacity 判可见：整页层都有进场动画（.profile-layer 的 pf-in 从 opacity 0 开始），
         刚打开那一帧读到的是 0 —— 会把「刚起来的层」当成没开，正好漏掉最该比较的那个。 */
      const z = parseInt(st.zIndex, 10);
      if (isFinite(z) && z > top) top = z;
    }
    m.style.zIndex = (top >= 400) ? String(top + 10) : "";
  }

  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    /* 读屏器语义（10-29）：以前只有 aria-hidden，弹窗和背景在无障碍树里是同一层。
       在这里统一补 role / aria-modal，几十个 .modal 不用逐个改 HTML。 */
    if (!m.getAttribute("role")) m.setAttribute("role", "dialog");
    m.setAttribute("aria-modal", "true");
    m.classList.add("show");
    m.setAttribute("aria-hidden", "false");
    try { raiseAboveTop(m); } catch (e) { /* 抬层失败也不能拦住弹窗打开 */ }
    /* 弹窗打开时统一刷一次自绘选择器的文字：这些 select 的选项多半是「打开前才填的」，
       填完不会再触发 change —— 不刷的话按钮上还显示旧值。只改文字，开销可忽略。 */
    pickRefreshAll();
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.remove("show");
    m.setAttribute("aria-hidden", "true");
    m.setAttribute("aria-modal", "false");
    m.style.zIndex = "";        /* 收掉自动抬的那层，下次按当场的层级重新量 */
    /* 确认框被外部（返回键）关掉时按「取消」结算，避免 promise 悬挂 + 旧回调残留 */
    if (id === "dialogModal" && dialogSettle) {
      const f = dialogSettle; dialogSettle = null;
      try { f(false); } catch (e) { /* ignore */ }
    }
    /* 口令框同理（10-30）：它由 settings.js 提供结算钩子。不结算的后果更重 ——
       下一次点「确定」会把上一轮放弃的导出 / 关闭加密动作顶上去执行。 */
    if (id === "passModal" && typeof window.__dlSettlePass === "function") {
      try { window.__dlSettlePass(); } catch (e) { /* ignore */ }
    }
  }

  /* 当前挂着的确认框「结算函数」。返回键会直接 closeModal 关掉 dialogModal 而不结算，
     若不兜底：promise 永久悬挂、旧监听器残留 → 下一次任何确认框点「确定」会同时触发旧回调，
     把上次已取消的操作（删角色 / 删会话）也执行了。 */
  let dialogSettle = null;

  /* delayMs 可选：确认按钮延时这么多毫秒才可点（并显示倒计时）。
     用在「不再弹出」这类要想清楚的后果警告上。 */
  function confirmDialog(title, text, delayMs) {
    return new Promise((resolve) => {
      /* 上一个还没结算的先按「取消」结掉，绝不叠加监听器 */
      if (dialogSettle) { const f = dialogSettle; dialogSettle = null; try { f(false); } catch (e) { /* ignore */ } }
      $("#dialogTitle").textContent = title || "提示";
      $("#dialogText").textContent = text || "";
      const ok = $("#dialogOk");
      const cancel = $("#dialogCancel");
      let settled = false;
      let timer = null;
      const okLabel = ok.textContent;
      if (delayMs > 0) {
        let left = Math.ceil(delayMs / 1000);
        ok.disabled = true;
        ok.textContent = okLabel + "（" + left + "s）";
        timer = setInterval(() => {
          left--;
          if (left <= 0) { clearInterval(timer); timer = null; ok.disabled = false; ok.textContent = okLabel; return; }
          ok.textContent = okLabel + "（" + left + "s）";
        }, 1000);
      }
      function cleanup(result) {
        if (settled) return;
        settled = true;
        if (timer) { clearInterval(timer); timer = null; }
        ok.disabled = false;
        ok.textContent = okLabel;
        if (dialogSettle === cleanup) dialogSettle = null;
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        closeModal("dialogModal");
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      dialogSettle = cleanup;
      openModal("dialogModal");
    });
  }

  /* 带输入框的确认框（10-18 加）：复用 #dialogModal，只是往正文下面临时插一行输入。
     返回 Promise<string|null> —— 确定给去空格后的文本（空串按取消算），取消给 null。
     不新增弹窗节点、不改动了原有 confirmDialog 的返回类型，返回键 / 遮罩照旧。 */
  function askDialog(title, hint, placeholder) {
    return new Promise((resolve) => {
      if (dialogSettle) { const f = dialogSettle; dialogSettle = null; try { f(false); } catch (e) { /* ignore */ } }
      $("#dialogTitle").textContent = title || "输入";
      const txt = $("#dialogText");
      txt.textContent = hint || "";
      const ok = $("#dialogOk");
      const cancel = $("#dialogCancel");
      const wrap = document.createElement("label");
      wrap.className = "field ask-field";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = placeholder || "";
      wrap.appendChild(inp);
      if (txt && txt.parentNode) txt.parentNode.insertBefore(wrap, txt.nextSibling);
      let settled = false;
      const cleanup = (val) => {
        if (settled) return;
        settled = true;
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        inp.removeEventListener("keydown", onKey);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (dialogSettle === cleanup) dialogSettle = null;
        closeModal("dialogModal");
        resolve(val);
      };
      const onOk = () => { const v = String(inp.value || "").trim(); cleanup(v || null); };
      const onCancel = () => cleanup(null);
      const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); onOk(); } };
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      inp.addEventListener("keydown", onKey);
      dialogSettle = cleanup;
      openModal("dialogModal");
      setTimeout(() => { try { inp.focus(); } catch (e) { /* ignore */ } }, 60);
    });
  }

  /* 强警告确认框（10-19）：用于「群里改/删消息」这种会影响别人看到的内容。
     和 confirmDialog 的差别只有三点：
       ① 确定键延时 N 秒才可点（期间显示倒计时），逼用户先把话读完；
       ② 多一个「以后不再显示」勾选框，返回 { ok, dontAsk }；
       ③ 不开 escape/遮罩关闭 —— 想走只能点取消，不能一抹黑划走。
     复用 #dialogModal，临时插一行勾选框，退出时删掉（跟 askDialog 同一套办法）。 */
  function confirmDanger(title, text, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      if (dialogSettle) { const f = dialogSettle; dialogSettle = null; try { f(false); } catch (e) { /* ignore */ } }
      $("#dialogTitle").textContent = title || "请确认";
      const txt = $("#dialogText");
      txt.textContent = text || "";
      const ok = $("#dialogOk");
      const cancel = $("#dialogCancel");
      const okLabel = ok.textContent;

      const wrap = document.createElement("label");
      wrap.className = "check-field danger-ask";
      const box = document.createElement("input");
      box.type = "checkbox";
      const span = document.createElement("span");
      span.textContent = o.checkText || "以后不再提示";
      wrap.appendChild(box);
      wrap.appendChild(span);
      if (txt && txt.parentNode) txt.parentNode.insertBefore(wrap, txt.nextSibling);

      let settled = false;
      let timer = null;
      const delayMs = Math.max(0, Number(o.delayMs) || 0);
      if (delayMs > 0) {
        let left = Math.ceil(delayMs / 1000);
        ok.disabled = true;
        ok.textContent = okLabel + "（" + left + "s）";
        timer = setInterval(() => {
          left--;
          if (left <= 0) { clearInterval(timer); timer = null; ok.disabled = false; ok.textContent = okLabel; return; }
          ok.textContent = okLabel + "（" + left + "s）";
        }, 1000);
      }

      function cleanup(result, dontAsk) {
        if (settled) return;
        settled = true;
        if (timer) { clearInterval(timer); timer = null; }
        ok.disabled = false;
        ok.textContent = okLabel;
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (dialogSettle === cleanup) dialogSettle = null;
        closeModal("dialogModal");
        resolve({ ok: !!result, dontAsk: !!dontAsk });
      }
      function onOk() { if (ok.disabled) return; cleanup(true, box.checked); }
      function onCancel() { cleanup(false, box.checked); }
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      dialogSettle = cleanup;
      openModal("dialogModal");
    });
  }

  /* ── 选择器：把系统 select 弹层换成 App 内自绘（原 select 留在 DOM 里当值来源）── */
  const PICKABLES = [];
  function pickLabel(sel) {
    /* 多选（如「思考对象」）：selectedIndex 只代表第一个选中项，不能拿来当标签 */
    if (sel && sel.multiple) {
      let n = 0;
      for (let i = 0; i < sel.options.length; i++) if (sel.options[i].selected) n++;
      return n ? ("已选 " + n + " 项") : "（未选）";
    }
    const o = sel.options && sel.options[sel.selectedIndex];
    return o ? o.textContent : "（无可选项）";
  }
  function pickRefresh(sel) {
    const btn = sel && sel.__pickBtn;
    if (btn && btn.firstChild) btn.firstChild.textContent = pickLabel(sel);
  }
  function pickRefreshAll() { PICKABLES.forEach((s) => pickRefresh(s)); }
  function pickOpen(sel) {
    const multi = !!sel.multiple;
    const opts = Array.prototype.map.call(sel.options || [], (o, i) => ({ value: o.value, label: o.textContent, on: !!o.selected, i: i }));
    if (!opts.length) { toast("没有可选项", true); return; }
    const box = $("#pickList");
    if (!box) return;
    /* 多选时标题带一句提示，否则用户点完一行发现面板不关会以为坏了 */
    $("#pickTitle").textContent = (sel.getAttribute("data-pick-title") || "选择") + (multi ? "（可多选）" : "");
    box.innerHTML = "";
    opts.forEach((o) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pick-row" + ((multi ? o.on : o.value === sel.value) ? " on" : "");
      const txt = document.createElement("span");
      txt.className = "pick-txt";
      txt.textContent = o.label;
      const mk = document.createElement("span");
      mk.className = "pick-mark";
      row.appendChild(txt);
      row.appendChild(mk);
      row.addEventListener("click", () => {
        /* 多选：点一行只切换它，面板留着让人继续勾；点右上角关闭收起（10-27） */
        if (multi) {
          const opt = sel.options[o.i];
          if (!opt) return;
          opt.selected = !opt.selected;
          row.classList.toggle("on", opt.selected);
          try { sel.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) { /* ignore */ }
          pickRefresh(sel);
          return;
        }
        closeModal("pickModal");
        if (sel.value !== o.value) {
          sel.value = o.value;
          try { sel.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) { /* ignore */ }
        }
        pickRefresh(sel);
      });
      box.appendChild(row);
    });
    openModal("pickModal");
  }
  function pickBind(sel, title) {
    if (!sel || sel.__pickBtn) return;
    if (title) sel.setAttribute("data-pick-title", title);
    sel.classList.add("pick-hidden");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pick-btn";
    const txt = document.createElement("span");
    txt.textContent = pickLabel(sel);
    const ar = document.createElement("span");
    ar.className = "pick-arrow";
    btn.appendChild(txt);
    btn.appendChild(ar);
    btn.addEventListener("click", () => pickOpen(sel));
    if (sel.parentNode) sel.parentNode.insertBefore(btn, sel.nextSibling);
    sel.__pickBtn = btn;
    sel.addEventListener("change", () => pickRefresh(sel));
    PICKABLES.push(sel);
  }

  /* ── 主题 ──────────────────────────────────────── */
  let themeStyleEl = null;
  /* 主题变量不写在 .css 文件里（封装工具会剥离样式表/样式块），改由 JS 运行时注入 */
  function applyTheme(id, mode) {
    const theme = window.CONFIG.THEMES.find((t) => t.id === id) || window.CONFIG.THEMES[0];
    const m = mode === "light" ? "light" : "dark";
    const vars = (window.CONFIG.THEME_VARS[theme.id] || window.CONFIG.THEME_VARS[window.CONFIG.THEMES[0].id])[m];
    document.body.setAttribute("data-theme", theme.id);
    document.body.setAttribute("data-mode", m);
    /* 关键：color-scheme 必须始终包含 dark，否则安卓“强制深色”会把整页反色。
       第一个值决定 UA 控件（滚动条、原生表单）的偏好，与当前模式保持一致。 */
    document.documentElement.style.colorScheme = m === "dark" ? "dark light" : "light dark";
    if (!themeStyleEl) {
      themeStyleEl = document.createElement("style");
      themeStyleEl.id = "theme-css";
      document.head.appendChild(themeStyleEl);
    }
    themeStyleEl.textContent = ":root{" +
      Object.keys(vars).map((k) => k + ":" + vars[k]).join(";") +
      /* 骨架常量（字号/圆角/间距/时长）跟主题变量一起注入（7.1）。
         切主题每次都重写这段，所以不用单独注入一次。 */
      (function () {
        const t = window.CONFIG.TOKENS || {};
        const ks = Object.keys(t);
        return ks.length ? ";" + ks.map((k) => k + ":" + t[k]).join(";") : "";
      })() + "}";
    /* 切主题的这一帧关掉过渡（10-30）：body 有 0.28s 的背景过渡，而子元素是瞬切，
       两套速度并存在真机上会看到「底色慢慢变、卡片已经跳完了」，还和 forceRepaint 打架。 */
    try {
      const html = document.documentElement;
      if (html && html.classList) {
        html.classList.add("no-transition");
        void html.offsetWidth;
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { html.classList.remove("no-transition"); });
        });
      }
    } catch (e) { /* 关不掉过渡不影响换主题 */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme[m][0]);
    return theme.id;
  }

  /* 真机上主题变量到底解析成了什么，用于排查“部分变量不生效” */
  function themeDiagnostics() {
    const cb = getComputedStyle(document.body);
    const ch = getComputedStyle(document.documentElement);
    const v = (cs, n) => (cs.getPropertyValue(n) || "").trim() || "(空)";
    const ua = navigator.userAgent || "";
    const kernel = (ua.match(/Chrome\/[\d.]+/) || ["内核未知"])[0];
    const android = (ua.match(/Android[\s\d.]+/) || [""])[0];
    return [
      "模式：" + document.body.getAttribute("data-theme") + " / " + document.body.getAttribute("data-mode"),
      "内核：" + kernel + (android ? "　" + android : ""),
      "样式表：" + document.styleSheets.length + " 张",
      "html --bg " + v(ch, "--bg"),
      "body --bg " + v(cb, "--bg") + "　--panel " + v(cb, "--panel"),
      "body --accent " + v(cb, "--accent") + "　--text " + v(cb, "--text"),
      "实算背景 " + cb.backgroundColor + "　文字色 " + cb.color
    ];
  }

  /* 部分 Android WebView 切主题后只重绘部分区域，导致同屏新旧主题混杂。
     做法：先把 html 底色补上（避免闪白），再把 body 隐藏一帧逼它完整重绘，最后还原滚动位置。 */
  function forceRepaint() {
    const html = document.documentElement;
    const body = document.body;
    const box = document.getElementById("messages");
    const top = box ? box.scrollTop : 0;
    const prev = html.style.backgroundColor;
    html.style.backgroundColor = getComputedStyle(body).backgroundColor;
    body.style.display = "none";
    void body.offsetHeight;
    body.style.display = "";
    html.style.backgroundColor = prev;
    if (box) box.scrollTop = top;
  }

  function buildModeSwitch(currentMode, onPick) {
    const box = $("#modeSwitch");
    box.innerHTML = "";
    window.CONFIG.MODES.forEach((m) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = m.id === currentMode ? "on" : "";
      b.textContent = m.name;
      b.addEventListener("click", () => onPick(m.id));
      box.appendChild(b);
    });
  }

  function buildThemeGrid(currentId, mode, onPick) {
    const grid = $("#themeGrid");
    grid.innerHTML = "";
    const m = mode === "light" ? "light" : "dark";
    window.CONFIG.THEMES.forEach((t, i) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "theme-card" + (t.id === currentId ? " active" : "");
      if (i < 8) card.style.animationDelay = (i * 22) + "ms";   /* 7.1：只让前 8 项错峰，长列表不再整片在动 */
      card.innerHTML = '<div class="swatch">' +
        t[m].map((c) => '<i style="background:' + c + '"></i>').join("") +
        '</div><div class="t-name">' + t.name + "</div>";
      card.addEventListener("click", () => onPick(t.id));
      grid.appendChild(card);
    });
  }

  /* ── 会话列表 ──────────────────────────────────── */
  /* box2 可选：指定渲染到哪个容器（侧栏分栏后，助手 / 角色两栏各有一个会话列表）。
     不传就是原来的 #sessionList —— 老调用点一字不改。 */
  function sessionListEl(sessions, currentId, handlers, box2) {
    const box = box2 || $("#sessionList");
    if (!box) return;
    box.innerHTML = "";
    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.className = "session-item";
      empty.style.color = "var(--text-mute)";
      /* 只说「还没有对话」等于没告诉人下一步该干什么。指个方向。
         传了 box2 的是别的列表（角色栏/手机侧栏），它们的「上去点哪」不一样，保持原样。 */
      empty.textContent = box2 ? "还没有对话" : "还没有对话　点左上角「+ 新对话」开始";
      box.appendChild(empty);
      return;
    }
    sessions.forEach((s, i) => {
      const item = document.createElement("div");
      item.className = "session-item" + (s.id === currentId ? " active" : "");
      if (i < 8) item.style.animationDelay = (i * 20) + "ms";

      const sav = document.createElement("div");
      sav.className = "s-avatar";
      if (s.isGroup) sav.innerHTML = iconSvg("account-group");
      else fillAvatar(sav, "assistant", s);
      item.appendChild(sav);

      const title = document.createElement("span");
      title.className = "s-title";
      title.textContent = s.title || "新对话";
      item.appendChild(title);

      if (s.systemPrompt && s.systemPrompt.trim()) {
        const dot = document.createElement("span");
        dot.className = "s-dot";
        dot.title = "有自定义提示词";
        item.appendChild(dot);
      }

      if (s.isGroup) {
        const gb = document.createElement("span");
        gb.className = "s-badge group";
        gb.textContent = "群";
        item.appendChild(gb);
      } else if (s.characterId) {
        const badge = document.createElement("span");
        badge.className = "s-badge" + (s.mainLine ? " main" : "");
        badge.textContent = s.mainLine ? "主线" : "支线";
        item.appendChild(badge);
      }
      if (s.pinned) {
        const pb = document.createElement("span");
        pb.className = "s-badge pin";
        pb.textContent = "置顶";
        item.appendChild(pb);
      }

      const del = document.createElement("button");
      del.className = "s-del";
      del.type = "button";
      del.innerHTML = iconSvg("close");
      del.addEventListener("click", (e) => { e.stopPropagation(); handlers.onDelete(s.id); });
      item.appendChild(del);

      let lpTimer = null, lpFired = false;
      const lpEnd = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
      item.addEventListener("touchstart", () => { lpFired = false; lpTimer = setTimeout(() => { lpFired = true; if (handlers.onLongPress) handlers.onLongPress(s.id); }, 480); }, { passive: true });
      item.addEventListener("touchmove", lpEnd, { passive: true });
      item.addEventListener("touchend", (e) => { lpEnd(); if (lpFired) { e.preventDefault(); lpFired = false; } }, { passive: false });
      item.addEventListener("click", () => { if (lpFired) { lpFired = false; return; } handlers.onOpen(s.id); });
      box.appendChild(item);
    });
  }

  /* ── 滚动 ──────────────────────────────────────── */
  function isNearBottom() {
    const box = $("#messages");
    return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  }
  /* instant=true：流式跟随用。临时把 CSS 的 scroll-behavior 置成 auto，
     否则 scrollTop 赋值会走平滑动画，下一段 delta 到来时位置还在半路，
     isNearBottom() 会判成「没贴底」→ 从此不再跟随（长回答停在半空）。 */
  function scrollToBottom(instant) {
    const box = $("#messages");
    if (!box) return;
    if (!instant) { box.scrollTop = box.scrollHeight; return; }
    const prev = box.style.scrollBehavior;
    box.style.scrollBehavior = "auto";
    box.scrollTop = box.scrollHeight;
    box.style.scrollBehavior = prev;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fallthrough */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  window.UI = {
    $, escapeHtml, renderMarkdown, grayParens, msgEl, createStreamView, iconSvg, applyIcons, actionBtn, msgActionsEl, ACTIONS, setAvatarResolver, setSpeakerResolver, forceRepaint, themeDiagnostics, stickerize,
    toast, openModal, closeModal, confirmDialog, confirmDanger, askDialog,
    exitMs, reduceMotion,
    pickBind, pickRefreshAll,
    applyTheme, buildModeSwitch, buildThemeGrid, sessionListEl,
    isNearBottom, scrollToBottom, copyText,
    statusEl   /* 回归测试要用：验证「延续上一条」标记 */
  };
})();
