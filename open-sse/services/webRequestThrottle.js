// Request pacing for web-cookie (browser-session) providers.
//
// Why this exists: a web provider is a HUMAN account on a website. Its anti-bot
// scores "is this a browser acting like a person", not "is this a valid API
// key". Hammering it with an unbounded parallel worker pool reads as automation
// and the account gets throttled, challenged, or banned outright — and unlike an
// API key, a banned web session cannot be re-minted by waiting for a quota reset.
//
// So on top of the API-level 429 handling (which is reactive: it fires AFTER
// upstream already noticed), web providers need PROACTIVE pacing:
//
//   1. Concurrency cap — at most N requests in flight per account, so a burst
//      never becomes a visible spike.
//   2. Minimum spacing — requests leave at most every `minIntervalMs`; a burst
//      of 20 fans out over time instead of in one instant.
//   3. Burst budget (token bucket) — caps short-term rate while still allowing
//      brief bursts, i.e. the shape a human typist produces.
//   4. Adaptive backoff — after a 429/403/challenge, pace down for a while
//      before returning to baseline, instead of resuming at full speed and
//      getting banned on the retry.
//
// Keying: per CONNECTION (each web login = one account) when a connection id is
// available, falling back to per (provider + credential fingerprint). Multiple
// accounts of the same provider never share a budget — rotating across accounts
// is the whole point of account failover and must not be throttled away.
//
// Failing open: any internal error releases immediately. A throttle bug must
// degrade to "no pacing", never to "requests hang forever".

import { createHash } from "node:crypto";
import { WEB_THROTTLE_CONFIG } from "../config/runtimeConfig.js";

const CONFIG = WEB_THROTTLE_CONFIG;

/** Per-key runtime state. */
class Bucket {
  constructor() {
    this.tokens = CONFIG.burst;
    this.updatedAt = Date.now();
    this.inFlight = 0;
    this.lastStart = 0;     // timestamp of the last request that left
    this.chain = Promise.resolve();
    this.penaltyUntil = 0;  // adaptive slowdown window
    this.penaltyLevel = 0;
    this.stats = { total: 0, throttled: 0, rejected: 0, waitedMs: 0 };
  }

  refill(now) {
    const elapsed = now - this.updatedAt;
    if (elapsed <= 0) return;
    this.updatedAt = now;
    if (elapsed >= CONFIG.resetMs) {
      this.tokens = CONFIG.burst;   // idle for a full window → full bucket, don't carry debt
      return;
    }
    this.tokens = Math.min(CONFIG.burst, this.tokens + (elapsed / CONFIG.resetMs) * CONFIG.burst);
    // Long idle also decays the penalty: coming back after a quiet period
    // should not still be pacing at the penalised rate.
    if (elapsed > CONFIG.penaltyMs) this.penaltyLevel = 0;
  }

  /** Extra spacing while an account is being penalised after a throttle signal. */
  penaltyInterval(now) {
    if (now >= this.penaltyUntil || this.penaltyLevel <= 0) return 0;
    return Math.min(
      CONFIG.maxPenaltyIntervalMs,
      CONFIG.minIntervalMs * 2 ** this.penaltyLevel,
    );
  }
}

const buckets = new Map();

function bucketFor(key) {
  let b = buckets.get(key);
  if (!b) {
    b = new Bucket();
    buckets.set(key, b);
  }
  return b;
}

// Buckets are created per key and never individually deleted, so bound the map:
// a long-lived gateway rotating hundreds of web accounts must not leak. Entries
// are dropped oldest-first once the cap is hit.
const MAX_BUCKETS = 512;
function evictIfNeeded() {
  if (buckets.size <= MAX_BUCKETS) return;
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, b] of buckets) {
    if (b.updatedAt >= oldestAt) continue;
    oldestAt = b.updatedAt;
    oldestKey = key;
  }
  if (oldestKey) buckets.delete(oldestKey);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stable fingerprint so the key never holds the raw credential. */
