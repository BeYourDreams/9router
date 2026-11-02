export default {
  id: "xinghuo-web",
  priority: 245,
  alias: "xinghuo-web",
  aliases: ["xinghuo", "spark", "讯飞"],
  uiAlias: "xinghuo-web",
  display: {
    name: "Xinghuo Web (讯飞星火)",
    icon: "auto_awesome",
    color: "#5581FE",
    textIcon: "XH",
    website: "https://xinghuo.xfyun.cn",
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint:
    "点 “Login via Browser” 登录 xinghuo.xfyun.cn 自动抓 Cookie；或 DevTools → Application → Cookies → xinghuo.xfyun.cn，整行复制 Cookie 头（必须含 SESSION / ssoSessionId）。",
  transport: {
    // Real web uplink, captured from the logged-in page (see executors/xinghuo-web).
    baseUrl: "https://xinghuo.xfyun.cn/iflygpt-chat/u/chat_message/chat",
    format: "openai",
    authType: "cookie",
  },
  // The web endpoint has NO model field: the site's model picker is driven by
  // server-side routing ("routeVersion":"v2") plus per-bot feature ids. Until a
  // second feature id is captured, every id below is a label for the same
  // channel — do not present them as distinct models.
  models: [
    { id: "xinghuo-auto", name: "星火 自动 (server-routed)" },
  ],
};
