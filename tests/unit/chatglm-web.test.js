/**
 * chatglm-web adapter: no browser involved.
 *
 * Covers the two behaviours that broke the old browser path:
 *  - a turn runs on plain fetch (guest token minted on demand)
 *  - a new conversation opens with conversation_id "" and later turns echo the
 *    id upstream issued (upstream answers 200 + EMPTY stream otherwise)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { executeChatGLMWebCleanRoom } from "../../open-sse/executors/chatglm-web/adapter.js";

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const jwt = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;

function frame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sse(text, conversationId) {
  return new Response(
    frame({ conversation_id: conversationId, status: "init", parts: [] }) +
      frame({
        conversation_id: conversationId,
        status: "init",
        parts: [
          { id: "p1", role: "assistant", content: [{ type: "text", text: text.slice(0, 1) }] },
        ],
      }) +
      frame({
        conversation_id: conversationId,
        status: "init",
        parts: [
          { id: "p1", role: "assistant", content: [{ type: "text", text }] },
        ],
      }) +
      frame({ conversation_id: conversationId, status: "finish" }) +
      "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

async function readAll(stream) {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
  return out;
}

function stubUpstream(streamBodies) {
  global.fetch = vi.fn(async (url, init) => {
    if (String(url).endsWith("/guest/access")) {
      return new Response(JSON.stringify({ result: { access_token: jwt } }), { status: 200 });
    }
    streamBodies.push(JSON.parse(init.body));
    return streamBodies.length === 1 ? sse("你好", "conv-1") : sse("还在", "conv-1");
  });
}

const credentials = { connectionId: "conn-1" };
const body = { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] };

describe("chatglm-web adapter", () => {
  it("streams a turn over plain fetch and reuses the upstream conversation id", async () => {
    const bodies = [];
    stubUpstream(bodies);

    const first = await readAll((await executeChatGLMWebCleanRoom({ body, credentials })).body);
    expect(first).toContain('"content":"你"');
    expect(first).toContain('"content":"好"');
    expect(first).toContain('"finish_reason":"stop"');
    expect(first).toContain("data: [DONE]");
    expect(bodies[0].conversation_id).toBe("");

    await readAll((await executeChatGLMWebCleanRoom({ body, credentials })).body);
    expect(bodies[1].conversation_id).toBe("conv-1");
  });

  it("returns a real Response so the handler sees ok/status", async () => {
    stubUpstream([]);
    const res = await executeChatGLMWebCleanRoom({ body, credentials });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("falls back to a guest session when the pasted token is dead", async () => {
    let streamCalls = 0;
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/guest/access")) {
        return new Response(JSON.stringify({ result: { access_token: jwt } }), { status: 200 });
      }
      streamCalls++;
      return streamCalls === 1 ? new Response("expired", { status: 401 }) : sse("OK", "conv-9");
    });

    const res = await executeChatGLMWebCleanRoom({
      body,
      credentials: { apiKey: "chatglm_token=stale.abc.def", connectionId: "conn-3" },
    });
    const out = await readAll(res.body);
    expect(streamCalls).toBe(2);
    expect(out).toContain('"content":"O"');
  });

  it("throws instead of streaming nothing when upstream returns an empty body", async () => {
    global.fetch = vi.fn(async (url) =>
      String(url).endsWith("/guest/access")
        ? new Response(JSON.stringify({ result: { access_token: jwt } }), { status: 200 })
        : new Response("", { status: 200 })
    );
    await expect(
      executeChatGLMWebCleanRoom({ body, credentials: { connectionId: "conn-2" } })
    ).rejects.toThrow(/empty stream/);
  });
});
