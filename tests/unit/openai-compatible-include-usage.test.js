/**
 * #3283 — OpenAI-compatible chat endpoints only send the usage trailer (and with it
 * prompt_tokens_details.cached_tokens) when the request asks for it, so 9router had no
 * way to see a cache hit and fell back to token estimation: inflated token counts and
 * cached_tokens 0 on every turn, which makes a cache hit look like a miss.
 * Ask for include_usage in every streaming request from an openai-compatible executor.
 */
import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const credentials = { apiKey: "sk-test" };

describe("DefaultExecutor stream_options.include_usage", () => {
  it("asks for usage on streaming openai-compatible requests", () => {
    const executor = new DefaultExecutor("openai-compatible-chat");
    const output = executor.transformRequest("gpt-4o", { stream: true, messages: [{ role: "user", content: "Reply" }] }, true, credentials);

    expect(output.stream).toBe(true);
    expect(output.stream_options).toEqual({ include_usage: true });
  });

  it("keeps a client-present stream_options when include_usage is true", () => {
    const executor = new DefaultExecutor("openai-compatible-chat");
    const output = executor.transformRequest("gpt-4o", { stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Reply" }] }, true, credentials);

    expect(output.stream_options).toEqual({ include_usage: true });
  });

  it("does nothing for non-streaming requests", () => {
    const executor = new DefaultExecutor("openai-compatible-chat");
    const output = executor.transformRequest("o4o", { stream: false, messages: [{ role: "user", content: "Reply" }] }, false, credentials);

    expect(output.stream).toBe(false);
    expect(output.stream_options).toBeUndefined();
  });

  it("does nothing for non-openai-compatible providers", () => {
    const executor = new DefaultExecutor("anthropic");
    const output = executor.transformRequest("claude-sonnet-4-2", { stream: true, messages: [{ role: "user", content: "Reply" }] }, true, credentials);

    expect(output.stream_options).toBeUndefined();
  });
});
