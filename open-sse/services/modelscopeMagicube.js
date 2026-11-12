// ModelScope 魔搭 daily login (每日自动登录领取魔粒) — claim the daily Magicube
// credits by making one authenticated call per local calendar day.
//
// ModelScope awards the daily reward on *login*, not through a claim button:
// the 魔粒 rules (modelscope.cn/docs/magicube/intro) define 基础额度 "注册并登录
// 200 魔粒/日" and 绑定增额 "绑定阿里云账号 50 魔粒/日" as "每日登录即可获取",
// and the web client never POSTs a claim — its whole Magicube surface is these
// four GETs under the /openapi prefix:
//
//   GET https://modelscope.cn/openapi/v1/magicubes/balance
//        -> { success, data: { total_balance, available_balance, frozen_amount } }
//   GET https://modelscope.cn/openapi/v1/magicubes/earn/rules
//        -> { success, data: [ { rule_key, title, amount, daily_cap,
//             today_used, today_remain, today_earned_amount, ... } ] }
//   GET .../magicubes/transactions   GET .../magicubes/spend/rates   (unused here)
//
// So "auto login" == an authenticated request carrying the account's access
// token, which grants the day's 200 (+50 when an Aliyun account is bound) and
// is idempotent — a second call the same day reports today_used=1 and grants
// nothing extra. We read earn/rules to learn whether today's daily rows are
// already credited (today_used >= daily_cap) and balance to report the total.
//
// Nothing here logs an account out: a refused/expired token comes back as
// { ok:false, authExpired:true } so the scheduler backs off instead of
// destroying the credential.

import { proxyAwareFetch } from "../utils/proxyFetch.js";

export const MAGICUBE_BASE = "https://modelscope.cn/openapi";
export const BALANCE_PATH = "/v1/magicubes/balance";
export const EARN_RULES_PATH = "/v1/magicubes/earn/rules";

// The rules whose payout is the daily login itself.
export const DAILY_RULE_KEYS = ["daily_active", "aliyun_bindlogin"];

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A refusal from the gateway (non-2xx or success:false). */
class MagicubeRefused extends Error {
  constructor(message, { authExpired = false } = {}) {
    super(message);
    this.name = "MagicubeRefused";
    this.authExpired = authExpired;
  }
}

/** The account token — an `ms-…` Access Token, stored as the connection's apiKey. */
export function resolveToken(connection) {
  return connection?.apiKey || connection?.accessToken || null;
}

// A connection may point the Magicube surface elsewhere
// (providerSpecificData.magicubeBaseUrl) — private deployment or a local mock.
function magicubeBase(connection) {
  const override = connection?.providerSpecificData?.magicubeBaseUrl;
  return typeof override === "string" && override.trim()
    ? `${override.trim().replace(/\/+$/, "")}/openapi`
    : MAGICUBE_BASE;
}

