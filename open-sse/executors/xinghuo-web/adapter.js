// Xinghuo (星火 AI, xinghuo.xfyun.cn) web executor adapter — plain HTTP, no browser.
//
// Endpoint:  POST /iflygpt-chat/u/chat_message/chat  → text/event-stream
// Auth:      the site login cookie (SESSION + JSESSIONID + ssoSessionId + ui +
//            account_id — "Login via Browser", or a pasted DevTools Cookie header).
//
// Captured against the logged-in site (2026-11):
//   • The uplink is multipart/form-data, NOT JSON, and its text field carries only
//     the NEW user turn: the server keeps history keyed on chatId. An OpenAI client
//     is stateless, so every request opens a fresh conversation (see createChatId)
//     and sends the last user message. Reusing one chatId across requests silently
//     appends every call to the same conversation and the model answers with the
//     old context in mind.
//   • The geetest fields (GtToken / seccode / validate / challenge) are NOT needed
//     on a normal session — proven by a live turn with none of them. They only
//     appear when the risk engine challenges you; that case surfaces as the SSE
//     error below and is handled by the auto-verify flow.
//   • There is no model field on this endpoint: the web picker drives server-side
//     routing ("routeVersion":"v2"), so registry ids are labels over one channel.
//   • Reasoning tokens arrive as event:reasoning frames; answer text as
//     event:message; the turn ends with event:done (finishReason:"stop").

import { randomUUID } from "node:crypto";
import { SSE_HEADERS_NO_BUFFER } from "../../utils/sseConstants.js";

const BASE = "https://xinghuo.xfyun.cn";
const CHAT_PATH = "/iflygpt-chat/u/chat_message/chat";
const CREATE_PATH = "/iflygpt/u/chat-list/v1/create-chat-list";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
// Feature id the web client sends; the endpoint rejects a request without it.
const FD = "928244";

// Cookie names the session actually needs. Everything else in the jar is
// analytics; the whole header is sent anyway (a pasted DevTools cookie works),
// this list is only what testConnection insists on.
const REQUIRED_COOKIES = ["SESSION", "ssoSessionId"];

/** Accept a raw Cookie header, a JSON array, or a storage-state object. */
export function resolveCookieHeader(credentials) {
  const raw = String(credentials?.apiKey || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies || [];
      return cookies
        .filter((c) => /xfyun\.cn/.test(String(c.domain || "")) && c.value)
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
    } catch {
      return raw;
    }
  }
  return raw.replace(/^Cookie:\s*/i, "");
}

export function hasRequiredCookies(cookieHeader) {
  const have = new Set(
    String(cookieHeader || "")
      .split(/;\s*/)
      .filter(Boolean)
      .map((part) => part.split("=")[0])
  );
  return REQUIRED_COOKIES.some((name) => have.has(name));
}

function headersFor(cookie, extra = {}) {
  return {
    Cookie: cookie,
    Origin: BASE,
    Referer: `${BASE}/desk`,
    "User-Agent": USER_AGENT,
    "clientType": "1",
    "lang-code": "zh",
    ...extra,
  };
}

/**
 * Open a fresh conversation and return its numeric chatId.
 * The response wraps it as { flag, code, data: { id } }; code 0 means ok.
 */
export async function createChatId({ cookie, fetchImpl, signal }) {
  const res = await fetchImpl(`${BASE}${CREATE_PATH}`, {
    method: "POST",
    headers: headersFor(cookie, { "Content-Type": "application/json", Accept: "application/json" }),
    body: JSON.stringify({ chatSource: 1 }),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`Xinghuo Web rejected the cookie (HTTP ${res.status}) — re-login at xinghuo.xfyun.cn`), { status: 401 });
  }
  let id;
  try {
    const json = JSON.parse(text);
    if (json?.code && json.code !== 0) throw new Error(String(json.desc || `code ${json.code}`));
    id = json?.data?.id ?? json?.id;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // HTML instead of JSON = redirected to the login page = dead cookie.
      throw Object.assign(new Error("Xinghuo Web rejected the cookie (login page returned) — refresh it with “Login via Browser”"), { status: 401 });
    }
    throw error;
  }
  if (!id) {
    throw Object.assign(new Error(`Xinghuo Web created no conversation: ${text.slice(0, 160)}`), { status: 502 });
  }
  return String(id);
}

/** multipart/form-data body with a fixed boundary (no file parts to encode). */
export function buildMultipart(fields, boundary = `----9r${Math.random().toString(36).slice(2, 12)}`) {
  const body = Object.entries(fields)
    .map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    )
    .join("");
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: `${body}--${boundary}--\r\n` };
}

