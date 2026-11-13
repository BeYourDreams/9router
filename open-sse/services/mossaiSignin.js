// MossAI (mossai.cc) daily check-in (每日签到领取算力) + balance read.
//
// The web account surface is the frontend's own /api/* family, authenticated
// with the browser session's access token (localStorage `accessToken`, sent as
// `X-Access-Token`). We drive it the same way the frontend does:
//
//   GET  https://mossai.cc/api/promotion/checkin        -> check-in panel state
//   POST https://mossai.cc/api/promotion/checkin        -> claim today's reward
//   GET  https://mossai.cc/api/balance                  -> { balance: <算力> }
//
// `POST checkin` is idempotent upstream (a second claim the same day just
// returns the already-claimed state), so a double-run is harmless; the
// scheduler's per-day gate dedupes the round-trips.
//
// The model-call lane uses the developer API key (`sk-…`, Authorization: Bearer)
// at /v1/chat/completions; that key lives in providerSpecificData.skKey and is
// NOT the same credential as the web access token. Nothing here logs an account
// out: a refused/expired token comes back as { ok:false, authExpired:true } so
// the scheduler backs off instead of destroying the credential.

import { proxyAwareFetch } from "../utils/proxyFetch.js";

export const MOSS_BASE = "https://mossai.cc";
export const CHECKIN_PATH = "/api/promotion/checkin";
export const BALANCE_PATH = "/api/balance";

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A refusal from the gateway (non-2xx, or an auth-shaped error body). */
class MossRefused extends Error {
  constructor(message, { authExpired = false } = {}) {
    super(message);
    this.name = "MossRefused";
    this.authExpired = authExpired;
  }
}

/** The web access token — the credential stored as the connection's apiKey. */
export function resolveToken(connection) {
  return connection?.apiKey || connection?.accessToken || null;
}

function isAuthError(body) {
  return body?.error?.type === "authentication_error"
    || body?.error?.code === "authentication_error"
    || /请先登录|API Key 无效|未登录|登录.*失效/i.test(`${body?.error?.message || ""} ${body?.message || ""}`);
}