async function callMagicube(token, path, proxyOptions, base = MAGICUBE_BASE) {
  const response = await proxyAwareFetch(`${base}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  }, proxyOptions);

  if (response.status === 401 || response.status === 403) {
    throw new MagicubeRefused(`ModelScope Magicube unauthorized (${response.status})`, { authExpired: true });
  }
  if (!response.ok) {
    throw new MagicubeRefused(`ModelScope Magicube API error (${response.status})`);
  }

  const json = await response.json().catch(() => null);
  if (!json) throw new MagicubeRefused("ModelScope Magicube returned a non-JSON body");
  if (json.success === false) {
    throw new MagicubeRefused(`ModelScope Magicube error: ${json.message || json.code || "unknown"}`);
  }
  return json;
}

/**
 * Normalize the earn-rules list into the daily-login subset:
 *   { dailyRules: [{ key, title, amount, dailyCap, todayUsed, todayRemain,
 *                    todayEarned, totalEarned }], creditedToday, todayEarned }
 * `creditedToday` is true only when every daily rule has hit its cap for the
 * day, so a partially-credited account (e.g. Aliyun bound mid-day) keeps the
 * scheduler polling until the remainder lands.
 */
export function parseEarnRules(body) {
  const rules = Array.isArray(body?.data) ? body.data : [];
  const dailyRules = rules
    .filter((r) => obj(r) && DAILY_RULE_KEYS.includes(r.rule_key))
    .map((r) => ({
      key: r.rule_key,
      title: r.title,
      amount: num(r.amount) ?? 0,
      dailyCap: num(r.daily_cap) ?? 0,
      todayUsed: num(r.today_used) ?? 0,
      todayRemain: num(r.today_remain) ?? 0,
      todayEarned: num(r.today_earned_amount) ?? 0,
      totalEarned: num(r.earned_amount) ?? 0,
    }));

  const creditedToday = dailyRules.length > 0
    && dailyRules.every((r) => r.dailyCap > 0 && r.todayUsed >= r.dailyCap);
  const todayEarned = dailyRules.reduce((sum, r) => sum + r.todayEarned, 0);
  return { dailyRules, creditedToday, todayEarned };
}

/** { total, available, frozen } or null when the reply has no balance fields. */
export function parseBalance(body) {
  const data = obj(body?.data);
  if (!data) return null;
  const total = num(data.total_balance);
  const available = num(data.available_balance);
  if (total === undefined && available === undefined) return null;
  return {
    total: total ?? available ?? 0,
    available: available ?? total ?? 0,
    frozen: num(data.frozen_amount) ?? 0,
  };
}

/**
 * One daily login: authenticated read of balance + earn rules.
 *
 * Returns:
 *   { ok:true, credited, creditedToday, earnedToday, balance, dailyRules }  on success
 *   { ok:false, authExpired:true, error }                                  refused token
 *   { ok:false, error }                                                    other failure
 *
 * `credited` is true when the daily rows were already at cap on arrival (the
 * common case after a manual visit) — the login itself is the reward, so the
 * call is never a no-op even then: it is what keeps the streak alive.
 */
export async function runModelScopeDailyLogin(connection, proxyOptions = null) {
  const token = resolveToken(connection);
  if (!token) return { ok: false, error: "no ModelScope access token on this connection" };

  try {
    const base = magicubeBase(connection);
    const [balanceBody, rulesBody] = await Promise.all([
      callMagicube(token, BALANCE_PATH, proxyOptions, base),
      callMagicube(token, EARN_RULES_PATH, proxyOptions, base),
    ]);

    const balance = parseBalance(balanceBody);
    const { dailyRules, creditedToday, todayEarned } = parseEarnRules(rulesBody);

    return {
      ok: true,
      // The login is the claim: report the daily rows as credited for today.
      credited: true,
      creditedToday,
      earnedToday: todayEarned,
      balance,
      dailyRules,
    };
  } catch (e) {
    if (e instanceof MagicubeRefused) {
      return { ok: false, authExpired: e.authExpired === true, error: e.message };
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------------------
// Usage lane (Provider Limits) — the dashboard's quota rows for a ModelScope
// connection.
//
//   "魔粒"  remaining / available (frozen held back) → percentage row
//   "今日魔粒" today's earned vs. today's cap          → percentage row
//   "魔粒余额" the raw balance                         → credit-balance row
//
// earn/rules carries the daily caps so "今日魔粒" reads 0% before the login
// lands and 100% after it; the rules whose payout is *not* the daily login
// (e.g. 验证邮箱) are counted too, so the row is "how much of everything
// claimable today did I claim". A frozen amount (200 魔粒) reads as used in the
// 魔粒 row: the bar is what is actually spendable.

/** Percent left, 0-100, rounded. */
function percentLeft(remaining, total) {
  if (!(total > 0)) return 0;
  return Math.round(Math.max(0, Math.min(100, (remaining / total) * 100)));
}

/**
 * Shape one connection's usage answer from the two Magicube reads.
 * Returns { quotas, plan, user, message? } in the dashboard's parseQuotaData
 * contract. Both bodies may be null (endpoint answered nothing useful).
 */
export function buildModelScopeUsage({ balance, rules, earnedToday, balanceCents } = {}) {
  const quotas = {};

  if (balance) {
    const spendable = balance.available;
    const pct = percentLeft(spendable, balance.total);
    quotas["魔粒"] = {
      used: Math.max(0, balance.total - spendable),
      total: balance.total,
      remaining: pct,
      remainingPercentage: pct,
      unit: "魔粒",
      resetAt: null,
    };
  }

  const daily = Array.isArray(rules?.dailyRules) ? rules.dailyRules : [];
  const todayCap = daily.reduce((sum, r) => sum + (r.dailyCap > 0 ? r.amount : 0), 0);
  const todayDone = daily.reduce(
    (sum, r) => sum + (r.dailyCap > 0 ? Math.min(r.todayUsed, r.dailyCap) * r.amount : 0),
    0,
  );
  const todaySpend = earnedToday ?? rules?.todayEarned ?? 0;
  if (todayCap > 0) {
    const left = todayCap - todayDone;
    quotas["今日魔粒"] = {
      used: todayDone,
      total: todayCap,
      remaining: percentLeft(left, todayCap),
      remainingPercentage: percentLeft(left, todayCap),
      unit: "魔粒",
      // "今日" resets at local midnight; leave the date to the dashboard, which
      // shows a countdown only when it has one. Kept null on purpose so the row
      // never claims a reset instant the server did not report.
      resetAt: null,
      // Uncredited remainder means the login for today has not landed yet.
      ...(todayDone < todayCap ? { message: `未领取 ${left} 魔粒 — 每日登录后自动到账` } : {}),
    };
    if (todaySpend !== todayDone) {
      quotas["今日魔粒"].used = todaySpend > todayDone ? todaySpend : todayDone;
    }
  }

  if (balance) {
    quotas["魔粒余额"] = {
      used: 0,
      total: balance.available,
      isCreditBalance: true,
      currency: "魔粒",
      unit: "魔粒",
    };
  }

  if (Object.keys(quotas).length === 0) {
    return { message: "ModelScope returned no Magicube data for this account" };
  }

  return {
    quotas,
    plan: daily.some((r) => r.key === "aliyun_bindlogin") ? "魔搭 · 已绑定阿里云" : "魔搭 · 免费",
    ...(balance ? { user: `余额 ${balance.total} 魔粒` } : {}),
    ...(balanceCents ? { message: balanceCents } : {}),
  };
}

/**
 * Usage handler (USAGE_HANDLERS shape) for a ModelScope apikey connection.
 * The "login" is the authenticated read, so this also keeps the daily streak
 * alive when the dashboard opens — same idempotent call the scheduler makes.
 */
export async function getModelScopeUsage(connection, proxyOptions = null) {
  const token = resolveToken(connection);
  if (!token) return { message: "ModelScope: no access token on this connection" };

  try {
    const base = magicubeBase(connection);
    const [balanceBody, rulesBody] = await Promise.all([
      callMagicube(token, BALANCE_PATH, proxyOptions, base),
      callMagicube(token, EARN_RULES_PATH, proxyOptions, base),
    ]);
    const balance = parseBalance(balanceBody);
    const rules = parseEarnRules(rulesBody);
    const conn = connection || {};
    const earnedToday = typeof conn.modelscopeLastLoginEarnedToday === "number"
      ? conn.modelscopeLastLoginEarnedToday
      : undefined;
    return buildModelScopeUsage({ balance, rules, earnedToday });
  } catch (e) {
    if (e instanceof MagicubeRefused) {
      return { message: e.authExpired ? `ModelScope unauthorized — check the access token (${e.message})` : e.message };
    }
    return { message: `ModelScope: ${e?.message ?? String(e)}` };
  }
}
