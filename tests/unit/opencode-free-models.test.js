import { describe, it, expect } from "vitest";
import {
  OPENCODE_FREE_PROVIDER_IDS,
  isFreeModelId,
  collectFreeModelIds,
} from "@/shared/utils/freeModelIds.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";

// One-click "Enable Free Models" on the four OpenCode lanes must add exactly the
// free tier: every "-free" id (plus the ones upstream never suffixes), nothing paid.
describe("freeModelIds", () => {
  it("covers the four OpenCode lanes, each backed by a registry catalogue", () => {
    expect(OPENCODE_FREE_PROVIDER_IDS).toEqual([
      "opencode",
      "opencode-free-v2",
      "opencode-zen",
      "opencode-zen-v2",
    ]);
    // PROVIDER_MODELS is keyed by alias, so resolve the lane first.
    for (const id of OPENCODE_FREE_PROVIDER_IDS) {
      const alias = PROVIDER_ID_TO_ALIAS[id] || id;
      expect(PROVIDER_MODELS, "registry missing " + id).toHaveProperty(alias);
    }
  });

  it("treats the -free suffix and the unsuffixed id as free", () => {
    expect(isFreeModelId("iceman-free")).toBe(true);
    expect(isFreeModelId("big-pickle")).toBe(true);
    expect(isFreeModelId("deepseek-v4-flash")).toBe(false);
    // Upstream dead — never re-enabled by the bulk action
    expect(isFreeModelId("deepseek-v4-flash-free")).toBe(false);
    expect(isFreeModelId("muse-spark-1.3")).toBe(false);
    expect(isFreeModelId("free")).toBe(false);
    expect(isFreeModelId("")).toBe(false);
    expect(isFreeModelId(undefined)).toBe(false);
  });

  it("collects free models from picker-shaped groups and skips other lanes", () => {
    const groups = {
      opencode: {
        models: [
          { id: "muse-spark-1.2-contributor-free", value: "oc/muse-spark-1.2-contributor-free" },
          { id: "big-pickle", value: "oc/big-pickle" },
          { id: "jev-1.13-free", value: "oc/jev-1.13-free" },
        ],
      },
      "opencode-free-v2": {
        models: [
          { id: "iceman-free", value: "ocfv2/iceman-free" },
          // Upstream dead id — must never be re-enabled by the bulk action
          { id: "deepseek-v4-flash-free", value: "ocfv2/deepseek-v4-flash-free" },
          { id: "gpt-5.5", value: "ocfv2/gpt-5.5" },
        ],
      },
      "opencode-zen": {
        models: [{ id: "claude-opus-4-8", value: "ocz/claude-opus-4-8" }],
      },
      "opencode-go": {
        models: [{ id: "space-bunny-free", value: "ocg/space-bunny-free" }],
      },
      cursor: {
        models: [{ id: "some-free", value: "cursor/some-free" }],
      },
    };

    const all = collectFreeModelIds(groups);
    expect(all.map((m) => m.value)).toEqual([
      "oc/muse-spark-1.2-contributor-free",
      "oc/big-pickle",
      "oc/jev-1.13-free",
      "ocfv2/iceman-free",
      "ocg/space-bunny-free",
      "cursor/some-free",
    ]);
    expect(all.some((m) => m.id === "deepseek-v4-flash-free")).toBe(false);

    // The OpenCode lanes only: the subscription lane (ocg) carries no free tier.
    const lanes = collectFreeModelIds(groups, OPENCODE_FREE_PROVIDER_IDS);
    expect(lanes.map((m) => m.value)).toEqual([
      "oc/muse-spark-1.2-contributor-free",
      "oc/big-pickle",
      "oc/jev-1.13-free",
      "ocfv2/iceman-free",
    ]);
  });

  it("keeps the static lanes\' free models discoverable", () => {
    // opencode-zen-v2 ships an empty catalogue and rides the live feed, so only
    // the lanes with static rows are asserted.
    for (const id of ["opencode", "opencode-free-v2", "opencode-zen"]) {
      const alias = PROVIDER_ID_TO_ALIAS[id] || id;
      const freeIds = (PROVIDER_MODELS[alias] || []).filter((m) => isFreeModelId(m.id)).map((m) => m.id);
      expect(freeIds.length, "no free model in " + id).toBeGreaterThan(0);
    }
    expect(PROVIDER_MODELS["oczv2"].length).toBe(0);
  });
});