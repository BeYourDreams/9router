// ModelScope 魔搭 usage lane — the 魔粒 quota rows the Provider Limits dashboard
// renders, built from a mocked Magicube balance + earn/rules read.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

import { buildModelScopeUsage, getModelScopeUsage } from "../../open-sse/services/modelscopeMagicube.js";

const BALANCE = { success: true, data: { total_balance: 403, available_balance: 203, frozen_amount: 200 } };
const RULES = {
  success: true,
  data: [
    { rule_key: "daily_active", amount: 200, daily_cap: 1, today_used: 1, today_earn_amount: 200, today_earned_amount: 200 },
    { rule_key: "aliyun_bindlogin", amount: 50, daily_cap: 1, today_used: 1, today_earned_amount: 50 },
    { rule_key: "verify_email", amount: 50, daily_cap: 0, today_used: 0, today_earned_amount: 0 },
  ],
};

function stubFetch({ status = 200, balance = BALANCE, rules = RULES } = {}) {
  globalThis.fetch = vi.fn(async (url) => {
    const body = String(url).endsWith("/balance") ? balance : rules;
    return new Response(JSON.stringify(body), { status });
  });
}

const rules = { dailyRules: [
  { key: "daily_active", amount: 200, dailyCap: 1, todayUsed: 1, todayEarned: 200 },
  { key: "aliyun_bindlogin", amount: 50, dailyCap: 1, todayUsed: 1, todayEarned: 50 },
  { key: "verify_email", amount: 50, dailyCap: 0, todayUsed: 0, todayEarned: 0 },
], creditedToday: true, todayEarned: 250 };

afterEach(() => { vi.restoreAllMocks(); delete globalThis.fetch; });

describe("ModelScope usage rows", () => {
  it("turns the balance into a percentage row that discounts the frozen amount", () => {
    const { quotas } = buildModelScopeUsage({ balance: { total: 403, available: 203, frozen: 200 }, rules });
    expect(quotas["魔粒"]).toMatchObject({ total: 403, used: 200, remainingPercentage: 50, unit: "魔粒" });
  });

  it("reports today's payout against the daily cap", () => {
    const { quotas } = buildModelScopeUsage({ balance: { total: 403, available: 203, frozen: 200 }, rules });
    expect(quotas["今日魔粒"]).toMatchObject({ total: 250, used: 250, remainingPercentage: 0 });
    expect(quotas["今日魔粒"].message).toBeUndefined();
  });

  it("flags a partially claimed day", () => {
    const partial = { dailyRules: [
      { key: "daily_active", amount: 200, dailyCap: 1, todayUsed: 1, todayEarned: 200 },
      { key: "aliyun_bindlogin", amount: 50, dailyCap: 1, todayUsed: 0, todayEarned: 0 },
    ], creditedToday: false, todayEarned: 200 };
    const { quotas } = buildModelScopeUsage({ balance: { total: 403, available: 203, frozen: 200 }, rules: partial });
    expect(quotas["今日魔粒"].used).toBe(200);
    expect(quotas["今日魔粒"].message).toMatch(/未领取 50 魔粒/);
  });

  it("adds an absolute credit-balance row", () => {
    const { quotas } = buildModelScopeUsage({ balance: { total: 403, available: 203, frozen: 200 }, rules });
    expect(quotas["魔粒余额"]).toMatchObject({ total: 203, isCreditBalance: true, currency: "魔粒" });
  });

  it("labels a bound Aliyun account in the plan", () => {
    expect(buildModelScopeUsage({ balance: { total: 1, available: 1, frozen: 0 }, rules }).plan).toContain("阿里云");
  });

  it("explains an empty answer instead of rendering nothing", () => {
    expect(buildModelScopeUsage({}).message).toMatch(/no Magicube data/);
  });
});

describe("getModelScopeUsage", () => {
  it("reads both Magicube endpoints with the connection token", async () => {
    stubFetch();
    const usage = await getModelScopeUsage({ provider: "modelscope", apiKey: "ms-abc" });
    expect(usage.quotas["魔粒"].total).toBe(403);
    const calls = globalThis.fetch.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.endsWith("/v1/magicubes/balance"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/v1/magicubes/earn/rules"))).toBe(true);
  });

  it("surfaces an expired token as a message", async () => {
    stubFetch({ status: 401 });
    const usage = await getModelScopeUsage({ provider: "modelscope", apiKey: "ms-expired" });
    expect(usage.message).toMatch(/unauthorized/i);
  });

  it("refuses to run without a token", async () => {
    const usage = await getModelScopeUsage({ provider: "modelscope" });
    expect(usage.message).toMatch(/no access token/);
  });
});

describe("Provider Limits rendering of the ModelScope rows", () => {
  const apiAnswer = {
    quotas: {
      "魔粒": { used: 200, total: 403, remainingPercentage: 50, unit: "魔粒", resetAt: null },
      "今日魔粒": { used: 250, total: 250, remainingPercentage: 0, unit: "魔粒", resetAt: null },
      "魔粒余额": { used: 0, total: 203, isCreditBalance: true, currency: "魔粒", unit: "魔粒" },
    },
    plan: "魔搭 · 已绑定阿里云",
  };

  it("keeps the percentage rows' bars and the balance row absolute", async () => {
    const { parseQuotaData, getRemainingPercentage } = await import(
      "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );
    const rows = parseQuotaData("modelscope", apiAnswer);
    expect(rows.map((r) => r.name)).toEqual(["魔粒", "今日魔粒", "魔粒余额"]);
    // Percentage bars read the remaining share the service computed.
    expect(rows.slice(0, 2).map(getRemainingPercentage)).toEqual([50, 0]);
    // The balance row's 203 魔粒 must never leak into `remaining` as "203%".
    expect(rows[2].isCreditBalance).toBe(true);
    expect(rows[2].total).toBe(203);
    expect(rows[2].currency).toBe("魔粒");
    expect(rows[0].unit).toBe("魔粒");
  });

  it("surfaces an unclaimed day as a row hint", async () => {
    const { parseQuotaData, getRemainingPercentage } = await import(
      "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );
    const rows = parseQuotaData("modelscope", {
      quotas: { "今日魔粒": { used: 200, total: 250, remainingPercentage: 20, message: "未领取 50 魔粒 — 每日登录后自动到账" } },
    });
    expect(getRemainingPercentage(rows[0])).toBe(20);
    expect(rows[0].emptyMessage).toMatch(/未领取 50 魔粒/);
  });
});
