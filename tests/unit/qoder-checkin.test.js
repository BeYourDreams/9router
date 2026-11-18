// Qoder daily credit claim (每日签到领 100 Credits): the campaign list the
// IDE's growth page exposes, the claim call, and the per-day scheduler gate.
import { afterEach, describe, expect, it, vi } from "vitest";

// Route proxyAwareFetch through the test's global fetch so no network is hit.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

import {
  parseCampaigns,
  pickClaimable,
  pickClaimedToday,
  getQoderCampaigns,
  claimQoderCampaign,
  claimQoderDailyCredits,
} from "../../open-sse/services/qoderCheckin.js";
import {
  localDayKey,
  enabledConnectionIds,
  claimConnection,
  runQoderAutoSigninTick,
} from "../../src/shared/services/qoderAutoSignin.js";

const CAMPAIGN_ID = "01a1e029-3407-73db-9dbc-c987364578f6";
const CAMPAIGNS = {
  shouldShowCampaignPopup: true,
  claimable: true,
  campaigns: [
    {
      campaignId: CAMPAIGN_ID,
      actionType: "CLAIM_BENEFIT",
      claimStatus: "CLAIMABLE",
      startAt: 1794794400,
      endAt: 1794880740,
      benefit: { kind: "CREDITS", amount: 100, validity: { mode: "RELATIVE_DAYS", days: 30 } },
    },
    { campaignId: "promo-1", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE" },
  ],
};

function stubFetch({ campaigns = CAMPAIGNS, claimStatus = "CLAIMED", amount = 100, status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, options) => {
    const u = String(url);
    calls.push({ url: u, method: options?.method || "GET" });
    if (u.includes("/claim")) {
      return new Response(JSON.stringify({ data: { status: claimStatus, benefit: { amount } } }), { status });
    }
    return new Response(JSON.stringify(campaigns), { status });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe("Qoder campaigns", () => {
  it("keeps the claimable daily campaign and ignores promos", () => {
    const parsed = parseCampaigns(CAMPAIGNS);
    expect(parsed).toHaveLength(2);
    expect(pickClaimable(parsed)).toHaveLength(1);
    expect(pickClaimable(parsed)[0]).toMatchObject({ campaignId: CAMPAIGN_ID, amount: 100 });
  });

  it("treats a campaign inside its window as already claimed", () => {
    const now = 1794800000 * 1000;
    const parsed = parseCampaigns({
      campaigns: [{ campaignId: "x", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED", startAt: 1794794400, endAt: 1794880740 }],
    });
    expect(pickClaimedToday(parsed, now)).toHaveLength(1);
    expect(pickClaimedToday(parsed, 1794900000 * 1000)).toHaveLength(0);
  });
});

describe("Qoder daily claim", () => {
  it("reads the campaigns from the region host", async () => {
    const calls = stubFetch();
    const res = await getQoderCampaigns({ provider: "qoder-cn", accessToken: "jt-1" });
    expect(res.ok).toBe(true);
    expect(res.campaigns).toHaveLength(2);
    expect(calls[0].url).toBe("https://openapi.qoder.com.cn/sash/api/v1/me/campaigns");
    expect(calls[0].url).not.toContain("qoder.sh");
  });

  it("claims the daily campaign and reports the credits", async () => {
    const calls = stubFetch();
    const res = await claimQoderDailyCredits({ provider: "qoder", accessToken: "jt-2" });
    expect(res.ok).toBe(true);
    expect(res.claimed).toBe(1);
    expect(res.credits).toBe(100);
    expect(calls.map((c) => c.method + " " + c.url).join(" || ")).toBe(
      "GET https://openapi.qoder.sh/sash/api/v1/me/campaigns || POST https://openapi.qoder.sh/sash/api/v1/me/campaigns/" + CAMPAIGN_ID + "/claim",
    );
  });

  it("reports an expired token instead of pretending nothing is claimable", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    const res = await claimQoderDailyCredits({ provider: "qoder", accessToken: "jt-3" });
    expect(res.ok).toBe(false);
    expect(res.authExpired).toBe(true);
  });

  it("needs a token", async () => {
    const res = await claimQoderDailyCredits({ provider: "qoder" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no Qoder access token/);
  });

  it("treats a grant taken by another account of the same person as a no-op", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/claim")) {
        return new Response(JSON.stringify({
          status: "BLOCKED",
          failureCode: "SAME_PERSON_ALREADY_CLAIMED",
          benefit: { amount: 100 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify(CAMPAIGNS), { status: 200 });
    });
    const res = await claimQoderDailyCredits({ provider: "qoder-cn", accessToken: "jt-4" });
    expect(res.ok).toBe(true);
    expect(res.claimed).toBe(0);
    expect(res.alreadyClaimed).toBe(true);
    expect(res.creditedElsewhere).toBe(true);
  });

  it("reports the daily campaign as missing when the account has none", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      campaigns: [{ campaignId: "promo-1", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE" }],
    }), { status: 200 }));
    const res = await claimQoderDailyCredits({ provider: "qoder", accessToken: "jt-5" });
    expect(res.ok).toBe(true);
    expect(res.dailySeen).toBe(false);
    expect(res.alreadyClaimed).toBe(false);
  });
});

describe("Qoder claim scheduler", () => {
  const conn = { id: "c1", provider: "qoder-cn", authType: "oauth", accessToken: "jt-1" };

  function deps(overrides = {}) {
    return {
      getSettings: async () => ({ qoderAutoSignin: { connections: { c1: true } } }),
      getProviderConnections: async () => [conn],
      updateConnection: vi.fn(async () => {}),
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c, refreshed: false }),
      claim: vi.fn(async () => ({ ok: true, claimed: 1, credits: 100 })),
      ...overrides,
    };
  }

  it("claims once per local day", async () => {
    const d = deps();
    const now = new Date("2026-05-01T10:00:00").getTime();
    const first = await claimConnection(conn, d, now);
    expect(first).toMatchObject({ claimed: 1, credits: 100 });
    expect(d.updateConnection).toHaveBeenCalledWith("c1", expect.objectContaining({ qoderLastClaimDate: localDayKey(now) }));

    // Same day: the connection already carries the day stamp -> no second call.
    const claimed = { ...conn, qoderLastClaimDate: localDayKey(now) };
    const again = await claimConnection(claimed, d, now);
    expect(again).toMatchObject({ skipped: "already-claimed-today" });
    expect(d.claim).toHaveBeenCalledTimes(1);
  });

  it("seals the day when nothing is claimable", async () => {
    const d = deps({ claim: vi.fn(async () => ({ ok: true, claimed: 0, credits: 0, alreadyClaimed: true })) });
    const now = new Date("2026-05-01T10:00:00").getTime();
    const res = await claimConnection(conn, d, now);
    expect(res).toMatchObject({ claimed: 0, alreadyClaimed: true });
    expect(d.updateConnection).toHaveBeenCalledWith("c1", expect.objectContaining({ qoderLastClaimCredits: 0 }));
  });

  it("keeps the day open when the account has no daily campaign yet", async () => {
    // The window opens at 10:00 (UTC+8): a tick before that must not burn the
    // day, so no day stamp is written and the next tick tries again.
    const d = deps({ claim: vi.fn(async () => ({ ok: true, claimed: 0, credits: 0, dailySeen: false })) });
    const now = new Date("2026-05-01T08:00:00").getTime();
    const res = await claimConnection(conn, d, now);
    expect(res).toMatchObject({ claimed: 0, noCampaign: true });
    const patch = d.updateConnection.mock.calls[0][1];
    expect(patch.qoderLastClaimDate).toBeUndefined();
    expect(patch.qoderLastClaimStatus).toBe("no-campaign");
  });

  it("reports that the day's grant went to another account of the same person", async () => {
    const d = deps({
      claim: vi.fn(async () => ({ ok: true, claimed: 0, credits: 0, alreadyClaimed: true, creditedElsewhere: true })),
    });
    const now = new Date("2026-05-01T10:00:00").getTime();
    const res = await claimConnection(conn, d, now);
    expect(res).toMatchObject({ claimed: 0, alreadyClaimed: true, creditedElsewhere: true });
    expect(d.updateConnection).toHaveBeenCalledWith("c1", expect.objectContaining({
      qoderLastClaimDate: localDayKey(now),
      qoderLastClaimStatus: "claimed-elsewhere",
    }));
  });

  it("only claims opted-in connections", async () => {
    const d = deps({ getSettings: async () => ({ qoderAutoSignin: { connections: { other: true } } }) });
    const summary = await runQoderAutoSigninTick(d, { running: false, failureCache: {} }, Date.now());
    expect(summary.checked).toBe(0);
    expect(d.claim).not.toHaveBeenCalled();
  });

  it("reads the opt-in map, honouring the global off switch", () => {
    expect([...enabledConnectionIds({ qoderAutoSignin: { connections: { a: true, b: false } } })]).toEqual(["a"]);
    expect(enabledConnectionIds({ qoderAutoSignin: { enabled: false, connections: { a: true } } }).size).toBe(0);
  });
});
