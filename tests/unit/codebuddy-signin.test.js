// CodeBuddy daily check-in — panel parsing from the live checkin-activity-status
// payload, claim idempotency against the billing gateway, the check-in
// orchestration, and the per-day scheduler gate that keeps a claim from firing
// twice in one local day.
//
// Fixture shapes are captured from the real gateway (POST
// /v2/billing/meter/checkin-activity-status), including the 10001 business code
// the claim endpoint answers with once today is spent.
import { afterEach, describe, expect, it, vi } from "vitest";

// Route proxyAwareFetch through the test's global fetch so no network is hit.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

import {
  parseSigninPanel,
  getSigninStatus,
  runCodeBuddySignin,
} from "../../open-sse/services/codebuddySignin.js";
import {
  localDayKey,
  enabledConnectionIds,
  checkinConnection,
  runCodeBuddyAutoSigninTick,
} from "../../src/shared/services/codebuddyAutoSignin.js";

const STATUS_OPEN = {
  code: 0, msg: "OK",
  data: {
    active: true, today_checked_in: false, streak_days: 0, daily_credit: 100,
    today_credit: 100, is_streak_day: false, checkin_dates: [], total_credits: 0,
    activity_name: "签到活动",
  },
};

const STATUS_DONE = {
  code: 0, msg: "OK",
  data: {
    active: true, today_checked_in: true, streak_days: 1, daily_credit: 100,
    today_credit: 100, is_streak_day: false, checkin_dates: ["2026-11-13"],
    total_credits: 100, activity_name: "签到活动",
  },
};

const STATUS_INACTIVE = {
  code: 0, msg: "OK",
  data: { active: false, today_checked_in: false, streak_days: 0, daily_credit: 100, today_credit: 100 },
};

const CLAIM_OK = {
  code: 0, msg: "OK", data: { credit: 100, streak_days: 1, is_streak_day: false },
};

const CLAIM_ALREADY = { code: 10001, msg: "今天已签到，请明天再来" };
const CLAIM_INACTIVE = { code: 10001, msg: "签到活动未开启或已过期" };

describe("codebuddy sign-in panel parsing", () => {
  it("reads an open activity as claimable with today's credit", () => {
    const p = parseSigninPanel(STATUS_OPEN);
    expect(p).not.toBeNull();
    expect(p.active).toBe(true);
    expect(p.claimableToday).toBe(true);
    expect(p.claimedToday).toBe(false);
    expect(p.todayPoints).toBe(100);
  });

  it("reads a spent day as claimed and not claimable", () => {
    const p = parseSigninPanel(STATUS_DONE);
    expect(p.claimedToday).toBe(true);
    expect(p.claimableToday).toBe(false);
    expect(p.streakDays).toBe(1);
  });

  it("reports a missing-checkin_dates reply as claimed without a day list", () => {
    const p = parseSigninPanel({ code: 0, data: { active: true, today_checked_in: true, today_credit: 100 } });
    expect(p.claimedToday).toBe(true);
    expect(p.claimableToday).toBe(false);
    expect(p.todayPoints).toBe(100);
  });

  it("treats an inactive activity as not claimable", () => {
    const p = parseSigninPanel(STATUS_INACTIVE);
    expect(p.active).toBe(false);
    expect(p.claimableToday).toBe(false);
  });

  it("returns null when no panel-like payload is present", () => {
    expect(parseSigninPanel({ code: 0 })).toBeNull();
    expect(parseSigninPanel({ code: 0, data: {} })).toBeNull();
  });
});

describe("codebuddy sign-in calls (mocked upstream)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  const site = { providerId: "codebuddy-cn", token: "tok" };
  const conn = { provider: "codebuddy-cn", accessToken: "tok" };

  it("POSTs the activity status endpoint with the bearer headers", async () => {
    let url = "", method = "", headers = {};
    globalThis.fetch = vi.fn(async (u, init) => {
      url = String(u); method = init.method; headers = init.headers;
      return new Response(JSON.stringify(STATUS_OPEN), { status: 200 });
    });
    const p = await getSigninStatus(site);
    expect(url).toContain("/v2/billing/meter/checkin-activity-status");
    expect(method).toBe("POST");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(p.claimableToday).toBe(true);
  });

  it("claims when today is open (+credit)", async () => {
    let claimMethod = "";
    globalThis.fetch = vi.fn(async (u, init) => {
      if (String(u).includes("daily-checkin")) {
        claimMethod = init.method;
        return new Response(JSON.stringify(CLAIM_OK), { status: 200 });
      }
      return new Response(JSON.stringify(STATUS_OPEN), { status: 200 });
    });
    const r = await runCodeBuddySignin(conn);
    expect(claimMethod).toBe("POST");
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(true);
    expect(r.points).toBe(100);
  });

  it("does not claim when today is already claimed", async () => {
    let posts = 0;
    globalThis.fetch = vi.fn(async (u, init) => {
      if (init.method === "POST") posts += 1;
      return new Response(JSON.stringify(STATUS_DONE), { status: 200 });
    });
    const r = await runCodeBuddySignin(conn);
    expect(posts).toBe(1); // only the status read
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(false);
    expect(r.alreadyClaimed).toBe(true);
  });

  it("treats a 10001 claim reply as already claimed (idempotent)", async () => {
    globalThis.fetch = vi.fn(async (u) => {
      if (String(u).includes("daily-checkin")) return new Response(JSON.stringify(CLAIM_ALREADY), { status: 200 });
      return new Response(JSON.stringify(STATUS_OPEN), { status: 200 });
    });
    const r = await runCodeBuddySignin(conn);
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(false);
    expect(r.alreadyClaimed).toBe(true);
    expect(r.points).toBe(0);
  });

  it("skips an inactive activity without claiming", async () => {
    let claims = 0;
    globalThis.fetch = vi.fn(async (u) => {
      if (String(u).includes("daily-checkin")) claims += 1;
      return new Response(JSON.stringify(STATUS_INACTIVE), { status: 200 });
    });
    const r = await runCodeBuddySignin(conn);
    expect(claims).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(false);
  });

  it("reports a refused token as authExpired (no throw)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("<html>401</html>", { status: 401 }));
    const r = await runCodeBuddySignin(conn);
    expect(r.ok).toBe(false);
    expect(r.authExpired).toBe(true);
  });

  it("returns an error when the connection has no token", async () => {
    const r = await runCodeBuddySignin({ provider: "codebuddy-cn" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no token/);
  });
});

