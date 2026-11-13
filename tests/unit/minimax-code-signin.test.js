// MiniMax Code daily check-in — panel parsing, claim idempotency, the
// check-in orchestration against a mocked upstream, and the per-day scheduler
// gate that keeps a claim from firing twice in one local day.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseSigninPanel,
  getSigninStatus,
  claimSignin,
  runMiniMaxCodeSignin,
} from "../../open-sse/services/minimaxCodeSignin.js";
import {
  localDayKey,
  enabledConnectionIds,
  checkinConnection,
  runMiniMaxAutoSigninTick,
} from "../../src/shared/services/minimaxAutoSignin.js";

const PANEL_UNCLAIMED = {
  data: {
    scene: 2,
    days: [
      { day_no: 1, points: 400, status: 1, is_today: true, bonus_points: 0 },
      { day_no: 2, points: 400, status: 1, is_today: false, bonus_points: 0 },
      { day_no: 4, points: 1000, status: 1, is_today: false, bonus_points: 0 },
    ],
  },
  base_resp: { status_code: 0, status_msg: "ok" },
};

const PANEL_CLAIMED = {
  data: {
    scene: 2,
    days: [
      { day_no: 1, points: 400, status: 3, is_today: true, bonus_points: 0 },
      { day_no: 2, points: 400, status: 1, is_today: false, bonus_points: 0 },
    ],
  },
  base_resp: { status_code: 0, status_msg: "ok" },
};

describe("minimax-code sign-in panel parsing", () => {
  it("reads today's claimable slot and future points", () => {
    const p = parseSigninPanel(PANEL_UNCLAIMED);
    expect(p).not.toBeNull();
    expect(p.scene).toBe(2);
    expect(p.claimableToday).toBe(true);
    expect(p.claimedToday).toBe(false);
    expect(p.todayPoints).toBe(400);
    expect(p.days.map((d) => d.dayNo)).toEqual([1, 2, 4]);
    expect(p.days.find((d) => d.dayNo === 4).points).toBe(1000);
  });

  it("marks a claimed day (status 3) as claimed, not claimable", () => {
    const p = parseSigninPanel(PANEL_CLAIMED);
    expect(p.claimedToday).toBe(true);
    expect(p.claimableToday).toBe(false);
    expect(p.todayPoints).toBe(400);
  });

it("treats today's live status 2 (unclaimed) as claimable", () => {
    const p = parseSigninPanel({
      data: { scene: 2, days: [{ day_no: 2, points: 400, status: 2, is_today: true, bonus_points: 0 }] },
    });
    expect(p.claimableToday).toBe(true);
    expect(p.claimedToday).toBe(false);
    expect(p.todayPoints).toBe(400);
  });

  it("treats bonus_points as part of today's points", () => {
    const p = parseSigninPanel({
      data: { scene: 2, days: [{ day_no: 1, points: 400, bonus_points: 100, status: 1, is_today: true }] },
    });
    expect(p.todayPoints).toBe(500);
  });

  it("returns null when no panel is present", () => {
    expect(parseSigninPanel({ base_resp: { status_code: 0 } })).toBeNull();
    expect(parseSigninPanel({ data: { days: [] } })).toBeNull();
  });
});

