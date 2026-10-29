// ChatGLM Web clean-room executor adapter.
//
// Validates the storage state (cookies + localStorage), flattens the prompt,
// resolves the UI model selection, and drives one browser turn through the
// pooled headless context.
//
// Every first-party call is authenticated by a signature triple the page
// normally builds in JS (X-Timestamp / X-Nonce / X-Sign). The signature covers
// only the timestamp and nonce, so this adapter reproduces it on the Node side
// and never needs to scrape the page's signer.
//
// SSE endpoint: POST /chatglm/backend-api/assistant/stream
// Accept: text/event-stream

import { createHash, randomUUID } from "node:crypto";
import { resolveConversationId } from "../../shared/conversationId.js";

import { acquireBrowserContext, openPage } from "../../services/browserPool.js";


const CHATGLM_WEB_PAGE_URL = "https://chatglm.cn/main/chat";
const STREAM_ENDPOINT = "https://chatglm.cn/chatglm/backend-api/assistant/stream";
const FIRST_PARTY_COOKIE_HOSTS = ["chatglm.cn", "zhipuai.cn"];

// Every first-party XHR the web app fires carries a signature triple. The page
// builds it as md5(`<timestamp>-<nonce>-<SIGN_SALT>`) with a nonce that is a
// dash-stripped v4 UUID. The signature covers only the timestamp and nonce —
// never the URL or the body — so it can be produced on the Node side.
const SIGN_SALT = "8a1317a7468aa3ad86e997d08f3f31cb";
const APP_PLATFORM = "pc";
const APP_NAME = "chatglm";
const APP_VERSION = "0.0.1";
const APP_FR = "default";
const APP_LANG = "zh";

/**
 * Reproduce the page's obfuscated timestamp: the second-to-last digit is
 * replaced by (sum(digits) - that digit) % 10. For a 13-char ms timestamp the
 * result is the same value, and the page's own traffic confirms it.
 */
function obfuscateTimestamp(now = Date.now()) {
  const raw = String(now);
  const digits = [...raw].map(Number);
  const total = digits.reduce((sum, d) => sum + d, 0);
  const replacement = (total - digits[digits.length - 2]) % 10;
  return `${raw.slice(0, -2)}${replacement}${raw.slice(-1)}`;
}

function signRequest(timestamp, nonce) {
  return createHash("md5").update(`${timestamp}-${nonce}-${SIGN_SALT}`, "utf8").digest("hex");
}

