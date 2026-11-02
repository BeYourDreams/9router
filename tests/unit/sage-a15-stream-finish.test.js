import { describe, it, expect } from "vitest";
import { hasValuableContent, parseSSELine } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Sage-A1.5 (书生-A1.5) is a DeepSeek-style thinking model on an OpenAI-compatible
// endpoint: the terminal chunk carries finish_reason ON THE DELTA, not on
// choices[0]. Without the check, parseStream() drops the whole terminal frame,
// the client never receives the content nor the usage trailer (cached_tokens /
// cache hits), and every turn looks like a cold cache miss.
const finishChunk = {
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1793606300,
  model: "Sage-A1.5",
  choices: [{ index: 0, delta: { content: "hello", finish_reason: "stop" } }],
  usage: {
    prompt_tokens: 2298,
    completion_tokens: 20,
    total_tokens: 2318,
    prompt_tokens_details: { cached_tokens: 256 },
  },
};

describe("Sage-A1.5 (书生-A1.5) streaming finish chunk", () => {
  it("parses the terminal chunk and exposes its finish_reason + usage", () => {
    const parsed = parseSSELine(
      `data: ${JSON.stringify(finishChunk)}`,
      FORMATS.OPENAI,
    );
    expect(parsed.choices[0].delta.finish_reason).toBe("stop");
    expect(parsed.usage.prompt_tokens).toBe(2298);
    expect(parsed.usage.prompt_tokens_details?.cached_tokens).toBe(256);
  });

  it("marks that terminal chunk valuable", () => {
    const parsed = parseSSELine(
      `data: ${JSON.stringify(finishChunk)}`,
      FORMATS.OPENAI,
    );
    expect(hasValuableContent(parsed, FORMATS.OPENAI)).toBe(true);
  });

  it("accepts the standard finish_reason on choices[0] too", () => {
    const standard = {
      ...finishChunk,
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
    };
    expect(hasValuableContent(standard, FORMATS.OPENAI)).toBe(true);
  });

  it("still drops genuinely empty chunks", () => {
    expect(hasValuableContent({ choices: [{ index: 0, delta: {} }], usage: {} }, FORMATS.OPENAI)).toBe(false);
    expect(hasValuableContent({ choices: [{ index: 0, delta: { content: "" } }] }, FORMATS.OPENAI)).toBe(false);
    expect(hasValuableContent({ choices: [{ index: 0, delta: {} }] }, FORMATS.OPENAI)).toBe(false);
  });

  it("exits the loop on the [DONE] sentinel instead of the terminal frame", () => {
    expect(parseSSELine("data: [DONE]", FORMATS.OPENAI)).toEqual({ done: true });
  });
});
