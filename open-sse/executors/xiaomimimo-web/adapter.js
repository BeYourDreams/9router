// Xiaomi MiMo Web clean-room executor adapter.
//
// Validates the storage state (cookies + localStorage), flattens the prompt,
// resolves the UI model selection, and drives one browser turn through the
// pooled headless context (xiaomichatbot_ph signing is done in-page).
//
// Endpoint: POST /open-apis/react/chat?xiaomichatbot_ph=<signature>

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { acquireBrowserContext, openPage } from "../../services/browserPool.js";
import { prepareToolMessages } from "../../translator/webTools.js";

const XIAOMIMIMO_WEB_PAGE_URL = "https://aistudio.xiaomimimo.com/#/ultra";
const XIAOMIMIMO_API_BASE = "https://aistudio.xiaomimimo.com";
const CHAT_ENDPOINT = `${XIAOMIMIMO_API_BASE}/open-apis/react/chat`;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const FIRST_PARTY_COOKIE_HOSTS = ["xiaomimimo.com", "account.xiaomi.com"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFirstPartyHost(value) {
  const host = value.toLowerCase().replace(/^\./, "");
  return FIRST_PARTY_COOKIE_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

function validateCookie(value) {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !value.name ||
    typeof value.value !== "string" ||
    typeof value.domain !== "string" ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires) ||
    typeof value.httpOnly !== "boolean" ||
    typeof value.secure !== "boolean" ||
    !["Strict", "Lax", "None"].includes(String(value.sameSite))
  ) {
    throw new Error("Xiaomi MiMo Web browser storage state contains an invalid cookie");
  }
  if (!isFirstPartyHost(value.domain)) {
    throw new Error("Xiaomi MiMo Web browser storage state contains a foreign cookie domain");
  }
}

function validateOrigin(value) {
  if (!isRecord(value) || typeof value.origin !== "string" || !Array.isArray(value.localStorage)) {
    throw new Error("Xiaomi MiMo Web browser storage state contains an invalid origin");
  }
  let url;
  try {
    url = new URL(value.origin);
  } catch {
    throw new Error("Xiaomi MiMo Web browser storage state contains an invalid origin");
  }
  if (url.protocol !== "https:" || !isFirstPartyHost(url.hostname)) {
    throw new Error("Xiaomi MiMo Web browser storage state contains a foreign origin");
  }
  for (const entry of value.localStorage) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
      throw new Error("Xiaomi MiMo Web browser storage state contains invalid local storage");
    }
  }
}

export function normalizeXiaomiMiMoWebStorageState(value) {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    throw new Error("Xiaomi MiMo Web browser storage state is invalid");
  }
  for (const cookie of value.cookies) validateCookie(cookie);
  for (const origin of value.origins) validateOrigin(origin);
  const state = structuredClone(value);
  // `__Host-` cookies must be host-only: no Domain attribute, Path=/, Secure.
  for (const cookie of state.cookies) {
    if (!cookie.name.startsWith("__Host-")) continue;
    cookie.domain = cookie.domain.replace(/^\./, "");
    cookie.path = "/";
    cookie.secure = true;
  }
  return state;
}

export function xiaomiMiMoWebStorageStateFromCookieHeader(raw) {
  const header = raw.trim().replace(/^Cookie:\s*/i, "");
  if (!header) throw new Error("Xiaomi MiMo Web Cookie header is empty");

  // Bare deviceId value (no `name=` prefix at all).
  if (!header.includes("=")) {
    return normalizeXiaomiMiMoWebStorageState({
      cookies: [
        {
          name: "deviceId",
          value: header,
          domain: ".xiaomimimo.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://aistudio.xiaomimimo.com",
          localStorage: [
            { name: "_onetrack_cid", value: `cid-${randomUUID().replace(/-/g, "")}` },
            { name: "pass_ua", value: "web" },
            { name: "uLocale", value: "zh_CN" },
          ],
        },
      ],
    });
  }

  const parts = header.split(/;\s*/);
  const cookies = parts.map((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) throw new Error("Xiaomi MiMo Web Cookie header contains an invalid cookie");
    return [part.slice(0, separator).trim(), part.slice(separator + 1)];
  });

  if (!cookies.some(([name]) => /^(deviceId|pass_ua|uLocale)$/.test(name))) {
    if (header.includes(";") || header.includes("=")) {
      throw new Error("Xiaomi MiMo Web Cookie header is missing deviceId");
    }
    cookies.splice(0, cookies.length, ["deviceId", header]);
  }

  return normalizeXiaomiMiMoWebStorageState({
    cookies: cookies.map(([name, value]) => ({
      name,
      value,
      domain: ".xiaomimimo.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    })),
    origins: [
      {
        origin: "https://aistudio.xiaomimimo.com",
        localStorage: [
          { name: "_onetrack_cid", value: `cid-${randomUUID().replace(/-/g, "")}` },
          { name: "pass_ua", value: "web" },
          { name: "uLocale", value: "zh_CN" },
        ],
      },
    ],
  });
}

function contentText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join(" ");
  return String(value);
}

function extractLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return contentText(m.content);
  }
  return "";
}

function resolveModel(messages, bodyObj) {
  // Model precedence: explicit body.model -> last user message hint -> default
  const explicit = bodyObj?.model;
  if (explicit && typeof explicit === "string") return explicit;

  const lastUser = extractLastUserMessage(messages);
  if (lastUser.includes("v2.6-pro")) return "mimo-v2.6-pro";
  if (lastUser.includes("v2.6-flash")) return "mimo-v2.6-flash";
  if (lastUser.includes("v2.5-pro")) return "mimo-v2.5-pro";
  if (lastUser.includes("v2.5")) return "mimo-v2.5";
  if (lastUser.includes("v2-omni")) return "mimo-v2-omni";
  if (lastUser.includes("v2-flash")) return "mimo-v2-flash";
  return "mimo-v2.6-pro"; // default
}

