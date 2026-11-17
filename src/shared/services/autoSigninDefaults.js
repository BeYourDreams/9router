// Opt a newly created connection into its daily check-in (每日自动签到) by
// default, so a fresh MiniMax Code / CodeBuddy / ModelScope account starts
// claiming its daily reward without the user flipping a toggle.
//
// Called from the connection repo *after* a row is created (never on update —
// re-authorizing an existing account must not resurrect a check-in the user
// turned off).
//
// The stored opt-in map is the single source of truth:
//   settings[family.settingsKey].connections[id] === true   → opted in
//   === false                                               → opted out, sticky
//   absent                                                  → the default below
//
// An explicit `false` is therefore never overwritten by this module. The
// default only fills in the gaps: on create we write `true`, which keeps the
// dashboard's per-card toggle and the master switch honest (both read the map).

import {
  AUTO_SIGNIN_CONFIGS,
  AUTO_SIGNIN_DEFAULT_ENABLED,
  isAutoSigninEligibleConnection,
} from "@/shared/constants/config";

/** The check-in family that owns this connection, or null. */
export function familyForConnection(conn) {
  if (!conn?.provider) return null;
  return AUTO_SIGNIN_CONFIGS.find((c) => c.providers.includes(conn.provider)) || null;
}

/**
 * Compute the settings patch that opts `conn` into check-in by default.
 * Returns null when nothing should change (not eligible, or already recorded).
 */
export function buildDefaultOptInPatch(conn, settings) {
  if (!AUTO_SIGNIN_DEFAULT_ENABLED) return null;
  if (!isAutoSigninEligibleConnection(conn)) return null;
  const family = familyForConnection(conn);
  if (!family) return null;

  const previous = settings?.[family.settingsKey] || {};
  // Respect an explicit choice already on record (either direction).
  if (Object.hasOwn(previous.connections || {}, conn.id)) return null;
  // A family the user switched off wholesale stays off.
  if (previous.enabled === false) return null;

  return {
    [family.settingsKey]: {
      ...previous,
      connections: { ...(previous.connections || {}), [conn.id]: true },
    },
  };
}

/**
 * Persist the default opt-in for a just-created connection.
 * Best-effort: a failure here must never fail the connection creation itself,
 * so the caller keeps the account and the user can still flip the toggle.
 *
 * @param conn     the created connection row
 * @param deps     { getSettings, updateSettings } — injectable for tests
 */
export async function optInNewConnection(conn, deps) {
  try {
    const settings = await deps.getSettings();
    const patch = buildDefaultOptInPatch(conn, settings);
    if (!patch) return null;
    await deps.updateSettings(patch);
    return patch;
  } catch (e) {
    console.warn("[AutoSignin] default opt-in failed:", e.message);
    return null;
  }
}

/**
 * One-time backfill of the default for accounts that predate the "on by
 * default" policy: a connection with *no entry at all* in its family's map is
 * opted in; an explicit true/false is left exactly as stored.
 *
 * Runs at startup (see initializeApp) and is idempotent — after the first pass
 * every eligible id has an entry, so later runs patch nothing.
 */
export async function backfillDefaultOptIns(deps) {
  if (!AUTO_SIGNIN_DEFAULT_ENABLED) return null;
  try {
    const [settings, connections] = await Promise.all([deps.getSettings(), deps.getProviderConnections()]);
    // Collect ids per family first, then build one patch object per family so
    // previously collected ids are not dropped while iterating.
    const idsByFamily = {};
    for (const conn of connections || []) {
      const family = familyForConnection(conn);
      if (!family) continue;
      if (!isAutoSigninEligibleConnection(conn)) continue;
      const previous = settings?.[family.settingsKey] || {};
      if (previous.enabled === false) continue;
      if (Object.hasOwn(previous.connections || {}, conn.id)) continue;
      (idsByFamily[family.settingsKey] ||= []).push(conn.id);
    }
    const patch = {};
    for (const [settingsKey, ids] of Object.entries(idsByFamily)) {
      const previous = settings?.[settingsKey] || {};
      const nextConnections = { ...(previous.connections || {}) };
      for (const id of ids) nextConnections[id] = true;
      patch[settingsKey] = { ...previous, connections: nextConnections };
    }
    if (Object.keys(patch).length === 0) return null;
    const saved = await deps.updateSettings(patch);
    // The backfill can be what first makes a family "opted in"; start its
    // scheduler now rather than leaving it until the next restart.
    if (patch.minimaxAutoSignin) {
      import("@/shared/services/minimaxAutoSignin")
        .then(({ configureMiniMaxAutoSignin }) => configureMiniMaxAutoSignin(saved))
        .catch(() => {});
    }
    if (patch.codebuddyAutoSignin) {
      import("@/shared/services/codebuddyAutoSignin")
        .then(({ configureCodeBuddyAutoSignin }) => configureCodeBuddyAutoSignin(saved))
        .catch(() => {});
    }
    if (patch.modelscopeAutoSignin) {
      import("@/shared/services/modelscopeAutoSignin")
        .then(({ configureModelScopeAutoSignin }) => configureModelScopeAutoSignin(saved))
        .catch(() => {});
    }
    console.log(`[AutoSignin] backfilled default opt-in for ${
      Object.values(patch).reduce((n, cfg) => n + Object.keys(cfg.connections).length, 0)
    } connection(s)`);
    return patch;
  } catch (e) {
    console.warn("[AutoSignin] default backfill failed:", e.message);
    return null;
  }
}
