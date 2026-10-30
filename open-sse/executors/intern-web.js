// InternWebExecutor — discovery.intern-ai.org.cn (书生·端砚) web provider (clean-room).
//
// Authentication is a JWT in the `uaa-token` cookie. The web client does NOT
// send a Cookie header — it lifts the cookie VALUE out and sends it as
// `Authorization: Bearer <jwt>`. Sending the raw pair (`uaa-token=<jwt>`) or
// `Cookie: uaa-token=<jwt>` is rejected with 401 {"code":-10002,"msg":"参数错误，请求未认证"}.
//
// Endpoint: POST https://discovery.intern-ai.org.cn/api/orbit/v1/chat
// Lifecycle: POST /api/orbit/v1/chat/new {"scenario":1} -> {data:{id: <chat_id>}}
//            POST /api/orbit/v1/chat  {"scenario":1,...,"query":...,"chat_id":<id>} -> SSE
// Models come from GET /api/orbit/v1/models -> data.models[].name
//
// ==== VERBATIM PROTOCOL FACTS (captured from the web client, then reproduced live) ====
//
// Auth failure is ONE shape on EVERY authenticated path:
//   HTTP 401 {"traceId":"…","msgCode":"A0202","msg":"user authenticate failed",
//             "data":null,"success":false,"total":0}
// It is returned by /models, /chat/list, /chat/new, /chat, /credits/balance,
// /users/getUserInfo and /users/auth alike. There is no second 401 shape and no
// hidden meaning (no ban/kick flag, no per-endpoint variation): it means the
// bearer JWT is expired, malformed, or missing the Bearer form entirely.
// These endpoints answer 200 {"code":0,...} on success and the chat endpoints
// answer app-level errors as {"code":-10002,"msg":"…"} — 200s are NOT all good.
//
// The chat_id is CONVERSATION-scoped: reusing it keeps upstream history AND its
// prompt cache; minting a new one per turn silently pays full input price. IDs
// are minted by upstream (/chat/new), so we remember what it gave us.
// A stale/foreign chat_id answers 400 "Chat not found" (NOT a 401).
//
// There is no chatefa endpoint at the site root: POST https://discovery.intern-ai.org.cn
// is nginx 405. Only /api/* exists — routing here must never fall back to root.

import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_HEADERS_NO_BUFFER, SSE_DONE } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { extractCookieValue } from "../utils/webCookieAuth.js";
import { resolveConversationId, rememberUpstreamConversationId, recallUpstreamConversationId } from "../shared/conversationId.js";

const API_ORIGIN = "https://discovery.intern-ai.org.cn";
const API_BASE = `${API_ORIGIN}/api/orbit/v1`;
const CHAT_URL = `${API_BASE}/chat`;
const NEW_CHAT_URL = `${API_BASE}/chat/new`;
const MODELS_URL = `${API_BASE}/models`;

const DEFAULT_MODEL = "Default";
const SCENARIO = 1;
const REQUEST_TIMEOUT_MS = 120000;

// Model list returned by /api/orbit/v1/models. "Auto" is the router alias; the
// web client calls it "Default".
const KNOWN_MODELS = [
  "Auto",
  "Default",
  "书生-Agents-A1",
  "书生-A1.5",
  "书生-S2",
  "书生-Atria-Dawn-Preview",
  "Qwen3.7-Plus",
  "Qwen3.8-Flash",
  "DeepSeek-V4-Flash",
  "Kimi-K2.7-Code",
];

const MODEL_MAP = {
  auto: "Default",
  default: "Default",
  "internlm2.5-20b": "Default",
  "internlm2.5-7b": "Default",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0";

/**
 * One auth-failure string for every 401/403 path.
 *
 * VERBATIM PROTOCOL FACT (not a guess): the token in this conversation expired
 * 2026-11-12T08:13:57Z and upstream answers exactly
 *   HTTP 401 {"traceId":"…","msgCode":"A0202","msg":"user authenticate failed",…}
 * to EVERY authenticated path (/models, /credits/balance, /chat/list, /getUserInfo,
 * /chat/new, /chat) — there is no other 401 shape and no other meaning.
 *
 * Reproduced live to confirm each branch:
 *   · valid token  → /models 200, /chat/new 200, /chat 200 SSE
 *   · garbage JWT  → 401 A0202 on every one of those paths
 *   · Cookie header instead of Authorization → 401 (-10002 请求未认证)
 * So this message can say “expired OR malformed” with confidence, and the clock
 * check below tells those two apart for the operator.
 */
function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1] + "=".repeat(4), "base64").toString("utf8"));
    return Number(payload?.exp) || 0;
  } catch {
    return 0;
  }
}

