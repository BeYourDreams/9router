// `npm start` wrapper.
//
// Three failure modes this exists to prevent:
//
//  1. MODULE_NOT_FOUND for `.next/standalone/custom-server.js` — that file only
//     appears after a successful `next build` + a copy step, so a missing or
//     interrupted build used to surface as a bare stack trace.
//  2. Every `/_next/static/**` request 404ing — the standalone server reads
//     assets from `.next/standalone/.next/static`, which Next does NOT create.
//     `npm run build` copies it via the `postbuild` lifecycle hook, but any
//     other path into the build (e.g. `npx next build`, which is what this
//     wrapper previously ran) skips that hook and ships a page with no JS.
//  3. Serving code that is older than the tree — `npm start` used to die on a
//     missing build and otherwise happily launch a stale one, so an edited
//     `src/` looked like "my change did nothing".
//
// Handled here: rebuild when the build is older than the sources, always re-run
// the asset copy, and never do either while a server is live on this port —
// `<distDir>/standalone` is that server's own working directory and `next build`
// deletes it (EBUSY on Windows, a crashed instance everywhere else). A stale
// build behind a live port is therefore a refusal with the fix in its message.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePort, withPortEnv, portFlagFromArgv } from "./server-port.mjs";
import { resolveDistDir, wantsSandbox, assertNotProductionPort } from "./dist-dir.mjs";
import { isBuildStale, portOccupied } from "./build-state.mjs";

const argv = process.argv.slice(2);

// `--sandbox` serves .next-sandbox, leaving the production instance on its own
// directory. Must be resolved before anything reads NEXT_DIST_DIR below.
process.env.NEXT_DIST_DIR = resolveDistDir(argv).distDir;

// `--port N` is a wrapper-only flag: resolvePort() reads env/.env (and this repo's
// .env pins PORT=20128), so without translating it here a sandbox run serves on
// the production port and shadows the live instance.
const fromFlag = portFlagFromArgv(argv);
if (fromFlag) process.env.PORT = String(fromFlag);

const projectRoot = process.cwd();
const distDir = process.env.NEXT_DIST_DIR;
const buildDir = resolve(projectRoot, distDir);
const standaloneDir = resolve(buildDir, "standalone");
const serverPath = resolve(standaloneDir, "custom-server.js");
const copyScript = resolve(projectRoot, "scripts", "copy-standalone-assets.mjs");
const port = assertNotProductionPort(resolvePort(), { sandbox: wantsSandbox(argv) });

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

// Rebuild only when the build is older than its inputs, and only when nothing is
// serving that tree. `build-server.mjs` is invoked directly (not through npm) so
// the memory caps and the sandbox dist dir carry over.
if (isBuildStale({ projectRoot, distDir })) {
  if (await portOccupied(port)) {
    console.error(
      `\n[9router] The build in ${distDir}/ is older than the sources, but port ${port} is taken\n` +
        `  by a running server whose working directory is ${distDir}/standalone — rebuilding here\n` +
        `  would kill it mid-task (and fail on Windows with EBUSY).\n` +
        `  Either stop that server and re-run this, or verify on a sandbox:\n` +
        `    npm run build -- --sandbox && node scripts/start-server.mjs --sandbox --port 20127\n`
    );
    process.exit(1);
  }
  console.log(`[9router] build is older than the sources — rebuilding in ${distDir}/ …`);
  const buildCode = await run(process.execPath, [resolve(projectRoot, "scripts", "build-server.mjs")], withPortEnv(port));
  if (buildCode !== 0) {
    console.error(`\n[9router] Build failed (exit ${buildCode}); refusing to serve.`);
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
