// Qoder daily credit claim (每日签到领 100 Credits) scheduler: once per local
// calendar day, claim the account's daily credit campaign.
//
// The claim lives in the IDE's growth-page campaigns (open-sse/services/
// qoderCheckin.js): a daily campaign arrives with actionType "CLAIM_BENEFIT"
// and claimStatus "CLAIMABLE" and is claimed by POSTing to its claim path.
// Upstream is idempotent — once claimed the campaign reads "CLAIMED" — so a
// double run cannot double-grant.
//
// Mirrors modelscopeAutoSignin.js:
//   - An hourly tick; the real gate is the per-connection "already claimed
//     today" date, so a claim fires at most once per local day.
//   - Opt-in is per connection: settings.qoderAutoSignin.connections[id] === true
//     (settings.enabled === false disables the feature wholesale).
//   - A refused/expired token is logged and cooled down — never logged out.
//
// The day is sealed ONLY when today's grant is settled (claimed here, or the
// upstream says it already exists). An account that has no daily campaign yet
// stays open, because the window opens at 10:00 (UTC+8) and a tick before that
// must not burn the whole day.

import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { QODER_AUTOSIGNIN_CONFIG } from "@/shared/constants/config";
import { claimQoderDailyCredits } from "open-sse/services/qoderCheckin.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const C = QODER_AUTOSIGNIN_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__qoderAutoSignin ??= {
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

/** The connection ids the user opted into the daily claim. */
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
 * Claim one connection's daily credits, honoring the per-day gate. `deps` is
 * injectable for tests (claim/refresh/updateConnection/...).
 */
export async function claimConnection(conn, deps, nowMs = Date.now()) {
  const today = localDayKey(nowMs);

  if (conn.qoderLastClaimDate === today) {
    return { skipped: "already-claimed-today" };
  }

  const key = `${conn.provider}:${conn.id}`;
  if (shouldSkipAfterFailure(key, nowMs)) return { skipped: "failure-cooldown" };

  // Keep the token fresh: Qoder access tokens expire, and a stale one would
  // make the campaign list look empty instead of failing loudly.
  let connection = conn;
  try {
    const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
    const r = await deps.refreshAndUpdateCredentials(connection, false, proxyOptionsFor(proxyCfg));
    connection = r.connection || connection;
  } catch (e) {
    g.failureCache[key] = nowMs;
    console.warn(`[QoderCheckin] ${key}: refresh failed: ${e.message}`);
    return { error: `refresh failed: ${e.message}` };
  }

  const result = await deps.claim(connection);

  if (!result?.ok) {
    g.failureCache[key] = nowMs;
    const suffix = result?.authExpired ? " (token expired — re-authorize)" : "";
    console.warn(`[QoderCheckin] ${key}: ${result?.error ?? "unknown error"}${suffix}`);
    return { error: result?.error ?? "unknown error", authExpired: result?.authExpired === true };
  }

  delete g.failureCache[key];

  const patch = { qoderLastClaimAt: new Date(nowMs).toISOString() };

  if (result.claimed > 0) {
    patch.qoderLastClaimDate = today;
    patch.qoderLastClaimCredits = result.credits || 0;
    patch.qoderLastClaimStatus = "claimed";
  } else if (result.alreadyClaimed) {
    // Today's grant already exists: this account holds it (claimed in the IDE)
    // or another account of the same person does — Qoder grants the daily
    // campaign per person. Either way the day is settled; stop asking.
    patch.qoderLastClaimDate = today;
    patch.qoderLastClaimCredits = result.credits || 0;
    patch.qoderLastClaimStatus = result.creditedElsewhere ? "claimed-elsewhere" : "already-claimed";
  } else {
    // No daily campaign for this account right now. The window opens at 10:00
    // (UTC+8), so an early tick must NOT seal the day — the next tick has to
    // try again. Qoder also serves the campaign per person, so an account of a
    // person who already claimed never sees one: that is a fact, not an error.
    patch.qoderLastClaimStatus = "no-campaign";
  }

  await deps.updateConnection(conn.id, patch);

  if (patch.qoderLastClaimStatus === "claimed") {
    console.log(`[QoderCheckin] ${key}: claimed +${result.credits || 0} Credits (day ${today})`);
    return { claimed: result.claimed, credits: result.credits || 0 };
  }
  if (patch.qoderLastClaimStatus === "already-claimed") {
    console.log(`[QoderCheckin] ${key}: already claimed today (day ${today})`);
    return { claimed: 0, credits: result.credits || 0, alreadyClaimed: true };
  }
  if (patch.qoderLastClaimStatus === "claimed-elsewhere") {
    console.log(`[QoderCheckin] ${key}: today's grant already used by another account of this person (day ${today})`);
    return { claimed: 0, credits: 0, alreadyClaimed: true, creditedElsewhere: true };
  }
  console.log(`[QoderCheckin] ${key}: no daily campaign for this account yet (day ${today}) — retrying on the next tick`);
  return { claimed: 0, credits: 0, noCampaign: true };
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateConnection: updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    claim: claimQoderDailyCredits,
  };
}

/** One scheduler tick across all Qoder connections. Returns a summary (tests + logs). */
export async function runQoderAutoSigninTick(deps = createDefaultDeps(), state = g, nowMs = Date.now()) {
  if (state.running) return { skipped: "busy" };
  state.running = true;
  const summary = { checked: 0, claimed: 0, credits: 0, errors: 0 };
  try {
    const settings = await deps.getSettings();
    const ids = enabledConnectionIds(settings);
    if (ids.size === 0) return summary;

    for (const provider of C.providers) {
      const conns = await deps.getProviderConnections({ provider, isActive: true });
      for (const conn of conns) {
        if (!ids.has(conn.id)) continue;
        if (conn.authType !== "oauth") continue;
        summary.checked += 1;
        try {
          const r = await claimConnection(conn, deps, nowMs);
          if (r?.claimed) { summary.claimed += 1; summary.credits += r.credits || 0; }
          if (r?.error) summary.errors += 1;
        } catch (e) {
          summary.errors += 1;
          console.warn(`[QoderCheckin] ${provider}:${conn.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn("[QoderCheckin] tick error:", e.message);
  } finally {
    state.running = false;
  }
  return summary;
}

export function startQoderAutoSignin() {
  if (g.interval) return;
  console.log("[QoderCheckin] scheduler started");
  runQoderAutoSigninTick().catch(() => {});
  g.interval = setInterval(() => { runQoderAutoSigninTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopQoderAutoSignin() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[QoderCheckin] scheduler stopped");
}

/** A single opted-in connection is enough to need the scheduler running. */
export function hasAnyAutoSigninEnabled(settings) {
  return enabledConnectionIds(settings).size > 0;
}

export function configureQoderAutoSignin(settings) {
  if (hasAnyAutoSigninEnabled(settings)) startQoderAutoSignin();
  else stopQoderAutoSignin();
}
