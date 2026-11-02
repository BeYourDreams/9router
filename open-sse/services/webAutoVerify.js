// Humans-in-the-loop recovery for every web-cookie provider: when a request
// comes back with a captcha challenge or a dead session, pop the provider's
// "Login via Browser" window unprompted and wait.
//
// Scope decision: the hook lives in throttledExecute — the single seam ALL
// webCookie providers pass — so a new provider gets recovery for free instead
// of remembering to. One window per provider+connection, rate-limited: a
// challenge storm must not spawn a browser per request. Opt out: WEB_AUTO_VERIFY=0.
//
// The window is driven by the EXISTING manual flow, not a guessed signal:
//   open → user solves captcha / logs in → clicks "Read key" → webLogin flips
//          the session to "success" and the web-login route saves the fresh
//          credential → this watcher mirrors it onto the challenged connection
//          and closes the window.
// Watching the cookie jar itself was tried and is wrong: a warm profile
// rewrites analytics cookies (ttwid/isg) seconds after launch, so "the jar
// changed" fires before the human touched anything (window pops, dies in 5s),
// and a slide-captcha (doubao) is cleared server-side WITHOUT rotating the
// login token at all — jar-diff can never be proof. "Read key" is the only
// authoritative "I am done", and it also runs the real identity probe.
// Unresolved at timeout: the window stays open. A window someone is mid-solve
// in must never be closed by a timer.

import { getProviderConnections, updateProviderConnection } from "@/models";
import { WEB_THROTTLE_CONFIG } from "../config/runtimeConfig.js";
import { getWebLoginConfig } from "./webLoginConfig.js";
import { startWebLogin, getWebLoginStatus, cancelWebLogin } from "./webLogin.js";
import { hasDisplay } from "./virtualDisplay.js";

const ms = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const OPEN_COOLDOWN_MS = ms("WEB_AUTO_VERIFY_COOLDOWN_MS", 10 * 60 * 1000); // per provider+connection
const POLL_INTERVAL_MS = ms("WEB_AUTO_VERIFY_POLL_MS", 5000);
// Human time, generously. On expiry the timeout only stops the mirror-watch —
// the route saves on its own when the user finally clicks Read key.
const WAIT_TIMEOUT_MS = ms("WEB_AUTO_VERIFY_TIMEOUT_MS", 5 * 60 * 1000);

const EXPIRED_MARKERS = [
  "cookie expired",
  "session expired",
  "invalid or expired",
  "expired —",
  "rejected the cookie",
  "re-login",
  "re-paste",
  "log in again",
  "not signed in",
  "unauthorized",
];

const openedAt = new Map(); // key -> timestamp
const inFlight = new Set(); // key

export function isVerifyChallenge(text = "") {
  const lower = String(text).toLowerCase();
  return WEB_THROTTLE_CONFIG.challengeMarkers.some((m) => lower.includes(m));
}

export function isExpiredSession(text = "") {
  const lower = String(text).toLowerCase();
  return EXPIRED_MARKERS.some((m) => lower.includes(m));
}

export function autoVerifyEnabled() {
  if (process.env.WEB_AUTO_VERIFY === "0") return false;
  // A headed window nobody can see is not a fix — it is a leaked Chromium and a
  // "human verification" that never happens.
  if (process.platform === "linux" && !hasDisplay()) return false;
  return true;
}

/**
 * Map an executor's answer to a human action.
 * 401 is an auth failure by definition (webCookie providers authenticate with
 * the session cookie); 403/429 need the body — a plain 403 (region block) or a
 * quota 429 must NOT raise a browser.
 */
export function verifyReason(status, text = "") {
  if (status === 401) return "expired";
  if (status !== 403 && status !== 429) return null;
  if (isVerifyChallenge(text)) return "captcha";
  if (status === 403 && isExpiredSession(text)) return "expired";
  return null;
}

