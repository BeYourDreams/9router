export default {
  id: "mossai",
  priority: 262,
  alias: "mossai",
  aliases: ["moss", "moss-ai"],
  uiAlias: "mossai",
  hasFree: true,
  display: {
    name: "MossAI (mossai.cc)",
    icon: "auto_awesome",
    color: "#0EA5E9",
    textIcon: "MA",
    website: "https://mossai.cc",
    notice: {
      apiKeyUrl: "https://mossai.cc/",
      text: "MossAI 一站式 AI 模型平台。apiKey 填开发者 sk- API Key（模型调用，走 /api/open-platform/v1）；网页 access token（localStorage accessToken）存在连接的 accessToken 字段，用于每日签到与算力余额。",
    },
  },
  category: "freeTier",
  authType: "apikey",
  // 两条凭证互不相同：
  //   apiKey      = 开发者 sk- key → 模型调用（Bearer）。模型网关只认 /api/open-platform/v1
  //                 （https://mossai.cc/v1 对这些 key 直接 401，已实测）。
  //   accessToken = 网页 access token → 签到/余额（X-Access-Token）。
  // 连接列表里 sk- key 是主凭证，所以 apiKey 归它；网页 token 由 resolveToken 单独取。
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "https://mossai.cc/api/open-platform/v1/chat/completions",
    validateUrl: "https://mossai.cc/api/open-platform/v1/models",
    // 目录公开带价目（GET …/models 需要有效 sk- key），用 openai 过滤器拉取。
    modelsFetcher: { url: "https://mossai.cc/api/open-platform/v1/models", type: "openai" },
  },
  serviceKinds: ["llm"],
  models: [
    { id: "gpt-6-astra", name: "GPT6 Astra" },
    { id: "nano-banana-2", name: "Nano Banana 2" },
    { id: "nano-banana-pro", name: "Nano Banana Pro" },
    { id: "gpt-image-2", name: "GPT Image 2" },
  ],
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
