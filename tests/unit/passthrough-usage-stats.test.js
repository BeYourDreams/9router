// Streaming usage must come from the upstream trailer, not from the body-size
// estimate injected into the finish chunk for OpenAI-compatible clients.
import { describe, it, expect } from "vitest";

import { createSSEStream } from "../../open-sse/utils/stream.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (text, finish_reason = null) => ({
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content: text }, finish_reason }],
});
// Much larger than the real usage below, so an estimate cannot pass unnoticed.
const body = { messages: [{ role: "user", content: "x".repeat(4000) }] };

async function run(sseText, { close = true } = {}) {
  let completed = null;
  const stream = createSSEStream({
    mode: "passthrough",
    provider: "modelscope",
    model: "m",
    body,
    onStreamComplete: (_content, usage) => { completed = usage; },
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const read = (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      if (!close && out.includes("data: [DONE]")) break;
    }
    return out;
  })();
  await writer.write(enc.encode(sseText));
  if (close) await writer.close();
  const out = await read;
  reader.cancel().catch(() => {});
  writer.close().catch(() => {});
  return { completed, out };
}

describe("passthrough usage stats", () => {
  it("uses the real trailer that arrives after an estimated finish chunk", async () => {
    const { completed } = await run([
      sse(delta("hi")),
      sse(delta("", "stop")),
      sse({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } }),
      "data: [DONE]\n\n",
    ].join(""));

    expect(completed).toMatchObject({ prompt_tokens: 17, completion_tokens: 5 });
    expect(completed.estimated).toBeUndefined();
  });

  it("reads usage from a chunk whose empty delta is filtered out", async () => {
    const { completed } = await run([
      sse(delta("hi", "stop")),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 13, completion_tokens: 4 } }),
      "data: [DONE]\n\n",
    ].join(""));

    expect(completed).toMatchObject({ prompt_tokens: 13, completion_tokens: 4 });
  });

  it("finalizes at [DONE] even if the client never closes the stream", async () => {
    const { completed, out } = await run([
      sse(delta("hi", "stop")),
      sse({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ].join(""), { close: false });

    expect(out).toContain("data: [DONE]");
    expect(completed).toMatchObject({ prompt_tokens: 9, completion_tokens: 3 });
  });
});