function authFailureMessage(token = null) {
  const base = "Intern Web auth failed — the uaa-token is invalid or expired.";
  const hint = "Re-login at discovery.intern-ai.org.cn (Login via Browser) and update the connection.";
  const exp = token ? tokenExpiry(token) : 0;
  if (exp && Date.now() / 1000 > exp) {
    // Deterministic and unambiguous: nobody has to guess whether they were banned.
    return `${base} The stored JWT expired ${new Date(exp * 1000).toISOString()}. ${hint}`;
  }
  return `${base} Upstream answers 401 msgCode A0202 \u201cuser authenticate failed\u201d \u2014 the token expired, or it was captured with the uaa-token= prefix still attached (send the bare JWT). ${hint}`;
}

function errorResponse(status, message, code) {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error", code: code || `HTTP_${status}` } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * The stored credential is whatever the user pasted. webLogin stores only the
 * cookie VALUE (config.credentialFrom = "cookieValue"), but manual paste can be
 * the bare JWT, `uaa-token=<jwt>`, a full DevTools blob, or a cookie-editor JSON
 * array. Normalize all of them down to the bare JWT.
 */
function resolveToken(credentials) {
  const raw = String(credentials?.apiKey || credentials?.accessToken || "").trim();
  if (!raw) return "";
  let value = raw.replace(/^bearer\s+/i, "").replace(/^cookie:\s*/i, "").trim();
  // Cookie-editor JSON array → "name=value; name=value"
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        value = parsed
          .filter((c) => c && typeof c.name === "string" && typeof c.value === "string")
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
      }
    } catch { /* not JSON — keep as-is */ }
  }
  // Full blob / single pair → extract just the uaa-token value.
  if (value.includes("uaa-token")) {
    const extracted = extractCookieValue(value, "uaa-token");
    if (extracted) return extracted;
  }
  // Bare JWT (or anything else): strip a trailing "name=" prefix if present.
  const eq = value.indexOf("=");
  if (eq > 0 && !value.slice(0, eq).includes(".")) {
    // "somename=xxx" — take the right side only when the left is not a JWT.
    return value.slice(eq + 1).trim();
  }
  return value;
}

function resolveModel(model) {
  const key = String(model || "").trim();
  if (!key) return DEFAULT_MODEL;
  if (MODEL_MAP[key.toLowerCase()]) return MODEL_MAP[key.toLowerCase()];
  // Passthrough: models fetched from /api/orbit/v1/models are sent verbatim.
  return key;
}

function extractUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((c) => c?.type === "text")
        .map((c) => String(c.text ?? ""))
        .join("");
    }
  }
  return "";
}

/**
 * Upstream conversation id for this turn.
 *
 * Upstream keys BOTH its history and its prompt cache on chat_id, so this must
 * be conversation-stable and survive restarts — exactly the contract
 * shared/conversationId.js exists for (same bug class as CodeBuddy's
 * X-Conversation-ID: per-request ids = cold cache + no history every turn).
 *
 * Upstream mints ids itself (integers from /chat/new), so the derived id is only
 * a KEY to remember them by; the value comes back from recall().
 */
function internConversationKey(credentials, body) {
  return resolveConversationId({ credentials, body, scope: "intern-web" });
}

function resolveChatId(credentials, body) {
  // Upstream-minted id wins: it is the only value the API accepts.
  const remembered = recallUpstreamConversationId({ credentials, body, scope: "intern-web" });
  if (Number.isFinite(Number(remembered)) && Number(remembered) > 0) return Number(remembered);
  // Legacy field, kept for connections saved before this existed.
  const stored = credentials?.providerSpecificData?.internChatId;
  if (Number.isFinite(Number(stored)) && Number(stored) > 0) return Number(stored);
  const fromBody = body?.conversationId || body?.chat_id;
  if (Number.isFinite(Number(fromBody)) && Number(fromBody) > 0) return Number(fromBody);
  return 0;
}

function baseHeaders(token, referer) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN",
    Origin: API_ORIGIN,
    Referer: referer,
    "User-Agent": UA,
  };
}

async function createChat(token, signal, proxyOptions) {
  const res = await proxyAwareFetch(NEW_CHAT_URL, {
    method: "POST",
    headers: baseHeaders(token, `${API_ORIGIN}/chat`),
    body: JSON.stringify({ scenario: SCENARIO }),
    signal,
  }, proxyOptions);
  if (!res.ok) return { id: 0, error: await res.text().catch(() => ""), status: res.status };
  let json = null;
  try { json = await res.json(); } catch { return { id: 0, error: "invalid JSON", status: res.status }; }
  const id = Number(json?.data?.id);
  return { id: Number.isFinite(id) && id > 0 ? id : 0, error: "", status: res.status };
}

export class InternWebExecutor extends BaseExecutor {
  constructor() {
    super("intern-web", { id: "intern-web", baseUrl: CHAT_URL });
  }

