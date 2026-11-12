// CodeBuddy daily check-in — panel parsing, claim idempotency, the check-in
// orchestration against a mocked upstream, and the per-day scheduler gate that
// keeps a claim from firing twice in one local day.
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

const PANEL_UNCLAIMED = {
  code: 0,
  data: {
    days: [
      { day_no: 1, points: 100, status: 1, is_today: true },
      { day_no: 2, points: 100, status: 1, is_today: false },
      { day_no: 4, points: 300, status: 1, is_today: false },
    ],
  },
};

const PANEL_CLAIMED = {
  code: 0,
  data: {
    days: [
      { day_no: 1, points: 100, status: 3, is_today: true },
      { day_no: 2, points: 100, status: 1, is_today: false },
    ],
  },
};

describe("codebuddy sign-in panel parsing", () => {
  it("reads today's claimable slot and future points", () => {
    const p = parseSigninPanel(PANEL_UNCLAIMED);
    expect(p).not.toBeNull();
    expect(p.claimableToday).toBe(true);
    expect(p.claimedToday).toBe(false);
    expect(p.todayPoints).toBe(100);
    expect(p.days.map((d) => d.dayNo)).toEqual([1, 2, 4]);
  });

  it("marks a claimed day (status 3) as claimed, not claimable", () => {
    const p = parseSigninPanel(PANEL_CLAIMED);
    expect(p.claimedToday).toBe(true);
    expect(p.claimableToday).toBe(false);
  });

  it("honors an explicit claimed flag without a day list", () => {
    const p = parseSigninPanel({ code: 0, data: { claimed: true, points: 100 } });
    expect(p.claimedToday).toBe(true);
    expect(p.claimableToday).toBe(false);
    expect(p.todayPoints).toBe(100);
  });

  it("returns null when no panel-like payload is present", () => {
    expect(parseSigninPanel({ code: 0 })).toBeNull();
    expect(parseSigninPanel({ data: { days: [] } })).toBeNull();
  });
});

describe("codebuddy sign-in calls (mocked upstream)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  const site = { base: "https://copilot.tencent.com", domain: "copilot.tencent.com", providerId: "codebuddy-cn", token: "tok" };
  const conn = { provider: "codebuddy-cn", accessToken: "tok" };

  it("GETs the status endpoint and sends the plugin headers", async () => {
    let url = "", method = "", headers = {};
    globalThis.fetch = vi.fn(async (u, init) => {
      url = String(u); method = init.method; headers = init.headers;
      return new Response(JSON.stringify(PANEL_UNCLAIMED), { status: 200 });
    });
    const p = await getSigninStatus(site);
    expect(url).toContain("/v2/activity/signin");
    expect(method).toBe("GET");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["X-Domain"]).toBe("copilot.tencent.com");
    expect(headers["x-codebuddy-request"]).toBe("1");
    expect(p.claimableToday).toBe(true);
  });

  it("claims when today is claimable (+points)", async () => {
    let claimMethod = "";
    globalThis.fetch = vi.fn(async (u, init) => {
      if (init.method === "POST") {
        claimMethod = "POST";
        return new Response(JSON.stringify({ code: 0, data: { claimed: true, points: 100 } }), { status: 200 });
      }
      return new Response(JSON.stringify(PANEL_UNCLAIMED), { status: 200 });
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
      return new Response(JSON.stringify(PANEL_CLAIMED), { status: 200 });
    });
    const r = await runCodeBuddySignin(conn);
    expect(posts).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(false);
    expect(r.alreadyClaimed).toBe(true);
  });

  it("treats an explicit already_claimed reply as a no-op", async () => {
    globalThis.fetch = vi.fn(async (u, init) => {
      if (init.method === "POST") {
        return new Response(JSON.stringify({ code: 0, data: { already_claimed: true, points: 100 } }), { status: 200 });
      }
      return new Response(JSON.stringify(PANEL_UNCLAIMED), { status: 200 });
    });
    const r = await runCodeBuddySignin(conn);
    expect(r.claimed).toBe(false);
    expect(r.alreadyClaimed).toBe(true);
    expect(r.points).toBe(0);
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
    const summary = await runCodeBuddyAutoSigninTick(d, { running: false, failureCache: {} }, now);
    expect(summary.checked).toBe(1);
    expect(summary.claimed).toBe(1);
    expect(summary.points).toBe(100);
  });
});