/** Sync guards first, so a non-event costs one field read. Never throws. */
export function maybeOpenVerifyWindow({ provider, connectionId, credentials, response, log }) {
  if (!autoVerifyEnabled() || !response || !getWebLoginConfig(provider)) return false;
  const status = response.status;
  if (status !== 401 && status !== 403 && status !== 429) return false;
  const key = `${provider}:${connectionId || credentials?.connectionId || "-"}`;
  if (inFlight.has(key)) return false;
  const last = openedAt.get(key) || 0;
  if (Date.now() - last < OPEN_COOLDOWN_MS) return false;

  // Claim the slot before awaiting: two concurrent failures would otherwise
  // both pass the cooldown check and fight over the browser profile.
  openedAt.set(key, Date.now());
  inFlight.add(key);
  runVerify({ provider, connectionId, credentials, response, status, log, key }).finally(() =>
    inFlight.delete(key)
  );
  return true;
}

const sleep = (delay) => new Promise((done) => setTimeout(done, delay));

async function runVerify({ provider, connectionId, credentials, response, status, log, key }) {
  let reason = status === 401 ? "expired" : null;
  try {
    if (!reason) {
      // Read a clone: the client is still waiting on this body.
      reason = verifyReason(status, await response.clone().text().catch(() => ""));
      if (!reason) {
        openedAt.delete(key); // not our event (quota, region block) — keep the cooldown free
        return;
      }
    }

    const profile = credentials?.providerSpecificData?.webLoginProfile || "default";
    log?.warn?.(
      "VERIFY",
      `${provider}: ${reason === "expired" ? "session expired" : "captcha challenge"} — browser window opened (profile "${profile}"). Fix the login there, then click "Login via Browser" → Read key`
    );
    const session = await startWebLogin(provider, profile);
    if (session.status === "error") {
      log?.warn?.("VERIFY", `${provider}: could not open the window — ${session.error}`);
      return;
    }

    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const current = getWebLoginStatus(provider);
      if (!current) return;
      if (current.status === "cancelled" || !current.context) return; // window is gone
      if (current.status === "success") {
        // The web-login route has already saved the fresh credential (possibly
        // onto a different row — it matches by account email). Point the
        // challenged row at the same cookie, so the retry does not hit the
        // dead one again.
        await mirrorSavedCredential(provider, current, connectionId || credentials?.connectionId, log);
        cancelWebLogin(provider); // our window, our cleanup — theirs stays open
        openedAt.delete(key); // solved: a stale cookie again should open again now
        return;
      }
    }
    log?.warn?.("VERIFY", `${provider}: no login captured in ${Math.round(WAIT_TIMEOUT_MS / 60000)}min — window left open; "Login via Browser" → Read key still saves it`);
  } catch (error) {
    log?.warn?.("VERIFY", `${provider}: ${error?.message || error}`);
  }
}

/** Best-effort, never throws: a failed mirror must not lose the saved login. */
async function mirrorSavedCredential(provider, session, connectionId, log) {
  if (!connectionId) return;
  try {
    const rows = await getProviderConnections({ provider });
    const saved = rows.find((r) => r.id === session.savedConnectionId) || rows.find((r) => r.apiKey);
    if (!saved?.apiKey) {
      log?.warn?.("VERIFY", `${provider}: login captured — retry should work now`);
      return;
    }
    if (saved.id === connectionId) {
      log?.warn?.("VERIFY", `${provider}: connection refreshed — retry should work now`);
      return;
    }
    await updateProviderConnection(connectionId, {
      apiKey: saved.apiKey,
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      isActive: true,
    });
    log?.warn?.("VERIFY", `${provider}: fresh cookie mirrored onto the challenged connection — retry works now`);
  } catch (error) {
    log?.warn?.("VERIFY", `${provider}: captured but NOT mirrored (${error?.message || error}) — the dashboard row is still saved`);
  }
}

/** Test hook: forget cooldowns. */
export function resetAutoVerify() {
  openedAt.clear();
  inFlight.clear();
}
