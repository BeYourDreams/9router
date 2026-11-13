// The "Auto check-in" master switch on the quota page: one toggle turns the
// daily check-in on (or off) for every eligible MiniMax Code / CodeBuddy /
// ModelScope connection at once, and the per-day gate holds after an off→on
// round-trip so nothing is claimed twice in one local day.
import { describe, expect, it, vi } from "vitest";

import { isAutoSigninEligible } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { getAutoSigninConfigForProvider } from "../../src/shared/constants/config.js";
import {
  summarizeAutoSignin,
  buildAutoSigninPatch,
} from "../../src/shared/services/autoSigninBulk.js";
import { checkinConnection as checkinMinimax, localDayKey } from "../../src/shared/services/minimaxAutoSignin.js";
import { checkinConnection as checkinCodebuddy } from "../../src/shared/services/codebuddyAutoSignin.js";
import { loginConnection as checkinModelscope } from "../../src/shared/services/modelscopeAutoSignin.js";

const CONNS = [
  { id: "mm-cn", provider: "minimax-code", authType: "oauth" },
  { id: "mm-global", provider: "minimax-code-global", authType: "oauth" },
  { id: "mm-lease", provider: "minimax-code", authType: "mcode-lease" },
  { id: "cb-cn", provider: "codebuddy-cn", authType: "oauth" },
  { id: "cb-intl", provider: "codebuddy-intl", authType: "apikey" },
  { id: "ms", provider: "modelscope", authType: "apikey" },
  // Not check-in eligible / not belonging to a check-in family.
  { id: "cb-inactive", provider: "codebuddy-cn", authType: "oauth", isActive: false },
  { id: "ms-wrong-auth", provider: "modelscope", authType: "oauth" },
  { id: "claude", provider: "claude", authType: "oauth" },
];

const SETTINGS = {
  minimaxAutoSignin: { connections: { "mm-cn": true } },
  codebuddyAutoSignin: {},
  modelscopeAutoSignin: { enabled: true, connections: {} },
};

describe("auto check-in eligibility", () => {
  it("maps a provider back to its check-in family", () => {
    expect(getAutoSigninConfigForProvider("minimax-code-global").settingsKey).toBe("minimaxAutoSignin");
    expect(getAutoSigninConfigForProvider("codebuddy-intl").settingsKey).toBe("codebuddyAutoSignin");
    expect(getAutoSigninConfigForProvider("modelscope").settingsKey).toBe("modelscopeAutoSignin");
    expect(getAutoSigninConfigForProvider("claude")).toBeNull();
  });

  it("only counts providers + auth types that can actually claim", () => {
    const eligible = CONNS.filter(isAutoSigninEligible).map((c) => c.id);
    expect(eligible).toEqual(["mm-cn", "mm-global", "mm-lease", "cb-cn", "cb-intl", "ms"]);
  });

  it("rolls the opt-in map into on / partial / off", () => {
    expect(summarizeAutoSignin(CONNS, SETTINGS)).toMatchObject({ total: 6, optedIn: 1, on: false, partial: true });
    expect(summarizeAutoSignin(CONNS, {})).toMatchObject({ total: 6, optedIn: 0, on: false, partial: false });
    const allOn = buildAutoSigninPatch(CONNS, SETTINGS, true);
    expect(summarizeAutoSignin(CONNS, allOn)).toMatchObject({ total: 6, optedIn: 6, on: true, partial: false });
  });

  it("builds one PATCH that flips every eligible connection, leaving others alone", () => {
    const on = buildAutoSigninPatch(CONNS, SETTINGS, true);
    expect(Object.keys(on).sort()).toEqual([
      "codebuddyAutoSignin",
      "minimaxAutoSignin",
      "modelscopeAutoSignin",
    ]);
    expect(on.minimaxAutoSignin.connections).toEqual({ "mm-cn": true, "mm-global": true, "mm-lease": true });
    expect(on.codebuddyAutoSignin.connections).toEqual({ "cb-cn": true, "cb-intl": true });
    expect(on.modelscopeAutoSignin.connections).toEqual({ ms: true });
    expect(on.codebuddyAutoSignin.enabled).toBe(true);

    const off = buildAutoSigninPatch(CONNS, on, false);
    for (const cfg of Object.values(off)) {
      expect(Object.values(cfg.connections).every((v) => v === false)).toBe(true);
    }
    expect(summarizeAutoSignin(CONNS, off)).toMatchObject({ optedIn: 0, on: false, partial: false });
  });

  it("reaches accounts beyond the first page (the paginated-view bug)", () => {
    // The dashboard holds one 20-row page. The server fan-out must still flip
    // every eligible account in the full table, not just the visible slice.
    const many = Array.from({ length: 45 }, (_, i) => ({
      id: `mm-${i}`,
      provider: "minimax-code",
      authType: "oauth",
    }));
    const pageOne = many.slice(0, 20);
    // What the old client-side code did — only the visible page.
    expect(Object.keys(buildAutoSigninPatch(pageOne, {}, true).minimaxAutoSignin.connections)).toHaveLength(20);
    // What the server endpoint does — the whole table.
    const full = buildAutoSigninPatch(many, {}, true);
    expect(Object.keys(full.minimaxAutoSignin.connections)).toHaveLength(45);
    expect(summarizeAutoSignin(many, full)).toMatchObject({ total: 45, optedIn: 45, on: true });
    // And the roll-up the page displays is the server one, which sees all 45.
    expect(summarizeAutoSignin(many, full).total).toBeGreaterThan(pageOne.length);
  });

  it("skips families the page has no eligible connection for", () => {
    const onlyModelscope = CONNS.filter((c) => c.provider === "modelscope");
    const patch = buildAutoSigninPatch(onlyModelscope, {}, true);
    expect(Object.keys(patch)).toEqual(["modelscopeAutoSignin"]);
    expect(buildAutoSigninPatch([], {}, true)).toEqual({});
  });
});