describe("minimax-code sign-in calls (mocked upstream)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  const site = { agent: "https://agent.minimaxi.com", lang: "zh" };

  it("GETs the status endpoint (no body) and parses the panel", async () => {
    let calledUrl = "";
    let method = "";
    let hasBody = false;
    globalThis.fetch = vi.fn(async (url, init) => {
      calledUrl = String(url);
      method = init.method;
      hasBody = init.body !== undefined && init.body !== null;
      return new Response(JSON.stringify(PANEL_UNCLAIMED), { status: 200 });
    });
    const p = await getSigninStatus(site, "tok", "42");
    expect(calledUrl).toContain("/minimax-cloud/api/v1/signin/status");
    expect(method).toBe("GET");
    expect(hasBody).toBe(false);
    expect(p.claimableToday).toBe(true);
  });

  it("POSTs the claim endpoint and reports a fresh claim (+points)", async () => {
    let method = "";
    let bodyText = "";
    globalThis.fetch = vi.fn(async (url, init) => {
      method = init.method;
      bodyText = init.body;
      return new Response(JSON.stringify({
        data: { claim_result: 1, day_no: 1, points: 400, expire_at_ms: 1797004800000, panel: PANEL_CLAIMED.data },
        base_resp: { status_code: 0, status_msg: "ok" },
      }), { status: 200 });
    });
    const r = await claimSignin(site, "tok", "42");
    expect(method).toBe("POST");
    expect(JSON.parse(bodyText)).toEqual({ scene: 2 });
    expect(r.claimed).toBe(true);
    expect(r.points).toBe(400);
    expect(r.alreadyClaimed).toBe(false);
    expect(r.panel.claimedToday).toBe(true);
  });

  it("treats claim_result=2 as already-claimed (idempotent, 0 points)", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: { claim_result: 2, day_no: 1, points: 400, panel: PANEL_CLAIMED.data },
      base_resp: { status_code: 0, status_msg: "ok" },
    }), { status: 200 }));
    const r = await claimSignin(site, "tok", "42");
    expect(r.claimed).toBe(false);
    expect(r.alreadyClaimed).toBe(true);
    expect(r.points).toBe(0);
  });
});

describe("minimax-code check-in orchestration (runMiniMaxCodeSignin)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  const conn = { provider: "minimax-code", accessToken: "tok", providerSpecificData: { realUserID: "42" } };

  it("reads status then claims when today is claimable", async () => {
    const urls = [];
    globalThis.fetch = vi.fn(async (url) => {
      urls.push(String(url));
      if (String(url).includes("signin/status")) return new Response(JSON.stringify(PANEL_UNCLAIMED), { status: 200 });
      return new Response(JSON.stringify({
        data: { claim_result: 1, day_no: 1, points: 400, panel: PANEL_CLAIMED.data },
        base_resp: { status_code: 0, status_msg: "ok" },
      }), { status: 200 });
    });
    const r = await runMiniMaxCodeSignin(conn);
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(true);
    expect(r.points).toBe(400);
    expect(urls.some((u) => u.includes("signin/status"))).toBe(true);
    expect(urls.some((u) => u.includes("signin/claim"))).toBe(true);
  });

  it("does NOT claim when today is already claimed", async () => {
    const urls = [];
    globalThis.fetch = vi.fn(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(PANEL_CLAIMED), { status: 200 });
    });
    const r = await runMiniMaxCodeSignin(conn);
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(false);
    expect(r.alreadyClaimed).toBe(true);
    expect(urls.some((u) => u.includes("signin/claim"))).toBe(false);
  });

  it("reports authExpired (no throw) when the token is refused", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 401 }));
    const r = await runMiniMaxCodeSignin(conn);
    expect(r.ok).toBe(false);
    expect(r.authExpired).toBe(true);
  });

  it("does not run for an unsupported provider", async () => {
    const r = await runMiniMaxCodeSignin({ provider: "unknown", accessToken: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not supported/);
  });
});

