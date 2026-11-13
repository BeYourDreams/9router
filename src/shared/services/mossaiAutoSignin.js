// MossAI (mossai.cc) daily check-in scheduler: once per local calendar day,
// claim the daily 算力 reward for every opted-in MossAI connection and refresh
// the balance read, so the dashboard's 算力 quota row stays honest.
//
// Mirrors modelscopeAutoSignin.js:
//   - An hourly tick; the real gate is the per-connection "already claimed
//     today" date, so a claim fires at most once per local day across restarts.
//   - Opt-in is per connection: settings.mossaiAutoSignin.connections[id] === true
//     (settings.enabled, when explicitly false, disables the feature wholesale).
//   - A refused/expired token is logged and cooled down — never logged out here.
//
// The upstream claim is idempotent (a second claim the same day grants
// nothing), so a double-run is harmless; persisting the date just avoids
// pointless round-trips and keeps the dashboard honest about "last checked in".

import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { MOSSAI_AUTOSIGNIN_CONFIG } from "@/shared/constants/config";
import { claimMossCheckin, readMossBalance } from "open-sse/services/mossaiSignin.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const C = MOSSAI_AUTOSIGNIN_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__mossaiAutoSignin ??= {
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
 * tests (refresh/claim/readBalance/updateConnection/resolveConnectionProxyConfig).
 */
export async function checkinConnection(conn, deps, nowMs = Date.now()) {
  const today = localDayKey(nowMs);

  // Done for today (claimed now, or already claimed upstream) -> nothing to do.
  // The seal (done===true) is the real gate: a date alone would let an unlucky
  // early pass skip the whole day.
  if (conn.mossaiLastSigninDate === today && conn.mossaiLastSigninDone) {
    return { skipped: "already-claimed-today" };
  }

  const key = `${conn.provider}:${conn.id}`;
  if (shouldSkipAfterFailure(key, nowMs)) return { skipped: "failure-cooldown" };

  // Keep the token fresh before the call — a web access token may be OAuth-
  // wrapped; refresh rotates a near-expiry credential uniformly.
  let connection = conn;
  try {
    const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
    const r = await deps.refreshAndUpdateCredentials(connection, false, proxyOptionsFor(proxyCfg));
    connection = r.connection || connection;
  } catch (e) {
    g.failureCache[key] = nowMs;
    console.warn(`[MossSignin] ${key}: refresh failed: ${e.message}`);
    return { error: `refresh failed: ${e.message}` };
  }

  // Read current balance + status first; claim only when today is still open.
  const status = await deps.readStatus(connection);
  let result = { ok: false, error: "status failed" };
  if (status?.ok && status.claimedToday !== true) {
    result = await deps.claim(connection);
  } else {
    result = { ok: true, alreadyClaimed: true, reward: status?.reward ?? null };
  }

  if (!result?.ok) {
    g.failureCache[key] = nowMs;
    const suffix = result?.authExpired ? " (sign-in expired — re-authorize)" : "";
    console.warn(`[MossSignin] ${key}: ${result?.error ?? "unknown error"}${suffix}`);
    return { error: result?.error ?? "unknown error", authExpired: result?.authExpired === true };
  }

  const balance = await deps.readBalance(connection).catch(() => null);
  delete g.failureCache[key];
  const nowIso = new Date(nowMs).toISOString();
  const doneToday = result.claimed === true || result.alreadyClaimed === true;
  const patch = {
    mossaiLastSigninDate: today,
    mossaiLastSigninAt: nowIso,
    mossaiLastSigninDone: doneToday,
    mossaiLastSigninClaimed: result.claimed === true,
    mossaiLastSigninReward: result.reward ?? 0,
    ...(balance?.ok ? { mossaiBalance: balance.balance } : {}),
  };
  await deps.updateConnection(conn.id, patch);
  if (result.claimed) {
    console.log(`[MossSignin] ${key}: claimed +${result.reward} 算力 (day ${today})`);
  }
  return {
    claimed: result.claimed === true,
    reward: result.reward ?? 0,
    alreadyClaimed: result.alreadyClaimed === true,
    balance: balance?.ok ? balance.balance : null,
  };
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateConnection: updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    readStatus: (conn) => import("open-sse/services/mossaiSignin.js").then((m) => m.readMossCheckinStatus(conn)),
    claim: (conn) => import("open-sse/services/mossaiSignin.js").then((m) => m.claimMossCheckin(conn)),
    readBalance: (conn) => import("open-sse/services/mossaiSignin.js").then((m) => m.readMossBalance(conn)),
  };
}

/** One scheduler tick across all MossAI connections. Returns a summary. */
export async function runMossAutoSigninTick(deps = createDefaultDeps(), state = g, nowMs = Date.now()) {
  if (state.running) return { skipped: "busy" };
  state.running = true;
  const summary = { checked: 0, claimed: 0, reward: 0, errors: 0 };
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
          const r = await checkinConnection(conn, deps, nowMs);
          if (r?.claimed) { summary.claimed += 1; summary.reward += r.reward || 0; }
          if (r?.error) summary.errors += 1;
        } catch (e) {
          summary.errors += 1;
          console.warn(`[MossSignin] ${provider}:${conn.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn("[MossSignin] tick error:", e.message);
  } finally {
    state.running = false;
  }
  return summary;
}

export function startMossAutoSignin() {
  if (g.interval) return;
  console.log("[MossSignin] scheduler started");
  runMossAutoSigninTick().catch(() => {});
  g.interval = setInterval(() => { runMossAutoSigninTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopMossAutoSignin() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[MossSignin] scheduler stopped");
}

/** A single opted-in connection is enough to need the scheduler running. */
export function hasAnyAutoSigninEnabled(settings) {
  return enabledConnectionIds(settings).size > 0;
}

export function configureMossAutoSignin(settings) {
  if (hasAnyAutoSigninEnabled(settings)) startMossAutoSignin();
  else stopMossAutoSignin();
}
