// Single source of truth for the dashboard port.
//
// The port used to be baked into every npm script as `${PORT:-20127}`, which
// only works in a POSIX shell — on Windows cmd (where npm defaults to
// cmd.exe) the literal string survives and Next receives a garbage port. The
// port now lives here, and both the dev and start wrappers ask for it, so
// changing the port is a one-line edit in one file.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_PORT = 20128;

/**
 * Resolve the port: explicit env > .env file > default.
 * A .env file is parsed directly because `next dev` loads it on its own but
 * our node wrappers do not.
 */
export function resolvePort(projectRoot = process.cwd()) {
  // Environment variable takes highest priority
  const fromEnv = Number.parseInt(process.env.PORT, 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;

  const envFile = resolve(projectRoot, ".env");
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, "utf8").match(/^\s*PORT\s*=\s*(\d+)\s*$/m);
    if (match) {
      const fromFile = Number.parseInt(match[1], 10);
      if (Number.isInteger(fromFile) && fromFile > 0 && fromFile < 65536) return fromFile;
    }
  }

  return DEFAULT_PORT;
}

/** Spawn a child process with PORT exported so the child sees the same value. */
export function withPortEnv(port, extra = {}) {
  return { ...process.env, ...extra, PORT: String(port) };
}
