// Qwen (qianwen.com) web provider — clean-room browser turn.
//
// Auth: cookie-based. The user pastes a login cookie header (or a Playwright
// storageState JSON) from DevTools → Cookies → qianwen.com (the `isg` /
// `tfstk` / `_qk_bx_um_v1` session cookies the page's security SDK signs with).
//
// The web client signs every /api/v2/chat call from within the page (Aliyun
// x5sec + bx headers), so turns are driven through the pooled browser context
// rather than plain Node fetch: goto https://www.qianwen.com/, type into the
// chat input, click 发送消息, stream the `.answer-common-card` bubbles into OpenAI SSE.
// Without a login cookie the upstream refuses every turn ("we can't answer that"
// — RGV587 risk control blocks anonymous usage), so the connection cannot be used.
//
// Endpoint: POST https://chat2.qianwen.com/api/v2/chat?biz_id=ai_qwen&...
//   body.model: "Qwen" | "Qwen3.7-Max" | "Qwen3.6-Flash"
//   3rd-party / passthrough models are forwarded as-is; streaming supported.
//
  // Login capture target: `.qianwen.com` cookies `isg` + `tfstk` (see webLoginConfig).

export default {
  id: "qwen-web",
  priority: 210,
  alias: "qwen-web",
  aliases: [
    "qwen-web",
    "qianwen-web",
  ],
  uiAlias: "Qwen",
  display: {
    name: "Qwen (qianwen.com)",
    icon: "auto_awesome",
    color: "#615CED",
    textIcon: "QW",
    website: "https://qianwen.com",
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint: "Paste your qianwen.com login cookie header (the `isg`, `tfstk` and `_qk_bx_*` session cookies from DevTools → Application → Cookies → qianwen.com), or click \"Login via Browser\" to capture the `isg` session cookie automatically.",
  transport: {
    baseUrl: "https://www.qianwen.com",
    format: "openai",
    authType: "cookie",
  },
  models: [
    { id: "Qwen", name: "Qwen3.7-千问", supportsReasoning: true },
    { id: "Qwen3.7-Max", name: "Qwen3.7-Max" },
    { id: "Qwen3.6-Flash", name: "Qwen3.6-Flash" },
  ],
  passthroughModels: true,
};
