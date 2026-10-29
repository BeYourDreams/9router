import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { getExecutor } from "open-sse/executors/index.js";
import crypto from "node:crypto";

// Every upstream that keys its prompt cache on a per-conversation identifier must
// send the SAME id on every turn of that conversation. Minting a fresh id per
// request is invisible in the response — the call succeeds — but every turn is a
// cold cache, which is the difference between paying for incremental input and
// paying for the whole context every single request.
//
// This suite is the guard: it does not know which providers matter, it walks all
// of them and asserts the contract holds wherever such a header is emitted.
// Add an upstream here the moment it grows a conversation id.

// Header (or body field) → "conversation" means it must repeat across turns of
// one conversation; "request" means it must differ on every call.
const CONVERSATION_ID_HEADERS = [
  "X-Conversation-ID",      // CodeBuddy CN + intl
  "X-Mavis-Session-Id",     // MiniMax Code
  "x-session-id",           // Command Code
];

const REQUEST_SCOPED_HEADERS = [
  "X-Request-ID",
  "X-Conversation-Request-ID",
  "X-Conversation-Message-ID",
];

const CREDS = { accessToken: "TESTTOKEN", apiKey: null, connectionId: "conn-1" };

// One conversation, two turns. The second turn is a continuation (assistant has
// spoken), which is what a real multi-turn agent session looks like.
const turn = (extraAssistant, followUp) => ({
  messages: [
    { role: "user", content: "refactor the parser module" },
    ...(extraAssistant ? [{ role: "assistant", content: extraAssistant }] : []),
    ...(followUp ? [{ role: "user", content: followUp }] : []),
  ],
});

describe("prompt-cache continuity across all upstreams", () => {
  const providers = Object.keys(PROVIDERS).filter((id) => {
    try { return !!getExecutor(id); } catch { return false; }
  });

  it("finds providers to check", () => {
    expect(providers.length).toBeGreaterThan(0);
  });

  it("keeps every conversation-scoped id stable across turns", () => {
    const fresh = [];
    for (const id of providers) {
      try {
        const exec = getExecutor(id);
        const base = PROVIDERS[id].baseUrl;
        const first = exec.buildHeaders(CREDS, true, base, "auto", turn());
        const second = exec.buildHeaders(CREDS, true, base, "auto", turn("I read parser.js and rewrote the tokenizer.", "now add tests"));
        for (const key of CONVERSATION_ID_HEADERS) {
          if (first[key] === undefined) continue;
          if (second[key] !== first[key]) fresh.push(`${id}.${key}`);
        }
        for (const key of REQUEST_SCOPED_HEADERS) {
          if (first[key] === undefined) continue;
          if (second[key] === first[key]) fresh.push(`${id}.${key} (stale request id)`);
        }
      } catch {
        // No headers without live credentials: nothing to assert.
      }
    }
    expect(fresh, "these re-mint their conversation id every request → cold cache").toEqual([]);
  });
});

describe("conversation ids isolate conversations", () => {
  for (const id of ["codebuddy-intl", "codebuddy-cn"]) {
    it(`${id}: two different conversations get different ids`, () => {
      const exec = getExecutor(id);
      const a = exec.buildHeaders(CREDS, true, PROVIDERS[id].baseUrl, "auto", {
        messages: [{ role: "user", content: "totally different topic A" }],
      });
      const b = exec.buildHeaders(CREDS, true, PROVIDERS[id].baseUrl, "auto", {
        messages: [{ role: "user", content: "totally different topic B" }],
      });
      expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
    });
  }
});

describe("a client-supplied session id always wins", () => {
  it("derives the id from the caller's own session, not the connection", () => {
    const exec = getExecutor("codebuddy-intl");
    const body = { messages: [{ role: "user", content: "same opening" }] };
    const withSession = (sid) => exec
      .buildHeaders({ ...CREDS, rawHeaders: { "x-session-id": sid } }, true, PROVIDERS["codebuddy-intl"].baseUrl, "auto", body)
      ["X-Conversation-ID"];
    // Different caller sessions must not collapse onto one upstream session.
    expect(withSession("session-A")).not.toBe(withSession("session-B"));
    // But each stays stable for itself.
    expect(withSession("session-A")).toBe(withSession("session-A"));
  });

  it("never emits a raw, non-UUID conversation id upstream would reject", () => {
    const exec = getExecutor("codebuddy-intl");
    const h = exec.buildHeaders(CREDS, true, PROVIDERS["codebuddy-intl"].baseUrl, "auto", {
      messages: [{ role: "user", content: "hi" }],
      session_id: "cmb-0194e02ccf6111f1967fa6c1be056095",
    });
    expect(h["X-Conversation-ID"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("the shared resolver stays deterministic", () => {
  it("produces UUID-shaped output for any seed", async () => {
    const { toUuidShaped } = await import("open-sse/shared/conversationId.js");
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(toUuidShaped("abc")).toMatch(re);
    expect(toUuidShaped("abc")).toBe(toUuidShaped("abc"));
    expect(toUuidShaped("abc")).not.toBe(toUuidShaped("abd"));
    // Deterministic, not random — this is what makes restart recovery work.
    expect(toUuidShaped(crypto.randomUUID())).not.toBe(toUuidShaped(crypto.randomUUID()));
  });
});
