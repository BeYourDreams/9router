// CodeBuddy daily check-in (每日签到) — read the daily activity/sign-in state and
// claim today's credit/points bonus the way the CodeBuddy client does.
//
// CodeBuddy (CN: copilot.tencent.com, intl: www.codebuddy.ai) fronts its API with
// a Tencent APISIX gateway that requires the same Bearer token + plugin header
// family as the chat gateway. The daily check-in lives under the /v2/activity
// namespace:
//
//   <base>/v2/activity/signin          GET  -> today's sign-in state / panel
//   <base>/v2/activity/signin/claim    POST -> claim today's bonus
//        -> { code: 0, data: { ... , points, claimed/claimable, days:[...] } }
//
// The gateway prefix /v2/activity is confirmed live (APISIX answers 401 for it,
// 404 "Route Not Found" for anything outside it), but the exact leaf resource is
// behind the auth gate and can only be exercised with a live token. The paths
// are therefore kept as named constants here — correct them in one place if the
// contract shifts without touching the scheduler or the UI.
//
// Nothing here logs an account out: a refused/expired token is reported as
// { ok:false, authExpired:true } so the scheduler backs off instead of
// destroying the credential.

import { PROVIDERS } from "../providers/index.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const SIGNIN_STATUS_PATH = "/v2/activity/signin";
const SIGNIN_CLAIM_PATH = "/v2/activity/signin/claim";

