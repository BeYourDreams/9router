// Is the production build up to date with the sources that feed `next build`?
//
// `npm start` uses this to rebuild by itself instead of serving pages that were
// compiled from older code. Pure (no side effects), so it is unit-testable.

import { connect } from "node:net";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Everything `next build` compiles, plus what copy-standalone-assets.mjs copies
// into the standalone tree. Deliberately NOT included: `gitbook/` (excluded by
// outputFileTracingExcludes), `docs/`, `tests/`, `cli/` (its own package/build),
// and stray root scratch files.
export const BUILD_INPUTS = [
  "src",
  "open-sse",
  "i18n",
  "public",
  "scripts",
  "custom-server.js",
  "next.config.mjs",
  "package.json",
  "postcss.config.mjs",
  "jsconfig.json",
];

/** Newest mtime under `path` (recursive) — 0 when unreadable, never throws. */
function newestMtime(path) {
  let root;
  try {
    root = statSync(path);
  } catch {
    return 0;
  }
  if (!root.isDirectory()) return root.mtimeMs;

  let newest = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    let m = 0;
    try {
      m = entry.isDirectory() ? newestMtime(child) : statSync(child).mtimeMs;
    } catch {
      continue; // unreadable entry: a missing file is never fresher than the build
    }
    if (m > newest) newest = m;
  }
  return newest;
}

/** True when `<distDir>/BUILD_ID` is missing or older than any build input. */
export function isBuildStale({ projectRoot = process.cwd(), distDir = ".next" } = {}) {
  const buildId = resolve(projectRoot, distDir, "BUILD_ID");
  if (!existsSync(buildId)) return true;
  let built;
  try {
    built = statSync(buildId).mtimeMs;
  } catch {
    return true;
  }
  return BUILD_INPUTS.some((rel) => newestMtime(resolve(projectRoot, rel)) > built);
}

/**
 * True when something already serves on `port`. A live server's own working
 * directory is `<distDir>/standalone`, and `next build` deletes it, so a port in
 * use is the signal to leave that tree alone.
 */
export async function portOccupied(port) {
  // A connect probe, not a bind probe: on Windows a listener on 0.0.0.0 does NOT
  // collide with binding :: or 127.0.0.1, so `listen()` happily rebinds a port the
  // production server is using and would let the auto-build delete its cwd.
  const results = await Promise.all([probe(port, "127.0.0.1"), probe(port, "::1")]);
  return results.includes("in use");
}

function probe(port, host) {
  return new Promise((done) => {
    const socket = connect({ port, host });
    const finish = (verdict) => {
      socket.destroy();
      done(verdict);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish("in use"));
    socket.once("timeout", () => finish("free")); // silent: nothing serving on it
    // ECONNREFUSED (nothing listening), EADDRNOTAVAIL (no IPv6 on this box), etc.
    socket.once("error", () => finish("free"));
  });
}
