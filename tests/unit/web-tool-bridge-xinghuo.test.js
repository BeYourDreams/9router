import { describe, it, expect } from "vitest";
import { executeXinghuoWeb } from "open-sse/executors/xinghuo-web/adapter.js";
import { prepareToolMessages } from "open-sse/translator/webTools.js";
import { wrapResponseWithWebToolBridge } from "open-sse/utils/webToolBridge.js";

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

/** Minimal upstream: accept the chat-create call, then stream one answer turn. */
function makeFetchImpl(answerText) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes("create-chat-list")) {
      return new Response(JSON.stringify({ code: 0, data: { id: 4242 } }), { status: 200 });
    }
    const frames = [
      { event: "message", content: answerText },
      { event: "done", finishReason: "stop" },
    ]
      .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f)}\n\n`)
      .join("");
    return new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  return { fetchImpl, calls };
}

const credentials = { apiKey: "SESSION=abc; ssoSessionId=def" };

describe("xinghuo-web × webToolBridge — end to end", () => {
  it("sends the tool contract to the upstream prompt", async () => {
    const { fetchImpl, calls } = makeFetchImpl("no tools needed");
    const body = { model: "xinghuo-auto", tools: TOOLS, messages: [{ role: "user", content: "What is the weather in Paris?" }] };
    const prepared = prepareToolMessages(body, body.messages);

    await executeXinghuoWeb({
      input: { body: { ...body, messages: prepared.effectiveMessages }, credentials },
      fetchImpl,
    });

    // The chat turn is the multipart POST; its `text` field must carry the reminder.
    const chatCall = calls.find((c) => String(c.url).includes("chat_message/chat"));
    expect(chatCall).toBeTruthy();
    expect(String(chatCall.options.body)).toContain("Client protocol reminder");
    expect(String(chatCall.options.body)).toContain("get_weather");
  });

  it("promotes a text <tool> reply into tool_calls", async () => {
    const envelope = '<tool>{"name":"get_weather","arguments":{"city":"Paris"}}</tool>';
    const { fetchImpl } = makeFetchImpl(envelope);
    const result = await executeXinghuoWeb({
      input: { body: { model: "xinghuo-auto", messages: [{ role: "user", content: "weather?" }] }, credentials },
      fetchImpl,
    });

    // Executor alone streams prose with finish_reason:"stop".
    const rawBridged = result.response;
    const bridged = wrapResponseWithWebToolBridge(rawBridged, { requestedTools: TOOLS });
    const text = await bridged.text();

    const frames = text
      .split("\n\n")
      .filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"))
      .map((b) => JSON.parse(b.slice(6)));

    const toolFrame = frames.find((f) => f.choices?.[0]?.delta?.tool_calls);
    expect(toolFrame, "a tool_calls frame is emitted").toBeTruthy();
    const call = toolFrame.choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe("get_weather");
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "Paris" });
    expect(frames.at(-1).choices[0].finish_reason).toBe("tool_calls");

    // The raw envelope must not have been delivered as assistant prose.
    const content = frames.map((f) => f.choices?.[0]?.delta?.content || "").join("");
    expect(content).not.toContain("<tool>");
  });

  it("keeps a normal answer as plain content ending in stop", async () => {
    const { fetchImpl } = makeFetchImpl("It is sunny in Paris.");
    const result = await executeXinghuoWeb({
      input: { body: { model: "xinghuo-auto", messages: [{ role: "user", content: "weather?" }] }, credentials },
      fetchImpl,
    });
    const text = await wrapResponseWithWebToolBridge(result.response, { requestedTools: TOOLS }).text();
    const frames = text
      .split("\n\n")
      .filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"))
      .map((b) => JSON.parse(b.slice(6)));
    expect(frames.map((f) => f.choices?.[0]?.delta?.content || "").join("")).toBe("It is sunny in Paris.");
    expect(frames.at(-1).choices[0].finish_reason).toBe("stop");
  });
});
