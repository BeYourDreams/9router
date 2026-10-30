// `--sandbox` — a second, persistent build/dev directory.
//
// Why this exists: `.next/standalone` is the *live working directory* of the
// production server (port 20128). Building into it removes that directory, which
// kills the running instance mid-task — and that instance must never be stopped.
// So any change being verified gets its own directory, and it is never deleted:
// Turbopack's build cache lives in `<distDir>/cache/turbopack`, so a cold
// `next build` costs ~37s of compile and a warm one ~21s.
//
// next.config.mjs reads distDir from NEXT_DIST_DIR, so passing the env var down
// is all that is needed — dev, build and start honour the same flag.
//
//   npm run build -- --sandbox                    # build into .next-sandbox
//   npm run dev -- --sandbox -- --port 20127      # dev server, separate cache
//   node scripts/start-server.mjs --sandbox --port 20127

import { resolve } from "node:path";
import { DEFAULT_PORT as DEFAULT_PRODUCTION_PORT } from "./server-port.mjs";

export const SANDBOX_DIST_DIR = ".next-sandbox";
const DEFAULT_DIST_DIR = ".next";

/** true when `--sandbox` appears in argv (npm passes extras after `--`). */
export function wantsSandbox(argv = process.argv.slice(2)) {
  return argv.includes("--sandbox");
}

/**
 * The dist dir to use, plus the env a child needs to agree with it.
 * Explicit NEXT_DIST_DIR wins over --sandbox, which wins over the default.
 */
export function resolveDistDir(argv = process.argv.slice(2), env = process.env) {
  const dir = env.NEXT_DIST_DIR || (wantsSandbox(argv) ? SANDBOX_DIST_DIR : DEFAULT_DIST_DIR);
  return { distDir: dir, env: { ...env, NEXT_DIST_DIR: dir } };
}

/** argv with `--sandbox` stripped, so it is never forwarded to the next CLI. */
export function withoutSandbox(argv = process.argv.slice(2)) {
  return argv.filter((a) => a !== "--sandbox");
}

export function distDirRoot(projectRoot = process.cwd(), argv = process.argv.slice(2)) {
  return resolve(projectRoot, resolveDistDir(argv).distDir);
}

/**
 * A sandbox run must never bind the production port: the instance there holds
 * long-running tasks and the whole point of --sandbox is to leave it alone.
 * Returns the port to use, or exits rather than taking 20128 over.
 */
export function assertNotProductionPort(port, { sandbox = wantsSandbox() } = {}) {
  if (sandbox && Number(port) === DEFAULT_PRODUCTION_PORT) {
    console.error(
      `[sandbox] refusing to serve on port ${port} — that is the production instance.\n` +
      `          Pass an explicit port, e.g. -- --sandbox --port 20127`,
    );
    process.exit(1);   // a CLI guard, not a library: exiting is the caller's only option
  }
  return port;
}
