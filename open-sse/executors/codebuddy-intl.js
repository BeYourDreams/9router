import { createHash, randomUUID } from "node:crypto";
import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 *
 * Unlike codebuddy-cn, the intl gateway runs a **channel verification** gate on
 * /v2/chat/completions (live since ~2026-10-15): a request that does not carry
 * the official IDE's `X-Conversation-*` header family is refused with HTTP 400
 * code 11128 `request illegal` and the tip "This call failed channel
 * verification, possibly because it was not sent from an official client".
 * buildHeaders() below supplies that family — see withConversationHeaders().
 */

// The gate needs ALL THREE ids. Verified against the live gateway: none, any
// one, and any two of them are still answered 400/11128; all three clear the
// gate (the request then reaches the account risk stage, 403/11140).
// `X-Request-ID` is NOT part of the gate — it mirrors the message id because the
// official client sends it, and it makes upstream log correlation possible when
// a request is refused.
const CONVERSATION_ID_HEADER = "X-Conversation-ID";
const CONVERSATION_REQUEST_ID_HEADER = "X-Conversation-Request-ID";
const CONVERSATION_MESSAGE_ID_HEADER = "X-Conversation-Message-ID";
const REQUEST_ID_HEADER = "X-Request-ID";

// Values must be UUID-shaped. The gateway issues ids like `cmb-<32 hex>` inside
// its own response payloads, but sending that form as a conversation id is
// refused with 11128 again — only the UUID form passes. Every value below is
// therefore produced by uuidFromSeed()/randomUUID() and never passed through
// from client data.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Client signals that identify one conversation, in priority order. Any of them
// beats the message-derived fallback: they are what the official client keeps
// stable for a whole thread, so retries and later turns share one conversation id.
const SESSION_SIGNAL_KEYS = ["conversation_id", "session_id", "prompt_cache_key"];
const SESSION_HEADER_KEYS = ["x-session-id", "session-id", "x-claude-code-session-id", "x-client-request-id", "x-amp-thread-id"];

// RFC-4122 v5-shaped UUID from a seed string (the same sha1-embedding trick
// antigravity.js uses), so one conversation maps to one id across retries,
// account failovers, and 9router restarts.
function uuidFromSeed(seed) {
  const hash = createHash("sha1").update(seed).digest("hex");
  const version = ((parseInt(hash.slice(12, 16), 16) & 0x0fff) | 0x5000).toString(16).padStart(4, "0");
  const variant = ((parseInt(hash.slice(16, 20), 16) & 0x3fff) | 0x8000).toString(16).padStart(4, "0");
  return [hash.slice(0, 8), hash.slice(8, 12), version, variant, hash.slice(20, 32)].join("-");
}

