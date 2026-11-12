// Pure fan-out logic for the bulk daily check-in switch (每日自动签到).
//
// Kept out of the route so it can be unit-tested without a database: the route
// reads connections + settings, calls these, and persists the patch.
//
// The quota page only ever holds one page of the (paginated) account list, so
// "turn check-in on for everything" has to be resolved against the full table
// here, server-side. Eligibility reuses the same shared rule the dashboard uses
// for its per-card buttons, so the two can never disagree.

import {
  AUTO_SIGNIN_CONFIGS,
  getAutoSigninConfigForProvider,
  isAutoSigninEligibleConnection,
} from "@/shared/constants/config";

/**
 * Roll the stored opt-in maps up against the eligible connections.
 * `on` is true only when every eligible connection of every family is opted in.
 * Returns { on, partial, total, optedIn, byFamily }.
 */
export function summarizeAutoSignin(connections, settings) {
  const summary = { on: false, partial: false, total: 0, optedIn: 0, byFamily: {} };
  for (const cfg of AUTO_SIGNIN_CONFIGS) {
    const providerCfg = settings?.[cfg.settingsKey] || {};
    const enabledGlobally = providerCfg.enabled !== false;
    const family = { total: 0, optedIn: 0, on: false };
    for (const conn of connections || []) {
      if (getAutoSigninConfigForProvider(conn?.provider)?.settingsKey !== cfg.settingsKey) continue;
      if (!isAutoSigninEligibleConnection(conn)) continue;
      family.total += 1;
      summary.total += 1;
      if (enabledGlobally && providerCfg.connections?.[conn.id] === true) {
        family.optedIn += 1;
        summary.optedIn += 1;
      }
    }
    family.on = family.total > 0 && family.optedIn === family.total;
    summary.byFamily[cfg.settingsKey] = family;
  }
  summary.on = summary.total > 0 && summary.optedIn === summary.total;
  summary.partial = summary.optedIn > 0 && !summary.on;
  return summary;
}

/**
 * Build the settings patch that turns check-in on/off for every eligible
 * connection. Only families that actually own an eligible connection are
 * rewritten, so unrelated stored config is left untouched.
 */
export function buildAutoSigninPatch(connections, settings, on) {
  const patch = {};
  for (const cfg of AUTO_SIGNIN_CONFIGS) {
    const eligible = (connections || []).filter(
      (conn) => getAutoSigninConfigForProvider(conn?.provider)?.settingsKey === cfg.settingsKey
        && isAutoSigninEligibleConnection(conn),
    );
    if (eligible.length === 0) continue;
    const previous = settings?.[cfg.settingsKey] || {};
    const nextConnections = { ...(previous.connections || {}) };
    for (const conn of eligible) nextConnections[conn.id] = on;
    patch[cfg.settingsKey] = { ...previous, enabled: on !== false, connections: nextConnections };
  }
  return patch;
}
