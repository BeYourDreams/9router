// Timing behaviour of the web throttle.
//
// The throttle reads its limits at module load, so this file sets the env vars
// FIRST and then imports the module fresh — that is the only way to exercise
// non-default pacing without mutating shared state.

process.env.WEB_THROTTLE_MIN_INTERVAL_MS = "50";
process.env.WEB_THROTTLE_BURST = "2";
process.env.WEB_THROTTLE_RESET_MS = "200";
process.env.WEB_THROTTLE_MAX_CONCURRENT = "1";

const { acquireWebSlot, resetWebThrottles, webThrottleStats } = await import(
  "open-sse/services/webRequestThrottle.js"
);

import { describe, it, expect, beforeEach } from "vitest";

beforeEach(() => resetWebThrottles());

describe("web throttle pacing timing", () => {
  it("spaces requests at least minIntervalMs apart", async () => {
    const key = "conn:spacing";
    const stamps = [];
    for (let i = 0; i < 4; i++) {
      const { release } = await acquireWebSlot(key);
      stamps.push(Date.now());
      release();
    }
    for (let i = 1; i < stamps.length; i++) {
      const gap = stamps[i] - stamps[i - 1];
      expect(gap).toBeGreaterThanOrEqual(30); // allow timer jitter, reject "no wait"
    }
  });

  it("allows a burst of 2 instantly, then paces the rest", async () => {
    const key = "conn:burst";
    const t0 = Date.now();
    const a = await acquireWebSlot(key); a.release();
    const b = await acquireWebSlot(key); b.release();
    const burstMs = Date.now() - t0;
    // The burst two are free (the first waits nothing; the second only the
    // min-interval), so both land fast.
    expect(burstMs).toBeLessThan(400);

    const c = await acquireWebSlot(key); c.release();
    const d = await acquireWebSlot(key); d.release();
    const stats = webThrottleStats(key);
    // Post-burst requests waited, and the throttle recorded that.
    expect(stats.throttled).toBeGreaterThan(0);
    expect(stats.waitedMs).toBeGreaterThan(0);
  });

  it("never lets concurrency exceed maxConcurrent", async () => {
    const key = "conn:concurrency";
    let peak = 0;
    let current = 0;
    const job = async () => {
      const { release } = await acquireWebSlot(key);
      current++;
      peak = Math.max(peak, current);
      await new Promise((r) => setTimeout(r, 10));
      current--;
      release();
    };
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(1);
  });

  it("counts only requests that actually waited as throttled", async () => {
    const key = "conn:counting";
    const first = await acquireWebSlot(key);
    expect(first.waitedMs).toBe(0);
    first.release();
    const later = await acquireWebSlot(key);
    expect(later.waitedMs).toBeGreaterThan(0);
    later.release();

    const stats = webThrottleStats(key);
    expect(stats.total).toBe(2);
    expect(stats.throttled).toBe(1);
  });
});
