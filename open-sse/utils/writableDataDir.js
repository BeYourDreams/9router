// Resolve a writable data directory: DATA_DIR first, then ~/.9router, then
// tmpdir. Some installs point DATA_DIR at root-owned paths (e.g. /var/lib) that
// the server process cannot write browser profiles or runtime installs into.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached = null;

// Same directory src/lib/dataDir.js picks, so Open SSE (browser profiles,
// runtime downloads) and the dashboard agree on one location per OS.
function defaultDataDir() {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "9router",
    );
  }
  return path.join(os.homedir(), ".9router");
}

export function getWritableDataDir() {
  if (cached) return cached;
  const configured = process.env.DATA_DIR;
  // A Unix-style absolute path (e.g. /var/lib/9router from a Linux .env or
  // Docker config) is not a real path on Windows: Node resolves it against the
  // current drive root and Chrome then refuses the user-data-dir. Skip it.
  const isUnixPathOnWindows =
    process.platform === "win32" && !!configured && /^\//.test(configured);
  if (isUnixPathOnWindows) {
    console.warn(
      `[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`,
    );
  }
  const candidates = [
    isUnixPathOnWindows ? null : configured,
    defaultDataDir(),
    path.join(os.tmpdir(), "9router"),
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      fs.mkdirSync(base, { recursive: true });
      fs.accessSync(base, fs.constants.W_OK);
      cached = base;
      return base;
    } catch {
      // Not writable — try the next candidate.
    }
  }
  cached = process.cwd();
  return cached;
}
