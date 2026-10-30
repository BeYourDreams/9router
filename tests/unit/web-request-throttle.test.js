import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  webThrottleKey,
  acquireWebSlot,
  withWebThrottle,
  reportWebThrottleSignal,
  webThrottleStats,
  resetWebThrottles,
  WEB_THROTTLE_LIMITS,
} from "open-sse/services/webRequestThrottle.js";
import {
  isWebCookieProvider,
  shouldThrottleWebProvider,
  throttledExecute,
  WEB_COOKIE_PROVIDERS,
  SELF_PACED,
} from "open-sse/services/webThrottleGuard.js";

// The throttle reads its limits at MODULE LOAD (env → const), so tests that
// want different limits must set env and re-import. These tests exercise the
// DEFAULT behaviour and the pure seams (key derivation, signal reporting,
// guard selection), which is what matters for correctness of wiring.

const JWT_A = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LUEifQ.sigA";
const JWT_B = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LUIifQ.sigB";

beforeEach(() => {
  resetWebThrottles();
  vi.useRealTimers();
});
afterEach(() => {
  resetWebThrottles();
  vi.restoreAllMocks();
});

describe("throttle key derivation", () => {
  it("keys on the CONNECTION id when present (one row = one account)", () => {
    expect(webThrottleKey({ connectionId: "conn-1", provider: "intern-web", credentials: { apiKey: JWT_A } }))
      .toBe("conn:conn-1");
  });

  it("gives different connections separate budgets", () => {
    const a = webThrottleKey({ connectionId: "conn-1", provider: "grok-web", credentials: {} });
    const b = webThrottleKey({ connectionId: "conn-2", provider: "grok-web", credentials: {} });
    expect(a).not.toBe(b);
  });

  it("gives different accounts of the SAME provider separate budgets", () => {
    const a = webThrottleKey({ provider: "grok-web", credentials: { apiKey: JWT_A } });
    const b = webThrottleKey({ provider: "grok-web", credentials: { apiKey: JWT_B } });
    expect(a).not.toBe(b);
  });

  it("falls back to a hashed credential when no connection id, and never stores the raw credential", () => {
    const key = webThrottleKey({ provider: "grok-web", credentials: { apiKey: JWT_A } });
    expect(key.startsWith("cred:grok-web:")).toBe(true);
    expect(key).not.toContain(JWT_A);
    expect(key.length).toBeLessThan(60);
  });

  it("is stable for the same inputs", () => {
    const k1 = webThrottleKey({ provider: "grok-web", credentials: { apiKey: JWT_A } });
    const k2 = webThrottleKey({ provider: "grok-web", credentials: { apiKey: JWT_A } });
    expect(k1).toBe(k2);
  });
});

describe("slot acquisition", () => {
  it("releases the concurrency slot exactly once even when released twice", async () => {
    const key = "conn:release-test";
    const s1 = await acquireWebSlot(key);
    expect(webThrottleStats(key).inFlight).toBe(1);
    s1.release();
    s1.release(); // idempotent, must not go negative
    expect(webThrottleStats(key).inFlight).toBe(0);
  });

  it("serialises concurrent callers instead of letting them all fire at once", async () => {
    const key = "conn:serialise";
    const order = [];
    WEB_THROTTLE_LIMITS;
    const run = async (n) => {
      const { release } = await acquireWebSlot(key);
      order.push(`start${n}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end${n}`);
      release();
    };
    await Promise.all([run(1), run(2), run(3)]);
    // With maxConcurrent=1 a start must always be followed by its own end
    // before another start appears.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe(`start${order[i].slice(5)}`);
      expect(order[i + 1]).toBe(`end${order[i].slice(5)}`);
    }
  });

  it("a rejected waiter does not poison the queue for later callers", async () => {
    const key = "conn:poison";
    const { release } = await acquireWebSlot(key);
    // Hold the slot and force a rejection by asking for a zero wait budget.
    await expect(
      withWebThrottle(key, async () => "ok", {}),
    ).resolves.toBeDefined;
    release();
    // The key must still be usable afterwards.
    const again = await acquireWebSlot(key);
    expect(again).toBeTruthy();
    again.release();
  });
});

