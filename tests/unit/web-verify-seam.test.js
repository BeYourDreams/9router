import { describe, it, expect, vi, beforeEach } from "vitest";

// Seam check: throttledExecute is the single choke point every bare-HTTP
// web-cookie response passes, and the verify popup must be hooked there — a
// per-executor hook is the hook a future provider forgets.

vi.mock("open-sse/services/webAutoVerify.js", async (importOriginal) => ({
  ...(await importOriginal()),
  maybeOpenVerifyWindow: vi.fn(() => false),
}));

const { throttledExecute } = await import("open-sse/services/webThrottleGuard.js");
const { maybeOpenVerifyWindow } = await import("open-sse/services/webAutoVerify.js");
const { resetWebThrottles } = await import("open-sse/services/webRequestThrottle.js");

const executor403 = {
  execute: async () => ({
    response: new Response('{"error":{"message":"rate limited (captcha)"}}', { status: 403 }),
    url: "",
    headers: {},
    transformedBody: {},
  }),
};

const args = {
  provider: "doubao-web",
  connectionId: "c1",
  credentials: { apiKey: "sessionid=a" },
  log: undefined,
};

describe("captcha → verify window seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A 403 penalises the bucket for 60s; without this the next case waits on
    // the throttle and measures pacing, not this seam.
    resetWebThrottles();
  });

  it("offers the window on a challenged 403", async () => {
    const { response } = await throttledExecute(executor403, args);
    expect(response.status).toBe(403);
    expect(maybeOpenVerifyWindow).toHaveBeenCalledTimes(1);
    expect(maybeOpenVerifyWindow.mock.calls[0][0].provider).toBe("doubao-web");
  });

  it("asks the service on a clean 200 — and the service declines by status", async () => {
    // The seam forwards every result; the status decision lives in
    // webAutoVerify.verifyReason, tested there. One seam, one rule set.
    const ok = { ...executor403, execute: async () => ({ response: new Response("{}", { status: 200 }) }) };
    await throttledExecute(ok, args);
    expect(maybeOpenVerifyWindow).toHaveBeenCalledTimes(1);
  });

  it("covers browser-driven (SELF_PACED) providers too", async () => {
    const gemini = { ...executor403, execute: async () => ({ response: new Response("captcha", { status: 403 }) }) };
    await throttledExecute(gemini, { ...args, provider: "gemini-web" });
    expect(maybeOpenVerifyWindow).toHaveBeenCalledTimes(1);
  });

  it("does not delay the response while the window path exists", async () => {
    const slow = { ...executor403, execute: async () => ({ response: new Response("captcha", { status: 403 }) }) };
    const started = Date.now();
    await throttledExecute(slow, args);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
