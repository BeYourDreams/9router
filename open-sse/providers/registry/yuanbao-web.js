// Tencent Yuanbao web (yuanbao.tencent.com) — PLACEHOLDER, no executor yet.
// Listing only so the provider shows up in the picker; any request falls through
// to DefaultExecutor and fails. Implement: capture the page's /api/v2/chat turn,
// then add executors/yuanbao-web.js + webLoginConfig entry + executors/index.js.
export default {
  id: "yuanbao-web",
  priority: 246,
  alias: "yuanbao-web",
  aliases: ["yuanbao", "元宝"],
  uiAlias: "yuanbao-web",
  display: {
    name: "Yuanbao Web (腾讯元宝)",
    icon: "auto_awesome",
    color: "#0052D9",
    textIcon: "YB",
    website: "https://yuanbao.tencent.com",
    notice: { text: "占位：上游网页接口尚未实现，暂不可用。" },
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint: "占位中 — 尚未实现。",
  transport: {
    baseUrl: "https://yuanbao.tencent.com",
    format: "openai",
    authType: "cookie",
  },
  models: [],
};
