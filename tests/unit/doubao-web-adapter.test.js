import { describe, expect, it } from "vitest";
import {
  buildRequestBody,
  frameToText,
  frameError,
  resolveCookieHeader,
  executeDoubaoWeb,
} from "open-sse/executors/doubao-web/adapter.js";

// Frames lifted verbatim from a captured /chat/completion stream.
const SSE = [
  "id: 0\nevent: SSE_HEARTBEAT\ndata: {}\n\n",
  'id: 0\nevent: SSE_ACK\ndata: {"query_list":[{"message_index":1}]}\n\n',
  'id: 0\nevent: STREAM_MSG_NOTIFY\ndata: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"阳光"}},"is_finish":false}]}}\n\n',
  'id: 0\nevent: STREAM_CHUNK\ndata: {"message_id":"1","patch_op":[{"patch_object":1,"patch_type":1,"patch_value":{"content_block":[{"content":{"text_block":{"text":"里"}},"is_finish":false}]}}]}\n\n',
  'id: 0\nevent: STREAM_CHUNK\ndata: {"message_id":"1","patch_op":[{"patch_object":111,"patch_type":1,"patch_value":{"tts_content":"里"}}]}\n\n',
  'id: 0\nevent: CHUNK_DELTA\ndata: {"text":"的蓝光"}\n\n',
  'id: 0\nevent: CHUNK_DELTA\ndata: {"text":"更容易散射"}\n\n',
  'id: 0\nevent: STREAM_CHUNK\ndata: {"message_id":"1","patch_op":[{"patch_object":1,"patch_type":1,"patch_value":{"content_block":[{"content":{"text_block":{}},"is_finish":true}]}}]}\n\n',
  'id: 1\nevent: SSE_REPLY_END\ndata: {"end_type":1}\n\n',
  'id: 2\nevent: SSE_REPLY_END\ndata: {"end_type":2}\n\n',
  'id: 3\nevent: SSE_REPLY_END\ndata: {"end_type":3}\n\n',
].join("");

async function fakeFetch(url, opts) {
  fakeFetch.last = { url, opts };
  return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const input = {
  body: { model: "doubao-fast", messages: [{ role: "user", content: "天空为什么是蓝的" }] },
  credentials: { apiKey: "sessionid=abc123; sid_tt=abc123; ttwid=xyz" },
};

describe("doubao-web adapter", () => {
  it("builds the minimal valid uplink body (bot_id + fresh conversation)", () => {
    const body = buildRequestBody({ messages: input.body.messages, model: "doubao-fast" });
    expect(body.client_meta.bot_id).toBeTruthy();
    expect(body.client_meta.conversation_id).toBe("");
    expect(body.option.need_create_conversation).toBe(true);
    expect(body.option.conversation_init_ext.model_item_key).toBe("0");
    expect(body.messages[0].content_block[0].content.text_block.text).toBe("天空为什么是蓝的");
  });

  it("replays multi-turn history as one request", () => {
    const msgs = [
      { role: "user", content: "暗号是紫罗兰" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "暗号是什么" },
    ];
    const body = buildRequestBody({ messages: msgs, model: "doubao-expert" });
    expect(body.messages).toHaveLength(3);
    expect(body.option.model_config.model_item_key).toBe("3");
  });

  it("parses text deltas and skips tts patches", () => {
    expect(frameToText("CHUNK_DELTA", '{"text":"hi"}')).toBe("hi");
    expect(frameToText("STREAM_CHUNK", '{"patch_op":[{"patch_object":1,"patch_value":{"content_block":[{"content":{"text_block":{"text":"里"}}}]}}]}')).toBe("里");
    expect(frameToText("STREAM_CHUNK", '{"patch_op":[{"patch_object":111,"patch_value":{"tts_content":"里"}}]}')).toBe("");
  });

  it("recognizes the risk-control STREAM_ERROR inside a 200", () => {
    const err = frameError('{"error_code":710022004,"error_msg":"rate limited","extra":{"decision":"{\\"type\\":\\"verify\\"}"}}');
    expect(err).toMatchObject({ code: 710022004, needsVerify: true });
  });

  it("accepts cookie header, JSON array and storage-state credentials", () => {
    expect(resolveCookieHeader({ apiKey: "sessionid=a; x=1" })).toBe("sessionid=a; x=1");
    expect(resolveCookieHeader({ apiKey: 'Cookie: sessionid=a' })).toBe("sessionid=a");
    expect(resolveCookieHeader({ apiKey: '[{"name":"sessionid","value":"a","domain":".doubao.com"}]' })).toBe("sessionid=a");
    expect(resolveCookieHeader({ apiKey: '{"cookies":[{"name":"sessionid","value":"a","domain":".doubao.com"}]}' })).toBe("sessionid=a");
    expect(resolveCookieHeader({ apiKey: "" })).toBe("");
  });

  it("streams OpenAI chunks built from the captured SSE", async () => {
    const { response } = await executeDoubaoWeb({ input, fetchImpl: fakeFetch });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("阳光");
    expect(text).toContain("的蓝光");
    expect(text.match(/"tts_content"/g)).toBe(null);
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("does not replay the stale anti-bot signatures", async () => {
    await executeDoubaoWeb({ input, fetchImpl: fakeFetch });
    expect(fakeFetch.last.url).not.toMatch(/msToken|a_bogus/);
    expect(fakeFetch.last.opts.headers.Cookie).toContain("sessionid=abc123");
  });

  it("surfaces the verify challenge as a retryable error, not an empty 200", async () => {
    const limited = new Response('id: 0\nevent: STREAM_ERROR\ndata: {"error_code":710022004,"error_msg":"rate limited","extra":{"decision":"{\\"type\\":\\"verify\\"}"}}\n\nid: 1\nevent: SSE_REPLY_END\ndata: {"end_type":3}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    await expect(
      executeDoubaoWeb({ input, fetchImpl: async () => limited })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("fails loudly without a cookie instead of hitting the endpoint", async () => {
    await expect(
      executeDoubaoWeb({ input: { ...input, credentials: {} }, fetchImpl: fakeFetch })
    ).rejects.toMatchObject({ status: 401 });
  });
});
