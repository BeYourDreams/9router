// A combo mixes accounts per member, and account rotation happens one layer DOWN
// (chat.js loops connections inside a single member attempt). Parking a member for
// 60s after a 5xx / timeout / exception therefore also hides that member's other,
// healthy accounts: the next request filters the member out before ever selecting a
// connection. Only a failure that names its own recovery window — or a dead
// credential — may park a member.
import { describe, expect, it, vi } from "vitest";

import { handleComboChat, resetComboModelCooldowns } from "../../open-sse/services/combo.js";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

const ok = () => json({ choices: [{ message: { content: "served" } }] });
const fail = (status, message = "boom") => json({ error: { message } }, status);

async function run(models, handleSingleModel) {
  resetComboModelCooldowns();
  const first = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models, handleSingleModel: vi.fn(handleSingleModel), log: silentLog, comboStrategy: "fallback",
  });
  // Second request: is the failed member still attempted?
  const calls = [];
  const probe = async (_b, m) => { calls.push(m); return ok(); };
  const second = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi again" }] },
    models, handleSingleModel: vi.fn(probe), log: silentLog, comboStrategy: "fallback",
  });
  return { first, secondCalls: calls };
}

const PAIR = ["provider-a/model-a", "provider-b/model-b"];

describe("combo member parking", () => {
  it("does not park a member that returned a transient 5xx", async () => {
    const { secondCalls } = await run(PAIR, (_b, m) =>
      m === PAIR[0] ? fail(503, "Service Unavailable") : ok());
    expect(secondCalls).toEqual([PAIR[0]]);   // retried → its 2nd account gets a chance
  });

  it("does not park a member that threw", async () => {
    const { secondCalls } = await run(PAIR, (_b, m) => {
      if (m === PAIR[0]) throw new Error("socket hang up");
      return ok();
    });
    expect(secondCalls).toEqual([PAIR[0]]);
  });

  it("does not park on our own throttle queue giving up (429 + web_throttle_timeout)", async () => {
    const { secondCalls } = await run(PAIR, (_b, m) =>
      m === PAIR[0]
        ? json({ error: { message: "Web request throttled: waited 30s", code: "web_throttle_timeout" } }, 429)
        : ok());
    expect(secondCalls).toEqual([PAIR[0]]);
  });

  it("still parks a genuine rate limit so a saturated member is skipped", async () => {
    const { secondCalls } = await run(PAIR, (_b, m) =>
      m === PAIR[0] ? fail(429, "Too Many Requests") : ok());
    expect(secondCalls).toEqual([PAIR[1]]);   // parked → skipped
  });

  it("still parks a dead credential (401)", async () => {
    const { secondCalls } = await run(PAIR, (_b, m) =>
      m === PAIR[0] ? fail(401, "Invalid API key") : ok());
    expect(secondCalls).toEqual([PAIR[1]]);
  });

  it("honours an upstream-stated retryAfter even on a 5xx", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    const { secondCalls } = await run(PAIR, (_b, m) =>
      m === PAIR[0] ? json({ error: { message: "overloaded" }, retryAfter: until }, 503) : ok());
    expect(secondCalls).toEqual([PAIR[1]]);
  });

  it("no longer sleeps inside the request to 'wait out' a transient 503", async () => {
    const t0 = Date.now();
    await run(PAIR, (_b, m) => (m === PAIR[0] ? fail(502, "Bad Gateway") : ok()));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
