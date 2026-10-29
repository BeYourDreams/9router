// Interactive web login capture for web-cookie providers.
//
// Opens a persistent HEADED Chrome window at the provider's login page using a
// per-provider profile under <DATA_DIR>/browser-profiles/web-login/. The user
// logs in by hand (and clears any Cloudflare challenge in that window); we
// poll the context until every required token from webLoginConfig is present,
// then serialize the whole cookie jar as a paste-equivalent credential.
//
// The profile persists, so a repeat login usually finds the session still
// alive and resolves in one poll — and a warm profile keeps cf_clearance.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { join } from "node:path";
import { loadRuntimeDep } from "./lazyRuntime.js";
import { getWebLoginConfig } from "./webLoginConfig.js";
import { getWritableDataDir } from "../utils/writableDataDir.js";
import { pruneProfileCaches, formatBytes } from "./browserProfileCache.js";
import { resolveSystemChromeExecutable } from "../executors/browserExecutableCheck.js";


// Shared browser profiles: one Google login in a profile makes every
// "Continue with Google" provider login a single click.
function profileDir(profileName) {
  return path.join(getWritableDataDir(), "browser-profiles", sanitizeProfileName(profileName));
}

function matchesDomain(cookieDomain, cookie) {
  const want = String(cookieDomain || "").replace(/^\./, "").toLowerCase();
  const host = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
  return !want || host === want || host.endsWith(`.${want}`);
}

/** Direct cookie value, or the joined `.0/.1/…` chunks (NextAuth/Supabase split large values). */
function findCookieValue(jar, source) {
  if (source.namePattern) {
    for (const [cookieName, value] of jar) if (source.namePattern.test(cookieName)) return value;
    return null;
  }
  for (const name of [source.name, ...(source.names || [])]) {
    if (!name) continue;
    const direct = jar.get(name);
    if (direct) return direct;
    const chunks = new Map();
    for (const [cookieName, value] of jar) {
      if (!cookieName.startsWith(`${name}.`)) continue;
      const idx = Number(cookieName.split(".").pop());
      if (Number.isInteger(idx)) chunks.set(idx, value);
    }
    const joined = [];
    for (let i = 0; chunks.has(i); i++) joined.push(chunks.get(i));
    if (joined.length) return joined.join("");
  }
  return null;
}

/**
 * Read the required tokens from a live browser context.
 * Returns { ready, cookieHeader, localStorageValues }.
 * Exported so the login flow can be exercised without a real browser.
 */
export async function harvest(context, config) {
  const cookies = (await context.cookies()).filter((cookie) => matchesDomain(config.cookieDomain, cookie));
  const jar = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
  const localStorageValues = {};
  for (const page of context.pages()) {
    if (localStorageValues[config.tokenSources[0]?.name]) break;
    try {
      const url = page.url();
      if (!/^https?:/.test(url)) continue;
      const found = await page.evaluate((names) => {
        const out = {};
        for (const name of names) {
          const value = window.localStorage?.getItem(name);
          if (value) out[name] = value;
        }
        return out;
      }, config.tokenSources.filter((source) => source.type === "localStorage").map((source) => source.name));
      Object.assign(localStorageValues, found);
    } catch {
      // Page may be mid-navigation; try the next page.
    }
  }
  const ready = config.tokenSources.every((source) => {
    const value = source.type === "cookie"
      ? findCookieValue(jar, source)
      : (localStorageValues[source.name] || null);
    // Optional sources enrich the credential without gating completion.
    if (source.optional) return true;
    if (!value) return false;
    if (source.validateCookie) return source.validateCookie(value);
    if (source.validateToken) return source.validateToken(value);
    if (config.validateToken) return config.validateToken(value);
    if (config.validateCookie) return config.validateCookie(value);
    return true;
  });
  const cookieHeader = cookies
    .filter((cookie) => cookie.value)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  return { ready, cookieHeader, localStorageValues };
}

// providerId -> { status, startedAt, credential?, error? }
const sessions = new Map();

// One Chromium lock per profile dir: a second launch on the same persistent
// profile fails, so refuse up front with an actionable message.
const busyProfiles = new Map(); // profileName -> providerId

export function getWebLoginStatus(providerId) {
  return sessions.get(providerId) || null;
}

/** Existing browser profiles the user can pick from (shared across providers). */
export function listWebLoginProfiles() {
  const root = path.join(getWritableDataDir(), "browser-profiles");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "web-login")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Close the headed window and free the profile lock. Browser is never closed on its own. */
async function closeBrowser(session) {
  const context = session.context;
  session.context = null;
  busyProfiles.delete(session.profile);
  if (!context) return;
  await context.close().catch(() => {});
  const dir = profileDir(session.profile);
  clearStaleSingletonLocks(dir);
  // Chrome's caches balloon far past the session data we keep; drop them
  // while the profile is closed and rebuilding is free.
  const pruned = pruneProfileCaches(dir);
  if (pruned.freedBytes > 0) {
    console.log("[webLogin] pruned", formatBytes(pruned.freedBytes), "from profile", session.profile);
  }
}