describe("throttle signal reporting", () => {
  it("treats 429 and 403 as throttle signals", () => {
    const key = "conn:signal";
    expect(reportWebThrottleSignal(key, { status: 429 })).toBe(true);
    resetWebThrottles();
    expect(reportWebThrottleSignal(key, { status: 403 })).toBe(true);
  });

  it("detects a Cloudflare challenge that arrives as HTTP 200", () => {
    const key = "conn:challenge";
    const body = "<html><body>Checking your browser before accessing</body></html>";
    expect(reportWebThrottleSignal(key, { status: 200, bodyText: body })).toBe(true);
  });

  it("ignores ordinary success and unrelated errors", () => {
    const key = "conn:no-signal";
    expect(reportWebThrottleSignal(key, { status: 200, bodyText: "hello" })).toBe(false);
    expect(reportWebThrottleSignal(key, { status: 500 })).toBe(false);
    expect(reportWebThrottleSignal(key, { status: 401 })).toBe(false);
  });

  it("drains the burst budget after a throttle signal", () => {
    const key = "conn:drain";
    const before = webThrottleStats(key);
    expect(before).toBe(null);
    reportWebThrottleSignal(key, { status: 429 });
    const stats = webThrottleStats(key);
    expect(stats.tokens).toBe(0);
    expect(stats.penaltyLevel).toBe(1);
    expect(stats.penalised).toBe(true);
  });

  it("caps the penalty level so it cannot escalate forever", async () => {
    const key = "conn:cap";
    for (let i = 0; i < 50; i++) reportWebThrottleSignal(key, { status: 429 });
    const stats = webThrottleStats(key);
    expect(stats.penaltyLevel).toBeLessThanOrEqual(4);
  });

  it("records a signal even for a key it has never seen (first response can be the 429)", () => {
    // Regression: this used to return false for an unknown key, so the very
    // first throttle an account hit was discarded and pacing stayed at full
    // speed — the account kept hammering into the ban it was trying to avoid.
    expect(reportWebThrottleSignal("conn:ghost", { status: 429 })).toBe(true);
    expect(webThrottleStats("conn:ghost").penaltyLevel).toBe(1);
  });

  it("does not report a signal for a non-throttle status on a new key", () => {
    expect(reportWebThrottleSignal("conn:quiet", { status: 200 })).toBe(false);
  });
});

describe("withWebThrottle", () => {
  it("reports the signal from a throttled response via statusOf", async () => {
    const key = "conn:statusof";
    const result = await withWebThrottle(
      key,
      async () => ({ response: { status: 429 } }),
      { statusOf: (r) => r?.response?.status },
    );
    expect(result.response.status).toBe(429);
    expect(webThrottleStats(key).penaltyLevel).toBe(1);
  });

  it("releases the slot when fn throws (no leaked concurrency)", async () => {
    const key = "conn:throw";
    await expect(
      withWebThrottle(key, async () => { throw new Error("boom"); }, {}),
    ).rejects.toThrow("boom");
    expect(webThrottleStats(key).inFlight).toBe(0);
  });

  it("returns the fn result untouched on success", async () => {
    const key = "conn:ok";
    const result = await withWebThrottle(key, async () => ({ response: { status: 200 } }), {
      statusOf: (r) => r?.response?.status,
    });
    expect(result.response.status).toBe(200);
    expect(webThrottleStats(key).penaltyLevel).toBe(0);
  });
});

