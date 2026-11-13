// MossAI (mossai.cc) daily check-in — check-in status/claim parsing, the balance
// read, the claim orchestration against a mocked upstream, and the per-day
// scheduler gate that keeps a claim from firing twice in one local day.
import { afterEach, describe, expect, it, vi } from "vitest";

// Route proxyAwareFetch through the test's global fetch so no network is hit.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

// The scheduler imports "open-sse/index.js" for side effects (registers global
// DB + provider hooks); vitest cannot resolve the bare specifier, so stub it.
vi.mock("open-sse/index.js", () => ({}), { virtual: true });

import {
  readMossCheckinStatus,
  claimMossCheckin,
  readMossBalance,
  buildMossUsage,
  resolveToken,
} from "../../open-sse/services/mossaiSignin.js";
import {
  localDayKey,
  enabledConnectionIds,
  checkinConnection,
  runMossAutoSigninTick,
} from "../../src/shared/services/mossaiAutoSignin.js";

const BALANCE = { balance: 12.34 };
const CHECKIN_UNCLAIMED = {
  data: {
    active: true,
    claimed_today: false,
    today: "2026-11-13",
    reward: 0.5,
    streak_days: 3,
    days: [{ dayNo: 1, status: 3 }, { dayNo: 2, status: 3 }, { dayNo: 3, status: 3 }],
  },
};
const CHECKIN_CLAIMED = {
  data: {
    active: true,
    claimed_today: true,
    today: "2026-11-13",
    reward: 0.5,
    streak_days: 4,
    days: [{ dayNo: 1, status: 3 }, { dayNo: 2, status: 3 }, { dayNo: 3, status: 3 }, { dayNo: 4, status: 3 }],
  },
};

function stubFetch({ balance = BALANCE, checkin = CHECKIN_UNCLAIMED, status = 200 } = {}) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    const body = u.endsWith("/api/balance") ? balance : checkin;
    return new Response(JSON.stringify(body), { status });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe("MossAI check-in read", () => {
  it("parses an unclaimed panel", async () => {
    stubFetch();
    const r = await readMossCheckinStatus({ apiKey: "tok" });
    expect(r.ok).toBe(true);
    expect(r.claimedToday).toBe(false);
    expect(r.reward).toBe(0.5);
    expect(r.streak).toBe(3);
  });

  it("parses a claimed panel", async () => {
    stubFetch({ checkin: CHECKIN_CLAIMED });
    const r = await readMossCheckinStatus({ apiKey: "tok" });
    expect(r.ok).toBe(true);
    expect(r.claimedToday).toBe(true);
  });

  it("flags a 401 as an expired token", async () => {
    stubFetch({ status: 401 });
    const r = await readMossCheckinStatus({ apiKey: "tok" });
    expect(r.ok).toBe(false);
    expect(r.authExpired).toBe(true);
  });
});

describe("MossAI claim + balance", () => {
  it("claims and reports the reward", async () => {
    stubFetch({ checkin: { data: { reward: 0.5 } } });
    const r = await claimMossCheckin({ apiKey: "tok" });
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(true);
    expect(r.reward).toBe(0.5);
  });

  it("reads the balance", async () => {
    stubFetch();
    const r = await readMossBalance({ apiKey: "tok" });
    expect(r.ok).toBe(true);
    expect(r.balance).toBe(12.34);
  });

  it("builds dashboard quota rows", () => {
    const u = buildMossUsage({
      balance: { balance: 12.34 },
      checkin: { ok: true, active: true, claimedToday: false, reward: 0.5 },
    });
    expect(u.quotas["算力余额"].total).toBe(12.34);
    expect(u.quotas["算力余额"].isCreditBalance).toBe(true);
    expect(u.quotas["今日签到"].remaining).toBe(100);
    expect(u.quotas["签到奖励"].total).toBe(0.5);
  });
});

