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

async function callMagicube(token, path, proxyOptions) {
  const response = await proxyAwareFetch(`${MAGICUBE_BASE}${path}`, {
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
    const [balanceBody, rulesBody] = await Promise.all([
      callMagicube(token, BALANCE_PATH, proxyOptions),
      callMagicube(token, EARN_RULES_PATH, proxyOptions),
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
