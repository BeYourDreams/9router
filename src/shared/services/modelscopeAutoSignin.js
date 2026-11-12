// ModelScope 魔搭 daily auto-login scheduler: once per local calendar day, make
// one authenticated Magicube call per opted-in ModelScope connection so the
// day's 魔粒 (200 base + 50 Aliyun-bound) are granted.
//
// Mirrors codebuddyAutoSignin.js:
//   - An hourly tick; the real gate is the per-connection "already logged in
//     today" date, so a login fires at most once per local day across restarts.
//   - Opt-in is per connection: settings.modelscopeAutoSignin.connections[id] === true
//     (settings.enabled, when explicitly false, disables the feature wholesale).
//   - A refused/expired token is logged and cooled down — never logged out here.
//
// The upstream login is idempotent (a second call the same day grants nothing),
// so a double-run is harmless; persisting the date just avoids pointless
// round-trips and keeps the dashboard honest about "last logged in".

import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { MODELSCOPE_AUTOSIGNIN_CONFIG } from "@/shared/constants/config";
import { runModelScopeDailyLogin } from "open-sse/services/modelscopeMagicube.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const C = MODELSCOPE_AUTOSIGNIN_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__modelscopeAutoSignin ??= {
  interval: null,
  running: false,
  failureCache: {},
});

/** Local calendar day key (YYYY-MM-DD) used to dedupe logins per connection. */
export function localDayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The connection ids the user opted into daily auto-login. */
export function enabledConnectionIds(settings) {
  const cfg = settings?.[C.settingsKey];
  if (cfg && cfg.enabled === false) return new Set();
  const map = cfg?.connections || {};
  return new Set(Object.entries(map).filter(([, on]) => on === true).map(([id]) => id));
}

function shouldSkipAfterFailure(key, nowMs = Date.now()) {
  const failedAt = g.failureCache[key];
  return failedAt && nowMs - failedAt < C.failureCooldownMs;
}

function proxyOptionsFor(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

/**
 * Log in one connection, honoring the per-day gate. `deps` is injectable for
 * tests (refresh/login/updateConnection/resolveConnectionProxyConfig).
 */
export async function loginConnection(conn, deps, nowMs = Date.now()) {
  const today = localDayKey(nowMs);

  // Done for today -> nothing to do. The date key is enough: any login the
  // same day is a no-op upstream, and a fresh day carries a different key.
  if (conn.modelscopeLastLoginDate === today) {
    return { skipped: "already-logged-in-today" };
  }

  const key = `${conn.provider}:${conn.id}`;
  if (shouldSkipAfterFailure(key, nowMs)) return { skipped: "failure-cooldown" };

  // Keep the token fresh before the call. ModelScope is a static access token,
  // so this is normally a no-op, but it keeps the lane uniform with the other
  // daily-login providers and refreshes any OAuth-wrapped credential.
  let connection = conn;
  try {
    const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
    const r = await deps.refreshAndUpdateCredentials(connection, false, proxyOptionsFor(proxyCfg));
    connection = r.connection || connection;
  } catch (e) {
    g.failureCache[key] = nowMs;
    console.warn(`[ModelScopeLogin] ${key}: refresh failed: ${e.message}`);
    return { error: `refresh failed: ${e.message}` };
  }

  const result = await deps.login(connection);

  if (!result?.ok) {
    g.failureCache[key] = nowMs;
    const suffix = result?.authExpired ? " (token expired — re-authorize)" : "";
    console.warn(`[ModelScopeLogin] ${key}: ${result?.error ?? "unknown error"}${suffix}`);
    return { error: result?.error ?? "unknown error", authExpired: result?.authExpired === true };
  }

  delete g.failureCache[key];
  const nowIso = new Date(nowMs).toISOString();
  const patch = {
    modelscopeLastLoginDate: today,
    modelscopeLastLoginAt: nowIso,
    // The login itself is the claim, so the day is sealed once the call
    // succeeds; a partially-credited day (Aliyun bound mid-day) is still done
    // from our side — the next tick tomorrow picks up the full amount.
    modelscopeLastLoginDone: true,
    modelscopeLastLoginEarnedToday: result.earnedToday ?? 0,
    ...(result.balance ? { modelscopeMagicubeBalance: result.balance.total } : {}),
  };
  await deps.updateConnection(conn.id, patch);
  console.log(
    `[ModelScopeLogin] ${key}: logged in (day ${today}), +${result.earnedToday ?? 0} 魔粒 today, balance ${result.balance?.total ?? "?"}`,
  );
  return { loggedIn: true, earnedToday: result.earnedToday ?? 0, balance: result.balance ?? null };
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateConnection: updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    login: runModelScopeDailyLogin,
  };
}

/** One scheduler tick across all ModelScope connections. Returns a summary (tests + logs). */
export async function runModelScopeAutoSigninTick(deps = createDefaultDeps(), state = g, nowMs = Date.now()) {
  if (state.running) return { skipped: "busy" };
  state.running = true;
  const summary = { checked: 0, loggedIn: 0, earned: 0, errors: 0 };
  try {
    const settings = await deps.getSettings();
    const ids = enabledConnectionIds(settings);
    if (ids.size === 0) return summary;

    for (const provider of C.providers) {
      const conns = await deps.getProviderConnections({ provider, isActive: true });
      for (const conn of conns) {
        if (!ids.has(conn.id)) continue;
        if (conn.authType !== "apikey") continue;
        summary.checked += 1;
        try {
          const r = await loginConnection(conn, deps, nowMs);
          if (r?.loggedIn) { summary.loggedIn += 1; summary.earned += r.earnedToday || 0; }
          if (r?.error) summary.errors += 1;
        } catch (e) {
          summary.errors += 1;
          console.warn(`[ModelScopeLogin] ${provider}:${conn.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn("[ModelScopeLogin] tick error:", e.message);
  } finally {
    state.running = false;
  }
  return summary;
}

export function startModelScopeAutoSignin() {
  if (g.interval) return;
  console.log("[ModelScopeLogin] scheduler started");
  runModelScopeAutoSigninTick().catch(() => {});
  g.interval = setInterval(() => { runModelScopeAutoSigninTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopModelScopeAutoSignin() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[ModelScopeLogin] scheduler stopped");
}

/** A single opted-in connection is enough to need the scheduler running. */
export function hasAnyAutoSigninEnabled(settings) {
  return enabledConnectionIds(settings).size > 0;
}

export function configureModelScopeAutoSignin(settings) {
  if (hasAnyAutoSigninEnabled(settings)) startModelScopeAutoSignin();
  else stopModelScopeAutoSignin();
}
