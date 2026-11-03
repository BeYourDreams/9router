// Ant Ling web (ling.tbox.cn/chat) — PLACEHOLDER, no executor yet.
// Listing only so the provider shows up in the picker; any request falls through
// to DefaultExecutor and fails. Implement: capture the page's chat turn, then add
// executors/ling-web.js + webLoginConfig entry + executors/index.js.
export default {
  id: "ling-web",
  priority: 248,
  alias: "ling-web",
  aliases: ["ling", "tbox", "ling.tbox.cn"],
  uiAlias: "ling-web",
  display: {
    name: "Ling Web (蚂蚁 Ling)",
    icon: "auto_awesome",
    color: "#1677FF",
    textIcon: "LG",
    website: "https://chat.ant-ling.com/chat",
    notice: { text: "已实现。" },
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint: "已实现。",
  transport: {
    baseUrl: "https://ling.tbox.cn",
    format: "openai",
    authType: "cookie",
  },
  models: [{ id: "Ling-3.1-flash", name: "Ling 3.1 Flash" }],
};
