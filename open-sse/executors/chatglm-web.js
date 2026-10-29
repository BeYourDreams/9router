// ChatGLMWebExecutor — chatglm.cn (智谱清言) web provider (clean-room).
//
// Plain HTTP against the first-party API: the page's x-sign/x-timestamp/x-nonce
// triple is reproduced on the Node side and a guest token is minted on demand,
// so no browser is involved. Turns run over
// /chatglm/backend-api/assistant/stream (SSE). Tools are not yet supported.

import { BaseExecutor } from "./base.js";
import { executeChatGLMWebCleanRoom } from "./chatglm-web/adapter.js";

const CHATGLM_WEB_URL = "https://chatglm.cn";

function errorResponse(status, message) {
  return new Response(
    JSON.stringify({ error: { message } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function statusForAdapterError(message) {
  if (/guest token|HTTP[_\s-]*40[13]\b|status 40[13]\b|unauthor|token/i.test(message)) return 401;
  if (/(?:\bHTTP[_\s-]*429\b|\bstatus\s+429\b|\brate[-_\s]?limit(?:ed)?\b)/i.test(message)) return 429;
  if (/request|messages|prompt|model|tools|text content/i.test(message)) return 400;
  return 502;
}

export class ChatGLMWebExecutor extends BaseExecutor {
  constructor() {
    super("chatglm-web", { id: "chatglm-web", baseUrl: CHATGLM_WEB_URL });
  }

  // A pasted chatglm_token is optional: without one the adapter runs as a guest.
  async testConnection() {
    return true;
  }

  async execute(input) {
    try {
      const response = await executeChatGLMWebCleanRoom(input);
      return { response, url: CHATGLM_WEB_URL, headers: {}, transformedBody: input.body };
    } catch (error) {
      const message = error instanceof Error ? error.message : "ChatGLM Web execution failed";
      return {
        response: errorResponse(statusForAdapterError(message), message),
        url: CHATGLM_WEB_URL,
        headers: {},
        transformedBody: input.body,
      };
    }
  }
}