describe("codebuddy daily gate + scheduler", () => {
  const now = new Date("2026-01-05T10:00:00").getTime();

  function deps(overrides = {}) {
    return {
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c, refreshed: false }),
      updateConnection: vi.fn(async () => {}),
      signin: vi.fn(async () => ({ ok: true, claimed: true, points: 100 })),
      getSettings: async () => ({}),
      getProviderConnections: async () => [],
      ...overrides,
    };
  }

  it("day key is a local YYYY-MM-DD string", () => {
    expect(localDayKey(now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("enabledConnectionIds honors the opt-in map and global off switch", () => {
    expect([...enabledConnectionIds({ codebuddyAutoSignin: { connections: { a: true, b: false } } })]).toEqual(["a"]);
    expect([...enabledConnectionIds({ codebuddyAutoSignin: { enabled: false, connections: { a: true } } })]).toEqual([]);
  });

  it("skips a connection already claimed today", async () => {
    const d = deps();
    const r = await checkinConnection(
      { id: "x", provider: "codebuddy-cn", codebuddyLastSigninDate: localDayKey(now), codebuddyLastSigninDone: true },
      d, now,
    );
    expect(r.skipped).toBe("already-claimed-today");
    expect(d.signin).not.toHaveBeenCalled();
  });

  it("retries a day that recorded a date but nothing claimed", async () => {
    const d = deps();
    const r = await checkinConnection(
      { id: "x", provider: "codebuddy-cn", codebuddyLastSigninDate: localDayKey(now), codebuddyLastSigninDone: false },
      d, now,
    );
    expect(r.skipped).toBeUndefined();
    expect(d.signin).toHaveBeenCalledTimes(1);
    expect(r.claimed).toBe(true);
  });

  it("claims, updates the day gate, and accumulates points", async () => {
    const d = deps({ signin: vi.fn(async () => ({ ok: true, claimed: true, points: 100 })) });
    const conn = { id: "c1", provider: "codebuddy-cn", codebuddyLastSigninTotalPoints: 50 };
    const r = await checkinConnection(conn, d, now);
    expect(r.claimed).toBe(true);
    const patch = d.updateConnection.mock.calls[0][1];
    expect(patch.codebuddyLastSigninDate).toBe("2026-01-05");
    expect(patch.codebuddyLastSigninDone).toBe(true);
    expect(patch.codebuddyLastSigninClaimed).toBe(true);
    expect(patch.codebuddyLastSigninPoints).toBe(100);
    expect(patch.codebuddyLastSigninTotalPoints).toBe(150);
  });

  it("keeps the day open when today is not yet claimable", async () => {
    const d = deps({ signin: vi.fn(async () => ({ ok: true, claimed: false, alreadyClaimed: false, points: 0 })) });
    await checkinConnection({ id: "c1", provider: "codebuddy-cn" }, d, now);
    expect(d.updateConnection.mock.calls[0][1].codebuddyLastSigninDone).toBe(false);
  });

  it("does not log out on a refused sign-in", async () => {
    const d = deps({ signin: vi.fn(async () => ({ ok: false, authExpired: true, error: "401" })) });
    const r = await checkinConnection({ id: "c1", provider: "codebuddy-cn" }, d, now);
    expect(r.error).toBe("401");
    expect(d.updateConnection).not.toHaveBeenCalled();
  });

  it("runs one tick for opted-in connections only", async () => {
    const d = deps({
      getSettings: async () => ({ codebuddyAutoSignin: { connections: { tick1: true } } }),
      getProviderConnections: async ({ provider }) => (
        provider === "codebuddy-cn"
          ? [
              { id: "tick1", provider: "codebuddy-cn", authType: "oauth" },
              { id: "tick2", provider: "codebuddy-cn", authType: "oauth" },
            ]
          : []
      ),
    });
    const r = await runCodeBuddyAutoSigninTick(d, { running: false }, now);
    expect(d.signin).toHaveBeenCalledTimes(1);
    expect(r.claimed).toBe(1);
  });
});