function resolveModelConfig(bodyObj, model) {
  // thinking mode & web search mapping
  const thinkingEnabled =
    bodyObj?.thinking_enabled === true ||
    bodyObj?.thinking === true ||
    bodyObj?.reasoning_effort === "high" ||
    bodyObj?.reasoning_effort === "max" ||
    model?.includes("thinking");

  const webSearchEnabled =
    bodyObj?.search_enabled === true ||
    bodyObj?.search === true ||
    bodyObj?.web_search === true;

  return {
    enableThinking: thinkingEnabled,
    webSearchStatus: webSearchEnabled ? "enabled" : "disabled",
    model,
  };
}

function buildConversationId() {
  // Generate a conversation ID similar to what the web client uses
  // Format observed: babcb0bb5505ae7d95fdb0e27d5983c2 (32 hex chars)
  return randomUUID().replace(/-/g, "").slice(0, 32);
}

function buildMsgId() {
  // Format observed: 705ae05c1f76c5e610b87d110711a112 (32 hex chars)
  return randomUUID().replace(/-/g, "");
}

function buildChatPayload({ messages, model, bodyObj, conversationId, msgId, modelConfig }) {
  const lastUserMsg = messages.findLast((m) => m.role === "user");
  const userContent = contentText(lastUserMsg?.content);

  return {
    msgId,
    conversationId,
    query: userContent,
    isEditedQuery: false,
    modelConfig,
    multiMedias: [],
  };
}

/** Convert SSE stream to OpenAI-compatible chunk format. */
function parseSSEChunk(line) {
  if (!line.startsWith("data: ")) return null;
  const data = line.slice(6).trim();
  if (data === "[DONE]") return { done: true };
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function mapSSEEventToOpenAI(event, model) {
  // Expected SSE event structure (to be confirmed from live stream):
  // { "type": "delta", "content": "...", "role": "assistant" }
  // { "type": "reasoning", "content": "..." }
  // { "type": "done", "finish_reason": "stop" }
  // If response is plain JSON (non-streaming), handle that too.
  if (!event || typeof event !== "object") return null;

  const type = event?.type;
  if (type === "delta" || type === "content" || event?.content) {
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { content: event.content || "" },
        finish_reason: null,
      }],
    };
  }
  if (type === "reasoning" || event?.reasoning_content) {
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { reasoning_content: event.reasoning_content || event.content || "" },
        finish_reason: null,
      }],
    };
  }
  if (type === "done" || event?.finish_reason) {
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: event.finish_reason || "stop",
      }],
    };
  }
  // Plain JSON response (non-streaming)
  if (event?.choices?.[0]?.message) {
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: event.choices[0].message,
        finish_reason: event.choices[0].finish_reason || "stop",
      }],
      usage: event.usage,
    };
  }
  return null;
}

/** Main entry: execute one browser turn and return a ReadableStream of SSE chunks. */
export async function executeXiaomiMiMoWebCleanRoom(input) {
  const { body, credentials, signal } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const messages = bodyObj?.messages ?? [];
  const model = resolveModel(messages, bodyObj);
  const modelConfig = resolveModelConfig(bodyObj, model);
  const conversationId = bodyObj?.conversation_id || buildConversationId();
  const msgId = buildMsgId();

  // Normalize credentials -> storageState
  const raw = credentials?.providerSpecificData?.storageState ?? credentials?.apiKey;
  const storageState = raw.trim().startsWith("{")
    ? normalizeXiaomiMiMoWebStorageState(JSON.parse(raw))
    : xiaomiMiMoWebStorageStateFromCookieHeader(raw);

  // Acquire browser context from pool
  const context = await acquireBrowserContext("xiaomimimo-web", { storageState });
  const page = await openPage(context);

  try {
    // Navigate to chat page (ensures xiaomichatbot_ph JS is loaded)
    await page.goto(XIAOMIMIMO_WEB_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);

    // Build the request payload
    const payload = buildChatPayload({ messages, model, bodyObj, conversationId, msgId, modelConfig });

    // Execute the request via page.evaluate (fetch with browser's cookies/headers)
    // The browser will automatically compute xiaomichatbot_ph
    const response = await page.evaluate(async ({ endpoint, payload, signal }) => {
      const controller = new AbortController();
      signal?.addEventListener?.("abort", () => controller.abort());

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Timezone": "Asia/Shanghai",
          "Accept-Language": "system",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        credentials: "include",
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Xiaomi MiMo chat HTTP ${res.status}: ${text}`);
      }
      return res.body; // ReadableStream
    }, { endpoint: CHAT_ENDPOINT, payload, signal });

    // Wrap the browser's ReadableStream into a Node-compatible stream
    const reader = response.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    return new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const event = parseSSEChunk(trimmed);
            if (!event) {
              // Might be plain JSON response (non-streaming)
              try {
                const jsonEvent = JSON.parse(trimmed);
                const chunk = mapSSEEventToOpenAI(jsonEvent, model);
                if (chunk) {
                  if (chunk.object === "chat.completion") {
                    // Non-streaming: send as single chunk then close
                    controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
                    controller.enqueue(`data: [DONE]\n\n`);
                    controller.close();
                    return;
                  }
                  controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
                }
              } catch {
                // Not JSON, skip
              }
              continue;
            }
            if (event.done) {
              controller.enqueue(`data: [DONE]\n\n`);
              controller.close();
              return;
            }
            const chunk = mapSSEEventToOpenAI(event, model);
            if (chunk) {
              controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
        }
      },
      cancel() {
        reader.cancel();
      },
    });
  } finally {
    await page.close();
  }
}