describe("MossAI auto check-in scheduler", () => {
  const conn = { id: "c1", provider: "mossai", authType: "apikey", apiKey: "tok" };

  function deps(overrides = {}) {
    return {
      getSettings: async () => ({ mossaiAutoSignin: { connections: { c1: true } } }),
      getProviderConnections: async () => [conn],
      updateConnection: vi.fn(async () => {}),
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c }),
      readStatus: async () => ({ ok: true, active: true, claimedToday: false, reward: 0.5 }),
      claim: async () => ({ ok: true, claimed: true, reward: 0.5 }),
      readBalance: async () => ({ ok: true, balance: 12.34 }),
      ...overrides,
    };
  }

  it("uses a local calendar day key", () => {
    expect(localDayKey(new Date("2026-11-12T23:59:00").getTime())).toBe("2026-11-12");
  });

  it("reads the opt-in set and honors the global off switch", () => {
    expect(enabledConnectionIds({ mossaiAutoSignin: { connections: { c1: true, c2: false } } })).toEqual(new Set(["c1"]));
    expect(enabledConnectionIds({ mossaiAutoSignin: { enabled: false, connections: { c1: true } } }).size).toBe(0);
  });

  it("claims once and seals the day", async () => {
    const d = deps();
    const now = new Date("2026-11-12T09:00:00").getTime();
    const r = await checkinConnection(conn, d, now);
    expect(r.claimed).toBe(true);
    expect(r.reward).toBe(0.5);
    expect(d.updateConnection).toHaveBeenCalledWith("c1", expect.objectContaining({
      mossaiLastSigninDate: "2026-11-12",
      mossaiLastSigninDone: true,
      mossaiLastSigninReward: 0.5,
      mossaiBalance: 12.34,
    }));
  });

  it("skips a connection already claimed today", async () => {
    const claim = vi.fn(async () => ({ ok: true, claimed: true, reward: 0.5 }));
    const d = deps({ claim });
    const sealed = { ...conn, mossaiLastSigninDate: "2026-11-12", mossaiLastSigninDone: true };
    const r = await checkinConnection(sealed, d, new Date("2026-11-12T20:00:00").getTime());
    expect(r).toEqual({ skipped: "already-claimed-today" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("does not claim when already claimed upstream today", async () => {
    const claim = vi.fn(async () => ({ ok: true, claimed: true, reward: 0.5 }));
    const d = deps({
      claim,
      readStatus: async () => ({ ok: true, active: true, claimedToday: true, reward: 0.5 }),
    });
    const r = await checkinConnection(conn, d, new Date("2026-11-12T09:00:00").getTime());
    expect(r.alreadyClaimed).toBe(true);
    expect(claim).not.toHaveBeenCalled();
  });

  it("skips a connection that only carries a sk- model key (no web token)", async () => {
    const claim = vi.fn();
    const d = deps({ claim });
    const skConn = { id: "c2", provider: "mossai", authType: "apikey", apiKey: "sk-MBp0pqx" };
    const r = await checkinConnection(skConn, d, Date.now());
    expect(r).toEqual({ skipped: "no-web-token" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("summarizes a tick across opted-in connections", async () => {
    const d = deps();
    const summary = await runMossAutoSigninTick(d, { running: false }, Date.now());
    expect(summary).toMatchObject({ checked: 1, claimed: 1, reward: 0.5, errors: 0 });
  });
});

// A connection carries two different credentials: the developer sk- key in
// apiKey (model calls) and the web access token (check-in). Only the latter may
// ever be sent as X-Access-Token.
describe("resolveToken — web access token vs developer sk- key", () => {
  it("prefers accessToken over the sk- apiKey", () => {
    expect(resolveToken({ apiKey: "sk-abc", accessToken: "web-token" })).toBe("web-token");
    expect(resolveToken({ apiKey: "sk-abc", providerSpecificData: { accessToken: "web-token" } })).toBe("web-token");
  });

  it("never sends a developer sk- key as the web token", () => {
    expect(resolveToken({ apiKey: "sk-MBp0pqx" })).toBeNull();
    expect(resolveToken({})).toBeNull();
  });

  it("keeps the legacy layout where apiKey holds the web token", () => {
    expect(resolveToken({ apiKey: "eyJhbGciOi.web" })).toBe("eyJhbGciOi.web");
  });
});
