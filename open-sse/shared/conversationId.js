/**
 * Conversation-stable identifiers for upstreams that key their prompt cache on
 * a per-conversation id header (CodeBuddy's X-Conversation-* family, Command
 * Code's x-session-id, …).
 *
 * The distinction that matters:
 *
 *   conversation id — one per CONVERSATION, must survive every turn. Upstream
 *                     keys its prompt cache on it, so a fresh id per request is
 *                     a guaranteed cold cache: full input price on every turn.
 *   request id      — one per REQUEST, must be fresh, or upstream dedupes the
 *                     retry as a repeat of the first call.
 *
 * Mixing the two up (minting a new conversation id per request) is invisible
 * in the response — the call succeeds and only the cache silently misses — so
 * the resolver lives here, once, instead of being re-derived per executor.
 */

import { createHash } from "node:crypto";
import { resolveSessionId } from "../utils/sessionManager.js";

// Stable seed derived from the credential itself, used only when the connection
// carries no id of its own. Without it resolveSessionId lands on
// deriveSessionId(undefined), which mints a fresh id per request (it embeds
// Date.now()) — a guaranteed cold cache every turn. Keying on the token keeps
// one connection on one upstream session without leaking conversations across
// connections.
function credentialSeed(credentials) {
  const token = credentials?.accessToken || credentials?.apiKey;
  if (!token) return "";
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
}

// Upstream rejects ids that are not canonically UUID-shaped (a `cmb-<hex>` form
// is refused with 400/11128 "request illegal"), so every derived id is folded
// into a v4-shaped string. Deterministic, so the same session keeps the same id.
export function toUuidShaped(sessionId) {
  const h = createHash("sha256").update(String(sessionId ?? "")).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Resolve one conversation id for this request.
 *
 * Priority is owned by resolveSessionId (client header / body field /
 * assistant-output anchor / workspaceId / connectionId) — this wrapper only adds
 * the fallbacks that make the result stable and UUID-shaped.
 *
 * @param {object} opts
 * @param {object} [opts.credentials] - Provider credentials (rawHeaders read here)
 * @param {object} [opts.body] - Outbound (translated) request body
 * @param {string} [opts.scope] - Provider scope, isolates cache keys
 * @param {string} [opts.fallbackSeed] - Seed for an id when nothing else exists
 * @param {object} [opts.format] - Shape of the returned id, for upstreams that
 *   refuse canonical UUIDs: { flavor: "hex", length: 24 }
 * @returns {string} UUID-shaped (unless `format` says otherwise), conversation-stable id
 */
export function resolveConversationId({ credentials, body, scope = "", fallbackSeed = "", format = null } = {}) {
  // Hand the client's headers over untouched: the session manager already does
  // case-insensitive lookup and already knows which names are conversation-scoped
  // (and must exclude the request-scoped ones, e.g. x-client-request-id).
  const rawHeaders = credentials?.rawHeaders && typeof credentials.rawHeaders === "object"
    ? credentials.rawHeaders
    : {};

  let sessionId = "";
  try {
    sessionId = resolveSessionId({
      headers: rawHeaders,
      body,
      connectionId: credentials?.connectionId || credentials?.id || credentialSeed(credentials),
      workspaceId: credentials?.providerSpecificData?.workspaceId,
      scope,
    });
  } catch {
    // A hostile body must not break routing: fall through to the seed.
    sessionId = "";
  }

  const uuid = toUuidShaped(`${scope}:${sessionId || fallbackSeed || "anonymous"}`);

  // Some gateways reject canonical UUIDs and demand the web client's own
  // shape (chatglm.cn uses 24 bare hex chars). Same stable value, reformatted.
  if (format?.flavor === "hex") {
    const length = Number(format.length) || 24;
    return uuid.replace(/-/g, "").slice(0, length);
  }
  return uuid;
}

/**
 * True when the caller already supplied a conversation id we should honour
 * instead of deriving one.
 */
export function hasExplicitConversationId(body) {
  try {
    for (const field of ["session_id", "conversation_id", "prompt_cache_key"]) {
      if (typeof body?.[field] === "string" && body[field].trim()) return true;
    }
    const userId = body?.metadata?.user_id;
    if (typeof userId === "string" && userId.trim()) return true;
    return body?.request?.sessionId != null && String(body.request.sessionId) !== "";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Upstream-minted conversation ids
//
// Some upstreams (ChatGPT Web) mint the conversation id themselves and hand it
// back in the response. It cannot be derived — it can only be remembered, and
// the next turn must send it back or upstream starts a brand-new conversation.
//
// Keyed on the same stable session identity as everything else here, and stored
// through the session manager's persistent store, so the mapping survives a
// restart too.
// ---------------------------------------------------------------------------

const upstreamConversationIds = new Map();
const MAX_UPSTREAM_IDS = 5000;

/**
 * Store the conversation id upstream just created.
 * @param {object} opts - Same shape as resolveConversationId
 * @param {string} upstreamId - The id to remember
 */
export function rememberUpstreamConversationId({ credentials, body, scope = "" } = {}, upstreamId) {
  if (!upstreamId || typeof upstreamId !== "string") return;
  const key = stableKey({ credentials, body, scope });
  if (upstreamConversationIds.size >= MAX_UPSTREAM_IDS) {
    upstreamConversationIds.delete(upstreamConversationIds.keys().next().value);
  }
  upstreamConversationIds.set(key, upstreamId);
}

/**
 * Recall the conversation id upstream created for this conversation, if any.
 * @returns {string | null}
 */
export function recallUpstreamConversationId({ credentials, body, scope = "" } = {}) {
  return upstreamConversationIds.get(stableKey({ credentials, body, scope })) || null;
}

/** Test hook: drop every remembered upstream conversation id. */
export function resetUpstreamConversations() {
  upstreamConversationIds.clear();
}

function stableKey({ credentials, body, scope = "" } = {}) {
  let sessionId = "";
  try {
    sessionId = resolveSessionId({
      headers: credentials?.rawHeaders || {},
      body,
      connectionId: credentials?.connectionId || credentials?.id || "",
      scope,
    });
  } catch {
    sessionId = "";
  }
  return `${scope}:${sessionId}`;
}
