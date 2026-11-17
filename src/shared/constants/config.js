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

// CodeBuddy daily check-in (每日签到): claim the daily credit bonus once per
// local calendar day for opted-in CodeBuddy (CN + intl) connections. Same
// scheduler shape as MINIMAX_AUTOSIGNIN_CONFIG — hourly tick, per-day gate.
//
// The upstream is CodeBuddy's billing meter gateway (the same host as the quota
// lane), reached the way WorkBuddy's own frontend does:
//   POST /v2/billing/meter/checkin-activity-status   state
//   POST /v2/billing/meter/daily-checkin             claim
// The exact paths are isolated in open-sse/services/codebuddySignin.js so they
// can be corrected in one place if the contract shifts; every call reuses the
// chat gateway's auth headers + bearer token, so a refused token just backs off
// (never logs the account out).
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

// The daily check-in family, in the order the dashboard lists it. Every entry
// shares the scheduler shape above: an hourly tick, a per-connection opt-in map
// at settings[settingsKey].connections, and `enabled: false` as a global off
// switch. The "Auto check-in" master toggle on the quota page flips every
// eligible connection of every entry at once.
export const AUTO_SIGNIN_CONFIGS = [
  MINIMAX_AUTOSIGNIN_CONFIG,
  CODEBUDDY_AUTOSIGNIN_CONFIG,
  MODELSCOPE_AUTOSIGNIN_CONFIG,
];

// Which auth types can actually be checked in, per provider. MiniMax Code
// connections are OAuth, or "mcode-lease" when they mirror a local `mcode`
// login; CodeBuddy reuses its bearer for OAuth *and* API-key accounts; ModelScope
// is API-key only.
export const AUTO_SIGNIN_AUTH_TYPES = {
  "minimax-code": ["oauth", "mcode-lease"],
  "minimax-code-global": ["oauth", "mcode-lease"],
  "codebuddy-cn": ["oauth", "apikey"],
  "codebuddy-intl": ["oauth", "apikey"],
  modelscope: ["apikey"],
};

// Daily check-in is ON for newly added accounts: a fresh MiniMax Code /
// CodeBuddy / ModelScope connection is opted in at creation time, so the user
// never has to remember to flip a per-account toggle. An explicit `false`
// written by the user (single toggle, or the master switch) always wins and is
// never overwritten — only the *absence* of an entry falls back to this default.
export const AUTO_SIGNIN_DEFAULT_ENABLED = true;

/**
 * True when a connection is something the daily check-in can actually claim for:
 * a check-in provider, a supported auth type, and not switched off. Shared by the
 * dashboard and by the bulk endpoint so both agree on "eligible".
 */
export function isAutoSigninEligibleConnection(conn) {
  if (!conn?.provider) return false;
  if (conn.isActive === false) return false;
  const authTypes = AUTO_SIGNIN_AUTH_TYPES[conn.provider];
  if (!authTypes) return false;
  return authTypes.includes(conn.authType);
}

/** The check-in family whose opt-in map owns this provider, or null. */
export function getAutoSigninConfigForProvider(provider) {
  return AUTO_SIGNIN_CONFIGS.find((c) => c.providers.includes(provider)) || null;
}
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
