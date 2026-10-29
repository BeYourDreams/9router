/**
 * Session Manager for Antigravity Cloud Code
 *
 * Handles session ID generation and caching for prompt caching continuity.
 * Mimics the Antigravity binary behavior: generates a session ID at startup
 * and keeps it for the process lifetime, scoped per account/connection.
 *
 * Reference: antigravity-claude-proxy/src/cloudcode/session-manager.js
 */

import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { getWritableDataDir } from "./writableDataDir.js";

// ---------------------------------------------------------------------------
// Disk persistence
//
// Session ids live in Maps, so anything that drops the module — a dev HMR
// reload, a `next dev` recompile, a server restart — hands every connection a
// brand-new id. Upstream keys its prompt cache on that id, so the very next
// turn after a reload is a cold cache miss and the user pays full input price
// again.
//
// Mirroring the three stores to disk keeps ids stable across reloads. Writes
// are debounced and best-effort: a read-only data dir must never break routing.
// ---------------------------------------------------------------------------

const SESSION_STORE_FILE = "session-store.json";
const PERSIST_DEBOUNCE_MS = 2000;

function storeFilePath() {
  try {
    return path.join(getWritableDataDir(), SESSION_STORE_FILE);
  } catch {
    return null;
  }
}

/**
 * A Map that survives process reloads.
 * Entries are `{ value, lastUsed }` — `lastUsed` drives both in-memory TTL and
 * the prune-on-load step, so a store idle for days does not grow forever.
 */
// Every store registers its flush handler here so one process-level hook can
// persist all of them on shutdown.
const STORES = [];
function createPersistentStore(name, maxEntries) {
  const map = new Map();
  let timer = null;
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    const file = storeFilePath();
    if (!file) return;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      const bucket = parsed?.[name];
      if (!bucket || typeof bucket !== "object") return;
      // The TTL means "this conversation went idle", NOT "wall-clock time passed".
      // Downtime is not idleness: the user shut the gateway down overnight and is
      // resuming the very same conversation this morning. Pruning on absolute
      // lastUsed therefore threw away every session after a restart, which is the
      // opposite of what persisting them is for. Only prune when traffic true-ups
      // (see the touch below), i.e. real elapsed conversation inactivity.
      const cutoff = Date.now() - MEMORY_CONFIG.sessionTtlMs;
      let retained = 0;
      for (const [key, entry] of Object.entries(bucket)) {
        if (!entry || typeof entry.value !== "string") continue;
        const lastUsed = Number(entry.lastUsed) || Date.now();
        // Restart carries every recently-active session over; only entries that
        // were ALREADY idle before the restart (and have since been superseded by
        // fresher ones) are dropped, so the loaded store stays bounded without
        // discarding live conversations after downtime.
        if (lastUsed < cutoff && retained >= MAX_LOAD_ENTRIES) continue;
        retained++;
        map.set(key, { value: entry.value, lastUsed });
      }
    } catch {
      // Missing/corrupt file: start empty. Never throw during module init.
    }
  }

  function flush() {
    const file = storeFilePath();
    if (!file) return;
    try {
      let parsed = {};
      try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* start fresh */ }
      if (!parsed || typeof parsed !== "object") parsed = {};
      const bucket = {};
      for (const [key, entry] of map) bucket[key] = { value: entry.value, lastUsed: entry.lastUsed };
      parsed[name] = bucket;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(parsed), "utf8");
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      // Read-only or full disk: persistence is an optimization, not a requirement.
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, PERSIST_DEBOUNCE_MS);
    if (timer.unref) timer.unref();
  }

  // Flush whatever is pending, synchronously. Registered on process exit so a
  // restart inside the debounce window does not lose the ids it just minted —
  // with the timer unref'd, Node would otherwise exit without ever running it.
  function flushNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  }

  STORES.push(flushNow);

  return {
    get(key) {
      load();
      return map.get(key);
    },
    set(key, value) {
      load();
      // Evict oldest when over cap (safety net between cleanup cycles).
      if (map.size >= maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined && !map.has(key)) map.delete(oldest);
      }
      map.set(key, { value, lastUsed: Date.now() });
      schedule();
    },
    delete(key) {
      map.delete(key);
      schedule();
    },
    clear() {
      map.clear();
      schedule();
    },
    /** Iterate for TTL cleanup without touching lastUsed. */
    entries() {
      return map.entries();
    },
    /** Best-effort synchronous flush (tests, shutdown). */
    flush,
  };
}

