// The caps are only useful if they land on the child env and stay inside a
// machine that has other things running on it.
import { describe, it, expect } from "vitest";
import { buildLimits } from "../../scripts/build-server.mjs";

const env = (o = {}) => ({ ...o });
const GB = 1024 ** 3;

describe("buildLimits", () => {
  it("caps heap and keeps one core free by default (memory is the failure mode)", () => {
    const { heapMb, jobs } = buildLimits(env(), 16 * GB, 8);
    expect(heapMb).toBe(6553);          // ~40% of 16GB
    expect(jobs).toBe(7);               // cores-1: always leave one physical core free
  });

  it("never drops below one job even on a single-core box", () => {
    expect(buildLimits(env(), 16 * GB, 1).jobs).toBe(1);
  });

  it("never exceeds 8GB of heap no matter how much RAM the box has", () => {
    expect(buildLimits(env(), 128 * GB, 32).heapMb).toBe(8192);
  });

  it("keeps a floor of 2GB heap so a small box still finishes", () => {
    expect(buildLimits(env(), 2 * GB, 1).heapMb).toBe(2048);
  });

  it("honours explicit overrides", () => {
    const l = buildLimits(env({ NINEROUTER_BUILD_HEAP_MB: "3000", NINEROUTER_BUILD_JOBS: "2" }), 16 * GB, 8);
    expect(l).toEqual({ heapMb: 3000, jobs: 2 });
  });

  it("NINEROUTER_BUILD_MEM=0 lifts every cap", () => {
    expect(buildLimits(env({ NINEROUTER_BUILD_MEM: "0" }), 16 * GB, 8)).toBeNull();
  });

  it("ignores garbage env values instead of setting --max-old-space-size=NaN", () => {
    const l = buildLimits(env({ NINEROUTER_BUILD_HEAP_MB: "abc", NINEROUTER_BUILD_JOBS: "0" }), 16 * GB, 8);
    expect(Number.isFinite(l.heapMb)).toBe(true);
    expect(l.jobs).toBe(7);
  });
});