describe("minimax auto-signin scheduler gate", () => {
  it("localDayKey rolls a local calendar day", () => {
    const a = localDayKey(new Date(2026, 0, 5, 23, 59).getTime());
    const b = localDayKey(new Date(2026, 0, 6, 0, 1).getTime());
    expect(a).toBe("2026-01-05");
    expect(b).toBe("2026-01-06");
  });

  it("enabledConnectionIds respects the global off switch", () => {
    expect([...enabledConnectionIds({ minimaxAutoSignin: { connections: { a: true, b: false } } })]).toEqual(["a"]);
    expect([...enabledConnectionIds({ minimaxAutoSignin: { enabled: false, connections: { a: true } } })]).toEqual([]);
    expect([...enabledConnectionIds({})]).toEqual([]);
  });

  it("skips a connection already claimed today without calling upstream", async () => {
    const now = new Date(2026, 0, 5, 10, 0).getTime();
    const signin = vi.fn();
    const deps = {
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c }),
      signin,
      updateConnection: vi.fn(),
    };
    const r = await checkinConnection(
      { id: "x", provider: "minimax-code", minimaxLastSigninDate: localDayKey(now), minimaxLastSigninDone: true },
      deps,
      now,
    );
    expect(r.skipped).toBe("already-claimed-today");
    expect(signin).not.toHaveBeenCalled();
  });

  it("claims, persists the day + points, and counts a fresh claim", async () => {
    const now = new Date(2026, 0, 5, 10, 0).getTime();
    const updateConnection = vi.fn(async () => ({}));
    const deps = {
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c }),
      signin: async () => ({ ok: true, claimed: true, points: 400 }),
      updateConnection,
    };
    const r = await checkinConnection({ id: "x", provider: "minimax-code" }, deps, now);
    expect(r.claimed).toBe(true);
    expect(r.points).toBe(400);
    expect(updateConnection).toHaveBeenCalledTimes(1);
    const patch = updateConnection.mock.calls[0][1];
    expect(patch.minimaxLastSigninDate).toBe("2026-01-05");
    expect(patch.minimaxLastSigninDone).toBe(true);
    expect(patch.minimaxLastSigninClaimed).toBe(true);
    expect(patch.minimaxLastSigninPoints).toBe(400);
  });

  it("seals the day when already claimed upstream (done:true, 0 points)", async () => {
    const now = new Date(2026, 0, 5, 10, 0).getTime();
    const updateConnection = vi.fn(async () => ({}));
    const deps = {
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c }),
      signin: async () => ({ ok: true, claimed: false, alreadyClaimed: true, points: 0 }),
      updateConnection,
    };
    const r = await checkinConnection({ id: "x", provider: "minimax-code" }, deps, now);
    expect(r.claimed).toBe(false);
    const patch = updateConnection.mock.calls[0][1];
    expect(patch.minimaxLastSigninDone).toBe(true);
    expect(patch.minimaxLastSigninClaimed).toBe(false);
    expect(patch.minimaxLastSigninPoints).toBe(0);
  });

it("retries a day that recorded a date but nothing claimed (done:false)", async () => {
    const now = new Date(2026, 0, 5, 10, 0).getTime();
    const signin = vi.fn(async () => ({ ok: true, claimed: true, points: 400 }));
    const deps = {
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c }),
      signin,
      updateConnection: vi.fn(async () => ({})),
    };
    const conn = {
      id: "x", provider: "minimax-code",
      minimaxLastSigninDate: localDayKey(now), minimaxLastSigninDone: false,
    };
    const r = await checkinConnection(conn, deps, now);
    expect(r.skipped).toBeUndefined();
    expect(signin).toHaveBeenCalledTimes(1);
    expect(r.claimed).toBe(true);
  });

  it("does not seal the day when today is not claimable yet (done:false)", async () => {
    const now = new Date(2026, 0, 5, 10, 0).getTime();
    const updateConnection = vi.fn(async () => ({}));
    const deps = {
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c }),
      signin: async () => ({ ok: true, claimed: false, alreadyClaimed: false, points: 0 }),
      updateConnection,
    };
    await checkinConnection({ id: "x", provider: "minimax-code" }, deps, now);
    const patch = updateConnection.mock.calls[0][1];
    expect(patch.minimaxLastSigninDone).toBe(false);
  });

  it("a tick checks only opted-in connection ids and counts claims", async () => {
    const now = new Date(2026, 0, 5, 9, 0).getTime();
    const deps = {
      getSettings: async () => ({ minimaxAutoSignin: { connections: { c1: true } } }),
      getProviderConnections: async ({ provider }) => (
        provider === "minimax-code"
          ? [
              { id: "c1", provider: "minimax-code", authType: "oauth" },
              { id: "c2", provider: "minimax-code", authType: "oauth" },
            ]
          : []
      ),
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c }),
      signin: async () => ({ ok: true, claimed: true, points: 400 }),
      updateConnection: async () => ({}),
    };
    const summary = await runMiniMaxAutoSigninTick(deps, { running: false, failureCache: {} }, now);
    expect(summary.checked).toBe(1);
    expect(summary.claimed).toBe(1);
    expect(summary.points).toBe(400);
  });
});