/** Build the full X-* header set the real web client sends on every call. */
function buildSignedHeaders({ deviceId, expGroups, token }) {
  const timestamp = obfuscateTimestamp();
  const nonce = randomUUID().replace(/-/g, "");
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "App-Name": APP_NAME,
    "X-Lang": APP_LANG,
    "X-App-Platform": APP_PLATFORM,
    "X-App-Version": APP_VERSION,
    "X-App-fr": APP_FR,
    "X-Device-Id": deviceId,
    "X-Device-Model": "",
    "X-Device-Brand": "",
    "X-Request-Id": randomUUID().replace(/-/g, ""),
    "X-Exp-Groups": expGroups,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Sign": signRequest(timestamp, nonce),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

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

/**
 * Pull the access token out of the stored state. The web app keeps it in the
 * `chatglm_token` cookie and sends it as a raw `Bearer <jwt>` (no "Bearer "
 * prefix stored in the cookie).
 */
function extractToken(storageState) {
  const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];
  const hit = cookies.find((c) => c?.name === "chatglm_token" && typeof c.value === "string" && c.value);
  return hit ? hit.value.replace(/^Bearer\s+/i, "") : "";
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

// Models the web UI actually offers (from the page's own model list). The
// guest/depth tiers resolve to GLM-5.3-Flash, the paid tier to GLM-5.3.
const DEFAULT_MODEL = "glm-5.3-flash";
const KNOWN_MODELS = new Set(["glm-5.3", "glm-5.3-flash"]);

/**
 * Pick the upstream model id.
 *
 * Callers address this provider with whatever id they like ("glm-5.3",
 * "GLM-5.3-Flash", "glm-4.5", …). Only two ids exist on the web surface, so
 * anything else is folded onto the best match instead of being forwarded
 * verbatim — an unknown id would make upstream reject the whole turn.
 */
function resolveModel(messages, bodyObj) {
  const requested = typeof bodyObj?.model === "string" ? bodyObj.model : "";
  const candidates = [requested, extractLastUserMessage(messages)];
  for (const raw of candidates) {
    const id = String(raw).toLowerCase().trim();
    if (!id) continue;
    if (KNOWN_MODELS.has(id)) return id;
    // Direct hit on a known family (glm-5.3, glm-5.3-flash) even when the
    // caller wrote e.g. "GLM-5.3-Flash" or "glm-5.3-flash:web".
    for (const known of KNOWN_MODELS) {
      if (id.includes(known)) return known;
    }
  }
  return DEFAULT_MODEL;
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

function buildAssistantId() {
  // Every model variant shares one assistant id in the captured traffic — the
  // chat surface is a single agent and `meta_data.selected_model` (not this
  // field) is what selects the underlying model.
  return "65940acff94777010aa6b796";
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

/**
 * Convert one upstream SSE frame into zero or more OpenAI chunks.
 *
 * The real frames look like:
 *   {"id":…,"conversation_id":…,"status":"init",
 *    "parts":[{"role":"assistant","status":"init|finish","model":…,
 *               "content":[{"type":"think","think":"User"},
 *                          {"type":"text","text":"OK"}]}]}
 * Every frame re-sends the WHOLE part — `think`/`text` are cumulative, not
 * deltas — so we diff against the last emitted value and forward only the new
 * tail. A top-level status of "finish" closes the turn.
 */
function frameToChunks(frame, state, model) {
  if (!frame || typeof frame !== "object") return [];
  if (frame.status === "finish") return [finishChunk(model, frame.conversation_id)];

  const parts = Array.isArray(frame.parts) ? frame.parts : [];
  const chunks = [];
  for (const part of parts) {
    if (part?.role !== "assistant") continue;
    const contents = Array.isArray(part.content) ? part.content : [];
    for (const item of contents) {
      if (item?.type === "think" && typeof item.think === "string") {
        const delta = tail(state.reasoning, item.think);
        if (delta) {
          state.reasoning = item.think;
          chunks.push(deltaChunk(model, frame.conversation_id, { reasoning_content: delta }));
        }
      } else if (item?.type === "text" && typeof item.text === "string") {
        const delta = tail(state.content, item.text);
        if (delta) {
          state.content = item.text;
          chunks.push(deltaChunk(model, frame.conversation_id, { content: delta }));
        }
      }
      // type === "tool_calls" carries no text payload we can forward.
    }
  }
  return chunks;
}

/** The not-yet-emitted tail of `next` given the last emitted prefix. */
function tail(previous, next) {
  if (!next) return "";
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  // Upstream rewrote the buffer — emit the fresh full text rather than nothing.
  return next;
}

function deltaChunk(model, id, delta) {
  return {
    id: `chatcmpl-${id || randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

function finishChunk(model, id) {
  return {
    id: `chatcmpl-${id || randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
}

/** Main entry: execute one browser turn and return a ReadableStream of SSE chunks. */
export async function executeChatGLMWebCleanRoom(input) {
  const { body, credentials, signal } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const messages = bodyObj?.messages ?? [];
  const model = resolveModel(messages, bodyObj);
  const reasoning = resolveReasoningEffort(bodyObj, model);
  // conversation_id is CONVERSATION-scoped: upstream keys its context on it, so
  // a fresh random id per turn discarded the whole history every request. An
  // explicit client id wins; otherwise derive one that survives turns AND restarts.
  const conversationId = bodyObj?.conversation_id
    || resolveConversationId({
      credentials,
      body: bodyObj,
      scope: "chatglm-web",
      format: { flavor: "hex", length: 24 },
    });
  const assistantId = buildAssistantId();

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

    // Read the LIVE session from the page. The site rotates chatglm_token on
    // load (guest tokens mint a fresh one, and the refresh flow rewrites it),
    // so the token we seeded is usually stale by the time we call the stream.
    // Reading it back from the page is what the SPA's own axios interceptor
    // does (c.gf() -> Cookies.get("chatglm_token")).
    const session = await page.evaluate(() => {
      let expGroups = "";
      try { expGroups = localStorage.getItem("trialGroup") || ""; } catch { /* ignore */ }
      const read = (name) => {
        try {
          const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
          return match ? decodeURIComponent(match[1]) : "";
        } catch { return ""; }
      };
      return {
        expGroups,
        deviceId: read("chatglm_deid") || read("chatglm-deid"),
        token: read("chatglm_token"),
      };
    });
    // Fall back to the stored token only when the page has no live cookie.
    const token = session.token || extractToken(storageState);
    // X-Device-Id is REQUIRED: the gateway answers 40001 when it is empty, and
    // the page seeds it from localStorage['chatglm-deid'] (falling back to a
    // generated `device-<uuid>`). The cookie with the same name is a different,
    // optional value, so read localStorage first and persist whatever we pick.
    const deviceId = session.deviceId
      || (await page.evaluate((fallback) => {
        let existing = "";
        try { existing = localStorage.getItem("chatglm-deid") || ""; } catch { /* ignore */ }
        if (existing) return existing;
        try { localStorage.setItem("chatglm-deid", fallback); } catch { /* ignore */ }
        return fallback;
      }, `device-${randomUUID().replace(/-/g, "")}`));
    const headers = buildSignedHeaders({
      deviceId,
      expGroups: session.expGroups,
      token,
    });

    // Execute the stream via page.evaluate (browser supplies cookies/origin).
    //
    // The body must be consumed IN the page: a ReadableStream cannot cross the
    // CDP boundary, so `page.evaluate` would otherwise hand back a plain object
    // without getReader(). We read to completion here and return the raw SSE
    // text — chat turns are small enough that buffering is fine.
    const rawSSE = await page.evaluate(async ({ endpoint, payload, headers }) => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`ChatGLM stream HTTP ${res.status}: ${text}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let out = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
      out += decoder.decode();
      return out;
    }, { endpoint: STREAM_ENDPOINT, payload, headers });

    // Translate the captured SSE text into OpenAI chunks. Translation is pure
    // string work with no back-pressure, so building the queue up front is both
    // simpler and cheaper than slicing the buffer inside pull().
    const encoder = new TextEncoder();
    const queue = [];
    {
      const state = { reasoning: "", content: "" };
      for (const line of rawSSE.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const frame = parseSSEChunk(trimmed);
        if (!frame) continue;
        if (frame.done) break;
        for (const chunk of frameToChunks(frame, state, model)) {
          queue.push(`data: ${JSON.stringify(chunk)}\n\n`);
          if (chunk.choices?.[0]?.finish_reason) break;
        }
      }
      // Upstream may close without a finish frame; always terminate the turn.
      if (!queue.some((entry) => entry.includes('"finish_reason":"stop"'))) {
        queue.push(`data: ${JSON.stringify(finishChunk(model, conversationId))}\n\n`);
      }
      queue.push(`data: [DONE]\n\n`);
    }

    let cursor = 0;
    return new ReadableStream({
      pull(controller) {
        if (cursor >= queue.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(queue[cursor++]));
      },
    });
  } finally {
    await page.close();
  }
}