// DoubaoWebExecutor — doubao.com (豆包) web provider (clean-room).
//
// Plain HTTP against the first-party web endpoint: POST /chat/completion streams
// SSE. Auth is the account cookie header, so "Login via Browser" (or a pasted
// DevTools Cookie header) is the only credential. Tools are not supported.

import { BaseExecutor } from "./base.js";
import { executeDoubaoWeb, resolveCookieHeader } from "./doubao-web/adapter.js";

const DOUBAO_WEB_URL = "https://www.doubao.com";

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class DoubaoWebExecutor extends BaseExecutor {
  constructor() {
    super("doubao-web", { id: "doubao-web", baseUrl: DOUBAO_WEB_URL });
  }

  async testConnection(credentials) {
    return !!resolveCookieHeader(credentials);
  }

  async execute(input) {
    try {
      return await executeDoubaoWeb({ input, fetchImpl: (url, options) => this.fetchUpstream(url, options, input.proxyOptions) });
    } catch (error) {
      const status = error.status || 502;
      return {
        response: errorResponse(status, error.message || "Doubao Web request failed"),
        url: DOUBAO_WEB_URL,
        headers: {},
        transformedBody: input.body,
      };
    }
  }
}
