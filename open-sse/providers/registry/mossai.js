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
      text: "MossAI 一站式 AI 模型平台。网页账号登录后即可每日签到领取算力；填入网页 access token（localStorage accessToken）用于签到与余额展示，开发者 sk- API Key 用于模型调用。",
    },
  },
  category: "freeTier",
  authType: "apikey",
  // 签到/余额用网页 access token（X-Access-Token），模型调用用 Bearer sk-key。
  // apiKey 字段承载网页 access token（签到/余额/调用共用，若调用失败用户可在
  // providerSpecificData.skKey 填开发者 sk- key）。
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "https://mossai.cc/v1/chat/completions",
    validateUrl: "https://mossai.cc/v1/models",
    // 目录公开带价目（GET /v1/models 需要有效 key），用 openai 过滤器拉取。
    modelsFetcher: { url: "https://mossai.cc/v1/models", type: "openai" },
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
