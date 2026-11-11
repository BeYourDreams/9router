// Shared free-lane handling for the OpenCode executors (opencode, opencode-zen).
// Both routes reach the same opencode.ai inference lane, so both need the same
// two fixes: retry the transient load-shedding 429, and stop reusing a session
// id upstream has spent or flagged.

// Free-lane load shedding: total attempts (first try + retries) and backoff.
// Live bursts last ~20 s (a request that kept failing for 8 s succeeded at 19 s),
// so the schedule below covers 800+1600+2400+3200+4000*3 = ~20 s.
const OVERLOAD_ATTEMPTS = 8;
const OVERLOAD_BASE_MS = 800;
const OVERLOAD_MAX_MS = 4000;
const OVERLOAD_RE = /overloaded/i;

/**
 * Classify a gated free-lane rejection:
 * - "overload": transient 429 load shedding, worth retrying.
 * - "session":  any other 429 (FreeUsageLimitError) or 403, which can mean the
 *               session id itself is spent or flagged.
 * - null:       anything else.
 */
async function classifyRejection(response) {
  const status = response?.status;
  if (status !== 429 && status !== 403) return null;
  if (status === 403) return "session";
  try {
    // The body is the response stream; clone it so a non-retryable 429 is still
    // delivered intact to the caller.
    return OVERLOAD_RE.test(await response.clone().text()) ? "overload" : "session";
  } catch {
    return "session";
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

// Memoized sessions are never refreshed on failure, so once upstream spends or
// flags one, every later request reuses it and fails the same way until restart
// (#5559). Drop the rejected id so the next request mints a fresh one. Match by
// value, not identity key: a concurrent request may already have minted a
// replacement, which must survive. Ids a client supplied live in no store, so
// they are never touched.
export function forgetSession(stores, sessionId) {
  if (!sessionId) return false;
  let removed = false;
  for (const store of stores) {
    for (const [key, entry] of store) {
      if (entry.sessionId === sessionId) {
        store.delete(key);
        removed = true;
      }
    }
  }
  return removed;
}

/**
 * Run `run()` and post-process the response: retry transient overloads with
 * backoff, and hand back every other response untouched. (Base retry does not
 * cover this: DEFAULT_RETRY_CONFIG sets 429 attempts to 0.)
 */
export async function executeFreeLane({ run, stores, sessionId, signal, log }) {
  for (let attempt = 1; ; attempt++) {
    const result = await run();
    const rejection = await classifyRejection(result?.response);
    if (rejection === "session") {
      if (forgetSession(stores, sessionId)) {
        log?.debug?.("SESSION", `OpenCode ${result.response.status}: dropped cached session, next request re-mints`);
      }
      return result;
    }
    // A disconnected client should not keep the retry loop (and the free lane)
    // busy for another ~20 s.
    if (rejection !== "overload" || attempt >= OVERLOAD_ATTEMPTS || signal?.aborted) {
      return result;
    }
    // Release the discarded 429 instead of leaving its stream half-read.
    result.response.body?.cancel?.().catch?.(() => {});
    log?.debug?.("RETRY", `OpenCode free lane overloaded, retry ${attempt}/${OVERLOAD_ATTEMPTS - 1}`);
    const backoff = Math.min(OVERLOAD_BASE_MS * attempt, OVERLOAD_MAX_MS);
    await sleep(backoff + Math.random() * 250, signal);
    // Aborted mid-backoff: surface it the way a disconnect during the fetch does.
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  }
}