  /**
   * Cheap credentials check: the token must be a JWT. `/api/orbit/v1/models`
   * answers 401 for a bad one, so confirm before the chat call reports it.
   */
  async testConnection(credentials) {
    const token = resolveToken(credentials);
    if (!token) return false;
    try {
      const res = await proxyAwareFetch(MODELS_URL, {
        headers: baseHeaders(token, `${API_ORIGIN}/chat`),
        signal: AbortSignal.timeout(15000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(credentials) {
    const token = resolveToken(credentials);
    if (!token) return [];
    try {
      const res = await proxyAwareFetch(MODELS_URL, {
        headers: baseHeaders(token, `${API_ORIGIN}/chat`),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      const json = await res.json();
      const models = json?.data?.models;
      if (!Array.isArray(models)) return [];
      return models
        .map((m) => ({ id: String(m?.name || "").trim(), name: String(m?.name || "").trim() }))
        .filter((m) => m.id);
    } catch {
      return [];
    }
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions }) {
    const token = resolveToken(credentials);
    if (!token) {
      const errResp = errorResponse(401, "Missing uaa-token. Add the Intern Web connection again: paste the uaa-token cookie value, or use “Login via Browser”.", "MISSING_CREDENTIAL");
      return { response: errResp, url: CHAT_URL, headers: {}, transformedBody: body };
    }

    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      const errResp = errorResponse(400, "Missing or empty messages array", "INVALID_REQUEST");
      return { response: errResp, url: CHAT_URL, headers: {}, transformedBody: body };
    }

    const query = extractUserText(messages);
    if (!query.trim()) {
      const errResp = errorResponse(400, "Empty query after processing", "INVALID_REQUEST");
      return { response: errResp, url: CHAT_URL, headers: {}, transformedBody: body };
    }

    const upstreamModel = resolveModel(model);
    const chatId = resolveChatId(credentials, body);

    // Pacing is applied upstream by webThrottleGuard (see chatCore): it wraps
    // the WHOLE execute() call, so the /chat/new + /chat pair of this turn
    // shares one throttle slot and the account sees one paced turn, not two.
    return this.runTurn({ token, chatId, credentials, body, model, upstreamModel, query, stream, signal, log, proxyOptions });
  }

  async runTurn({ token, body, chatId: seededChatId, model, upstreamModel, query, stream, signal, log, proxyOptions, credentials, reminted = false }) {
    let chatId = seededChatId;
    const chatIdReused = chatId > 0;

    // The first turn of a conversation needs a chat_id from /chat/new. The
    // outbound payload is the contract for these early returns: it is what the
    // request WAS going to send, so it is declared before the network work.
    const payload = {
      scenario: SCENARIO,
      thinking_mode: true,
      planning_mode: false,
      model: upstreamModel,
      query,
      chat_id: chatId,
    };

    if (!chatId) {
      const created = await createChat(token, signal, proxyOptions);
      if (created.status === 401 || created.status === 403) {
        const errResp = errorResponse(401, authFailureMessage(token), `HTTP_${created.status}`);
        return { response: errResp, url: NEW_CHAT_URL, headers: {}, transformedBody: payload };
      }
      if (!created.id) {
        // Upstream reports app-level failures as HTTP 200 {"code":-10002,...} too
        // (confirmed: an empty body → 200 + code -10002 "invalidate param failed"),
        // so surface `created.error` instead of a bare status.
        const errResp = errorResponse(502, `Intern Web could not open a conversation (HTTP ${created.status}${created.error ? `: ${created.error.slice(0, 160)}` : ""})`, "CHAT_CREATE_FAILED");
        return { response: errResp, url: NEW_CHAT_URL, headers: {}, transformedBody: payload };
      }
      chatId = created.id;
      payload.chat_id = chatId;
      // Remember it so the NEXT turn of this conversation reuses one upstream
      // session instead of opening a fresh one: fixes both follow-up context and
      // per-turn cold prompt cache.
      rememberUpstreamConversationId({ credentials, body, scope: "intern-web" }, String(created.id));
    }

    const headers = baseHeaders(token, `${API_ORIGIN}/chat/chat/${chatId}`);
    log?.info?.("INTERN-WEB", `POST /api/orbit/v1/chat model=${upstreamModel} chat_id=${chatId} reused=${chatIdReused} len=${query.length}`);

    let response;
    try {
      response = await proxyAwareFetch(CHAT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyOptions);
    } catch (err) {
      log?.error?.("INTERN-WEB", `Fetch failed: ${err?.message || String(err)}`);
      const errResp = errorResponse(502, `Intern Web connection failed: ${err?.message || String(err)}`, "CONNECTION_FAILED");
      return { response: errResp, url: CHAT_URL, headers, transformedBody: payload };
    }

    if (!response.ok) {
      const status = response.status;
      const detail = await response.text().catch(() => "");

      // Upstream answers 400 "Chat not found" for a chat_id that aged out or was
      // minted by another connection — NOT an auth failure. A remembered id is a
      // cache, not a fact, so re-mint once instead of failing the turn.
      if (status === 400 && chatIdReused && !reminted && /chat not found/i.test(detail)) {
        log?.warn?.("INTERN-WEB", `chat_id ${chatId} rejected (${detail.slice(0, 80)}) — reminting conversation`);
        return this.runTurn({
          token, credentials, body,
          chatId: 0,                     // forces /chat/new below
          reminted: true,                // one re-mint only: never loop
          model, upstreamModel, query, stream, signal, log, proxyOptions,
        });
      }

      let msg = `Intern returned HTTP ${status}`;
      if (status === 401 || status === 403) {
        msg = authFailureMessage(token);
      } else if (status === 429) {
        msg = "Intern Web rate limited. Wait a moment and retry.";
      }
      log?.warn?.("INTERN-WEB", `${msg} ${detail.slice(0, 200)}`);
      const errResp = errorResponse(status, msg, `HTTP_${status}`);
      return { response: errResp, url: CHAT_URL, headers, transformedBody: payload };
    }

    if (!response.body) {
      const errResp = errorResponse(502, "Intern Web returned an empty response body", "EMPTY_BODY");
      return { response: errResp, url: CHAT_URL, headers, transformedBody: payload };
    }

    const cid = `chatcmpl-intern-${chatId}`;
    const created = Math.floor(Date.now() / 1000);

    return {
      response: stream
        ? new Response(buildSseStream(response.body, model, cid, created), { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } })
        : await collectNonStream(response.body, model, cid, created),
      url: CHAT_URL,
      headers,
      transformedBody: payload,
    };
  }
}

/**
 * The upstream stream is its own NDJSON/SSE dialect:
 *   data: {"event":"message","thinking":"..."}   → chain-of-thought
 *   data: {"event":"message","answer":"..."}     → the visible answer
 *   data: {"event":"workflow_started", ...}      → ignore
 * Translate it to OpenAI chat.completion.chunk frames.
 */
function buildSseStream(upstreamBody, model, cid, created) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      let buffer = "";
      let sentRole = false;
      let closed = false;

      const push = (chunk) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseChunk(chunk)));
      };
      const chatChunk = (delta, finishReason = null) =>
        push({ id: cid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });

