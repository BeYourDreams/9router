export default {
  id: "opencode-zen-v2",
  priority: 206,
  alias: "oczv2",
  uiAlias: "oczv2",
  display: {
    name: "OpenCode Zen v2",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OZ2",
    notice: {
      text: "OpenCode Zen v2: routes through the bundled opencode-free-bridge (Bun) for TLS fingerprint + self-healing gate + egress proxy. Reuses opencode-zen connections (API key).",
      apiKeyUrl: "https://opencode.ai/auth",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "http://127.0.0.1:20135/v1/chat/completions",
    headers: {},
  },
  models: [],
  passthroughModels: true,
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-go" },
  features: {
    usage: true,
    usageApikey: true,
  },
};