describe("webThrottleGuard provider selection", () => {
  it("knows every registry webCookie provider", () => {
    for (const id of ["grok-web", "gemini-web", "chatgpt-web", "deepseek-web", "intern-web", "qwen-web"]) {
      expect(isWebCookieProvider(id)).toBe(true);
    }
    expect(WEB_COOKIE_PROVIDERS.size).toBeGreaterThan(5);
  });

  it("does NOT throttle API-key providers (they have real quotas + 429s)", () => {
    for (const id of ["openai", "anthropic", "openrouter", "groq", "deepseek"]) {
      expect(isWebCookieProvider(id)).toBe(false);
      expect(shouldThrottleWebProvider(id)).toBe(false);
    }
  });

  it("throttles non-browser web providers", () => {
    for (const id of ["grok-web", "chatgpt-web", "deepseek-web", "intern-web"]) {
      expect(shouldThrottleWebProvider(id)).toBe(true);
    }
  });

  it("exempts browser-driven providers that are already paced by DOM waits", () => {
    for (const id of ["gemini-web", "muse-web", "qwen-web", "chatglm-web", "uc-web"]) {
      expect(isWebCookieProvider(id)).toBe(true);       // they ARE web providers
      expect(shouldThrottleWebProvider(id)).toBe(false); // but not throttled
      expect(SELF_PACED.has(id)).toBe(true);
    }
  });
});

describe("throttledExecute", () => {
  function makeExecutor(provider, result) {
    return { execute: vi.fn(async () => result) };
  }

  it("passes non-web providers straight through untouched", async () => {
    const exec = makeExecutor("openai", { response: new Response("{}", { status: 200 }) });
    const out = await throttledExecute(exec, {
      provider: "openai", credentials: {}, connectionId: "c1", body: {}, log: null,
    });
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(200);
  });

  it("wraps a web provider and still returns its result", async () => {
    const exec = makeExecutor("grok-web", { response: new Response("{}", { status: 200 }) });
    const out = await throttledExecute(exec, {
      provider: "grok-web", credentials: { apiKey: JWT_A }, connectionId: "c1", body: {}, log: null,
    });
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(200);
  });

  it("forwards every argument the executor needs (provider + connectionId included)", async () => {
    const exec = makeExecutor("grok-web", { response: new Response("{}", { status: 200 }) });
    const args = {
      provider: "grok-web", connectionId: "c9", credentials: { apiKey: JWT_A },
      model: "grok-4", body: { messages: [] }, stream: true, log: null,
    };
    await throttledExecute(exec, args);
    const passed = exec.execute.mock.calls[0][0];
    for (const k of ["provider", "connectionId", "credentials", "model", "body", "stream"]) {
      expect(passed[k]).toEqual(args[k]);
    }
  });

  it("surfaces a throttle timeout as 429 so existing fallback machinery handles it", async () => {
    const exec = {
      execute: vi.fn(async () => {
        const err = new Error("pacing saturated");
        err.code = "WEB_THROTTLE_TIMEOUT";
        throw err;
      }),
    };
    const out = await throttledExecute(exec, {
      provider: "grok-web", credentials: { apiKey: JWT_A }, connectionId: "c1", body: {}, log: null,
    });
    expect(out.response.status).toBe(429);
    const json = await out.response.json();
    expect(json.error.type).toBe("rate_limit_error");
  });

  it("rethrows non-throttle errors (does not mask real bugs)", async () => {
    const exec = { execute: vi.fn(async () => { throw new Error("upstream exploded"); }) };
    await expect(
      throttledExecute(exec, {
        provider: "grok-web", credentials: {}, connectionId: "c1", body: {}, log: null,
      }),
    ).rejects.toThrow("upstream exploded");
  });

  it("does not let a browser-driven provider get double-paced", async () => {
    const exec = makeExecutor("gemini-web", { response: new Response("{}", { status: 200 }) });
    await throttledExecute(exec, {
      provider: "gemini-web", credentials: {}, connectionId: "c1", body: {}, log: null,
    });
    expect(exec.execute).toHaveBeenCalledTimes(1);
  });
});
