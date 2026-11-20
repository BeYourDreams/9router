export default {
  id: "codebuddy-cn",
  // Short model prefix (cbcn/glm-5.2). "cbcn" = CodeBuddy CN; reserve "cbai"
  // for a future codebuddy-ai (intl) provider. The full id still resolves.
  alias: "cbcn",
  uiAlias: "cbcn",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy CN",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://copilot.tencent.com",
    notice: {
      signupUrl: "https://copilot.tencent.com",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://copilot.tencent.com/v2/chat/completions",
    forceStream: true,
    // CodeBuddy is a unified OpenAI-compatible gateway: every model (GLM, Kimi,
    // MiniMax, DeepSeek, Hunyuan) takes reasoning via OpenAI-style reasoning_effort,
    // not its vendor-native thinking shape. Force the openai thinking format.
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      // Channel check requires the plugin's request/conversation ids — without
      // them upstream rejects with 400 / 11128 "request illegal".
      hooks: ["codebuddyHeaders"],
    },
    // Quota endpoint differs from the chat gateway: POST returns nested Tencent
    // billing payload (data.Response.Data.Accounts[]). See services/usage/codebuddy-cn.js.
    usage: {
      url: "https://copilot.tencent.com/v2/billing/meter/get-user-resource",
    },
  },
  // Offline fallback for the CLI agent's live catalog. The resolver in
  // services/codebuddyModels.js keeps this current; the 2026-11-20 snapshot
  // below is what /console/enterprises/personal/models publishes. Names carry
  // the upstream credits multiplier, like the official client.
  models: [
    { id: "auto", name: "Auto" },
    { id: "hy4std", name: "Hy4 (x0.29 credits)" },
    { id: "hy4flash-free", name: "Hy4 flash (x0.00)" },
    { id: "hy4flash", name: "Hy4 flash (x0.03)" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash (x0.11 credits)" },
    { id: "glm-5.3", name: "GLM-5.3 (x0.69)" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash (x0.08)" },
    { id: "glm-5.2", name: "GLM-5.2 (x0.79 credits)" },
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro (x0.97 credits)" },
    { id: "kimi-k3-1", name: "Kimi-K3 (x1.62 credits)" },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview (x0.77 credits)" },
    { id: "space-bunny", name: "Space-Bunny (x0.08 credits)" },
    { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash (x0.08 credits)" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro (x0.51 credits)" },
    { id: "step-5-preview", name: "Step-5-Preview (x0.33 credits)" },
    { id: "mimo-v2.6-pro", name: "Xiaomi MiMo-V2.6-Pro (x0.13 credits)" },
  ],
  oauth: {
    baseUrl: "https://copilot.tencent.com",
    stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
    tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
    refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
    platform: "CLI",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
