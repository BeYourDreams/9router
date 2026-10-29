// `npm start` wrapper.
//
// Two failure modes this exists to prevent:
//
//  1. MODULE_NOT_FOUND for `.next/standalone/custom-server.js` — that file only
//     appears after a successful `next build` + a copy step, so a missing or
//     interrupted build used to surface as a bare stack trace.
//  2. Every `/_next/static/**` request 404ing — the standalone server reads
//     assets from `.next/standalone/.next/static`, which Next does NOT create.
//     `npm run build` copies it via the `postbuild` lifecycle hook, but any
//     other path into the build (e.g. `npx next build`, which is what this
//     wrapper previously ran) skips that hook and ships a page with no JS.
//
// Both are handled here: build when needed, and always re-run the asset copy so
// the served tree is guaranteed complete regardless of how the build happened.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePort, withPortEnv } from "./server-port.mjs";

const projectRoot = process.cwd();
const distDir = process.env.NEXT_DIST_DIR || ".next";
const buildDir = resolve(projectRoot, distDir);
const standaloneDir = resolve(buildDir, "standalone");
const serverPath = resolve(standaloneDir, "custom-server.js");
const copyScript = resolve(projectRoot, "scripts", "copy-standalone-assets.mjs");
const port = resolvePort();

// Set to skip the automatic build (CI, docker entrypoints, etc.).
const noBuild = process.env.NINEROUTER_START_NO_BUILD === "1";

function run(command, args, env) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env,
    });
    const forward = (signal) => () => child.kill(signal);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      done(signal ? 1 : (code ?? 0));
    });
  });
}

/** The standalone tree is only servable with assets + the wrapper present. */
function assetsMissing() {
  return (
    !existsSync(serverPath) ||
    !existsSync(resolve(standaloneDir, distDir, "static"))
  );
}

if (!existsSync(serverPath)) {
  if (noBuild) {
    console.error(
      `\n[9router] No production build found.\n` +
        `  Expected: ${serverPath}\n` +
        `  Run \`npm run build\` first (NINEROUTER_START_NO_BUILD=1 blocks the auto-build).\n`
    );
    process.exit(1);
  }
  console.log(`[9router] No production build found — running \`npm run build\` first.`);
  const buildCode = await run("npx", ["next", "build"], withPortEnv(port));
  if (buildCode !== 0) {
    console.error(`\n[9router] Build failed (exit ${buildCode}). Fix the errors above, then rerun \`npm start\`.`);
    process.exit(buildCode);
  }
}

// Always ensure the copy ran. `next build` alone leaves static/ out of the
// standalone tree, which is exactly the "page loads but all JS 404s" bug.
if (assetsMissing()) {
  console.log("[9router] Copying static assets into the standalone build…");
  const copyCode = await run(process.execPath, [copyScript], withPortEnv(port));
  if (copyCode !== 0) {
    console.error(`\n[9router] Asset copy failed (exit ${copyCode}); the dashboard would serve without JS.`);
    process.exit(copyCode);
  }
}

if (!existsSync(serverPath)) {
  console.error(
    `\n[9router] ${serverPath} is still missing after build + copy.\n` +
      `  The build may have failed silently — run \`npm run build\` and read its output.\n`
  );
  process.exit(1);
}

console.log(`[9router] starting production server on http://localhost:${port}`);
const code = await run(process.execPath, [serverPath], withPortEnv(port));
process.exit(code);
