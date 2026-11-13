// CodeBuddy daily check-in (每日签到) — read the check-in activity state and
// claim today's credit bonus the way CodeBuddy's own frontend does.
//
// The endpoint family is the same Tencent billing gateway as the quota lane
// (/v2/billing/meter/get-user-resource), reached from WorkBuddy's own frontend
// bundle (copilot.tencent.com/agents):
//
//   POST <base>/v2/billing/meter/checkin-activity-status   body {}
//        -> { code:0, data:{ active, today_checked_in, streak_days, daily_credit,
//              today_credit, is_streak_day, checkin_dates:["2026-11-13", …],
//              total_credits, activity_name, … } }
//   POST <base>/v2/billing/meter/daily-checkin            body {}
//        -> { code:0, data:{ credit:100, streak_days:1, is_streak_day:false } }
//
// The gateway answers business failures with HTTP 200 and a non-zero `code`
// (`10001` = 今天已签到 / 签到活动未开启或已过期), so the code — not the HTTP
// status — decides the outcome.
//
// Everything else in this module is deliberately unchanged in shape: the
// scheduler (src/shared/services/codebuddyAutoSignin.js) and its per-day gate
// consume the same { ok, claimed, alreadyClaimed, points } result. A
// refused/expired token is reported as { ok:false, authExpired:true } so the
// scheduler backs off instead of logging the account out.

import { PROVIDERS } from "../providers/index.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const SIGNIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const SIGNIN_CLAIM_PATH = "/v2/billing/meter/daily-checkin";

// Business-failure code the gateway uses for both "already claimed today" and
// "this activity is not running for you".
const CODE_TODAY_DONE = 10001;

// Per-site base — same split as the registry/refresh lanes. CN and intl run the
// identical handler; intl simply reports active:false while the activity is
// not running there, which the status call already turns into a skip.
const SITE_BASE = {
  "codebuddy-cn": "https://copilot.tencent.com",
  "codebuddy-intl": "https://www.codebuddy.ai",
};

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const truthy = (v) => v === true || v === 1 || v === "1";

/** A gateway failure (HTTP error, refused token, or a non-zero business code). */
class SigninRefused extends Error {
  constructor(message, { authExpired = false, todayDone = false } = {}) {
    super(message);
    this.name = "SigninRefused";
    this.authExpired = authExpired;
    this.todayDone = todayDone;
  }
}