export function buildFormFields({ text, chatId }) {
  return {
    fd: FD,
    isBot: "0",
    capabilities: "ifly_search",
    clientType: "1",
    text,
    chatId,
    firstChat: "true",
    options: JSON.stringify({ chatOption: { thinkPattern: "auto", routeVersion: "v2" } }),
  };
}

/** Split an SSE stream body into { event, data } frames. */
export function parseFrames(raw) {
  const frames = [];
  for (const block of String(raw || "").split(/\r?\n\r?\n+/)) {
    if (!block.trim()) continue;
    const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() || "message";
    const data = /^data:\s*(.*)$/m.exec(block)?.[1]?.trim() || "";
    if (!data) continue;
    try {
      frames.push({ event, json: JSON.parse(data) });
    } catch {
      // Non-JSON keep-alive frames carry nothing we need.
    }
  }
  return frames;
}

/** answer text, reasoning text, error message and finish reason from frames. */
export function readStream(frames) {
  let content = "";
  let reasoning = "";
  let error = null;
  let finished = false;
  for (const { event, json } of frames) {
    if (json.code && json.code !== 0 && !json.content) error = String(json.desc || `code ${json.code}`);
    if (event === "reasoning") reasoning += json.content || "";
    if (event === "message") content += json.content || "";
    if (event === "done") {
      finished = true;
      if (json.finishReason && json.finishReason !== "stop") error = error || `finishReason=${json.finishReason}`;
    }
  }
  return { content, reasoning, error, finished };
}

function sseChunk(model, delta, finish = null) {
  return {
    id: `chatcmpl-xinghuo-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  };
}

/**
 * One turn: fresh conversation → multipart POST → collect SSE frames.
 * The web uplink is not incremental per token on a short reply, so the whole
 * answer is emitted as one chunk; clients that stream still see a proper
 * delta + finish_reason + [DONE].
 */
export async function executeXinghuoWeb({ input, fetchImpl }) {
  const { body, credentials, signal } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const cookie = resolveCookieHeader(credentials);
  if (!cookie) {
    throw Object.assign(new Error("Xinghuo Web needs the xinghuo.xfyun.cn login cookie. Use “Login via Browser”, or paste the Cookie header from DevTools (must contain SESSION)."), { status: 401 });
  }

  const messages = bodyObj?.messages ?? [];
  const model = bodyObj?.model || "xinghuo-auto";
  // Last user turn only — the server owns the conversation history.
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const text = typeof lastUser?.content === "string"
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("")
      : "";
  if (!text.trim()) {
    throw Object.assign(new Error("Xinghuo Web needs a user message"), { status: 400 });
  }

  const chatId = await createChatId({ cookie, fetchImpl, signal });
  const form = buildMultipart(buildFormFields({ text, chatId }));

  const response = await fetchImpl(`${BASE}${CHAT_PATH}`, {
    method: "POST",
    headers: headersFor(cookie, {
      "Content-Type": form.contentType,
      Accept: "text/event-stream",
      botweb: "0",
      "x-requested-with": "XMLHttpRequest",
    }),
    body: form.body,
    ...(signal ? { signal } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error(`Xinghuo Web rejected the cookie (HTTP ${response.status}) — re-login with “Login via Browser”`), { status: 401 });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(new Error(`Xinghuo Web HTTP ${response.status}: ${detail.slice(0, 200)}`), { status: response.status });
  }

  const raw = await response.text();
  const { content, reasoning, error } = readStream(parseFrames(raw));
  if (!content && !reasoning) {
    // A challenged or rate-limited session answers 200 with an error frame.
    const challenged = /verify|seccode|captcha|机器人|人机|风险/i.test(raw);
    throw Object.assign(
      new Error(`Xinghuo Web returned no content${error ? `: ${error}` : ""}${challenged ? " (the site asked this session for a human check — log in once in a real browser on this machine)" : ""}`),
      { status: challenged ? 403 : 502 }
    );
  }

  const chunks = [];
  if (reasoning) chunks.push(sseChunk(model, { reasoning_content: reasoning }));
  chunks.push(sseChunk(model, { content }));
  chunks.push(sseChunk(model, {}, "stop"));

  const encoder = new TextEncoder();
  const queue = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"];
  let cursor = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (cursor >= queue.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(queue[cursor++]));
    },
  });

  return {
    response: new Response(stream, { status: 200, headers: SSE_HEADERS_NO_BUFFER }),
    url: `${BASE}${CHAT_PATH}`,
    headers: {},
    transformedBody: bodyObj,
  };
}

export { BASE, CHAT_PATH, CREATE_PATH, USER_AGENT };