async function callWeb(path, { token, method = "GET", body } = {}) {
  const response = await proxyAwareFetch(`${MOSS_BASE}${path}`, {
    method,
    headers: {
      "X-Access-Token": token,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const json = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403 || isAuthError(json)) {
    throw new MossRefused(`MossAI unauthorized (${response.status})`, { authExpired: true });
  }
  if (!response.ok) {
    throw new MossRefused(`MossAI API error (${response.status}): ${json?.error?.message || ""}`.trim());
  }
  if (json?.error) {
    throw new MossRefused(`MossAI error: ${json.error.message || json.error.type || "unknown"}`);
  }
  return json;
}

/**
 * Read the check-in panel state.
 *   { ok:true, active, claimedToday, today, reward, days, streak, balance? }
 */
export async function readMossCheckinStatus(connection, proxyOptions = null) {
  const token = resolveToken(connection);
  if (!token) return { ok: false, error: "no MossAI access token on this connection" };
  try {
    const body = await callWeb(CHECKIN_PATH, { token });
    const data = obj(body?.data) ?? obj(body) ?? {};
    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const days = Array.isArray(data.days)
      ? data.days.map((d, i) => ({ ...(obj(d) || {}), dayNo: num(d?.dayNo) ?? num(d?.day) ?? i + 1 }))
      : [];
    const claimedToday = data.claimed_today === true || data.claimedToday === true
      || data.today_checked_in === true || data.claimed === true
      || String(data.status || "") === "claimed"
      || days.some((d) => d.isToday === true && (d.status === 3 || d.claimed === true));
    return {
      ok: true,
      active: data.active !== false,
      claimedToday,
      today: typeof data.today === "string" ? data.today : localToday,
      reward: num(data.reward) ?? num(data.reward_points) ?? num(data.points) ?? num(data.today_reward) ?? null,
      streak: num(data.streak_days) ?? num(data.streak) ?? 0,
      days,
      balance: num(data.balance),
    };
  } catch (e) {
    if (e instanceof MossRefused) {
      return { ok: false, authExpired: e.authExpired === true, error: e.message };
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Claim today's reward. Returns:
 *   { ok:true, claimed, alreadyClaimed, reward, balance? }
 *   { ok:false, authExpired?, error }
 */
export async function claimMossCheckin(connection, proxyOptions = null) {
  const token = resolveToken(connection);
  if (!token) return { ok: false, error: "no MossAI access token on this connection" };
  try {
    const body = await callWeb(CHECKIN_PATH, { token, method: "POST", body: {} });
    const data = obj(body?.data) ?? obj(body) ?? {};
    const reward = num(data.reward) ?? num(data.reward_points) ?? num(data.points) ?? num(data.added) ?? null;
    const already = data.already_claimed === true || data.alreadyClaimed === true
      || /already|已签到|已领取/i.test(`${data.message || ""} ${data.msg || ""}`);
    return {
      ok: true,
      claimed: reward !== null && !already,
      alreadyClaimed: already || reward === null,
      reward,
      balance: num(data.balance) ?? num(body?.balance),
    };
  } catch (e) {
    if (e instanceof MossRefused) {
      return { ok: false, authExpired: e.authExpired === true, error: e.message };
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Read the 算力 balance. Returns { ok:true, balance } or { ok:false, error }. */
export async function readMossBalance(connection, proxyOptions = null) {
  const token = resolveToken(connection);
  if (!token) return { ok: false, error: "no MossAI access token on this connection" };
  try {
    const body = await callWeb(BALANCE_PATH, { token });
    const data = obj(body?.data) ?? obj(body) ?? {};
    const balance = num(data.balance) ?? num(body?.balance) ?? num(data.total) ?? num(data.points);
    if (balance === undefined) return { ok: false, error: "MossAI returned no balance" };
    return { ok: true, balance };
  } catch (e) {
    if (e instanceof MossRefused) {
      return { ok: false, authExpired: e.authExpired === true, error: e.message };
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------------------
// Usage lane (Provider Limits) — dashboard quota rows for a MossAI connection.
//
//   "算力"  remaining balance            -> credit-balance row (💰 amount)
//   "今日签到" 0/1 claimed vs. reward    -> percentage row
//   "签到奖励" the claimable amount      -> credit-balance row
//
// The balance read *is* the authenticated call; when it 401s the row carries
// the message and the scheduler backs off rather than logging out.

function percentLeft(remaining, total) {
  if (!(total > 0)) return 0;
  return Math.round(Math.max(0, Math.min(100, (remaining / total) * 100)));
}

/** Shape one connection's usage answer (parseQuotaData contract). */
export function buildMossUsage({ balance, checkin } = {}) {
  const quotas = {};
  if (balance?.balance !== undefined) {
    const b = balance.balance;
    quotas["算力余额"] = {
      used: 0,
      total: b,
      isCreditBalance: true,
      currency: "算力",
      unit: "算力",
    };
  }
  if (checkin?.ok) {
    const claimed = checkin.claimedToday === true;
    const reward = checkin.reward;
    const done = claimed ? 1 : 0;
    if (reward !== null && reward > 0) {
      quotas["今日签到"] = {
        used: done,
        total: 1,
        remaining: percentLeft(1 - done, 1),
        remainingPercentage: percentLeft(1 - done, 1),
        unit: "次",
        resetAt: null,
        ...(!claimed ? { message: `未领取 — 每日自动签到后到账` } : {}),
      };
      quotas["签到奖励"] = {
        used: 0,
        total: reward,
        isCreditBalance: true,
        currency: "算力",
        unit: "算力",
      };
    }
  }
  if (Object.keys(quotas).length === 0) {
    return { message: "MossAI returned no usable data for this account" };
  }
  return {
    quotas,
    plan: checkin?.active === false ? "MossAI · 签到未开启" : "MossAI · 免费",
    ...(balance?.balance !== undefined ? { user: `余额 ${balance.balance} 算力` } : {}),
  };
}

/**
 * Usage handler (USAGE_HANDLERS shape) for a MossAI apikey connection.
 * Reads balance + check-in status; the reads are the same authenticated calls
 * the daily scheduler makes, so opening the dashboard keeps the streak alive.
 */
export async function getMossUsage(connection, proxyOptions = null) {
  const token = resolveToken(connection);
  if (!token) return { message: "MossAI: no access token on this connection" };

  const [balance, checkin] = await Promise.all([
    readMossBalance(connection, proxyOptions),
    readMossCheckinStatus(connection, proxyOptions),
  ]);
  if (!balance.ok && !checkin.ok) {
    const msg = balance.error || checkin.error || "unknown";
    return { message: `MossAI: ${msg}` };
  }
  return buildMossUsage({ balance, checkin });
}
