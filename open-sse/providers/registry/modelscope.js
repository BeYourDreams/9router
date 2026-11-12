export default {
  id: "modelscope",
  priority: 260,
  alias: "modelscope",
  aliases: [
    "ms",
    "modelscope-inference",
  ],
  uiAlias: "ms",
  hasFree: true,
  display: {
    name: "ModelScope 魔搭",
    icon: "diversity_3",
    color: "#624AFF",
    textIcon: "MS",
    website: "https://www.modelscope.cn",
    notice: {
      apiKeyUrl: "https://modelscope.cn/my/myaccesstoken",
      text: "Free API-Inference for open models. Requires an Aliyun account binding + real-name verification. Calls are billed in 魔粒 (Magicube credits) — 0.5/1/2 per call by model tier; daily login grants 200 + 50 (Aliyun-bound) credits.",
    },
  },
  category: "freeTier",
  authType: "apikey",
  // The access token is a bearer for API-Inference, and the same token
  // authenticates the Magicube daily-credit call in the auto-login scheduler.
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "https://api-inference.modelscope.cn/v1/chat/completions",
    validateUrl: "https://api-inference.modelscope.cn/v1/models",
    // The catalogue is public and OpenAI-shaped (no key needed), so the model
    // list stays current instead of rotting in the seed set below.
    modelsFetcher: { url: "https://api-inference.modelscope.cn/v1/models", type: "openai" },
  },
  serviceKinds: ["llm"],
  // Seed set — refreshable at runtime through modelsFetcher above.
  models: [
    { id: "Qwen/Qwen3.5-397B-A17B", name: "Qwen 3.5 397B A17B" },
    { id: "Qwen/Qwen3.5-122B-A10B", name: "Qwen 3.5 122B A10B" },
    { id: "Qwen/Qwen3.5-35B-A3B", name: "Qwen 3.5 35B A3B" },
    { id: "Qwen/Qwen3.5-27B", name: "Qwen 3.5 27B" },
    { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" },
    { id: "moonshotai/Kimi-K3.1-Pro", name: "Kimi K3.1 Pro" },
    { id: "MiniMax/MiniMax-M3", name: "MiniMax M3" },
    { id: "ZhipuAI/GLM-5.2", name: "GLM 5.2" },
    { id: "ZhipuAI/GLM-4.7-Flash", name: "GLM 4.7 Flash" },
    { id: "stepfun-ai/Step-3.7-Flash", name: "Step 3.7 Flash" },
  ],
  passthroughModels: true,
};
