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
  authHint:
    "点 “Login via Browser” 登录 doubao.com 自动抓 Cookie；或 DevTools → Application → Cookies → www.doubao.com，整行复制 Cookie 头（必须含 sessionid / sid_tt）。",
  transport: {
    // Real web uplink, captured from the logged-in page (see executors/doubao-web).
    // The query string carries only inert client constants — the per-request
    // anti-bot signatures (msToken / a_bogus) are deliberately NOT replayed:
    // a stale one is answered as a rate-limit challenge.
    baseUrl: "https://www.doubao.com/chat/completion",
    format: "openai",
    authType: "cookie",
  },
  // model_item_key values read out of the /chat/ SSR payload (menu_item_list).
  // The client sends the key, not a model name — these ids are aliases mapped in
  // executors/doubao-web/adapter.js MODEL_KEYS.
  models: [
    { id: "doubao-fast", name: "豆包 快速" },
    { id: "doubao-expert", name: "豆包 专家" },
    { id: "doubao-2-1-pro", name: "豆包 2.1 Pro" },
    { id: "doubao-2-1-lite", name: "豆包 2.1 Lite" },
  ],
};
