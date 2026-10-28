// ChatGLM Web clean-room executor adapter.
//
// Validates the storage state (cookies + localStorage), flattens the prompt,
// resolves the UI model selection, and drives one browser turn through the
// pooled headless context (x-sign/x-timestamp/x-nonce signing is done in-page).
//
// SSE endpoint: POST /chatglm/backend-api/assistant/stream
// Accept: text/event-stream

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { acquireBrowserContext, openPage } from "../../services/browserPool.js";
import { prepareToolMessages } from "../../translator/webTools.js";

const CHATGLM_WEB_PAGE_URL = "https://chatglm.cn/main/chat";
const CHATGLM_API_BASE = "https://chatglm.cn/chatglm";
const STREAM_ENDPOINT = `${CHATGLM_API_BASE}/backend-api/assistant/stream`;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const FIRST_PARTY_COOKIE_HOSTS = ["chatglm.cn", "zhipuai.cn"];

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
    throw new Error("ChatGLM Web browser storage state contains an invalid cookie");
  }
  if (!isFirstPartyHost(value.domain)) {
    throw new Error("ChatGLM Web browser storage state contains a foreign cookie domain");
  }
}

function validateOrigin(value) {
  if (!isRecord(value) || typeof value.origin !== "string" || !Array.isArray(value.localStorage)) {
    throw new Error("ChatGLM Web browser storage state contains an invalid origin");
  }
  let url;
  try {
    url = new URL(value.origin);
  } catch {
    throw new Error("ChatGLM Web browser storage state contains an invalid origin");
  }
  if (url.protocol !== "https:" || !isFirstPartyHost(url.hostname)) {
    throw new Error("ChatGLM Web browser storage state contains a foreign origin");
  }
  for (const entry of value.localStorage) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
      throw new Error("ChatGLM Web browser storage state contains invalid local storage");
    }
  }
}

