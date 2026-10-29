// ChatGLM Web (chatglm.cn / 智谱清言) executor adapter.
//
// Plain HTTP — no browser. The page signs every first-party call with an
// md5 timestamp/nonce triple that is reproducible on the Node side, and a guest
// token can be minted without any login, so nothing here needs a page context.
//
// SSE endpoint: POST /chatglm/backend-api/assistant/stream

import { createHash, randomUUID } from "node:crypto";
import { resolveConversationId } from "../../shared/conversationId.js";
import { SSE_HEADERS_NO_BUFFER } from "../../utils/sseConstants.js";

const BASE = "https://chatglm.cn";
const STREAM_ENDPOINT = `${BASE}/chatglm/backend-api/assistant/stream`;
const GUEST_ENDPOINT = `${BASE}/chatglm/user-api/guest/access`;

// The page builds X-Sign as md5(`<timestamp>-<nonce>-<SIGN_SALT>`). It covers
// only the timestamp and nonce — never the URL or body.
const SIGN_SALT = "8a1317a7468aa3ad86e997d08f3f31cb";
const ASSISTANT_ID = "65940acff94777010aa6b796";

/**
 * Reproduce the page's obfuscated timestamp: the second-to-last digit is
 * replaced by (sum(digits) - that digit) % 10. For a 13-char ms timestamp the
 * result is the same value, and the page's own traffic confirms it.
 */
function obfuscateTimestamp(now = Date.now()) {
  const raw = String(now);
  const digits = [...raw].map(Number);
  const total = digits.reduce((sum, d) => sum + d, 0);
  return `${raw.slice(0, -2)}${(total - digits[digits.length - 2]) % 10}${raw.slice(-1)}`;
}

// One device id for the whole process: upstream ties the guest account to it,
// and rotating it per request would mint a new account every turn.
const DEVICE_ID = randomUUID().replace(/-/g, "");

function buildHeaders(extra = {}) {
  const timestamp = obfuscateTimestamp();
  const nonce = randomUUID().replace(/-/g, "");
  return {
    "Content-Type": "application/json",
    "App-Name": "chatglm",
    "X-Lang": "zh",
    "X-App-Platform": "pc",
    "X-App-Version": "0.0.1",
    "X-App-fr": "default",
    "X-Device-Id": DEVICE_ID,
    "X-Device-Model": "",
    "X-Device-Brand": "",
    "X-Request-Id": randomUUID().replace(/-/g, ""),
    "X-Exp-Groups": "",
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Sign": createHash("md5").update(`${timestamp}-${nonce}-${SIGN_SALT}`, "utf8").digest("hex"),
    Origin: BASE,
    Referer: `${BASE}/main/chat`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    ...extra,
  };
}

/** JWT `exp` in ms, or 0 when the token cannot be decoded. */
function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return Number(payload.exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

// Guest tokens last 24h. One cached token serves every request until it is
// within 5 minutes of expiry.
let guestToken = { token: "", exp: 0 };

async function mintGuestToken() {
  const res = await fetch(GUEST_ENDPOINT, { method: "POST", headers: buildHeaders(), body: "" });
  const text = await res.text();
  if (!res.ok) throw new Error(`ChatGLM guest token HTTP ${res.status}: ${text.slice(0, 200)}`);
  let token = "";
  try {
    token = JSON.parse(text)?.result?.access_token ?? "";
  } catch {
    /* fall through to the empty-token error */
  }
  if (!token) throw new Error(`ChatGLM guest token failed: ${text.slice(0, 200)}`);
  guestToken = { token, exp: tokenExpiry(token) };
  return token;
}

/**
 * Token to call the stream with. A pasted `chatglm_token` (bare JWT, cookie
 * header, or Playwright storage-state JSON) wins — that is what carries a
 * logged-in account. Without one we run as a guest, which needs no credentials
 * at all.
 */
async function resolveToken(credentials) {
  const raw = credentials?.providerSpecificData?.storageState ?? credentials?.apiKey ?? "";
  const text = String(raw).trim();
  let pasted = "";
  if (text.startsWith("{")) {
    try {
      const state = JSON.parse(text);
      pasted = state?.cookies?.find?.((c) => c?.name === "chatglm_token")?.value ?? "";
    } catch {
      /* not a storage state — treat as opaque below */
    }
  } else if (text.includes("chatglm_token=")) {
    pasted = text.match(/chatglm_token=([^;]+)/)?.[1] ?? "";
  } else if (/^eyJ[\w-]*\./.test(text)) {
    pasted = text;
  }
  pasted = pasted.replace(/^Bearer\s+/i, "").trim();
  if (pasted) return pasted;

  if (guestToken.token && guestToken.exp - Date.now() > 5 * 60 * 1000) return guestToken.token;
  return mintGuestToken();
}

// Our conversation key -> the id upstream actually issued. Upstream rejects a
// client-chosen id (it answers 200 with an EMPTY stream), so a new conversation
// must be opened with "" and every later turn must echo the id it returned.
const upstreamConversations = new Map();
const MAX_CONVERSATIONS = 500;

function rememberConversation(key, upstreamId) {
  if (upstreamConversations.size >= MAX_CONVERSATIONS) {
    upstreamConversations.delete(upstreamConversations.keys().next().value);
  }
  upstreamConversations.set(key, upstreamId);
}

function contentText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join(" ");
  }
  return String(value);
}

