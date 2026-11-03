// Baidu Yiyan web (yiyan.baidu.com) — PLACEHOLDER, no executor yet.
// Listing only so the provider shows up in the picker; any request falls through
// to DefaultExecutor and fails. Implement: capture the page's chat turn (note:
// yiyan shares Baidu's passport + bx/tt token signing), then add
// executors/yiyan-web.js + webLoginConfig entry + executors/index.js.
export default {
  id: "yiyan-web",
  priority: 247,
  alias: "yiyan-web",
  aliases: ["yiyan", "yiyan-baidu", "文心一言", "yiyan.baidu.com"],
  uiAlias: "yiyan-web",
  display: {
    name: "Yiyan Web (文心一言)",
    icon: "auto_awesome",
    color: "#2932E1",
    textIcon: "YY",
    website: "https://yiyan.baidu.com",
    notice: { text: "占位：上游网页接口尚未实现，暂不可用。" },
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint: "占位中 — 尚未实现。",
  transport: {
    baseUrl: "https://yiyan.baidu.com",
    format: "openai",
    authType: "cookie",
  },
  models: [],
};