function fingerprint(value) {
  if (!value) return "";
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

/**
 * Build the throttle key. `connectionId` (one row = one account) is preferred;
 * the credential fingerprint is the fallback so a connection saved before
 * ids were threaded through still gets its own budget.
 */
export function webThrottleKey({ connectionId, provider, credentials }) {
  if (connectionId) return `conn:${connectionId}`;
  const cred = credentials?.apiKey || credentials?.accessToken || "";
  return `cred:${provider || "unknown"}:${fingerprint(cred)}`;
}

/**
 * Acquire a slot. Resolves with a release function the caller MUST invoke when
 * the request settles — the slot is what caps concurrency, so a forgotten
 * release would wedge the account permanently.
 */
export async function acquireWebSlot(key, { log, tag } = {}) {
  const b = bucketFor(key);
  const arrivedAt = Date.now();

  // Serialise scheduling per key: each waiter computes its own wait against the
  // state the previous waiter left behind, so N concurrent callers cannot all
  // read the same snapshot and fire simultaneously.
  const scheduled = b.chain.then(async () => {
    let waited = 0;
    for (let guard = 0; guard < 100; guard++) {
      const now = Date.now();
      b.refill(now);

      const spacing = Math.max(CONFIG.minIntervalMs, b.penaltyInterval(now));
      const sinceLast = now - b.lastStart;
      const spacingWait = b.lastStart && sinceLast < spacing ? spacing - sinceLast : 0;

      // Token bucket: 1 token per request.
      const tokenWait = b.tokens >= 1 ? 0 : Math.ceil(((1 - b.tokens) / CONFIG.burst) * CONFIG.resetMs);

      // Concurrency cap: wait while the account is saturated.
      const concurrencyWait = b.inFlight >= CONFIG.maxConcurrent ? spacing : 0;

      const waitMs = Math.max(spacingWait, tokenWait, concurrencyWait);
      if (waitMs <= 0) break;

      if (waited + waitMs > CONFIG.maxWaitMs) {
        b.stats.rejected++;
        const err = new Error(
          `Web request throttled: waited ${Math.round((waited + waitMs) / 1000)}s for a slot on ${key} — upstream pacing is saturated`,
        );
        err.code = "WEB_THROTTLE_TIMEOUT";
        err.throttleKey = key;
        throw err;
      }

      if (waitMs > 0) {
        b.stats.waitedMs += waitMs;
        log?.debug?.(tag || "THROTTLE", `pacing ${waitMs}ms on ${key} (inFlight=${b.inFlight} tokens=${b.tokens.toFixed(2)})`);
        await sleep(waitMs);
        waited += waitMs;
      }
    }

    const now = Date.now();
    b.refill(now);
    b.tokens -= 1;
    b.inFlight += 1;
    b.lastStart = Date.now();
    b.stats.total++;
    if (waited > 0) b.stats.throttled++;
    return waited;
  });

  // Keep the chain alive even if this waiter throws, so one rejection does not
  // poison every subsequent request on this key.
  b.chain = scheduled.catch(() => {});

  let waited = 0;
  let release = () => {};
  try {
    waited = await scheduled;
  } catch (err) {
    evictIfNeeded();
    throw err;
  }

  let released = false;
  release = () => {
    if (released) return;   // idempotent: callers often release in finally + on error
    released = true;
    b.inFlight = Math.max(0, b.inFlight - 1);
  };

  evictIfNeeded();
  return { release, waitedMs: waited, key };
}

/**
 * Report an upstream signal. 429 / 403 / a challenge all mean "slow down" —
 * doing so proactively avoids the escalation that gets the session banned.
 */
export function reportWebThrottleSignal(key, { status, bodyText = "" } = {}) {
  // Create on demand: the first response an account ever gets can BE the 429,
  // and dropping it would leave the account pacing at full speed into a ban.
  const b = bucketFor(key);

  const text = String(bodyText || "").toLowerCase();
  const isChallenge = CONFIG.challengeMarkers.some((m) => text.includes(m));
  const isThrottle = status === 429 || status === 403 || isChallenge;
  if (!isThrottle) return false;

  b.penaltyLevel = Math.min(b.penaltyLevel + 1, CONFIG.maxPenaltyLevel);
  b.penaltyUntil = Date.now() + CONFIG.penaltyMs;
  // Drain the burst budget: after a throttle signal, no free burst.
  b.tokens = 0;
  evictIfNeeded();
  return true;
}

/**
 * Run `fn` under the throttle.
 *
 * `statusOf` extracts the upstream HTTP status from whatever the caller's `fn`
 * returns — executors differ (some return `{response}`, some a bare Response,
 * some throw with a status attached). Returning a plain number keeps the
 * throttle from having to know every shape.
 */
export async function withWebThrottle(key, fn, { log, tag, statusOf, onThrottled } = {}) {
  let release = () => {};
  try {
    ({ release } = await acquireWebSlot(key, { log, tag }));
  } catch (err) {
    // A scheduling failure must not be swallowed: the caller decides whether a
    // throttle timeout is a 429 or a retry.
    throw err;
  }
  try {
    const result = await fn();
    const status = statusOf ? statusOf(result) : result?.response?.status;
    if (status && reportWebThrottleSignal(key, { status })) onThrottled?.(result, key);
    return result;
  } finally {
    release();
  }
}

function snapshot(b) {
  return {
    inFlight: b.inFlight,
    tokens: Number(b.tokens.toFixed(2)),
    penaltyLevel: b.penaltyLevel,
    penalised: Date.now() < b.penaltyUntil,
    ...b.stats,
  };
}

/** Snapshot for the dashboard / logs. */
export function webThrottleStats(key) {
  const b = buckets.get(key);
  return b ? { key, ...snapshot(b) } : null;
}

export function listWebThrottleStats() {
  return [...buckets.entries()].map(([key, b]) => ({ key, ...snapshot(b) }));
}

/** Test hook: drop all state. */
export function resetWebThrottles() {
  buckets.clear();
}

export { CONFIG as WEB_THROTTLE_LIMITS };