// Persist on the way out. Without this, a restart inside the debounce window
// loses every id minted since the last flush: the debounce timer is unref'd so
// Node exits without running it. `exit` is synchronous-only, which is exactly
// what writeFileSync needs; SIGINT/SIGTERM are handled separately because
// `exit` does not fire when a signal terminates the process.
export function flushAllSessionStores() {
  for (const flush of STORES) {
    try { flush(); } catch { /* best-effort: never block shutdown */ }
  }
}

let hooksRegistered = false;
function registerShutdownHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const persist = () => flushAllSessionStores();
  process.once("exit", persist);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      persist();
      // Re-raise so the default behaviour (and any other listener) still runs.
      process.kill(process.pid, signal);
    });
  }
}
registerShutdownHooks();

// Runtime storage: Key = connectionId, Value = { value: sessionId, lastUsed }
const runtimeSessionStore = createPersistentStore("runtime", 1000);
const continuationStore = createPersistentStore("continuation", 5000);

// Periodically evict entries that haven't been used within TTL
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of runtimeSessionStore.entries()) {
        if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
            runtimeSessionStore.delete(key);
        }
    }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);

// Allow Node.js to exit even if interval is still active
if (cleanupInterval.unref) cleanupInterval.unref();

/**
 * Get or create a session ID for the given connection.
 *
 * The binary generates a session ID once at startup: `rs() + Date.now()`.
 * Since 9router is long-running, we simulate this "per-launch" behavior by
 * storing a generated ID in memory for each connection.
 *
 * - If 9router restarts, the ID changes (matching binary restart behavior).
 * - Within a running instance, the ID is stable for that connection.
 * - This enables prompt caching while using the EXACT random logic of the binary.
 *
 * @param {string} connectionId - The connection identifier (email or unique ID)
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(connectionId) {
    if (!connectionId) {
        return generateBinaryStyleId();
    }

    const existing = runtimeSessionStore.get(connectionId);
    if (existing) {
        // Refresh the TTL in place (the store persists `lastUsed` to disk).
        runtimeSessionStore.set(connectionId, existing.value);
        return existing.value;
    }

    const sessionId = generateBinaryStyleId();
    runtimeSessionStore.set(connectionId, sessionId);
    return sessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * Format: `rs() + Date.now()` where `rs()` is randomUUID
 *
 * @returns {string} A session ID in binary format
 */
export function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs (e.g. useful for testing or explicit reset)
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
    assistantSessionStore.clear();
    continuationStore.clear();
}

// Conversation-stable session store: Key = hash(scope+assistant text)
const assistantSessionStore = createPersistentStore("assistant", 5000);
const MAX_LOAD_ENTRIES = 500;
const ASSISTANT_MIN_LEN = 50;
const ASSISTANT_CAP_LEN = 50;
const MAX_CONTINUATION_SESSIONS = 5000;

// Client headers/body fields that carry an upstream session id (priority order)
const SESSION_HEADER_KEYS = ["x-session-id", "session-id", "session_id", "x-amp-thread-id"];
const CLAUDE_CODE_SESSION_RE = /_session_([a-f0-9-]+)$/;
const CLAUDE_CODE_SESSION_HEADER = "x-claude-code-session-id";

