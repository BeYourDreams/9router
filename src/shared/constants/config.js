import pkg from "../../../package.json" with { type: "json" };

// App configuration
export const APP_CONFIG = {
  name: "9Router Proxy",
  description: "AI Infrastructure Management",
  version: pkg.version,
};

// GitHub configuration
export const GITHUB_CONFIG = {
  changelogUrl: "https://raw.githubusercontent.com/decolua/9router/refs/heads/master/CHANGELOG.md",
  donateUrl: "https://9router.com/api/donate",
};

// Updater configuration
export const UPDATER_CONFIG = {
  npmPackageName: "9router",
  installCmd: "npm i -g 9router",
  installCmdLatest: "npm i -g 9router@latest --prefer-online",
  shutdownCountdownSec: 3,
  exitDelayMs: 500,
  statusPort: 20129,
  statusPollIntervalMs: 1000,
  statusLogTailLines: 8,
  installRetries: 3,
  installRetryDelayMs: 5000,
  lingerAfterDoneMs: 30000,
  waitForExitMinMs: 5000,
  waitForExitMaxMs: 20000,
  waitForExitCheckMs: 500,
  appPort: 20128,
};

// Theme configuration
export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system", // "light" | "dark" | "system"
};

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
};

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
};

export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
};

// Client-side store TTL: how long fetched data stays fresh before re-fetching
export const CLIENT_STORE_TTL_MS = 60000;

// MiniMax Code daily check-in (每日签到): claim the daily credit bonus once per
// local calendar day for opted-in MiniMax Code connections. The bonus is granted
// as "签到" credits (30-day validity, MiniMax Code only).
//
// Wire protocol (reverse-engineered from the MiniMax Code web/desktop app):
//   GET  {agent}/minimax-cloud/api/v1/signin/status  -> {data:{scene,days:[...]}}
//   POST {agent}/minimax-cloud/api/v1/signin/claim   {scene:2}
//        -> {data:{claim_result,day_no,points,expire_at_ms,panel:{...}}}
// Both use the signed mcode account request (see minimaxCodeUsage.js).
export const MINIMAX_AUTOSIGNIN_CONFIG = {
  settingsKey: "minimaxAutoSignin",     // { enabled, connections: { [id]: true } }
  tickIntervalMs: 60 * 60 * 1000,        // hourly tick; the per-day gate dedupes claims
  dayAnchorLocalHour: 0,                 // rollover at local midnight
  failureCooldownMs: 30 * 60 * 1000,     // do not hammer after a failed claim
  providers: ["minimax-code", "minimax-code-global"],
};

// CodeBuddy daily check-in (每日签到): claim the daily credit/points bonus once
// per local calendar day for opted-in CodeBuddy (CN + intl) connections. Same
// scheduler shape as MINIMAX_AUTOSIGNIN_CONFIG — hourly tick, per-day gate.
//
// The upstream is the CodeBuddy activity gateway (Tencent APISIX in front of
// /v2/activity/*). The exact resource path is isolated in
// open-sse/services/codebuddySignin.js (SIGNIN_STATUS_PATH / SIGNIN_CLAIM_PATH)
// so it can be corrected in one place if the contract shifts; every call reuses
// the chat gateway's auth headers + bearer token, so a refused token just backs
// off (never logs the account out).
export const CODEBUDDY_AUTOSIGNIN_CONFIG = {
  settingsKey: "codebuddyAutoSignin",   // { enabled, connections: { [id]: true } }
  tickIntervalMs: 60 * 60 * 1000,        // hourly tick; the per-day gate dedupes claims
  dayAnchorLocalHour: 0,                 // rollover at local midnight
  failureCooldownMs: 30 * 60 * 1000,     // do not hammer after a failed claim
  providers: ["codebuddy-cn", "codebuddy-intl"],
};

// ModelScope 魔搭 daily auto-login (每日自动登录领取魔粒): one authenticated
// Magicube call per local calendar day per opted-in account. The daily reward
// (200 基础 + 50 绑定阿里云, 当日有效) is granted on login, so the call *is* the
// claim — see open-sse/services/modelscopeMagicube.js for the endpoints.
export const MODELSCOPE_AUTOSIGNIN_CONFIG = {
  settingsKey: "modelscopeAutoSignin",  // { enabled, connections: { [id]: true } }
  tickIntervalMs: 60 * 60 * 1000,        // hourly tick; the per-day gate dedupes logins
  dayAnchorLocalHour: 0,                 // rollover at local midnight
  failureCooldownMs: 30 * 60 * 1000,     // do not hammer after a failed login
  providers: ["modelscope"],
};
// Quota auto-ping: keep 5h windows warm by sending a tiny request right after reset.
export const QUOTA_AUTOPING_CONFIG = {
  tickIntervalMs: 60000,                // scheduler tick
  pingLeadMs: 5000,                     // fire once reset passes (within tolerance)
  refreshAheadMs: 300000,               // refetch usage when within 5min of reset
  failureCooldownMs: 900000,            // avoid failed ping spam while upstream/auth is unhealthy
  providers: {
    claude: {
      settingsKey: "claudeAutoPing",    // preserve existing settings contract
      quotaKey: "session (5h)",         // quota key returned by usage handler
      pingModel: "claude-haiku-4-5-20251001",
      pingText: "hi",
      pingMaxTokens: 1,
    },
    codex: {
      settingsKey: "codexAutoPing",
      quotaKey: "session",
      pingWhenResetAtSlides: true,
      resetAtDriftMs: 30000,
      minPingIntervalMs: 600000,
      skipWhenBlockingQuotaExhausted: true,
      // gpt-5.6-terra is the lightweight model for auto-pinging Codex 5h reset window.
      pingModel: "gpt-5.6-terra",
      pingText: "hi",
      pingInstructions: "Reply with OK.",
      pingReasoningEffort: "none",
    },
  },
};

// Re-export from providers.js for backward compatibility
export {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers.js";

// Re-export from models.js for backward compatibility
export {
  PROVIDER_MODELS,
  AI_MODELS,
} from "./models.js";