function flattenPrompt(messages) {
  return messages
    .map((m) => {
      const text = contentText(m?.content);
      if (!text) return "";
      const role = m?.role === "assistant" ? "Assistant" : m?.role === "system" ? "System" : "User";
      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

// Models the web UI actually offers. Anything else is folded onto the closest
// match instead of being forwarded verbatim — an unknown id fails the turn.
const DEFAULT_MODEL = "glm-5.3-flash";
const KNOWN_MODELS = new Set(["glm-5.3", "glm-5.3-flash"]);

function resolveModel(bodyObj) {
  const requested = typeof bodyObj?.model === "string" ? bodyObj.model.toLowerCase().trim() : "";
  if (!requested) return DEFAULT_MODEL;
  if (KNOWN_MODELS.has(requested)) return requested;
  for (const known of KNOWN_MODELS) {
    if (requested.includes(known)) return known;
  }
  return DEFAULT_MODEL;
}

function resolveReasoning(bodyObj, model) {
  const deep = bodyObj?.reasoning_effort === "max" || model.includes("deep");
  const thinking =
    deep ||
    bodyObj?.thinking_enabled === true ||
    bodyObj?.thinking === true ||
    bodyObj?.reasoning_effort === "high" ||
    model.includes("thinking");
  if (deep) return { chat_mode: "deep_thinking", reasoning_effort: "max" };
  if (thinking) return { chat_mode: "deep_thinking", reasoning_effort: "high" };
  return { chat_mode: "normal", reasoning_effort: "low" };
}

function buildStreamPayload({ prompt, model, bodyObj, conversationId }) {
  const reasoning = resolveReasoning(bodyObj, model);
  return {
    assistant_id: ASSISTANT_ID,
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
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  };
}

/**
 * Convert one upstream SSE frame into zero or more OpenAI chunks.
 *
 * Frames look like:
 *   {"conversation_id":…,"status":"init",
 *    "parts":[{"role":"assistant","status":"init|finish",
 *              "content":[{"type":"think","think":"…"},{"type":"text","text":"…"}]}]}
 * `think`/`text` are cumulative, not deltas, so we diff against the last
 * emitted value and forward only the new tail. A top-level "finish" closes it.
 */
function frameToChunks(frame, state, model) {
  if (!frame || typeof frame !== "object") return [];
  if (frame.status === "finish") return [finishChunk(model, frame.conversation_id)];

  const chunks = [];
  for (const part of Array.isArray(frame.parts) ? frame.parts : []) {
    if (part?.role !== "assistant") continue;
    for (const item of Array.isArray(part.content) ? part.content : []) {
      // Each part keeps its own cumulative buffer, and a turn can carry several
      // parts at once — diffing against one shared buffer would re-emit text.
      const key = `${part.id ?? part.logic_id ?? ""}:${item?.type}`;
      const field = item?.type === "think" ? "think" : item?.type === "text" ? "text" : "";
      const value = field ? item[field] : null;
      if (typeof value !== "string") continue;
      const delta = tail(state.get(key) ?? "", value);
      if (!delta) continue;
      state.set(key, value);
      chunks.push(
        deltaChunk(model, frame.conversation_id,
          field === "think" ? { reasoning_content: delta } : { content: delta })
      );
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

/** One signed POST; throws an Error carrying `status` when upstream refuses. */
async function postStream(payload, token) {
  const res = await fetch(STREAM_ENDPOINT, {
    method: "POST",
    headers: buildHeaders({
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
    }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`ChatGLM stream HTTP ${res.status}: ${text.slice(0, 300)}`), {
      status: res.status,
    });
  }
  return res.text();
}

/** Main entry: run one turn and return a Response carrying OpenAI SSE chunks. */
export async function executeChatGLMWebCleanRoom(input) {
  const { body, credentials } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const messages = bodyObj?.messages ?? [];
  const prompt = flattenPrompt(messages);
  if (!prompt) throw new Error("ChatGLM Web request has no text content");

  const model = resolveModel(bodyObj);
  const conversationKey = resolveConversationId({
    credentials,
    body: bodyObj,
    scope: "chatglm-web",
    format: { flavor: "hex", length: 24 },
  });
  const conversationId = upstreamConversations.get(conversationKey) ?? "";
  const payload = buildStreamPayload({ prompt, model, bodyObj, conversationId });

  const token = await resolveToken(credentials);
  let rawSSE;
  try {
    rawSSE = await postStream(payload, token);
  } catch (error) {
    // A pasted cookie expires after 24h. A guest session is free and needs no
    // credentials at all, so fall back instead of failing the turn.
    if (![401, 403].includes(error.status) || token === guestToken.token) throw error;
    rawSSE = await postStream(payload, await mintGuestToken());
  }

  const encoder = new TextEncoder();
  const queue = [];
  const state = new Map();
  for (const line of rawSSE.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") break;
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      continue;
    }
    if (frame.conversation_id) rememberConversation(conversationKey, frame.conversation_id);
    const chunks = frameToChunks(frame, state, model);
    for (const chunk of chunks) queue.push(`data: ${JSON.stringify(chunk)}\n\n`);
    if (chunks.some((c) => c.choices[0].finish_reason)) break;
  }

  // Upstream answers 200 with an empty body when it dislikes the request (a
  // client-chosen conversation_id does exactly this). Fail loudly instead of
  // streaming nothing.
  if (!queue.length) {
    throw new Error(
      `ChatGLM returned an empty stream${conversationId ? ` for conversation ${conversationId}` : ""}`
    );
  }

  const finalId = upstreamConversations.get(conversationKey) || "";
  if (!queue.some((entry) => entry.includes('"finish_reason":"stop"'))) {
    queue.push(`data: ${JSON.stringify(finishChunk(model, finalId))}\n\n`);
  }
  queue.push("data: [DONE]\n\n");

  let cursor = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (cursor >= queue.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(queue[cursor++]));
      },
    }),
    { status: 200, headers: SSE_HEADERS_NO_BUFFER }
  );
}