export function normalizeChatGLMWebStorageState(value) {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    throw new Error("ChatGLM Web browser storage state is invalid");
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

export function chatGLMWebStorageStateFromCookieHeader(raw) {
  const header = raw.trim().replace(/^Cookie:\s*/i, "");
  if (!header) throw new Error("ChatGLM Web Cookie header is empty");

  // Bare JWT token value (no `name=` prefix at all).
  if (!header.includes("=")) {
    return normalizeChatGLMWebStorageState({
      cookies: [
        {
          name: "chatglm_token",
          value: header,
          domain: ".chatglm.cn",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://chatglm.cn",
          localStorage: [
            { name: "chatglm-deid", value: `device-${randomUUID().replace(/-/g, "")}` },
          ],
        },
      ],
    });
  }

  const parts = header.split(/;\s*/);
  const cookies = parts.map((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) throw new Error("ChatGLM Web Cookie header contains an invalid cookie");
    return [part.slice(0, separator).trim(), part.slice(separator + 1)];
  });

  if (!cookies.some(([name]) => /^chatglm_(token|refresh_token|user_id)$/.test(name))) {
    if (header.includes(";") || header.includes("=")) {
      throw new Error("ChatGLM Web Cookie header is missing chatglm_token");
    }
    cookies.splice(0, cookies.length, ["chatglm_token", header]);
  }

  return normalizeChatGLMWebStorageState({
    cookies: cookies.map(([name, value]) => ({
      name,
      value,
      domain: ".chatglm.cn",
      path: "/",
      expires: -1,
      httpOnly: name.startsWith("__Secure-") || name.startsWith("__Host-") || name === "chatglm_token",
      secure: true,
      sameSite: "Lax",
    })),
    origins: [
      {
        origin: "https://chatglm.cn",
        localStorage: [
          { name: "chatglm-deid", value: `device-${randomUUID().replace(/-/g, "")}` },
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
  if (lastUser.includes("glm-5.3")) return "glm-5.3";
  if (lastUser.includes("glm-4.5")) return "glm-4.5";
  return "glm-5.3-flash"; // default
}

function resolveReasoningEffort(bodyObj, model) {
  // thinking mode mapping
  const thinkingEnabled =
    bodyObj?.thinking_enabled === true ||
    bodyObj?.thinking === true ||
    bodyObj?.reasoning_effort === "high" ||
    bodyObj?.reasoning_effort === "max" ||
    model?.includes("thinking");

  const deepThinking =
    bodyObj?.reasoning_effort === "max" ||
    model?.includes("deep");

  if (deepThinking) return { chat_mode: "deep_thinking", reasoning_effort: "max" };
  if (thinkingEnabled) return { chat_mode: "deep_thinking", reasoning_effort: "high" };
  return { chat_mode: "normal", reasoning_effort: "low" };
}

function buildAssistantId(model) {
  // The assistant_id appears to be a fixed ID per model variant on chatglm.cn
  // From captured traffic: "65940acff94777010aa6b796" (for GLM-5.3-Flash)
  // We'll use a mapping; fallback to the known one.
  const map = {
    "glm-5.3": "65940acff94777010aa6b796",
    "glm-5.3-flash": "65940acff94777010aa6b796",
    "glm-4.5": "65940acff94777010aa6b796",
    "glm-4.5-flash": "65940acff94777010aa6b796",
    "glm-4.5-air": "65940acff94777010aa6b796",
    "glm-4.5-airx": "65940acff94777010aa6b796",
  };
  return map[model] || "65940acff94777010aa6b796";
}

function buildConversationId() {
  // Generate a conversation ID similar to what the web client uses
  // Format observed: 6ae1b8a763b384f29aad03d6 (24 hex chars)
  return randomUUID().replace(/-/g, "").slice(0, 24);
}

function buildStreamPayload({ messages, model, bodyObj, conversationId, assistantId, reasoning }) {
  const lastUserMsg = messages.findLast((m) => m.role === "user");
  const userContent = contentText(lastUserMsg?.content);

  return {
    assistant_id: assistantId,
    conversation_id: conversationId,
    project_id: "",
    chat_type: "user_chat",
    meta_data: {
      cogview: { rm_label_watermark: false },
      is_test: false,
      input_question_type: "xxxx",
      channel: "",
      draft_id: "",
      chat_mode: reasoning.chat_mode,
      reasoning_effort: reasoning.reasoning_effort,
      selected_model: model,
      is_networking: bodyObj?.web_search === true || bodyObj?.search === true,
      quote_log_id: "",
      platform: "pc",
    },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userContent }],
      },
    ],
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
  // event structure from chatglm.cn stream (observed):
  // { "type": "delta", "content": "...", "role": "assistant" }
  // { "type": "reasoning", "content": "..." }
  // { "type": "tool_calls", "tool_calls": [...] }
  // { "type": "done", "finish_reason": "stop" }
  const type = event?.type;
  if (type === "delta" || type === "content") {
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
  if (type === "reasoning") {
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { reasoning_content: event.content || "" },
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
  return null;
}

/** Main entry: execute one browser turn and return a ReadableStream of SSE chunks. */
export async function executeChatGLMWebCleanRoom(input) {
  const { body, credentials, signal } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const messages = bodyObj?.messages ?? [];
  const model = resolveModel(messages, bodyObj);
  const reasoning = resolveReasoningEffort(bodyObj, model);
  const conversationId = bodyObj?.conversation_id || buildConversationId();
  const assistantId = buildAssistantId(model);

  // Normalize credentials -> storageState
  const raw = credentials?.providerSpecificData?.storageState ?? credentials?.apiKey;
  const storageState = raw.trim().startsWith("{")
    ? normalizeChatGLMWebStorageState(JSON.parse(raw))
    : chatGLMWebStorageStateFromCookieHeader(raw);

  // Acquire browser context from pool
  const context = await acquireBrowserContext("chatglm-web", { storageState });
  const page = await openPage(context);

  try {
    // Navigate to chat page (ensures x-sign JS is loaded)
    await page.goto(CHATGLM_WEB_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);

    // Build the stream request payload
    const payload = buildStreamPayload({ messages, model, bodyObj, conversationId, assistantId, reasoning });

    // Execute the stream via page.evaluate (fetch with browser's cookies/headers)
    const stream = await page.evaluate(async ({ endpoint, payload, signal }) => {
      const controller = new AbortController();
      signal?.addEventListener?.("abort", () => controller.abort());

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-App-Platform": "pc",
          "App-Name": "chatglm",
          "X-Lang": "zh",
          "X-App-Version": "0.0.1",
          "X-App-fr": "default",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        credentials: "include",
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`ChatGLM stream HTTP ${res.status}: ${text}`);
      }
      return res.body; // ReadableStream
    }, { endpoint: STREAM_ENDPOINT, payload, signal });

    // Wrap the browser's ReadableStream into a Node-compatible stream
    const reader = stream.getReader();
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
            if (!event) continue;
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