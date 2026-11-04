import { describe, it, expect } from "vitest";
import { usesWebToolBridge, requestHasTools, SELF_HANDLED_TOOL_PROVIDERS } from "open-sse/utils/webToolPolicy.js";
import { prepareToolMessages } from "open-sse/translator/webTools.js";
import { PROVIDERS } from "open-sse/config/providers.js";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
];

describe("webToolPolicy — provider selection", () => {
  it("exposes category on PROVIDERS so webCookie providers are identifiable", () => {
    for (const id of ["xinghuo-web", "chatglm-web", "doubao-web", "yiyan-web", "yuanbao-web", "ling-web"]) {
      expect(PROVIDERS[id]?.category, `${id} should be webCookie`).toBe("webCookie");
    }
  });

  it("bridges webCookie providers without their own tool plumbing", () => {
    for (const id of ["xinghuo-web", "chatglm-web", "doubao-web", "yiyan-web", "yuanbao-web", "ling-web", "qwen-web", "xiaomimimo-web"]) {
      expect(usesWebToolBridge(id), id).toBe(true);
    }
  });

  it("opts out executors that already implement tools", () => {
    for (const id of SELF_HANDLED_TOOL_PROVIDERS) {
      expect(usesWebToolBridge(id), id).toBe(false);
    }
  });

  it("ignores non-webCookie providers", () => {
    for (const id of ["openai", "anthropic", "gemini", "deepseek", "unknown-provider"]) {
      expect(usesWebToolBridge(id), id).toBe(false);
    }
  });

  it("detects tools in the request body", () => {
    expect(requestHasTools({ tools: TOOLS })).toBe(true);
    expect(requestHasTools({ tools: [] })).toBe(false);
    expect(requestHasTools({})).toBe(false);
    expect(requestHasTools(null)).toBe(false);
  });
});

describe("webToolPolicy — request-side contract injection", () => {
  it("injects the contract and keeps a tool reminder on the last user turn", () => {
    const body = { tools: TOOLS, messages: [{ role: "user", content: "What is the weather in Paris?" }] };
    const prepared = prepareToolMessages(body, body.messages);

    expect(prepared.hasTools).toBe(true);
    // A system block carrying the contract is appended after the client messages.
    const system = prepared.effectiveMessages.at(-1);
    expect(system.role).toBe("system");
    expect(system.content).toContain("get_weather");
    expect(system.content).toContain("<tool>");
    // The last user turn keeps a short pointer so models that only read the
    // newest message still see the protocol.
    const user = prepared.effectiveMessages.find((m) => m.role === "user");
    expect(user.content).toContain("Client protocol reminder");
  });

  it("is a no-op when no tools are present", () => {
    const messages = [{ role: "user", content: "hi" }];
    const prepared = prepareToolMessages({ messages }, messages);
    expect(prepared.hasTools).toBe(false);
    expect(prepared.effectiveMessages).toBe(messages);
  });
});