// Per-site base + the X-Domain header the plugin sends. CN uses the tencent
// domain, intl the codebuddy.ai one — same split as the registry/refresh lanes.
const SITE_BASE = {
  "codebuddy-cn": { base: "https://copilot.tencent.com", domain: "copilot.tencent.com" },
  "codebuddy-intl": { base: "https://www.codebuddy.ai", domain: "www.codebuddy.ai" },
};

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const firstNum = (...vals) => {
  for (const v of vals) {
    const n = num(v) ?? (typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
    if (n !== undefined) return n;
  }
  return undefined;
};
const truthy = (v) => v === true || v === 1 || v === "1";

/** A code/msg failure from the gateway (code !== 0 with a message). */
class SigninRefused extends Error {
  constructor(message, { authExpired = false } = {}) {
    super(message);
    this.name = "SigninRefused";
    this.authExpired = authExpired;
  }
}

/** Build the plugin header family the CodeBuddy gateway requires. */
function siteHeaders(site, token) {
  return {
    ...(PROVIDERS[site.providerId]?.headers || {}),
    Authorization: `Bearer ${token}`,
    "X-Domain": site.domain,
    "X-Product": "SaaS",
    "x-codebuddy-request": "1",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Normalize a sign-in reply into a stable shape:
 *   { claimedToday, claimableToday, todayPoints, days: [{ dayNo, points,
 *     bonusPoints, status, isToday }] }
 * Tolerant of the several key spellings the activity gateway may return; null
 * when no panel-like payload is present.
 */
export function parseSigninPanel(body) {
  const root = obj(body) ?? {};
  const data = obj(root.data) ?? root;
  const rows = Array.isArray(data.days)
    ? data.days
    : Array.isArray(data.list)
      ? data.list
      : Array.isArray(data.panel?.days)
        ? data.panel.days
        : null;

  const days = (rows || [])
    .filter((d) => obj(d))
    .map((d) => ({
      dayNo: firstNum(d.day_no, d.dayNo, d.day, d.index) ?? 0,
      points: firstNum(d.points, d.point, d.credits) ?? 0,
      bonusPoints: firstNum(d.bonus_points, d.bonusPoints, d.bonus) ?? 0,
      status: firstNum(d.status, d.state) ?? 0,
      isToday: truthy(d.is_today) || truthy(d.isToday) || truthy(d.today),
    }))
    .filter((d) => d.dayNo > 0)
    .sort((a, b) => a.dayNo - b.dayNo);

  // Claimed/claimable can be reported directly (booleans) or via day status.
  const today = days.find((d) => d.isToday);
  const claimedDirect = truthy(data.claimed) || truthy(data.claimed_today) || truthy(data.hasSignin) || truthy(data.signed);
  const claimedToday = claimedDirect || (today ? today.status === 3 || today.status === 2 : false);
  const claimableDirect = truthy(data.claimable) || truthy(data.canSignin) || truthy(data.can_claim);
  const claimableToday = !claimedToday && (claimableDirect || (today ? today.status === 1 : days.length > 0));

  const todayPoints =
    firstNum(data.todayPoints, data.today_points, data.points) ??
    (today ? today.points + (today.bonusPoints || 0) : 0);

  if (days.length === 0 && data.claimed === undefined && data.claimable === undefined && todayPoints === 0) {
    return null;
  }
  return { claimedToday, claimableToday, todayPoints, days };
}

/** Prepare site + token for one connection; null when no token is available. */
function resolveSite(connection) {
  const site = SITE_BASE[connection.provider];
  if (!site) return null;
  const token = connection.accessToken || connection.apiKey;
  if (!token) return null;
  return { ...site, providerId: connection.provider, token };
}

async function callGateway(site, path, { method, body, proxyOptions } = {}) {
  const response = await proxyAwareFetch(`${site.base}${path}`, {
    method,
    headers: siteHeaders(site, site.token),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, proxyOptions);

  if (response.status === 401 || response.status === 403) {
    throw new SigninRefused(`CodeBuddy check-in unauthorized (${response.status})`, { authExpired: true });
  }
  if (!response.ok) {
    throw new SigninRefused(`CodeBuddy check-in API error (${response.status})`);
  }

  const json = await response.json().catch(() => null);
  if (!json) throw new SigninRefused("CodeBuddy check-in returned a non-JSON body");
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) {
    throw new SigninRefused(`CodeBuddy check-in error: ${json.msg || json.message || json.code}`);
  }
  return json;
}

/** GET the sign-in state -> normalized panel (or null when unavailable). */
export async function getSigninStatus(site, proxyOptions = null) {
  const json = await callGateway(site, SIGNIN_STATUS_PATH, { method: "GET", proxyOptions });
  return parseSigninPanel(json);
}

/**
 * GET the current state, then POST the claim only when today is claimable.
 * Returns:
 *   { ok:true, claimed, alreadyClaimed, points, panel }  on success/no-op
 *   { ok:false, authExpired:true, error }                on a refused token
 *   { ok:false, error }                                  on any other failure
 */
export async function runCodeBuddySignin(connection, proxyOptions = null) {
  const site = resolveSite(connection);
  if (!site) {
    return { ok: false, error: `daily check-in not supported for ${connection.provider} (no token)` };
  }

  try {
    const before = await getSigninStatus(site, proxyOptions);
    if (before?.claimedToday) {
      return { ok: true, claimed: false, alreadyClaimed: true, points: 0, panel: before };
    }
    // Guard a claim the server would reject: only fire when today is claimable.
    if (before && !before.claimableToday) {
      return { ok: true, claimed: false, alreadyClaimed: false, points: 0, panel: before };
    }

    const json = await callGateway(site, SIGNIN_CLAIM_PATH, { method: "POST", body: {}, proxyOptions });
    const data = obj(json.data) ?? obj(json) ?? {};
    // A re-claim returns code 0 but grants nothing; treat an explicit
    // already-claimed flag as a no-op so a double-run stays harmless.
    const alreadyClaimed = truthy(data.already_claimed) || truthy(data.alreadyClaimed);
    const claimed = !alreadyClaimed && (truthy(data.claimed) || truthy(data.success) || json.code === 0);
    const points = claimed ? firstNum(data.points, data.point, data.credits, data.reward) ?? 0 : 0;
    return {
      ok: true,
      claimed,
      alreadyClaimed,
      points,
      panel: parseSigninPanel(json) ?? before,
    };
  } catch (e) {
    if (e instanceof SigninRefused) {
      return { ok: false, authExpired: e.authExpired === true, error: e.message };
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}
