// Fallback strategy remembers the member that last answered so the next
// request keeps prompt cache warm. That pointer is now day-scoped: after local
// midnight the combo starts again from its own configured order, so a stuck
// member cannot own the combo forever.
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
    comboName: "daily",
    comboStrategy: "fallback",
  });
}

describe("combo fallback — order resets daily", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetComboRotation();
    resetComboModelCooldowns();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetComboRotation();
  });

  it("remembers within a day, then starts from the top the next day", async () => {
    vi.setSystemTime(new Date("2026-05-01T10:00:00"));

    // Day 1: first member rejects the request, second answers -> pointer = model-b.
    const day1 = vi.fn(async (_b, m) => (m === MODELS[0] ? requestScoped400() : ok()));
    expect((await run(day1)).status).toBe(200);
    expect(day1.mock.calls.map(([, m]) => m)).toEqual(MODELS);

    // Same day: the next request starts at the remembered member.
    const sameDay = vi.fn(async () => ok());
    expect((await run(sameDay)).status).toBe(200);
    expect(sameDay.mock.calls.map(([, m]) => m)).toEqual([MODELS[1]]);

    // Next day: pointer dropped, order is the combo's own again.
    vi.setSystemTime(new Date("2026-05-02T00:05:00"));
    const nextDay = vi.fn(async (_b, m) => (m === MODELS[0] ? requestScoped400() : ok()));
    expect((await run(nextDay)).status).toBe(200);
    expect(nextDay.mock.calls.map(([, m]) => m)).toEqual(MODELS);
  });
});
