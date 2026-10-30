export default {
  id: "doubao-web",
  priority: 250,
  alias: "doubao-web",
  aliases: ["doubao"],
  uiAlias: "doubao-web",
  display: {
    name: "Doubao Web (doubao.com)",
    icon: "cloud",
    color: "#1677FF",
    textIcon: "DB",
    website: "https://doubao.com",
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint: "登录 https://doubao.com，打开 DevTools → Application → Cookies，复制登录凭据（通常是 uaa-token 或 session cookie）；或点 “Login via Browser” 自动抓包。",
  transport: {
    // baseUrl 需要抓 DevTools 确认 doubao.com 网页版的实际 API 端点
    baseUrl: "https://doubao.com",
    format: "openai",
    authType: "cookie",
  },
  models: [
    { id: "doubao-seed-1-6", name: "豆包 Seed 1.6" },
    { id: "doubao-seed-1-6-flash", name: "豆包 Seed 1.6 Flash" },
    { id: "doubao-1-5-pro", name: "豆包 1.5 Pro" },
    { id: "doubao-1-5-lite", name: "豆包 1.5 Lite" },
  ],
  passthroughModels: true,
};