describe("a day is claimed at most once, even after toggling off and on", () => {
  const now = new Date(2026, 0, 5, 10, 0).getTime();
  const today = localDayKey(now);
  const deps = (signin) => ({
    resolveConnectionProxyConfig: async () => ({}),
    refreshAndUpdateCredentials: async (c) => ({ connection: c }),
    signin,
    updateConnection: vi.fn(async () => ({})),
  });

it("MiniMax: a sealed day is not re-polled", async () => {
    const signin = vi.fn();
    const r = await checkinMinimax(
      { id: "x", provider: "minimax-code", minimaxLastSigninDate: today, minimaxLastSigninDone: true },
      deps(signin),
      now,
    );
    expect(r.skipped).toBe("already-claimed-today");
    expect(signin).not.toHaveBeenCalled();
  });

  it("MiniMax: an unsealed day is retried within the same local day", async () => {
    // A date without the seal means nothing was claimed, so the hour tick must
    // try again instead of skipping the whole day.
    const signin = vi.fn(async () => ({ ok: true, claimed: true, points: 400 }));
    const r = await checkinMinimax(
      { id: "x", provider: "minimax-code", minimaxLastSigninDate: today, minimaxLastSigninDone: false },
      deps(signin),
      now,
    );
    expect(signin).toHaveBeenCalledTimes(1);
    expect(r.claimed).toBe(true);
  });

  it("CodeBuddy: a sealed day is not re-polled", async () => {
    const signin = vi.fn();
    const r = await checkinCodebuddy(
      { id: "y", provider: "codebuddy-cn", codebuddyLastSigninDate: today, codebuddyLastSigninDone: true },
      deps(signin),
      now,
    );
    expect(r.skipped).toBe("already-claimed-today");
    expect(signin).not.toHaveBeenCalled();
  });

  it("ModelScope: a touched day is not re-polled", async () => {
    const signin = vi.fn();
    const r = await checkinModelscope(
      { id: "z", provider: "modelscope", modelscopeLastLoginDate: today, modelscopeLastLoginDone: false },
      deps(signin),
      now,
    );
    expect(r.skipped).toBe("already-logged-in-today");
    expect(signin).not.toHaveBeenCalled();
  });

  it("a new local day does claim again", async () => {
    const signin = vi.fn(async () => ({ ok: true, claimed: true, points: 400 }));
    const today0 = localDayKey(now);
    const yesterday = localDayKey(now - 24 * 60 * 60 * 1000);
    expect(yesterday).not.toBe(today0);
    const r = await checkinMinimax(
      { id: "x", provider: "minimax-code", minimaxLastSigninDate: yesterday, minimaxLastSigninDone: true },
      deps(signin),
      now,
    );
    expect(signin).toHaveBeenCalledTimes(1);
    expect(r.claimed).toBe(true);
  });
});

