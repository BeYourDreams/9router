// MiniMax Code (mcode), international site — same wire protocol as the China
// entry (minimax-code.js), different hosts. Sign-ins are per-site: an account
// on agent.minimax.cn says nothing about agent.minimaxi.com. See
// docs/minimax-code-proxy-plan.md for the shared protocol notes.
//
// The site moved: agent.minimax.io now answers EVERY request with a 307 to
// agent.minimaxi.com (global sign-in moved with it, account.minimaxi.com still
// runs the same mcode-public device flow). Following that redirect client-side
// is what broke this provider — fetch drops Authorization on a cross-origin
// hop, so upstream saw an anonymous request and answered
// 401 {"code":401,"message":"token is required"}. A mmoat_2_… token was then
// refused outright ("invalid access token") on the new host; a token minted
// against account.minimaxi.com is accepted. So talk to minimaxi.com directly.
//
// DEPRECATED — the international deployment has been consolidated into the
// China one, so this provider is now a functional duplicate of minimax-code:
//   • bare agent.minimaxi.com/ answers 302 → agent.minimax.cn/;
//   • /mavis/api/v1/models?region=en returns a catalog byte-identical to the
//     region=cn one on agent.minimax.cn (same model_order/whitelist);
//   • the two OAuth hosts share one device-code store — a device_code minted
//     at account.minimaxi.com is recognised (answered slow_down, not
//     expired_token) when polled at account.minimax.cn/oauth2/token.
// The API paths still answer directly today, so existing connections keep
// working; this flag is a warning that sign-ins should move to "MiniMax Code"
// (minimax-code, host agent.minimax.cn) rather than a hard cut-off.

export default {
  id: "minimax-code-global",
  priority: 80,
  alias: "mmg",
  display: {
    name: "MiniMax Code (Global)",
    icon: "smart_toy",
    color: "#FF4D4F",
    textIcon: "MM",
    website: "https://minimaxi.com",
    deprecated: true,
    deprecationNotice:
      "MiniMax's international site has been merged into the China one: agent.minimaxi.com now redirects to agent.minimax.cn and both serve the same catalog and sign-in backend. This provider is a duplicate of \"MiniMax Code\" — new connections should use that provider instead. Existing connections keep working.",
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  features: { usage: true },
  modelsFetcher: { url: "https://agent.minimaxi.com/mavis/api/v1/models?region=en&buildEnv=prod", type: "minimax-code" },
  transport: {
    baseUrl: "https://agent.minimaxi.com/mavis/api/v1/llm/v1/messages",
    format: "claude",
    thinkingFormat: "claude-adaptive",
    headers: {
      "User-Agent": "MiniMaxAgent",
      "X-Mavis-Agent-Id": "main",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      anthropicVersion: true,
      hooks: ["minimaxHeaders"],
    },
  },
  oauth: {
    clientId: "mcode-public",
    deviceUrl: "https://account.minimaxi.com/oauth2/device/code",
    tokenUrl: "https://account.minimaxi.com/oauth2/token",
    scope: "agent.default",
    audience: "agent-backend",
    // mcode access tokens live ~1h; renew early (feeds REFRESH_LEAD_MS)
    refreshLeadMs: 10 * 60 * 1000,
  },
  // minimaxi.com's catalog is narrower than the CN one (verified against
  // /mavis/api/v1/models?region=en after the move): M3.1-Flash and M3 only.
  // The M3.1-Flash-Preview / M2.7 ids stay for pinned configs; upstream answers
  // an id it does not serve with 402 insufficient_balance_error, not 404.
  models: [
    { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash" },
    { id: "MiniMax-M3.1-Flash-Preview", name: "MiniMax M3.1 Flash Preview" },
    { id: "MiniMax-M3", name: "MiniMax M3" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" },
  ],
};
