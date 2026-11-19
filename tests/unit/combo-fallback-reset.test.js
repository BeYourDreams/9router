// The combos page has a "reset fallback order" button. It must drop the sticky
// fallback pointer so the next request starts at the head of the combo's list
// again, instead of sticking to the member that answered last.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleComboChat, resetComboModelCooldowns, resetComboRotation } from "../../open-sse/services/combo.js";
// A second instance of the same module, as Next can produce in dev / per bundle.
import { resetComboRotation as resetFromOtherCopy } from "../../open-sse/services/combo.js?second-copy";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MODELS = ["provider-a/model-a", "provider-b/model-b"];

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
  status: 200,
  headers: { "content-type": "application/json" },
});
const requestScoped400 = () => new Response(JSON.stringify({ error: { message: "Request validation failed" } }), {
  status: 400,
  headers: { "content-type": "application/json" },
});

function run(handleSingleModel) {
  return handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models: MODELS,
    handleSingleModel,
    log: silentLog,
    comboName: "reset-me",
    comboStrategy: "fallback",
  });
}

describe("combo fallback — manual order reset", () => {
  beforeEach(() => {
    resetComboRotation();
    resetComboModelCooldowns();
  });
  afterEach(() => {
    resetComboRotation();
  });

  it("starts from the first model again after the order is reset", async () => {
    // model-a rejects the request, model-b answers -> pointer = model-b.
    const first = vi.fn(async (_b, m) => (m === MODELS[0] ? requestScoped400() : ok()));
    expect((await run(first)).status).toBe(200);
    expect(first.mock.calls.map(([, m]) => m)).toEqual(MODELS);

    // The next request sticks to the member that answered.
    const sticky = vi.fn(async () => ok());
    expect((await run(sticky)).status).toBe(200);
    expect(sticky.mock.calls.map(([, m]) => m)).toEqual([MODELS[1]]);

    // What the dashboard button calls.
    resetComboRotation("reset-me");

    const afterReset = vi.fn(async () => ok());
    expect((await run(afterReset)).status).toBe(200);
    expect(afterReset.mock.calls.map(([, m]) => m)).toEqual([MODELS[0]]);
  });

  it("drops every combo's order when no name is given (the Reset All button)", async () => {
    const failFirst = vi.fn(async (_b, m) => (m === MODELS[0] ? requestScoped400() : ok()));
    expect((await run(failFirst)).status).toBe(200);
    const sticky = vi.fn(async () => ok());
    expect((await run(sticky)).status).toBe(200);
    expect(sticky.mock.calls.map(([, m]) => m)).toEqual([MODELS[1]]);

    // No name = reset every combo (the dashboard's Reset All).
    resetComboRotation();

    const afterResetAll = vi.fn(async () => ok());
    expect((await run(afterResetAll)).status).toBe(200);
    expect(afterResetAll.mock.calls.map(([, m]) => m)).toEqual([MODELS[0]]);
  });

  it("clears member cooldowns, so the first model is really tried again", async () => {
    const rateLimited = () => new Response(JSON.stringify({
      error: { message: "slow down" },
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
    }), { status: 429, headers: { "content-type": "application/json" } });

    const first = vi.fn(async (_b, m) => (m === MODELS[0] ? rateLimited() : ok()));
    expect((await run(first)).status).toBe(200);

    // model-a is parked for a minute: skipping it is what made Reset All look broken.
    const parked = vi.fn(async () => ok());
    expect((await run(parked)).status).toBe(200);
    expect(parked.mock.calls.map(([, m]) => m)).toEqual([MODELS[1]]);

    resetComboRotation();

    const afterReset = vi.fn(async () => ok());
    expect((await run(afterReset)).status).toBe(200);
    expect(afterReset.mock.calls.map(([, m]) => m)).toEqual([MODELS[0]]);
  });

  it("shares state with a second copy of the module (the reset route vs the chat lane)", async () => {
    const failFirst = vi.fn(async (_b, m) => (m === MODELS[0] ? requestScoped400() : ok()));
    expect((await run(failFirst)).status).toBe(200);
    const sticky = vi.fn(async () => ok());
    expect((await run(sticky)).status).toBe(200);
    expect(sticky.mock.calls.map(([, m]) => m)).toEqual([MODELS[1]]);

    // A distinct module instance (dev HMR / a bundle carrying its own copy) must
    // clear the SAME store the chat lane reads.
    resetFromOtherCopy("reset-me");

    const afterReset = vi.fn(async () => ok());
    expect((await run(afterReset)).status).toBe(200);
    expect(afterReset.mock.calls.map(([, m]) => m)).toEqual([MODELS[0]]);
  });
});
