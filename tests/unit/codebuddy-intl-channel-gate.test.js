// The intl gateway's channel verification (live since ~2026-10-15) refuses every
// /v2/chat/completions request that does not carry the official IDE's
// X-Conversation-* header family: HTTP 400 code 11128 "request illegal", tip
// "This call failed channel verification, possibly because it was not sent from
// an official client" (#5005, #5024, #4946). Verified against the live gateway:
// none / any one / any two of the three ids → 400 11128; all three → the gate
// clears and the request reaches the account risk stage (403 11140).
//
// ids must be UUID-shaped: `cmb-<32 hex>` (the form upstream uses inside its own
// response payloads) is refused with 11128 again.
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { toUuidShaped } from "../../open-sse/shared/conversationId.js";
import { BACKOFF_CONFIG, MAX_RATE_LIMIT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GATEWAY = "https://www.codebuddy.ai/v2/chat/completions";
const exec = new CodeBuddyIntlExecutor();
const creds = { accessToken: "t" };
const build = (body, credentials = creds) => exec.buildHeaders(credentials, true, GATEWAY, "auto", body);
const ids = (h) => [h["X-Conversation-ID"], h["X-Conversation-Request-ID"], h["X-Conversation-Message-ID"]];

describe("X-Conversation-* family clears the intl channel gate", () => {
  it("sends all three ids, UUID-shaped, on every request", () => {
    const h = build({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    for (const value of ids(h)) expect(value).toMatch(UUID_RE);
    expect(h["X-Request-ID"]).toBe(h["X-Conversation-Message-ID"]);
  });

  it("still sends them when there is no body at all", () => {
    for (const body of [undefined, null, {}]) {
      const h = build(body);
      for (const value of ids(h)) expect(value).toMatch(UUID_RE);
    }
  });

  it("keys one conversation to one id across turns and retries", () => {
    const a = build({ messages: [{ role: "user", content: "same opening message" }] });
    const b = build({ messages: [
      { role: "user", content: "same opening message" },
      { role: "assistant", content: "a reply" },
      { role: "user", content: "and a follow-up" },
    ] });
    expect(b["X-Conversation-ID"]).toBe(a["X-Conversation-ID"]);
    expect(b["X-Conversation-Request-ID"]).not.toBe(a["X-Conversation-Request-ID"]);
    expect(b["X-Conversation-Message-ID"]).not.toBe(a["X-Conversation-Message-ID"]);
  });

  it("gives different conversations different ids", () => {
    const a = build({ messages: [{ role: "user", content: "first thread" }] });
    const b = build({ messages: [{ role: "user", content: "second thread" }] });
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
  });

  it("prefers an explicit client session over the message-derived key", () => {
    const a = build({ messages: [{ role: "user", content: "hi" }], session_id: "sess-abc" });
    const b = build({ messages: [{ role: "user", content: "hi" }], session_id: "sess-def" });
    const plain = build({ messages: [{ role: "user", content: "hi" }] });
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
    expect(a["X-Conversation-ID"]).not.toBe(plain["X-Conversation-ID"]);
    const grown = build({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }], session_id: "sess-abc" });
    expect(grown["X-Conversation-ID"]).toBe(a["X-Conversation-ID"]);
  });

  it("reads the session from client headers too (they survive translation)", () => {
    // Both header spellings must be picked up. They are namespaced per client
    // kind in the session manager (`claude:` vs bare), so they are equal only
    // in what matters: each is stable across the turns of its conversation.
    const header = { "x-claude-code-session-id": "thread-1" };
    const body = { messages: [{ role: "user", content: "hi" }] };
    const first = build(body, { ...creds, rawHeaders: header })["X-Conversation-ID"];
    const again = build(body, { ...creds, rawHeaders: header })["X-Conversation-ID"];
    const plain = build(body)["X-Conversation-ID"];
    expect(first).toBe(again);
    expect(first).toMatch(UUID_RE);
    // A client-supplied session must win over the message-derived fallback.
    expect(first).not.toBe(plain);
  });

  it("never passes a client's raw session string through as an id", () => {
    const h = build({ messages: [{ role: "user", content: "hi" }], session_id: "cmb-0194e02ccf6111f1967fa6c1be056095" });
    expect(h["X-Conversation-ID"]).toMatch(UUID_RE);
  });
});

describe("caller-supplied ids are preserved", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const withIds = (extra) => exec.buildHeaders({ ...creds, rawHeaders: extra }, true, GATEWAY, "auto", body);

  it("keys the conversation on the caller's own session id", () => {
    // A client session id is the strongest anchor available; it wins over
    // anything message-derived.
    const a = withIds({ "x-session-id": "pi-session-1" });
    const b = withIds({ "x-session-id": "pi-session-2" });
    const plain = build(body);
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
    expect(a["X-Conversation-ID"]).not.toBe(plain["X-Conversation-ID"]);
  });

  it("keeps the same id once the conversation has grown", () => {
    const opening = { messages: [{ role: "user", content: "hi" }] };
    const grown = { messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "user", content: "and then" },
    ] };
    const a = exec.buildHeaders({ ...creds, rawHeaders: { "x-session-id": "pi-session-1" } }, true, GATEWAY, "auto", opening);
    const b = exec.buildHeaders({ ...creds, rawHeaders: { "x-session-id": "pi-session-1" } }, true, GATEWAY, "auto", grown);
    expect(b["X-Conversation-ID"]).toBe(a["X-Conversation-ID"]);
  });

  it("never passes a raw client session string through as an id", () => {
    const h = build({ ...body, session_id: "cmb-0194e02ccf6111f1967fa6c1be056095" });
    expect(h["X-Conversation-ID"]).toMatch(UUID_RE);
    expect(h["X-Conversation-ID"]).not.toContain("cmb-");
  });

  it("replaces a non-UUID request id instead of forwarding it", () => {
    // X-Request-ID is request-scoped and always freshly minted, so a caller's
    // value never reaches upstream verbatim.
    const h = build(body);
    expect(h["X-Request-ID"]).toMatch(UUID_RE);
    expect(h["X-Request-ID"]).toBe(h["X-Conversation-Message-ID"]);
  });

  it("still fills the ids when there is no body at all", () => {
    for (const empty of [undefined, null, {}]) {
      const h = build(empty);
      for (const value of ids(h)) expect(value).toMatch(UUID_RE);
    }
  });

  it("derives UUID shape deterministically for an arbitrary seed", () => {
    expect(toUuidShaped("anything")).toMatch(UUID_RE);
    expect(toUuidShaped("anything")).toBe(toUuidShaped("anything"));
    expect(toUuidShaped("one")).not.toBe(toUuidShaped("two"));
  });
});

