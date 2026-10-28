// ChatGLMWebExecutor — chatglm.cn (智谱清言) web provider (clean-room).
//
// Routes requests through the first-party web client from a logged-in
// browser page: the page's own JS solves the x-sign/x-timestamp/x-nonce
// signing and the turn runs over /chatglm/backend-api/assistant/stream (SSE).
// Tools are not yet supported.

import { BaseExecutor } from "./base.js";
import { randomUUID } from "node:crypto";
import {
  executeChatGLMWebCleanRoom,
  normalizeChatGLMWebStorageState,
  chatGLMWebStorageStateFromCookieHeader,
} from "./chatglm-web/adapter.js";
import { isMissingBrowserExecutable } from "./browserExecutableCheck.js";

const CHATGLM_WEB_URL = "https://chatglm.cn";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function errorResponse(status, message) {
  return new Response(
    JSON.stringify({ error: { message } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function statusForAdapterError(message) {
  if (/storage state|credentials|connection ID/i.test(message)) return 401;
  if (
    /(?:\bHTTP[_\s-]*429\b|\bstatus\s+429\b|\brate[-_\s]?limit(?:ed)?\b|\bquota\s+(?:exhausted|reached|exceeded)\b)/i.test(
      message
    )
  ) {
    return 429;
  }
  if (/request|messages|prompt|model|tools|text content|reasoning effort/i.test(message)) {
    return 400;
  }
  return 502;
}

export class ChatGLMWebExecutor extends BaseExecutor {
  constructor() {
    super("chatglm-web", { id: "chatglm-web", baseUrl: CHATGLM_WEB_URL });
  }

  async testConnection(credentials) {
    try {
      const raw = credentials?.providerSpecificData?.storageState ?? credentials?.apiKey;
      if (typeof raw !== "string" || !raw.trim()) return false;
      // Accept either a full storage-state JSON or a raw chatglm_token cookie value.
      if (raw.trim().startsWith("{")) {
        JSON.parse(raw);
        return true;
      }
      // Bare JWT token or cookie header
      return /^eyJ/.test(raw.trim()) || /chatglm_token=/.test(raw);
    } catch {
      return false;
    }
  }

  async execute(input) {
    try {
      const response = await executeChatGLMWebCleanRoom(input);
      return { response, url: CHATGLM_WEB_URL, headers: {}, transformedBody: input.body };
    } catch (error) {
      const message = error instanceof Error ? error.message : "ChatGLM Web browser execution failed";
      if (isMissingBrowserExecutable(message)) {
        return {
          response: errorResponse(
            503,
            "ChatGLM Web requires a Chrome/Chromium browser (headed). Install Google Chrome " +
              "on the host (or set CHATGLM_WEB_CHROME_PATH), and run `npx playwright-core install chromium`."
          ),
          url: CHATGLM_WEB_URL,
          headers: {},
          transformedBody: input.body,
        };
      }
      return {
        response: errorResponse(statusForAdapterError(message), message),
        url: CHATGLM_WEB_URL,
        headers: {},
        transformedBody: input.body,
      };
    }
  }
}

export { normalizeChatGLMWebStorageState, chatGLMWebStorageStateFromCookieHeader };