// ModelScope 魔搭 daily auto-login — earn-rules parsing, the balance read, the
// login orchestration against a mocked upstream, and the per-day scheduler gate
// that keeps a login from firing twice in one local day.
import { afterEach, describe, expect, it, vi } from "vitest";

// Route proxyAwareFetch through the test's global fetch so no network is hit.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

import {
  parseEarnRules,
  parseBalance,
  runModelScopeDailyLogin,
} from "../../open-sse/services/modelscopeMagicube.js";
import {
  localDayKey,
  enabledConnectionIds,
  loginConnection,
  runModelScopeAutoSigninTick,
} from "../../src/shared/services/modelscopeAutoSignin.js";

const BALANCE = { success: true, data: { total_balance: 403, available_balance: 203, frozen_amount: 200 } };
const RULES_CREDITED = {
  success: true,
  data: [
    { rule_key: "daily_active", title: "注册并登录", amount: 200, daily_cap: 1, today_used: 1, today_remain: 0, today_earned_amount: 200, earned_amount: 200 },
    { rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", amount: 50, daily_cap: 1, today_used: 1, today_remain: 0, today_earned_amount: 50, earned_amount: 50 },
    { rule_key: "verify_email", title: "验证邮箱", amount: 50, daily_cap: 0, today_used: 0, today_remain: 0, today_earned_amount: 0, earned_amount: 0 },
  ],
};
const RULES_PARTIAL = {
  success: true,
  data: [
    { rule_key: "daily_active", amount: 200, daily_cap: 1, today_used: 1, today_remain: 0, today_earned_amount: 200 },
    { rule_key: "aliyun_bindlogin", amount: 50, daily_cap: 1, today_used: 0, today_remain: 1, today_earned_amount: 0 },
  ],
};

function stubFetch(handlers) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    const body = u.endsWith("/balance") ? handlers.balance : handlers.rules;
    return new Response(JSON.stringify(body), { status: handlers.status ?? 200 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe("ModelScope earn-rules parsing", () => {
  it("keeps only the daily-login rules and sums today's payout", () => {
    const r = parseEarnRules(RULES_CREDITED);
    expect(r.dailyRules.map((d) => d.key)).toEqual(["daily_active", "aliyun_bindlogin"]);
    expect(r.creditedToday).toBe(true);
    expect(r.todayEarned).toBe(250);
  });

  it("reports a partially-credited day as not yet done", () => {
    const r = parseEarnRules(RULES_PARTIAL);
    expect(r.creditedToday).toBe(false);
    expect(r.todayEarned).toBe(200);
  });

  it("handles an empty rules list without throwing", () => {
    expect(parseEarnRules({ success: true, data: [] })).toEqual({ dailyRules: [], creditedToday: false, todayEarned: 0 });
  });

  it("reads the balance fields", () => {
    expect(parseBalance(BALANCE)).toEqual({ total: 403, available: 203, frozen: 200 });
    expect(parseBalance({ success: true })).toBeNull();
  });
});

describe("ModelScope daily login", () => {
  it("counts a successful authenticated read as the day's login", async () => {
    stubFetch({ balance: BALANCE, rules: RULES_CREDITED });
    const r = await runModelScopeDailyLogin({ apiKey: "ms-abc" });
    expect(r.ok).toBe(true);
    expect(r.credited).toBe(true);
    expect(r.earnedToday).toBe(250);
    expect(r.balance.total).toBe(403);
    // Both endpoints hit, both with the bearer token.
    const calls = globalThis.fetch.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.endsWith("/v1/magicubes/balance"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/v1/magicubes/earn/rules"))).toBe(true);
  });

  it("flags an unauthorized reply as an expired token", async () => {
    stubFetch({ balance: {}, rules: {}, status: 401 });
    const r = await runModelScopeDailyLogin({ apiKey: "ms-expired" });
    expect(r.ok).toBe(false);
    expect(r.authExpired).toBe(true);
  });

  it("refuses to run without a token", async () => {
    const r = await runModelScopeDailyLogin({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no ModelScope access token/);
  });
});

describe("ModelScope auto-login scheduler", () => {
  const conn = { id: "c1", provider: "modelscope", authType: "apikey", apiKey: "ms-abc" };

  function deps(overrides = {}) {
    return {
      getSettings: async () => ({ modelscopeAutoSignin: { connections: { c1: true } } }),
      getProviderConnections: async () => [conn],
      updateConnection: vi.fn(async () => {}),
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c }),
      login: async () => ({ ok: true, credited: true, earnedToday: 250, balance: { total: 403 } }),
      ...overrides,
    };
  }

  it("uses a local calendar day key", () => {
    expect(localDayKey(new Date("2026-11-12T23:59:00").getTime())).toBe("2026-11-12");
  });

  it("reads the opt-in set and honors the global off switch", () => {
    expect(enabledConnectionIds({ modelscopeAutoSignin: { connections: { c1: true, c2: false } } })).toEqual(new Set(["c1"]));
    expect(enabledConnectionIds({ modelscopeAutoSignin: { enabled: false, connections: { c1: true } } }).size).toBe(0);
  });

  it("logs in once and seals the day", async () => {
    const d = deps();
    const now = new Date("2026-11-12T09:00:00").getTime();
    const r = await loginConnection(conn, d, now);
    expect(r.loggedIn).toBe(true);
    expect(r.earnedToday).toBe(250);
    expect(d.updateConnection).toHaveBeenCalledWith("c1", expect.objectContaining({
      modelscopeLastLoginDate: "2026-11-12",
      modelscopeLastLoginDone: true,
      modelscopeLastLoginEarnedToday: 250,
      modelscopeMagicubeBalance: 403,
    }));
  });

  it("skips a connection already logged in today", async () => {
    const login = vi.fn(async () => ({ ok: true }));
    const d = deps({ login });
    const sealed = { ...conn, modelscopeLastLoginDate: "2026-11-12", modelscopeLastLoginDone: true };
    const r = await loginConnection(sealed, d, new Date("2026-11-12T20:00:00").getTime());
    expect(r).toEqual({ skipped: "already-logged-in-today" });
    expect(login).not.toHaveBeenCalled();
  });

  it("summarizes a tick across opted-in connections", async () => {
    const d = deps();
    const summary = await runModelScopeAutoSigninTick(d, { running: false }, Date.now());
    expect(summary).toMatchObject({ checked: 1, loggedIn: 1, earned: 250, errors: 0 });
  });
});