/** Build the header family the CodeBuddy gateways require for a bearer call. */
function siteHeaders(providerId, token) {
  return {
    ...(PROVIDERS[providerId]?.headers || {}),
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Normalize a checkin-activity-status payload into the stable panel shape:
 *   { active, claimedToday, claimableToday, todayPoints, days: […] }
 * `days` carries one row per recorded check-in date (the API reports dates, not
 * slots) plus one row for today, which is what the caller logs as "streak".
 * Returns null when no panel-like payload is present.
 */
export function parseSigninPanel(body) {
  const data = obj(body?.data) ?? obj(body);
  if (!data || data.active === undefined && data.today_checked_in === undefined) return null;

  const active = truthy(data.active);
  const claimedToday = truthy(data.today_checked_in);
  const todayPoints = num(data.today_credit) ?? num(data.daily_credit) ?? 0;
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const recorded = Array.isArray(data.checkin_dates) ? data.checkin_dates : [];

  const rows = recorded
    .map((d, i) => {
      if (typeof d !== "string") return null;
      const date = d.length > 10 ? d.slice(0, 10) : d;
      const seq = num(date.length === 10 ? Date.parse(`${date}T00:00:00`) : NaN);
      return {
        dayNo: Number.isFinite(seq) ? Math.round(seq / 86400000) : i + 1,
        points: todayPoints,
        bonusPoints: 0,
        status: 3,
        isToday: date === localToday,
      };
    })
    .filter(Boolean);

  const days = rows.some((d) => d.isToday)
    ? rows
    : [...rows, { dayNo: rows.length + 1, points: todayPoints, bonusPoints: 0, status: claimedToday ? 3 : 1, isToday: true }];

  return {
    active,
    claimedToday,
    // Claimable only while the activity is live and today is still open; an
    // inactive activity (intl, or CN outside a campaign) would just be refused.
    claimableToday: active && !claimedToday,
    todayPoints,
    streakDays: num(data.streak_days) ?? 0,
    totalPoints: num(data.total_credits) ?? 0,
    activityName: typeof data.activity_name === "string" ? data.activity_name : undefined,
    days,
  };
}

async function callGateway(base, providerId, path, { token, proxyOptions } = {}) {
  const response = await proxyAwareFetch(`${base}${path}`, {
    method: "POST",
    headers: siteHeaders(providerId, token),
    body: "{}",
    signal: AbortSignal.timeout(15000),
  }, proxyOptions);

  if (response.status === 401 || response.status === 403) {
    throw new SigninRefused(`CodeBuddy check-in unauthorized (${response.status})`, { authExpired: true });
  }
  if (!response.ok) throw new SigninRefused(`CodeBuddy check-in API error (${response.status})`);

  const json = await response.json().catch(() => null);
  if (!json) throw new SigninRefused("CodeBuddy check-in returned a non-JSON body");
  if (json.code !== undefined && json.code !== 0) {
    throw new SigninRefused(
      `CodeBuddy check-in error: ${json.msg || json.message || json.code}`,
      // The status call answers 10001 for an inactive campaign; the claim call
      // answers it for "already claimed today". The caller already read the
      // state, so only treat it as today-done on the claim lane.
      { todayDone: path === SIGNIN_CLAIM_PATH && json.code === CODE_TODAY_DONE },
    );
  }
  return json;
}

/** POST the check-in activity state -> normalized panel (or null if unavailable). */
export async function getSigninStatus({ providerId, token }, proxyOptions = null) {
  const json = await callGateway(SITE_BASE[providerId], providerId, SIGNIN_STATUS_PATH, { token, proxyOptions });
  return parseSigninPanel(json);
}

/**
 * POST the claim -> { claimed, alreadyClaimed, points, panel }. An upstream
 * 10001 reply is a no-op (already claimed today), never a failure.
 */
async function claimSignin({ providerId, token }, proxyOptions = null) {
  const json = await callGateway(SITE_BASE[providerId], providerId, SIGNIN_CLAIM_PATH, { token, proxyOptions });
  const data = obj(json.data) ?? {};
  return {
    claimed: true,
    alreadyClaimed: false,
    points: num(data.credit) ?? num(data.points) ?? 0,
    streakDays: num(data.streak_days) ?? 0,
  };
}

/** Prepare site + token for one connection; null when none is available. */
function resolveSite(connection) {
  const base = SITE_BASE[connection.provider];
  if (!base) return null;
  const token = connection.accessToken || connection.apiKey;
  if (!token) return null;
  return { providerId: connection.provider, base, token };
}

/**
 * Read the activity state, then claim today's bonus when it is still open.
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
    if (!before) return { ok: false, error: "check-in activity status unavailable" };
    if (before.claimedToday) {
      return { ok: true, claimed: false, alreadyClaimed: true, points: 0, panel: before };
    }
    if (!before.claimableToday) {
      // Inactive campaign (intl, or outside a CN campaign window) — nothing to
      // claim, and a claim call would just be refused with 10001.
      return { ok: true, claimed: false, alreadyClaimed: false, points: 0, panel: before };
    }

    try {
      const result = await claimSignin(site, proxyOptions);
      return {
        ok: true,
        claimed: result.claimed,
        alreadyClaimed: result.alreadyClaimed,
        points: result.points,
        streakDays: result.streakDays,
        panel: before,
      };
    } catch (e) {
      if (e instanceof SigninRefused && e.todayDone) {
        return { ok: true, claimed: false, alreadyClaimed: true, points: 0, panel: before };
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof SigninRefused) {
      return { ok: false, authExpired: e.authExpired === true, error: e.message };
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}
