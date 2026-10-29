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
  models: [
    { id: "Auto", name: "Auto" },
    { id: "internlm2.5-20b", name: "InternLM2.5-20B" },
    { id: "internlm2.5-7b", name: "InternLM2.5-7B" },
  ],
  passthroughModels: true,
};
