// MiniMax Code daily check-in (每日签到) — read the 7-day sign-in panel and
// claim today's credit bonus the way the MiniMax Code app does.
//
// Both endpoints ride the same signed mcode account request as the usage lane
// (signedAccountRequest / accountCall in minimaxCodeUsage.js):
//
//   GET  /minimax-cloud/api/v1/signin/status
//        -> { data: { scene, days: [{ day_no, points, status, is_today, bonus_points }] },
//             base_resp }
//   POST /minimax-cloud/api/v1/signin/claim        body { scene: 2 }
//        -> { data: { claim_result, day_no, points, expire_at_ms, panel: { scene, days } },
//             base_resp }
//
// Day status codes (observed from the live endpoint):
//   1 = not yet claimed (claimable if is_today)
//   2 = today, unclaimed — the live panel serves 2 (not 1) for the current day,
//       and the claim still grants (claim_result 1, the day then flips to 3)
//   3 = claimed
// claim_result: 1 = fresh claim, 2 = already claimed today (idempotent — the
// server re-returns the panel and grants nothing twice).
//
// Nothing here touches the desktop app's ~/.minimax; a lease connection borrows
// its token from the broker exactly like the usage lane.

import { SITES, accountCall, AccountRefused, getMiniMaxCodeIdentity } from "./minimaxCodeUsage.js";
import { getLeaseToken, isLeaseConnection } from "./minimaxCodeLease.js";

const SIGNIN_STATUS_PATH = "/minimax-cloud/api/v1/signin/status";
const SIGNIN_CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";
const SIGNIN_SCENE = 2;

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (o, k) => (typeof o?.[k] === "string" && o[k].trim() ? o[k].trim() : undefined);

// Status codes as parsed from `days[].status`.
const DAY_CLAIMED = 3;
// Both 1 and 2 mean "not claimed yet": observed live, today's slot reports 2 and
// the claim still succeeds, so gating on 1 alone silently skipped every check-in.
const DAY_UNCLAIMED = new Set([1, 2]);

/**
 * Normalize the sign-in panel (from status or claim) into a stable shape:
 *   { scene, claimedToday, claimableToday, todayPoints, days: [{ dayNo, points,
 *     bonusPoints, status, isToday }] }
 * Returns null when the reply carries no panel.
 */
export function parseSigninPanel(body) {
  const data = obj(body?.data) ?? obj(body);
  const panel = obj(data?.panel) ?? data;
  const rows = Array.isArray(panel?.days) ? panel.days : Array.isArray(data?.days) ? data.days : null;
  if (!rows) return null;

  const days = rows
    .filter((d) => obj(d))
    .map((d) => ({
      dayNo: num(d.day_no) ?? num(d.dayNo) ?? 0,
      points: num(d.points) ?? 0,
      bonusPoints: num(d.bonus_points) ?? num(d.bonusPoints) ?? 0,
      status: num(d.status) ?? 0,
      isToday: d.is_today === true || d.isToday === true,
    }))
    .filter((d) => d.dayNo > 0)
    .sort((a, b) => a.dayNo - b.dayNo);

  if (days.length === 0) return null;

  const today = days.find((d) => d.isToday);
  const claimedToday = today ? today.status === DAY_CLAIMED : false;
  const claimableToday = today ? DAY_UNCLAIMED.has(today.status) && !claimedToday : false;
  return {
    scene: num(panel?.scene) ?? SIGNIN_SCENE,
    claimedToday,
    claimableToday,
    todayPoints: today ? today.points + (today.bonusPoints || 0) : 0,
    days,
  };
}

/** GET signin/status -> normalized panel. */
export async function getSigninStatus(site, access, userID) {
  // Status is a plain GET (no body) — signedAccountRequest omits body -> GET.
  const env = await accountCall(site, SIGNIN_STATUS_PATH, { access, userID }, "signin status");
  return parseSigninPanel(env);
}

/**
 * POST signin/claim -> { claimed, points, result, panel }. A `claim_result` of 2
 * (already claimed today) is reported as claimed:false so a double-run is a no-op.
 */
export async function claimSignin(site, access, userID) {
  const env = await accountCall(site, SIGNIN_CLAIM_PATH, { access, userID, body: { scene: SIGNIN_SCENE } }, "signin claim");
  const data = obj(env.data) ?? {};
  const result = num(data.claim_result);
  const claimed = result === 1;
  return {
    claimed,
    alreadyClaimed: result === 2,
    points: claimed ? num(data.points) ?? 0 : 0,
    result,
    dayNo: num(data.day_no),
    expireAt: num(data.expire_at_ms) ? new Date(data.expire_at_ms) : null,
    panel: parseSigninPanel(env),
  };
}

/**
 * Resolve a usable access token + user id for one connection, borrowing a lease
 * token when the connection stores none. Returns null when a token cannot be
 * obtained (so the caller can skip rather than throw).
 */
async function resolveCredentials(connection) {
  let access = connection.accessToken;
  if (!access && isLeaseConnection(connection)) {
    try {
      access = (await getLeaseToken(connection)).accessToken;
    } catch {
      access = null;
    }
  }
  if (!access) return null;

  let userID = str(connection.providerSpecificData || {}, "realUserID");
  if (!userID) {
    try {
      userID = (await getMiniMaxCodeIdentity(SITES[connection.provider], access)).realUserID;
    } catch {
      userID = undefined;
    }
  }
  return { access, userID };
}

/**
 * Run one check-in pass for a connection: read status, claim only when today is
 * claimable, and report what happened. Never throws for a refused sign-in — it
 * returns { ok:false, authExpired:true } so the scheduler can back off instead
 * of logging out the account.
 *
 * Returns:
 *   { ok:true, claimed, alreadyClaimed, points, panel, userID }  on success/no-op
 *   { ok:false, authExpired:true, error }                        on a refused token
 *   { ok:false, error }                                          on any other failure
 */
export async function runMiniMaxCodeSignin(connection) {
  const site = SITES[connection.provider];
  if (!site) return { ok: false, error: `daily check-in not supported for ${connection.provider}` };

  try {
    const creds = await resolveCredentials(connection);
    if (!creds) return { ok: false, error: "no access token available (re-authorize the connection)" };

    // Read first: never fire a claim the server would reject anyway.
    const before = await getSigninStatus(site, creds.access, creds.userID);
    if (!before) return { ok: false, error: "sign-in status unavailable" };

    if (before.claimedToday) {
      return { ok: true, claimed: false, alreadyClaimed: true, points: 0, panel: before, userID: creds.userID };
    }
    if (!before.claimableToday) {
      return { ok: true, claimed: false, alreadyClaimed: false, points: 0, panel: before, userID: creds.userID };
    }

    const result = await claimSignin(site, creds.access, creds.userID);
    return {
      ok: true,
      claimed: result.claimed,
      alreadyClaimed: result.alreadyClaimed,
      points: result.points,
      panel: result.panel ?? before,
      userID: creds.userID,
    };
  } catch (e) {
    if (e instanceof AccountRefused) {
      return { ok: false, authExpired: true, error: e.message };
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}