      // Enqueue BEFORE latching `closed` — push() early-returns once the flag is
      // set, so closing first would silently drop the finish_reason chunk.
      const finish = () => {
        if (closed) return;
        chatChunk({}, "stop");
        closed = true;
        controller.enqueue(encoder.encode(SSE_DONE));
        controller.close();
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Upstream frames are "data: {json}\n\n"; split defensively on blank line.
          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === "[DONE]") continue;
              let evt;
              try { evt = JSON.parse(raw); } catch { continue; }
              if (!sentRole) {
                sentRole = true;
                chatChunk({ role: "assistant", content: "" });
              }
              const thinking = typeof evt?.thinking === "string" ? evt.thinking : "";
              if (thinking) chatChunk({ reasoning_content: thinking });
              const answer = typeof evt?.answer === "string" ? evt.answer : "";
              if (answer) chatChunk({ content: answer });
            }
          }
        }
        // Flush a trailing frame that arrived without its blank line.
        const tail = buffer.replace(/^data:\s*/, "").trim();
        if (tail && tail !== "[DONE]") {
          try {
            const evt = JSON.parse(tail);
            if (!sentRole) {
              sentRole = true;
              chatChunk({ role: "assistant", content: "" });
            }
            if (typeof evt?.thinking === "string" && evt.thinking) chatChunk({ reasoning_content: evt.thinking });
            if (typeof evt?.answer === "string" && evt.answer) chatChunk({ content: evt.answer });
          } catch { /* partial frame — nothing usable */ }
        }
      } catch (err) {
        if (!closed) {
          closed = true;
          try { controller.error(err); } catch { /* already closed */ }
          return;
        }
      }
      finish();
    },
  });
}

/** Non-streaming: drain the same dialect, then emit one chat.completion. */
async function collectNonStream(upstreamBody, model, cid, created) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let thinking = "";
  let answer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }
        if (typeof evt?.thinking === "string") thinking += evt.thinking;
        if (typeof evt?.answer === "string") answer += evt.answer;
      }
    }
  }

  const message = { role: "assistant", content: answer || "" };
  if (thinking) message.reasoning_content = thinking;

  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export { KNOWN_MODELS, resolveToken as resolveInternToken, resolveModel as resolveInternModel };
