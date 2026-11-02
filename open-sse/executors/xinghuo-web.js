// XinghuoWebExecutor — xinghuo.xfyun.cn (讯飞星火) web provider (clean-room).
//
// Plain HTTP against the first-party web endpoint: POST /iflygpt-chat/u/chat_message/chat
// streams SSE (multipart/form-data request). Auth is the login cookie header, so
// "Login via Browser" (or a pasted DevTools Cookie header) is the only credential.
// Tools are not supported — the web uplink has no tool-call channel.

import { BaseExecutor } from "./base.js";
import { executeXinghuoWeb, resolveCookieHeader } from "./xinghuo-web/adapter.js";

const XINGHUO_WEB_URL = "https://xinghuo.xfyun.cn";

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class XinghuoWebExecutor extends BaseExecutor {
  constructor() {
    super("xinghuo-web", { id: "xinghuo-web", baseUrl: XINGHUO_WEB_URL });
  }

  async testConnection(credentials) {
    return !!resolveCookieHeader(credentials);
  }

  async execute(input) {
    try {
      return await executeXinghuoWeb({ input, fetchImpl: (url, options) => this.fetchUpstream(url, options, input.proxyOptions) });
    } catch (error) {
      const status = error.status || 502;
      return {
        response: errorResponse(status, error.message || "Xinghuo Web request failed"),
        url: XINGHUO_WEB_URL,
        headers: {},
        transformedBody: input.body,
      };
    }
  }
}
