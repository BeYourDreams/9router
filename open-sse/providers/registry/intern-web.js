export default {
  id: "intern-web",
  priority: 230,
  alias: "intern-web",
  aliases: ["intern", "intern-ai"],
  uiAlias: "intern-web",
  display: {
    name: "Intern Web (intern-ai.org.cn)",
    icon: "auto_awesome",
    color: "#6366F1",
    textIcon: "IW",
    website: "https://discovery.intern-ai.org.cn",
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint: "Paste your discovery.intern-ai.org.cn login cookie header from DevTools → Application → Cookies, or click “Login via Browser” to capture it automatically.",
  transport: {
    baseUrl: "https://discovery.intern-ai.org.cn",
    format: "openai",
    authType: "cookie",
  },
  // Mirrors GET /api/orbit/v1/models (captured 2026-10). "Auto" is the router
  // alias the UI exposes; upstream calls the same selection "Default".
  models: [
    { id: "Auto", name: "Auto" },
    { id: "Default", name: "Default" },
    { id: "书生-Agents-A1", name: "书生-Agents-A1" },
    { id: "书生-A1.5", name: "书生-A1.5" },
    { id: "书生-S2", name: "书生-S2" },
    { id: "书生-Atria-Dawn-Preview", name: "书生-Atria-Dawn-Preview" },
    { id: "Qwen3.7-Plus", name: "Qwen3.7-Plus" },
    { id: "Qwen3.8-Flash", name: "Qwen3.8-Flash" },
    { id: "DeepSeek-V4-Flash", name: "DeepSeek-V4-Flash" },
    { id: "Kimi-K2.7-Code", name: "Kimi-K2.7-Code" },
  ],
  passthroughModels: true,
};
