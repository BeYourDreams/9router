// Global model-request pacing: one FIFO queue, one request start per interval.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { acquireRequestPace, resetRequestPace } from "../../open-sse/services/requestPace.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";
import { acquireRequestPace as acquireFromOtherCopy } from "../../open-sse/services/requestPace.js?second-copy";

afterEach(() => resetRequestPace());

describe("global request pacing settings", () => {
  it("is enabled by default at 3 seconds", () => {
    expect(mergeWithDefaults({})).toMatchObject({ requestPaceEnabled: true, requestPaceSeconds: 3 });
  });

  it.each(["zh-CN", "zh-TW"])("ships the Chinese UI labels in %s", (locale) => {
    const translations = JSON.parse(readFileSync(
      new URL(`../../public/i18n/literals/${locale}.json`, import.meta.url),
      "utf-8"
    ));
    for (const key of [
      "Request Rate Limit",
      "Interval (seconds)",
      "Queue model requests globally — only one starts per interval",
      "Minimum spacing between two model requests",
    ]) {
      expect(translations[key], `${locale}: ${key}`).toEqual(expect.any(String));
      expect(translations[key].trim()).not.toBe("");
      expect(translations[key]).not.toBe(key);
    }
  });
});

describe("global request pacing", () => {
  it("spaces concurrent requests by the interval, in arrival order", async () => {
    const interval = 60;
    const starts = [];
    const waits = await Promise.all([0, 1, 2].map(async () => {
      const waited = await acquireRequestPace({ intervalMs: interval });
      starts.push(Date.now());
      return waited;
    }));
    expect(waits[0]).toBeLessThan(20);
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(interval - 5);
    }
  });

  it("does nothing when pacing is off", async () => {
    expect(await acquireRequestPace({})).toBe(0);
    expect(await acquireRequestPace({ intervalMs: 0 })).toBe(0);
    expect(await acquireRequestPace({ intervalMs: "nope" })).toBe(0);
  });

  it("shares one queue across copies of the module", async () => {
    await acquireRequestPace({ intervalMs: 80 });
    const waited = await acquireFromOtherCopy({ intervalMs: 80 });
    expect(waited).toBeGreaterThanOrEqual(60);
  });

  it("rejects an aborted waiter without poisoning the queue", async () => {
    const ac = new AbortController();
    const first = acquireRequestPace({ intervalMs: 60 });
    const second = acquireRequestPace({ intervalMs: 60, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    await first;
    expect(await acquireRequestPace({ intervalMs: 60 })).toBeGreaterThanOrEqual(0);
  });
});