function sha16(text) {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Normalize a session id candidate (trim, length cap)
function normalizeSessionId(value) {
    if (typeof value !== "string") return null;
    const v = value.trim();
    if (!v || v.length > 256) return null;
    return v;
}

// Extract Claude Code session id from metadata.user_id (_session_{uuid} | JSON {session_id})
function extractClaudeCodeSession(userId) {
    if (typeof userId !== "string" || !userId) return null;
    const m = userId.match(CLAUDE_CODE_SESSION_RE);
    if (m) return m[1];
    if (userId[0] === "{") {
        try { return normalizeSessionId(JSON.parse(userId)?.session_id); } catch { /* noop */ }
    }
    return null;
}

// Lowercase-key lookup for raw client headers
function headerValue(headers, key) {
    if (!headers || typeof headers !== "object") return null;
    return normalizeSessionId(headers[key] ?? headers[key.toLowerCase()]);
}

// Read client-provided session id from headers/body (no generation)
// Antigravity envelope carries session in request.sessionId; requestId embeds conversation uuid
const ANTIGRAVITY_CONV_RE = /^[a-z]+\/([0-9a-f-]{36})\//i;
function extractAntigravitySession(body) {
    const sid = body?.request?.sessionId;
    if (sid != null && sid !== "") return normalizeSessionId(String(sid));
    const m = typeof body?.requestId === "string" ? body.requestId.match(ANTIGRAVITY_CONV_RE) : null;
    return m ? normalizeSessionId(m[1]) : null;
}

function extractClientSessionId(headers, body, scope = "") {
    // Claude Code sends the session in a header AND in metadata.user_id; the header
    // survives translation to formats that drop metadata (e.g. Responses API).
    const claude = extractClaudeCodeSession(body?.metadata?.user_id)
        || headerValue(headers, CLAUDE_CODE_SESSION_HEADER);
    if (claude) return `claude:${claude}`;
    const antigravity = extractAntigravitySession(body);
    if (antigravity) return `antigravity:${antigravity}`;
    for (const key of SESSION_HEADER_KEYS) {
        // x-client-request-id is request-scoped by definition — it must never seed a
        // conversation session, otherwise every request gets a new session and prompt
        // cache misses on every turn. Kiro already excluded it; extend to all scopes.
        if (key.toLowerCase() === "x-client-request-id") continue;
        const v = headerValue(headers, key);
        if (v) return v;
    }
    const fromBody =
        normalizeSessionId(body?.prompt_cache_key) ||
        normalizeSessionId(body?.session_id) ||
        normalizeSessionId(body?.conversation_id) ||
        (scope === "kiro" ? null : normalizeSessionId(body?.metadata?.user_id));
    return fromBody || null;
}

function requestMessages(body) {
    if (Array.isArray(body?.messages)) return body.messages;
    if (Array.isArray(body?.input)) return body.input;
    return [];
}

// Accumulate assistant output from OpenAI/Responses-style input/messages (cap-limited)
// A tool-only turn is still a turn: agent tool loops carry tool_use/tool_calls blocks
// and no text, and a text-only anchor would make every turn look like a new
// conversation — cache miss every turn.
function accumulateAssistantText(body) {
    const items = requestMessages(body);
    if (!items) return { text: "", hasTool: false };
    let text = "";
    let hasTool = false;
    for (const item of items) {
        if (item?.role !== "assistant") continue;
        if (typeof item.content === "string") text += item.content;
        else if (Array.isArray(item.content)) {
            for (const c of item.content) {
                if (c?.type === "tool_use") { hasTool = true; text += `${c.name || ""}${JSON.stringify(c.input || {})}`; }
                else text += c?.text || c?.output || "";
            }
        }
        for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
            hasTool = true;
            text += `${call?.function?.name || ""}${call?.function?.arguments || ""}`;
        }
        if (hasTool) break;              // one tool call is a stable anchor
        if (text.length >= ASSISTANT_CAP_LEN) break;
    }
    return { text, hasTool };
}

// Stable session id keyed on accumulated assistant output (avoids collision on identical first user prompt)
function assistantTextSessionId(scope, body) {
    const { text, hasTool } = accumulateAssistantText(body);
    if (!hasTool && text.length < ASSISTANT_MIN_LEN) return null;
    const hash = sha16(`${scope}:${text.slice(0, ASSISTANT_CAP_LEN)}`);
    return sessionIdForHash(assistantSessionStore, hash);
}

// First user turn of the conversation, flattened to text. This is the most
// durable anchor an agent conversation has: unlike the accumulated assistant
// output it does not move when the context is compacted/summarized, and unlike
// the connection id it separates two conversations that share one credential.
// Clients that send no session id at all (Pi configured with
// `api: "openai-completions"` sends neither a header nor a body field) have
// nothing else to key on.
const FIRST_USER_CAP_LEN = 200;
function firstUserSessionId(scope, body) {
    const items = requestMessages(body);
    for (const item of items) {
        // Only a conversation that has grown past its opening turn can be told
        // apart from a fresh one; a single user message is the start of both.
        if (item?.role === "user" && String(flattenContent(item.content)).trim()) {
            const text = String(flattenContent(item.content)).trim().slice(0, FIRST_USER_CAP_LEN);
            if (!text) return null;
            return sessionIdForHash(assistantSessionStore, sha16(`${scope}:first-user:${text}`));
        }
    }
    return null;
}

function flattenContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((c) => (typeof c === "string" ? c : c?.text || c?.output || "")).join("");
    }
    return "";
}

// Look up-or-mint, refreshing the TTL in place so a long conversation survives
// the cleanup sweep.
function sessionIdForHash(store, hash) {
    const existing = store.get(hash);
    if (existing) {
        store.set(hash, existing.value);
        return existing.value;
    }
    const sessionId = generateBinaryStyleId();
    store.set(hash, sessionId);
    return sessionId;
}

/**
 * Resolve a conversation-stable session id (generalizes Codex resolveCacheSessionId).
 * Priority: client session → accumulated-assistant-text hash → workspaceId → per-connection.
 *
 * @param {object} opts
 * @param {object} [opts.headers] - Raw client request headers (lowercase keys)
 * @param {object} [opts.body] - Parsed request body
 * @param {string} [opts.connectionId] - Connection identifier (fallback scope)
 * @param {string} [opts.workspaceId] - Provider workspace id (account-wide fallback)
 * @param {string} [opts.scope] - Provider scope to isolate cache keys across providers
 * @returns {{sessionId: string, ephemeral: boolean}} A session id plus whether it is one-shot
 */
export function resolveSessionIdentity({ headers, body, connectionId, workspaceId, scope = "" } = {}) {
    const client = extractClientSessionId(headers, body, scope);
    if (client) return { sessionId: client, ephemeral: false };
    // The opening user turn is tried BEFORE the accumulated assistant output:
    // it is the more durable anchor. Assistant text moves whenever an agent
    // compacts or summarizes its context, which starts a new session — and
    // therefore a cold cache — in the middle of a conversation. See the
    // `firstUserSessionId` comment below.
    const fromFirstUser = scope === "kiro" ? null : firstUserSessionId(`${scope}:${connectionId || ""}`, body);
    if (fromFirstUser) return { sessionId: fromFirstUser, ephemeral: false };
    const fromAssistant = scope === "kiro" ? null : assistantTextSessionId(`${scope}:${connectionId || ""}`, body);
    if (fromAssistant) return { sessionId: fromAssistant, ephemeral: false };
    const ws = normalizeSessionId(workspaceId);
    if (ws) return { sessionId: ws, ephemeral: false };
    if (scope === "kiro") return { sessionId: generateBinaryStyleId(), ephemeral: true };
    return { sessionId: deriveSessionId(connectionId), ephemeral: false };
}

export function resolveSessionId(opts = {}) {
    return resolveSessionIdentity(opts).sessionId;
}

export function resolveContinuationId({ sessionId, connectionId, scope = "", ephemeral = false } = {}) {
    if (ephemeral) return crypto.randomUUID();
    const key = `${scope}:${connectionId || ""}:${sessionId || ""}`;
    // The store normalizes to `{ value, lastUsed }` and persists it that way, so
    // the continuation id must live in `value` — reading a `continuationId`
    // property off the entry always came back undefined after the first turn.
    const existing = continuationStore.get(key);
    if (existing) {
        // Re-insert to move the key to the tail (recency order for eviction).
        continuationStore.delete(key);
        continuationStore.set(key, existing.value);
        return existing.value;
    }
    const continuationId = crypto.randomUUID();
    if (continuationStore.size >= MAX_CONTINUATION_SESSIONS) {
        continuationStore.delete(continuationStore.keys().next().value);
    }
    continuationStore.set(key, continuationId);
    return continuationId;
}

// Capture session id from request body + credentials (envelope still intact here)
export function captureSessionId(body, credentials, connectionId, scope = "") {
    return resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId, scope });
}

// Convert any session id to Antigravity numeric format "-<int64>" (matches real AG / CLIProxyAPI).
// Already-numeric ids (native AG sessionId) pass through unchanged.
export function toNumericSessionId(sessionId) {
    const v = normalizeSessionId(sessionId);
    if (!v) return null;
    if (/^-?\d+$/.test(v)) return v;
    const h = crypto.createHash("sha256").update(v).digest();
    const n = h.readBigUInt64BE(0) & 0x7fffffffffffffffn;
    return `-${n.toString()}`;
}

// Cleanup expired assistant-session entries
const assistantCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of assistantSessionStore) {
        if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) assistantSessionStore.delete(key);
    }
    for (const [key, entry] of continuationStore) {
        if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) continuationStore.delete(key);
    }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (assistantCleanup.unref) assistantCleanup.unref();
