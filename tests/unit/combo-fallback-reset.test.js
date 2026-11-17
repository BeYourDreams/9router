// The combos page has a "reset fallback order" button. It must drop the sticky
// fallback pointer so the next request starts at the head of the combo's list
// again, instead of sticking to the member that answered last.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleComboChat, resetComboModelCooldowns, resetComboRotation } from "../../open-sse/services/combo.js";

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
});
