// CodeBuddy daily check-in scheduler: once per local calendar day, claim the
// daily credit/points bonus (每日签到) for every opted-in CodeBuddy connection.
//
// Mirrors minimaxAutoSignin.js:
//   - An hourly tick; the real gate is the per-connection "already claimed today"
//     date, so a claim fires at most once per local day even across restarts.
//   - Opt-in is per connection: settings.codebuddyAutoSignin.connections[id] === true
//     (settings.enabled, when explicitly false, disables the feature wholesale).
//   - A refused/expired token is logged and cooled down — never logged out here.
//
// The upstream claim is idempotent, so a double-run is harmless; persisting the
// date just avoids pointless round-trips and keeps the dashboard honest about
// "last checked in".

import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { CODEBUDDY_AUTOSIGNIN_CONFIG } from "@/shared/constants/config";
import { runCodeBuddySignin } from "open-sse/services/codebuddySignin.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const C = CODEBUDDY_AUTOSIGNIN_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__codebuddyAutoSignin ??= {
  interval: null,
  running: false,
  failureCache: {},
});

/** Local calendar day key (YYYY-MM-DD) used to dedupe claims per connection. */
export function localDayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The connection ids the user opted into daily check-in. */
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
 * Check in one connection, honoring the per-day gate. `deps` is injectable for
 * tests (refresh/signin/updateConnection/resolveConnectionProxyConfig).
 */
export async function checkinConnection(conn, deps, nowMs = Date.now()) {
  const today = localDayKey(nowMs);

  // Done for today (claimed now, or already claimed upstream) -> nothing to do.
  // Once the day is sealed we stop polling too: a second claim attempt
  // the same day only earns "already claimed", and the day gate already keeps
  // an off→on toggle from re-claiming. A fresh day has a different date key.
  //
  // `codebuddyLastSigninDate` alone is not enough: an earlier pass records the
  // date even when nothing was claimed, so the *seal* (done===true) is the real
  // gate. Without it one unlucky early pass silently skipped the whole day.
  if (conn.codebuddyLastSigninDate === today && conn.codebuddyLastSigninDone) {
    return { skipped: "already-claimed-today" };
  }

  const key = `${conn.provider}:${conn.id}`;
  if (shouldSkipAfterFailure(key, nowMs)) return { skipped: "failure-cooldown" };

  // Keep the token fresh before the call — the sign-in endpoint needs a live
  // bearer, and refresh also rotates a near-expiry OAuth token uniformly.
  let connection = conn;
  try {
    const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
    const r = await deps.refreshAndUpdateCredentials(connection, false, proxyOptionsFor(proxyCfg));
    connection = r.connection || connection;
  } catch (e) {
    g.failureCache[key] = nowMs;
    console.warn(`[CodeBuddySignin] ${key}: refresh failed: ${e.message}`);
    return { error: `refresh failed: ${e.message}` };
  }

  const result = await deps.signin(connection);

  if (!result?.ok) {
    g.failureCache[key] = nowMs;
    const suffix = result?.authExpired ? " (sign-in expired — re-authorize)" : "";
    console.warn(`[CodeBuddySignin] ${key}: ${result?.error ?? "unknown error"}${suffix}`);
    return { error: result?.error ?? "unknown error", authExpired: result?.authExpired === true };
  }

  delete g.failureCache[key];
  const nowIso = new Date(nowMs).toISOString();
  const doneToday = result.claimed === true || result.alreadyClaimed === true;
  const patch = {
    codebuddyLastSigninDate: today,
    codebuddyLastSigninAt: nowIso,
    // doneToday seals the day: a claimed-now or already-claimed-upstream pass
    // stops further polling until the local date rolls over.
    codebuddyLastSigninDone: doneToday,
    codebuddyLastSigninClaimed: result.claimed === true,
    codebuddyLastSigninPoints: result.points ?? 0,
    ...(result.claimed
      ? { codebuddyLastSigninTotalPoints: (conn.codebuddyLastSigninTotalPoints || 0) + (result.points || 0) }
      : {}),
  };
  await deps.updateConnection(conn.id, patch);
  if (result.claimed) {
    console.log(`[CodeBuddySignin] ${key}: claimed +${result.points} points (day ${today})`);
  }
  return { claimed: result.claimed === true, points: result.points ?? 0, alreadyClaimed: result.alreadyClaimed === true };
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateConnection: updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    signin: runCodeBuddySignin,
  };
}

/** One scheduler tick across all CodeBuddy providers. Returns a summary (tests + logs). */
export async function runCodeBuddyAutoSigninTick(deps = createDefaultDeps(), state = g, nowMs = Date.now()) {
  if (state.running) return { skipped: "busy" };
  state.running = true;
  const summary = { checked: 0, claimed: 0, points: 0, errors: 0 };
  try {
    const settings = await deps.getSettings();
    const ids = enabledConnectionIds(settings);
    if (ids.size === 0) return summary;

    for (const provider of C.providers) {
      const conns = await deps.getProviderConnections({ provider, isActive: true });
      for (const conn of conns) {
        if (!ids.has(conn.id)) continue;
        // CodeBuddy connections are oauth or apikey — both carry a bearer token.
        if (conn.authType !== "oauth" && conn.authType !== "apikey") continue;
        summary.checked += 1;
        try {
          const r = await checkinConnection(conn, deps, nowMs);
          if (r?.claimed) { summary.claimed += 1; summary.points += r.points || 0; }
          if (r?.error) summary.errors += 1;
        } catch (e) {
          summary.errors += 1;
          console.warn(`[CodeBuddySignin] ${provider}:${conn.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn("[CodeBuddySignin] tick error:", e.message);
  } finally {
    state.running = false;
  }
  return summary;
}

export function startCodeBuddyAutoSignin() {
  if (g.interval) return;
  console.log("[CodeBuddySignin] scheduler started");
  runCodeBuddyAutoSigninTick().catch(() => {});
  g.interval = setInterval(() => { runCodeBuddyAutoSigninTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopCodeBuddyAutoSignin() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[CodeBuddySignin] scheduler stopped");
}

/** A single opted-in connection is enough to need the scheduler running. */
export function hasAnyAutoSigninEnabled(settings) {
  return enabledConnectionIds(settings).size > 0;
}

export function configureCodeBuddyAutoSignin(settings) {
  if (hasAnyAutoSigninEnabled(settings)) startCodeBuddyAutoSignin();
  else stopCodeBuddyAutoSignin();
}