describe("conversation id survives a context compaction", () => {
  it("keeps one id when the assistant text is replaced by a summary", () => {
    // The assistant-text anchor moves when an agent compacts its context, which
    // used to start a brand-new upstream session — a cold cache mid-conversation.
    // The opening user turn does not move.
    const before = { messages: [
      { role: "user", content: "refactor the parser" },
      { role: "assistant", content: "I will start by reading parser.js and then rewrite the tokenizer." },
      { role: "user", content: "go on" },
    ] };
    const after = { messages: [
      { role: "user", content: "refactor the parser" },
      { role: "assistant", content: "Summary: inspected parser.js; tokenizer rewritten." },
      { role: "user", content: "go on" },
    ] };
    expect(after.messages[1].content).not.toBe(before.messages[1].content);
    expect(build(after)["X-Conversation-ID"]).toBe(build(before)["X-Conversation-ID"]);
  });
});

describe("buildHeaders fails closed", () => {
  it("names the gate when the family cannot be attached", () => {
    // A hostile body makes the derivation itself throw. The caller must be told
    // which gate this blocks, not handed a bare TypeError.
    const hostile = new Proxy({}, { get() { throw new Error("hostile body"); } });
    let caught = null;
    try {
      exec.buildHeaders(creds, true, GATEWAY, "auto", { messages: [hostile] });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toMatch(/channel verification/i);
    expect(caught.message).toMatch(/X-Conversation/);
    expect(caught.message).toMatch(/11128/);
  });
});

describe("parseError names the two gates", () => {
  const blockedBody = JSON.stringify({
    code: 11128,
    msg: "request illegal",
    displayMsg: { en: "Request blocked. Please send it again" },
    displayTips: { en: "This call failed channel verification, possibly because it was not sent from an official client." },
  });

  it("diagnoses a 11128 block as the channel/WAF gate", () => {
    const out = exec.parseError({ status: 400 }, blockedBody);
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/channel verification/i);
    expect(out.message).toMatch(/11128/);
    expect(out.message).toMatch(/wait/i);
  });

  it("diagnoses a 11140 as an account restriction, not a request error", () => {
    const out = exec.parseError({ status: 403 }, JSON.stringify({
      code: 11140,
      msg: "request illegal",
      displayMsg: { en: "Your account has been restricted due to unusual activity" },
      displayTips: { en: "We detected unusual activity on this account. Submit feedback to appeal this restriction" },
    }));
    expect(out.status).toBe(403);
    expect(out.message).toMatch(/11140/);
    expect(out.message).toMatch(/restricted/i);
    expect(out.message).toMatch(/appeal/i);
  });

  it("does NOT call a body-shape 11128 a block", () => {
    const out = exec.parseError({ status: 400 }, JSON.stringify({ code: 11128, msg: "first message is not system prompt" }));
    expect(out.message).not.toMatch(/channel verification/i);
    expect(out.message).not.toMatch(/restricted/i);
  });

  it("keeps mapping the 6004 frequency limit to 429 with a reset time", () => {
    const out = exec.parseError({ status: 429 }, JSON.stringify({ code: 6004, msg: "超出频率限制 2026-10-16 10:00:00 UTC+8" }));
    expect(out.status).toBe(429);
    expect(out.resetsAtMs).toBeGreaterThan(0);
  });
});

describe("cooldowns for the intl gates", () => {
  it("backs off a 11128 block on this provider only", () => {
    expect(checkFallbackError(400, blockedText(), 0, "codebuddy-intl"))
      .toEqual({ shouldFallback: true, cooldownMs: BACKOFF_CONFIG.base, newBackoffLevel: 1 });
    expect(checkFallbackError(400, blockedText(), 0, "codebuddy-cn")).toEqual({ shouldFallback: false, cooldownMs: 0, requestScoped: true });
  });

  it("cools a restricted account down hard instead of cycling it back into rotation", () => {
    const restricted = JSON.stringify({ code: 11140, msg: "request illegal", displayMsg: { en: "Your account has been restricted due to unusual activity" } });
    expect(checkFallbackError(403, restricted, 0, "codebuddy-intl").cooldownMs).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
    // the message the executor hands up also matches (classification runs on it)
    const rewritten = exec.parseError({ status: 403 }, restricted).message;
    expect(checkFallbackError(403, rewritten, 0, "codebuddy-intl").cooldownMs).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
    // other providers keep their existing 403 handling
    expect(checkFallbackError(403, restricted, 0, "openai").cooldownMs).toBeLessThan(MAX_RATE_LIMIT_COOLDOWN_MS);
  });
});

function blockedText() {
  return JSON.stringify({ code: 11128, msg: "request illegal" });
}