// Header names are case-insensitive. A caller that already sent
// `x-conversation-id` must be found by a case-insensitive lookup, or a second
// key gets added and undici joins both into one comma-separated value —
// corrupting the id the caller was tracking. Accepts a plain object (executor
// path) or a fetch `Headers` instance (already case-insensitive); anything else
// means "no headers".
function readHeader(headers, name) {
  if (typeof headers?.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }
  if (!headers || typeof headers !== "object") return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// Write a header, updating the caller's existing key when only the case differs
// instead of adding a duplicate.
function writeHeader(headers, name, value) {
  if (typeof headers?.set === "function") {
    headers.set(name, value);
    return;
  }
  if (headers && typeof headers === "object") headers[name] = value;
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
  return "";
}

// Opening user turn — stable for a whole thread (messages only grow), so it keys
// one conversation when the client gave us no explicit session signal.
function openingUserText(body) {
  const items = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  const first = items.find((item) => item?.role === "user");
  return flattenContent(first?.content).trim();
}

function firstString(values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function conversationSeed(body, credentials) {
  const rawHeaders = credentials?.rawHeaders || {};
  const explicit =
    firstString(SESSION_SIGNAL_KEYS.map((key) => body?.[key]))
    || firstString(SESSION_SIGNAL_KEYS.map((key) => body?.metadata?.[key]))
    || firstString(SESSION_HEADER_KEYS.map((key) => rawHeaders[key]))
    || firstString([body?.metadata?.user_id]);
  if (explicit) return `cbai:session:${explicit}`;
  const opening = openingUserText(body);
  return opening ? `cbai:thread:${opening}` : null;
}

/**
 * Attach the `X-Conversation-*` family the intl channel verification demands.
 * Existing non-empty values are preserved (a caller tracking its own thread
 * keeps its ids); blanks count as absent. Re-running on an already-built bag is
 * a no-op, so an id never rotates between the attempts of one request.
 *
 * @param {object|Headers} headers - header bag to fill in place
 * @param {object|null} body - transformed request body (messages/input + session signals)
 * @param {object|null} credentials - routed credentials (rawHeaders, connectionId)
 * @returns {object|Headers} the same bag, for chaining
 */
export function withConversationHeaders(headers, body = null, credentials = null) {
  if (!readHeader(headers, CONVERSATION_ID_HEADER)) {
    const seed = conversationSeed(body, credentials);
    // Nothing to derive from (empty conversation): a fresh id still satisfies
    // the gate, and later turns of a real thread get a stable one.
    writeHeader(headers, CONVERSATION_ID_HEADER, seed ? uuidFromSeed(seed) : randomUUID());
  }
  // Mirror the message id onto X-Request-ID. A caller-provided trace id is only
  // reused when it is UUID-shaped, otherwise upstream reads the request as
  // non-official and refuses it.
  const callerMessageId = readHeader(headers, CONVERSATION_MESSAGE_ID_HEADER);
  const callerRequestId = readHeader(headers, REQUEST_ID_HEADER);
  const messageId = callerMessageId
    || (UUID_PATTERN.test(callerRequestId) ? callerRequestId : "")
    || randomUUID();
  if (!readHeader(headers, CONVERSATION_REQUEST_ID_HEADER)) writeHeader(headers, CONVERSATION_REQUEST_ID_HEADER, randomUUID());
  if (!callerMessageId) writeHeader(headers, CONVERSATION_MESSAGE_ID_HEADER, messageId);
  // A caller trace id that is not UUID-shaped is replaced, not forwarded: the
  // gateway reads a non-UUID correlation id as a non-official client and refuses the
  // call, and the mirror is only useful if it matches the message id.
  if (!callerRequestId || !UUID_PATTERN.test(callerRequestId)) writeHeader(headers, REQUEST_ID_HEADER, messageId);
  return headers;
}

export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  // Fail CLOSED: buildHeaders runs outside base.js's fetch try/catch, so an
  // unexpected throw here surfaces as a named error instead of a bare 502 — and
  // silently falling through would be worse, because a request without the
  // family is refused by the gateway every single time.
  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    try {
      return withConversationHeaders(headers, body, credentials);
    } catch (error) {
      throw new Error(
        "CodeBuddy intl channel verification: could not attach the X-Conversation-* header family "
        + `(${error?.message || error}). https://www.codebuddy.ai refuses every request without it `
        + '(HTTP 400 code 11128 "request illegal" / "conversation id missing"), so this call cannot succeed.',
      );
    }
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }

  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        // Upstream ships a per-locale bundle; prefer the human tip over the
        // opaque `msg`, which reads "request illegal" for every refusal.
        const tip = data?.displayTips?.en || data?.displayMsg?.en || "";
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }

        // 11128 is overloaded: besides the channel gate it also carries
        // "first message is not system prompt" (a body-shape problem already
        // handled in transformRequest). Branch on the MESSAGE, never on the code
        // alone, or every malformed request gets diagnosed as a block.
        if (data?.code === 11128 && /request illegal|conversation id missing|channel verification/i.test(`${msg} ${tip}`)) {
          return {
            status: 400,
            message:
              'CodeBuddy intl refused this request (11128 "request illegal"): its channel verification '
              + "gate blocked the call. This executor already sends the X-Conversation-* family the "
              + "official IDE uses, so a block here is account/IP-scoped WAF risk control — wait for it "
              + "to expire instead of retrying, or the block keeps renewing."
              + (tip ? ` Upstream: ${tip}.` : ""),
          };
        }

        // 11140 = risk control flagged the account itself. Not a request problem,
        // and retrying does not clear it: the user has to appeal from the
        // official client. Say so, and keep the code in the message so
        // ERROR_RULES can cool this connection down hard.
        if (data?.code === 11140) {
          return {
            status: 403,
            message:
              `CodeBuddy intl account restricted (11140): ${data?.displayMsg?.en || msg || "unusual activity detected on this account"}`
              + (tip ? ` — ${tip}` : " — submit feedback from the official CodeBuddy client to appeal."),
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;
