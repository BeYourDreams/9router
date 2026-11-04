import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Look up the weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

/** Build the SSE body a web executor returns for one assistant turn. */
function sseBody(text) {
  const frames = [
    { id: "x", object: "chat.completion.chunk", created: 1, model: "xinghuo-web", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: "x", object: "chat.completion.chunk", created: 1, model: "xinghuo-web", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function collectSse(response) {
  const text = await response.text();
  const frames = text
    .split("\n\n")
    .filter((b) => b.startsWith("data: ") && !b.trim().endsWith("[DONE]"))
    .map((b) => {
      try {
        return JSON.parse(b.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { text, frames };
}

describe("chatCore × webToolBridge — webCookie tool calling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects the tool contract and promotes a text <tool> reply (streaming)", async () => {
    executeMock.mockImplementation(async ({ body }) => {
      // The executor must receive the injected contract rather than native tools.
      return {
        response: new Response(sseBody('<tool>{"name":"get_weather","arguments":{"city":"Paris"}}</tool>'), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
        url: "https://xinghuo.xfyun.cn/iflygpt-chat/u/chat_message/chat",
        headers: {},
        transformedBody: body,
      };
    });

    const result = await handleChatCore({
      body: { model: "xinghuo-auto", stream: true, tools: TOOLS, messages: [{ role: "user", content: "weather in Paris?" }] },
      modelInfo: { provider: "xinghuo-web", model: "xinghuo-auto", format: "openai" },
      credentials: { apiKey: "SESSION=abc; ssoSessionId=def", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), errorLine: vi.fn() },
      connectionId: "test-conn",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
    });

    expect(result.success).toBe(true);

    // Request side: the executor's body carries the prompt contract, and the
    // native `tools` array is gone (the web UI cannot use it).
    const passedBody = executeMock.mock.calls[0][0].body;
    expect(passedBody.tools).toBeUndefined();
    const system = [...passedBody.messages].reverse().find((m) => m.role === "system");
    expect(system?.content).toContain("<tool>");
    expect(system?.content).toContain("get_weather");

    // Response side: the client sees a native tool turn.
    const { frames } = await collectSse(result.response);
    const toolFrame = frames.find((f) => f.choices?.[0]?.delta?.tool_calls);
    expect(toolFrame, "client receives tool_calls").toBeTruthy();
    expect(toolFrame.choices[0].delta.tool_calls[0].function.name).toBe("get_weather");
    expect(frames.at(-1).choices[0].finish_reason).toBe("tool_calls");
    const content = frames.map((f) => f.choices?.[0]?.delta?.content || "").join("");
    expect(content).not.toContain("<tool>");
  });

  it("leaves a provider that implements its own tools untouched", async () => {
    executeMock.mockImplementation(async ({ body }) => ({
      response: new Response(sseBody("plain answer"), { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://example.test",
      headers: {},
      transformedBody: body,
    }));

    await handleChatCore({
      body: { model: "grok-web", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "grok-web", model: "grok-web", format: "openai" },
      credentials: { apiKey: "x", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), errorLine: vi.fn() },
      connectionId: "test-conn",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
    });

    // grok-web handles tools itself, so chatCore must not strip/mutate `tools`.
    const passedBody = executeMock.mock.calls[0][0].body;
    expect(passedBody.tools).toEqual(TOOLS);
  });
});
