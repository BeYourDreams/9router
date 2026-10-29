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
import { SSE_HEADERS_NO_BUFFER } from "../../utils/sseConstants.js";

const XIAOMIMIMO_WEB_PAGE_URL = "https://aistudio.xiaomimimo.com/#/ultra";
const XIAOMIMIMO_API_BASE = "https://aistudio.xiaomimimo.com";
const CHAT_ENDPOINT = `${XIAOMIMIMO_API_BASE}/open-apis/react/chat`;
// Per-deployment signature cookie (production build: `xiaomichatbot_ph`;
// ultra/fastchat builds use `ultraspeed_ph`). Its value is echoed as the
// `?<name>=` query param on every /open-apis call.
const PH_COOKIE_NAME = "xiaomichatbot_ph";
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
          httpOnly: false,
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
    // A pasted header can carry RFC-6265 quoted values (Chrome's
    // "copy value" does this for base64/`==`-ending tokens). Stored as-is the
    // quotes become part of the cookie value and the server rejects the
    // session -> 401. The browser strips them for real Set-Cookie values.
    const value = part.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");
    return [part.slice(0, separator).trim(), value];
  });

  // The web session carries passToken/serviceToken/userId + a `<category>_ph`
  // signature cookie; `deviceId` only exists in the desktop app's jar.
  if (!cookies.some(([name]) => /^(deviceId|passToken|serviceToken|userId|cUserId|pass_ua|uLocale|.+_ph)$/.test(name))) {
    if (header.includes(";") || header.includes("=")) {
      throw new Error("Xiaomi MiMo Web Cookie header is missing a session cookie");
    }
    cookies.splice(0, cookies.length, ["deviceId", header]);
  }

  return normalizeXiaomiMiMoWebStorageState({
    // httpOnly MUST stay false: the chat call echoes the `_ph` cookie into a
    // query param, and that value is read from `document.cookie` in-page. An
    // httpOnly jar makes document.cookie empty -> no param -> upstream 401.
    cookies: cookies.map(([name, value]) => ({
      name,
      value,
      domain: ".xiaomimimo.com",
      path: "/",
      expires: -1,
      httpOnly: false,
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

/**
 * Consume the upstream SSE byte stream and emit OpenAI chunks.
 *
 * Live wire format (aistudio.xiaomimimo.com /open-apis/react/chat):
 *   id:<uuid>
 *   event:dialogId            data:{"content":"<dialogId>"}
 *   event:message             data:{"messageType":"assistant","content":"..."}
 *                             data:{"messageType":"assistant","reasoningContent":"..."}
 *   event:usage               data:{"promptTokens":N,"completionTokens":N,"totalTokens":N}
 *   event:finish              data:{"content":"[DONE]"}
 */
const SSE_EVENT = /^event:(.*)$/;
const SSE_DATA = /^data:(.*)$/;

function openAIChunk(model, delta, finishReason = null, usage = undefined) {
  const chunk = {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

function usageFromEvent(data) {
  const u = data?.nativeUsage ?? data ?? {};
  const prompt = Number(data?.promptTokens ?? u.prompt_tokens ?? 0);
  const completion = Number(data?.completionTokens ?? u.completion_tokens ?? 0);
  const total = Number(data?.totalTokens ?? u.total_tokens ?? prompt + completion);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(total) ? total : prompt + completion,
  };
}

const SSE_ENCODER = new TextEncoder();

function emitEvent(controller, model, state, name, data) {
  let sent = 0;
  const send = (payload) => {
    controller.enqueue(SSE_ENCODER.encode(`data: ${payload}\n\n`));
    sent++;
  };
  if (name === "message") {
    if (data?.messageType && data.messageType !== "assistant") return sent;
    if (typeof data.content === "string" && data.content) {
      send(JSON.stringify(openAIChunk(model, { content: data.content })));
    }
    if (typeof data.reasoningContent === "string" && data.reasoningContent) {
      send(JSON.stringify(openAIChunk(model, { reasoning_content: data.reasoningContent })));
    }
    return sent;
  }
  if (name === "usage") {
    const usage = usageFromEvent(data);
    if (usage) state.usage = usage;
    return sent;
  }
  if (name === "finish") {
    // Emit usage on the terminal chunk so it isn't dropped by the aggregator.
    send(JSON.stringify(openAIChunk(model, {}, "stop", state.usage)));
    send("[DONE]");
    state.done = true;
  }
  return sent;
}

function parseSSEBlocks(text, state) {
  // SSE frames events as "field: value\n" lines terminated by a BLANK line.
  // Splitting on "\n" alone is wrong: "event:message\n".split("\n") ends with
  // an empty string that is NOT a block terminator, so the block would be
  // flushed before its `data:` line ever arrived (dropping every message).
  // Only "\n\n" ends a block.
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n\n", start);
    if (end < 0) break;
    const block = text.slice(start, end);
    start = end + 2;
    let event = "";
    let data = "";
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const ev = line.match(SSE_EVENT);
      if (ev) {
        event = ev[1].trim();
        continue;
      }
      const da = line.match(SSE_DATA);
      if (da) {
        data = data ? `${data}\n${da[1].trim()}` : da[1].trim();
        continue;
      }
      if (line === "[DONE]") event = event || "finish";
    }
    if (event || data) state.blocks.push([event, data]);
  }
  return start;
}

function newSSEState() {
  return { buffer: "", event: "", data: "", blocks: [], usage: null, done: false };
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

  // Token identifying this turn's in-page reader (see the pull loop below).
  const callToken = `turn-${randomUUID().replace(/-/g, "")}`;
  let streamReleased = false;
  // NOTE: the page must outlive this function — the returned ReadableStream
  // keeps pulling from it, so cleanup belongs to the stream (see `cleanup`),
  // never to a `finally` here (that would tear the page down before the
  // caller ever reads chunk #1).
  const cleanup = async () => {
    if (streamReleased) return;
    streamReleased = true;
    await page
      .evaluate((token) => {
        const slot = window.__xmm?.[token];
        delete window.__xmm?.[token];
        return slot?.reader?.cancel?.().catch?.(() => {}) ?? null;
      }, callToken)
      .catch(() => {});
    await page.close().catch(() => {});
  };

  try {
    // Navigate to chat page (ensures xiaomichatbot_ph JS is loaded)
    await page.goto(XIAOMIMIMO_WEB_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);

    // Build the request payload
    const payload = buildChatPayload({ messages, model, bodyObj, conversationId, msgId, modelConfig });

    // Start the turn inside the page.
    //
    // page.evaluate() can only return structured-cloneable values, so the
    // upstream ReadableStream CANNOT cross the CDP boundary. Instead we start
    // the fetch in-page, hand back a per-call token, and pull chunks one
    // `evaluate` at a time (the in-page state holds the reader).
    //
    // The endpoint also needs the signature cookie mirrored as a query param:
    // the upstream proxy only authorizes /open-apis when `?<category>_ph=` is
    // present (without it the same jar returns 401 + a serviceLogin URL), and
    // we read it inside the page so we pick up whatever the app (re)wrote.
    const start = await page.evaluate(async ({ endpoint, payload, phName, token, maxBytes }) => {
      const readPh = (name) => {
        const prefix = `${name}=`;
        for (const part of document.cookie.split("; ")) {
          if (part.startsWith(prefix)) {
            return decodeURIComponent(part.slice(prefix.length)).replace(/^"|"$/g, "");
          }
        }
        return "";
      };
      const ph = readPh(phName);
      const url = ph ? `${endpoint}?${encodeURIComponent(phName)}=${encodeURIComponent(ph)}` : endpoint;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Timezone": "Asia/Shanghai",
          "Accept-Language": "system",
        },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Xiaomi MiMo chat HTTP ${res.status}: ${text}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Xiaomi MiMo chat returned no response body");
      const decoder = new TextDecoder();
      window.__xmm = window.__xmm || {};
      window.__xmm[token] = { reader, decoder, buffer: "", done: false, bytes: 0, maxBytes };
      return { ok: true, status: res.status, phSeen: Boolean(ph) };
    }, { endpoint: CHAT_ENDPOINT, payload, phName: PH_COOKIE_NAME, token: callToken, maxBytes: MAX_PROMPT_BYTES });

    if (!start?.phSeen) {
      throw new Error(
        `Xiaomi MiMo Web storage state has no ${PH_COOKIE_NAME} cookie — re-run the browser login`
      );
    }

    const state = newSSEState();
    let closed = false;

    const stream = new ReadableStream({
      async pull(controller) {
        if (closed) return;
        // Each pull must either enqueue or close: returning without doing
        // either makes ReadableStream re-pull immediately (busy loop).
        while (!closed) {
          const pulled = await page.evaluate(async (token) => {
            const slot = window.__xmm?.[token];
            if (!slot) return { done: true, chunk: "" };
            const { done, value } = await slot.reader.read();
            if (done) {
              slot.done = true;
              return { done: true, chunk: "" };
            }
            slot.bytes += value.byteLength ?? 0;
            return { done: false, chunk: slot.decoder.decode(value, { stream: true }) };
          }, callToken);

          if (pulled.done) {
            // A well-formed stream ends with event:finish; if the tail was
            // dropped (aborted turn), terminate it here so callers don't hang.
            if (!state.done) {
              controller.enqueue(
                SSE_ENCODER.encode(`data: ${JSON.stringify(openAIChunk(model, {}, "stop", state.usage))}\n\n`)
              );
              controller.enqueue(SSE_ENCODER.encode("data: [DONE]\n\n"));
            }
            await cleanup();
            closed = true;
            controller.close();
            return;
          }

          state.buffer += pulled.chunk;
          state.blocks.length = 0;
          // consume() returns how many bytes were framed; the rest is a
          // partial block (or a multi-byte char) and stays buffered.
          const consumed = parseSSEBlocks(state.buffer, state);
          if (consumed > 0) state.buffer = state.buffer.slice(consumed);
          let sent = 0;
          for (const [name, data] of state.blocks) {
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue; // non-JSON payload (e.g. "[DONE]" is handled by name)
            }
            sent += emitEvent(controller, model, state, name, parsed);
          }

          if (state.done) {
            await cleanup();
            closed = true;
            controller.close();
            return;
          }
          // A pull() that enqueues nothing leaves the consumer waiting forever:
          // SSE blocks like `dialogId` or a partial line produce no chunk, so
          // keep reading until we actually emit something (or the stream ends).
          if (sent > 0) return;
        }
      },
      cancel() {
        cleanup();
      },
    });

    // chatCore expects a real Response (it reads .ok/.status/.body), so the
    // browser-owned stream must be wrapped here rather than returned bare.
    return new Response(stream, { status: 200, headers: SSE_HEADERS_NO_BUFFER });
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}