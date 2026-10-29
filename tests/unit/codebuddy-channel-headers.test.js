import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { getExecutor } from "open-sse/executors/index.js";

// The CodeBuddy gateways (CN + intl) run a per-request channel check. Without
// the official plugin's request/conversation identifiers upstream rejects the
// call with 400 / 11128 "request illegal" ("failed channel verification").
// These tests lock the header wiring so the ids cannot silently disappear.
const REQUIRED = [
  "X-Request-ID",
  "X-Conversation-ID",
  "X-Conversation-Request-ID",
  "X-Conversation-Message-ID",
];

const CREDS = { accessToken: "TESTTOKEN", apiKey: null };

function buildHeaders(id, body = {}) {
  const executor = getExecutor(id);
  return executor.buildHeaders(CREDS, true, PROVIDERS[id].baseUrl, "deepseek-v4.1-flash", body);
}

describe("codebuddy channel headers", () => {
  for (const id of ["codebuddy-intl", "codebuddy-cn"]) {
    describe(id, () => {
      it("registers the codebuddyHeaders hook", () => {
        expect(PROVIDERS[id]?.auth?.hooks).toContain("codebuddyHeaders");
      });

      it("sends the plugin request/conversation ids", () => {
        const headers = buildHeaders(id);
        for (const key of REQUIRED) {
          expect(typeof headers[key], `${id} must send ${key}`).toBe("string");
          expect(headers[key].length).toBeGreaterThan(0);
        }
      });

      it("reuses one request id across the request/conversation pair", () => {
        const headers = buildHeaders(id);
        expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
        expect(headers["X-Conversation-ID"]).not.toBe(headers["X-Conversation-Message-ID"]);
      });

      it("still applies the bearer token after the hook runs", () => {
        expect(buildHeaders(id).Authorization).toBe("Bearer TESTTOKEN");
      });

      it("issues fresh request ids per request but keeps one conversation id", () => {
        const body = { messages: [{ role: "user", content: "same conversation" }] };
        const a = buildHeaders(id, body);
        const b = buildHeaders(id, body);
        // Request-scoped: a retry must not be deduped upstream as a repeat call.
        expect(a["X-Request-ID"]).not.toBe(b["X-Request-ID"]);
        // Conversation-scoped: upstream keys its prompt cache on this, so a new
        // id per request is a cold cache on every turn.
        expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
      });

      it("keeps the conversation id across turns of one conversation", () => {
        const first = buildHeaders(id, { messages: [{ role: "user", content: "opening question" }] });
        const second = buildHeaders(id, { messages: [
          { role: "user", content: "opening question" },
          { role: "assistant", content: "an answer" },
          { role: "user", content: "a follow-up" },
        ] });
        expect(second["X-Conversation-ID"]).toBe(first["X-Conversation-ID"]);
      });

      it("gives different conversations different ids", () => {
        const a = buildHeaders(id, { messages: [{ role: "user", content: "first thread" }] });
        const b = buildHeaders(id, { messages: [{ role: "user", content: "second thread" }] });
        expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
      });

      it("prefers the client's own session id over the message-derived one", () => {
        const body = { messages: [{ role: "user", content: "hi" }] };
        const exec = getExecutor(id);
        const forSession = (sessionId) => exec
          .buildHeaders({ ...CREDS, rawHeaders: { "x-session-id": sessionId } }, true, PROVIDERS[id].baseUrl, "auto", body)
          ["X-Conversation-ID"];
        expect(forSession("pi-session-1")).not.toBe(forSession("pi-session-2"));
      });

      it("emits UUID-shaped ids", () => {
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        const headers = buildHeaders(id);
        for (const key of REQUIRED) expect(headers[key]).toMatch(uuid);
      });
    });
  }
});
