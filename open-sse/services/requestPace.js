// Global model-request pacing (全局请求速率限制).
//
// One FIFO queue for the whole process: at most one model request *starts* per
// interval, everything else waits its turn. Enabled by default
// (settings.requestPaceEnabled + requestPaceSeconds, default 3s); the dashboard
// can switch it off, and the interval is read per call so a settings change
// applies to the next request, no restart.
//
// ponytail: the queue is unbounded but a waiter gives up after MAX_WAIT_MS and
// proceeds (fail-open) — a burst of hundreds must not wedge the lane forever.
// Upgrade path: a bounded queue with a 429 + Retry-After if that ever matters.
// Aborting (client disconnect) rejects the waiter and leaves the queue intact.

const state = (globalThis.__9rRequestPace ??= { chain: Promise.resolve(), lastStart: 0 });

const MAX_WAIT_MS = 120_000;

function abortError() {
  const err = new Error("Request aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Wait for the next global slot. Resolves with the milliseconds waited.
 * No-op when intervalMs is not a positive number (pacing off).
 */
export async function acquireRequestPace({ intervalMs, signal, log } = {}) {
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return 0;
  if (signal?.aborted) throw abortError();

  const scheduled = state.chain.then(async () => {
    const arrivedAt = Date.now();
    let wait = state.lastStart + interval - arrivedAt;
    if (wait > MAX_WAIT_MS) {
      log?.warn?.("PACE", "global queue saturated (wait " + Math.round(wait / 1000) + "s) — proceeding unpaced");
      wait = 0;
    }
    if (wait > 0) {
      log?.debug?.("PACE", "queued " + Math.round(wait) + "ms (interval " + interval + "ms)");
      await sleep(wait, signal);
    }
    state.lastStart = Date.now();
    return Date.now() - arrivedAt;
  });

  // Keep the chain alive when a waiter aborts, or one disconnect poisons the queue.
  state.chain = scheduled.catch(() => {});
  return scheduled;
}

/** Test hook: drop the queue state. */
export function resetRequestPace() {
  state.chain = Promise.resolve();
  state.lastStart = 0;
}