// ─── New accounts default to ON ──────────────────────────────────────────────
import {
  buildDefaultOptInPatch,
  optInNewConnection,
  backfillDefaultOptIns,
} from "../../src/shared/services/autoSigninDefaults.js";

describe("new connections opt into check-in by default", () => {
  const fresh = { id: "new-cb", provider: "codebuddy-cn", authType: "oauth" };

  it("opts a brand-new eligible connection in", () => {
    expect(buildDefaultOptInPatch(fresh, {})).toEqual({
      codebuddyAutoSignin: { connections: { "new-cb": true } },
    });
  });

  it("keeps the rest of the family config intact", () => {
    const patch = buildDefaultOptInPatch(fresh, {
      codebuddyAutoSignin: { enabled: true, connections: { old: false }, schedules: { x: 1 } },
    });
    expect(patch.codebuddyAutoSignin.connections).toEqual({ old: false, "new-cb": true });
    expect(patch.codebuddyAutoSignin.schedules).toEqual({ x: 1 });
  });

  it("never overrides an explicit choice already on record", () => {
    expect(buildDefaultOptInPatch(fresh, { codebuddyAutoSignin: { connections: { "new-cb": false } } })).toBeNull();
    expect(buildDefaultOptInPatch(fresh, { codebuddyAutoSignin: { connections: { "new-cb": true } } })).toBeNull();
  });

  it("does not opt in when the whole family was switched off", () => {
    expect(buildDefaultOptInPatch(fresh, { codebuddyAutoSignin: { enabled: false, connections: {} } })).toBeNull();
  });

  it("ignores ineligible connections and non-check-in providers", () => {
    expect(buildDefaultOptInPatch({ id: "a", provider: "modelscope", authType: "oauth" }, {})).toBeNull();
    expect(buildDefaultOptInPatch({ id: "b", provider: "claude", authType: "oauth" }, {})).toBeNull();
    expect(buildDefaultOptInPatch({ id: "c", provider: "codebuddy-cn", authType: "oauth", isActive: false }, {})).toBeNull();
  });

  it("persists through the injected deps and survives a throwing update", async () => {
    const updateSettings = vi.fn(async (p) => p);
    const patch = await optInNewConnection(fresh, { getSettings: async () => ({}), updateSettings });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(patch.codebuddyAutoSignin.connections["new-cb"]).toBe(true);

    const boom = await optInNewConnection(fresh, {
      getSettings: async () => ({}),
      updateSettings: async () => { throw new Error("db down"); },
    });
    expect(boom).toBeNull(); // best-effort: creation must not fail
  });
});

describe("startup backfill for accounts that predate the default", () => {
  it("fills only the gaps, leaving explicit choices alone", async () => {
    const connections = [
      { id: "mm1", provider: "minimax-code", authType: "oauth" },        // no entry → on
      { id: "mm2", provider: "minimax-code", authType: "oauth" },        // explicit off → stays off
      { id: "cb1", provider: "codebuddy-cn", authType: "oauth" },       // no entry → on
      { id: "ms1", provider: "modelscope", authType: "apikey" },        // family switched off → untouched
    ];
    const settings = {
      minimaxAutoSignin: { connections: { mm2: false } },
      modelscopeAutoSignin: { enabled: false, connections: {} },
    };
    const updateSettings = vi.fn(async (p) => ({ ...settings, ...p }));
    const patch = await backfillDefaultOptIns({
      getSettings: async () => settings,
      getProviderConnections: async () => connections,
      updateSettings,
    });
    expect(patch.minimaxAutoSignin.connections).toEqual({ mm2: false, mm1: true });
    expect(patch.codebuddyAutoSignin.connections).toEqual({ cb1: true });
    expect(patch.modelscopeAutoSignin).toBeUndefined();
  });

  it("is idempotent — a second run patches nothing", async () => {
    const connections = [{ id: "mm1", provider: "minimax-code", authType: "oauth" }];
    let stored = {};
    const deps = {
      getSettings: async () => stored,
      getProviderConnections: async () => connections,
      updateSettings: async (p) => (stored = { ...stored, ...p }),
    };
    expect(await backfillDefaultOptIns(deps)).not.toBeNull();
    expect(await backfillDefaultOptIns(deps)).toBeNull();
  });
});