export function cancelWebLogin(providerId) {
  const session = sessions.get(providerId);
  if (!session) return false;
  if (session.status !== "success") session.status = "cancelled";
  closeBrowser(session).catch(() => {});
  return true;
}

function credentialFrom(found, config) {
  if (config.credentialFrom === "localStorageValue") {
    const source = config.tokenSources[0];
    let val = found.localStorageValues[source.name];
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed.value === "string") val = parsed.value;
    } catch {
      // not JSON, keep raw
    }
    return val;
  }
  // cookieValue: return only the value of the named cookie (pure token, no "name=" prefix).
  // Needed for providers that send Authorization: Bearer <token> rather than Cookie: name=<token>.
  if (config.credentialFrom === "cookieValue") {
    const name = config.cookieValueName || config.tokenSources[0]?.name;
    if (!name) return found.cookieHeader;
    const match = found.cookieHeader.match(new RegExp(`(?:^|;\\s*)${escapeRegExp(name)}=([^;]*)`));
    return match ? match[1] : found.cookieHeader;
  }
  return found.cookieHeader;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Snapshot the live window now — called when the user clicks "Read key" after
 * logging in by hand. Never closes the window; a miss just reports why.
 */
export async function readWebLoginCredential(providerId) {
  const session = sessions.get(providerId);
  if (!session) return { session: null, ready: false, reason: "no-session" };
  if (session.status === "success") return { session, ready: true };
  if (!session.context) return { session, ready: false, reason: "browser-closed" };
  const config = getWebLoginConfig(providerId);
  const found = await harvest(session.context, config);
  if (!found.ready) return { session, ready: false, reason: "not-logged-in" };
  session.credential = credentialFrom(found, config);
  session.status = "success";
  return { session, ready: true };
}

/** "default" unless the user picked/created a named profile. */
function sanitizeProfileName(name) {
  const cleaned = String(name || "").trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  return cleaned || "default";
}

export async function startWebLogin(providerId, profileName = "default") {
  const config = getWebLoginConfig(providerId);
  if (!config) throw new Error(`No web-login config for provider "${providerId}"`);
  const existing = sessions.get(providerId);
  if (existing?.status === "running" || existing?.status === "waiting") return existing;
  const profile = sanitizeProfileName(profileName);
  // A previous run may still hold the window/profile lock — replace it.
  if (existing?.context) await closeBrowser(existing);
  if (busyProfiles.has(profile)) {
    throw new Error(`Profile "${profile}" is already open for ${busyProfiles.get(profile)} — finish that login first or pick another profile`);
  }

  const session = { providerId, profile, status: "running", startedAt: Date.now() };
  sessions.set(providerId, session);
  busyProfiles.set(profile, providerId);
  // Launch is quick (~2s); the window then stays open for the user to drive.
  await runLogin(session, config).catch((error) => {
    session.status = "error";
    session.error = error?.message || String(error);
    closeBrowser(session).catch(() => {});
  });
  return session;
}

// Chromium leaves Singleton* lock files when a launch is killed; a stale lock
// makes every next launch fail with "ProcessSingleton". Remove and retry once.
function clearStaleSingletonLocks(dir) {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { rmSync(join(dir, name), { force: true }); } catch { /* best-effort */ }
  }
}

async function launchLoginBrowser(chromium, dir, executablePath) {
  try {
    return await chromium.launchPersistentContext(dir, {
      headless: false,
      executablePath,
      viewport: null,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-site-isolation-trials",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--disable-extensions-except=",
        "--disable-extensions",
        "--password-store=basic",
        "--use-mock-keychain",
      ],
    });
  } catch (error) {
    if (!/ProcessSingleton|SingletonLock/i.test(String(error?.message || ""))) throw error;
    clearStaleSingletonLocks(dir);
    return await chromium.launchPersistentContext(dir, {
      headless: false,
      executablePath,
      viewport: null,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-site-isolation-trials",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--disable-extensions-except=",
        "--disable-extensions",
        "--password-store=basic",
        "--use-mock-keychain",
      ],
    });
  }
}

async function runLogin(session, config) {
  const { chromium } = await loadRuntimeDep("playwright-core");
  const executablePath = resolveSystemChromeExecutable();
  if (!executablePath) {
    throw new Error("No Chrome/Chromium executable found — set CHROME_PATH or install Google Chrome");
  }
  const dir = profileDir(session.profile);
  mkdirSync(dir, { recursive: true });

  const context = await launchLoginBrowser(chromium, dir, executablePath);
  session.context = context;
  // The user may close the window themselves — don't keep a dead context around.
  context.on("close", () => {
    if (session.context === context) session.context = null;
    busyProfiles.delete(session.profile);
  });

  const page = context.pages()[0] || (await context.newPage());
  // Hide webdriver property before navigation
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  // Leave the browser open: the user clicks "Read key" when done.
  session.status = "waiting";
}
