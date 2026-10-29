// XiaomiMiMoWebExecutor — aistudio.xiaomimimo.com (小米 MiMo AI Studio) web provider (clean-room).
//
// Routes requests through the first-party web client from a logged-in
// browser page: the page's own JS solves the xiaomichatbot_ph signing
// and the turn runs over /open-apis/react/chat (SSE or JSON).
// Tools are not yet supported.

import { BaseExecutor } from "./base.js";
import { randomUUID } from "node:crypto";
import {
  executeXiaomiMiMoWebCleanRoom,
  normalizeXiaomiMiMoWebStorageState,
  xiaomiMiMoWebStorageStateFromCookieHeader,
} from "./xiaomimimo-web/adapter.js";
import { isMissingBrowserExecutable } from "./browserExecutableCheck.js";

const XIAOMIMIMO_WEB_URL = "https://aistudio.xiaomimimo.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function errorResponse(status, message) {
  return new Response(
    JSON.stringify({ error: { message } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export function statusForAdapterError(message) {
  // Upstream 401 = expired web session; surface it as 401 so chatCore can
  // refresh/rotate connections instead of swallowing it as a 502.
  if (/(?:\bHTTP[\s_-]*401\b|"code"\s*:\s*401\b|loginUrl)/i.test(message)) return 401;
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

export class XiaomiMiMoWebExecutor extends BaseExecutor {
  constructor() {
    super("xiaomimimo-web", { id: "xiaomimimo-web", baseUrl: XIAOMIMIMO_WEB_URL });
  }

  async testConnection(credentials) {
    try {
      const raw = credentials?.providerSpecificData?.storageState ?? credentials?.apiKey;
      if (typeof raw !== "string" || !raw.trim()) return false;
      // Accept either a full storage-state JSON or a raw deviceId cookie value.
      if (raw.trim().startsWith("{")) {
        JSON.parse(raw);
        return true;
      }
      // Bare deviceId or cookie header
      return /deviceId=|_ph=|passToken=|serviceToken=/.test(raw) || /^wb_[a-f0-9-]+$/.test(raw.trim());
    } catch {
      return false;
    }
  }

  async execute(input) {
    try {
      const response = await executeXiaomiMiMoWebCleanRoom(input);
      return { response, url: XIAOMIMIMO_WEB_URL, headers: {}, transformedBody: input.body };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Xiaomi MiMo Web browser execution failed";
      if (isMissingBrowserExecutable(message)) {
        return {
          response: errorResponse(
            503,
            "Xiaomi MiMo Web requires a Chrome/Chromium browser (headed). Install Google Chrome " +
              "on the host (or set XIAOMIMIMO_WEB_CHROME_PATH), and run `npx playwright-core install chromium`."
          ),
          url: XIAOMIMIMO_WEB_URL,
          headers: {},
          transformedBody: input.body,
        };
      }
      const status = statusForAdapterError(message);
      const finalMessage =
        status === 401
          ? `${message} — the aistudio.xiaomimimo.com web session is expired. Re-connect the provider with fresh cookies (needs passToken + serviceToken, not just deviceId).`
          : message;
      return {
        response: errorResponse(status, finalMessage),
        url: XIAOMIMIMO_WEB_URL,
        headers: {},
        transformedBody: input.body,
      };
    }
  }
}

export { normalizeXiaomiMiMoWebStorageState, xiaomiMiMoWebStorageStateFromCookieHeader };