// `npm run dev` wrapper.
//
// Injects the resolved port so the port is defined once (scripts/server-port.mjs)
// instead of being repeated — with POSIX-only `${PORT:-...}` syntax — in every
// npm script.
//
// The dev server goes through scripts/spawn.mjs like every other child process:
// `node <next-cli> dev` with no shell, so a node.exe under "C:\Program Files\..."
// is never handed to cmd.exe unquoted (see the header comment in spawn.mjs).
//
// `isEntrypoint()` is exported (and unit-tested) because the wrong guard here
// once made a bare `import` of this file launch a dev server on the
// production port.

import { run, nextCliArgs } from "./spawn.mjs";
import { resolvePort, withPortEnv, portFlagFromArgv } from "./server-port.mjs";
import { resolveDistDir, assertNotProductionPort, withoutSandbox } from "./dist-dir.mjs";

/**
 * True when dev-server.mjs is the entrypoint Node was asked to run.
 *
 * Deliberately NOT the common `import.meta.url === pathToFileURL(argv[1]).href`
 * idiom: argv[1] is whatever the caller typed, so `node -e "..." scripts/dev-server.mjs`
 * leaves it relative — pathToFileURL() then resolves it against cwd and it
 * matches, so merely importing this module booted a dev server. Comparing a
 * normalized suffix keeps “am I being run” and “am I being imported” distinct.
 */
export function isEntrypoint(argv1 = process.argv[1]) {
  // A typeof guard rather than `argv1?.replace(…)`: argv[1] is untrusted caller
  // input, and a non-string here used to throw instead of answering "no".
  return typeof argv1 === "string"
    ? argv1.replace(/\\/g, "/").endsWith("scripts/dev-server.mjs")
    : false;
}

// Importable without booting a dev server: only the npm script runs the block below.
const isMain = isEntrypoint();

/**
 * argv for `node <argv>` that starts the dev server.
 *
 * Prefers the locally installed Next CLI (the same file its own bin/ scripts
 * run) so dev never depends on `npx`/`next` being on PATH. When Next isn't
 * installed it falls back to the npm CLI (`node <npm-cli> next dev`), which is
 * still a real executable — no branch here needs a shell.
 */
export function resolveDevArgs({ webpack = false, port = resolvePort() } = {}) {
  const args = nextCliArgs(["dev"]);
  if (webpack) args.push("--webpack");
  args.push("--port", String(port));
  return args;
}

if (isMain) {
  // --sandbox gives dev its own compile cache, so it never shares (or wipes) the
  // directory a running production server executes from.
  const argv = process.argv.slice(2);
  const fromFlag = portFlagFromArgv(argv);
  if (fromFlag) process.env.PORT = String(fromFlag);
  // next dev rejects unknown flags, so --sandbox is consumed by this wrapper only.
  const nextArgs = withoutSandbox(argv);
  // resolvePort() reads env/.env only; without the translation above, a dev server
  // silently binds the production port and shadows the live instance.
  const port = assertNotProductionPort(resolvePort(), { sandbox: argv.includes("--sandbox") });
  const distEnv = resolveDistDir(argv).env;

  const args = resolveDevArgs({ webpack: nextArgs.includes("--webpack"), port });

  console.log(`[dev] starting Next dev server on http://localhost:${port} (${distEnv.NEXT_DIST_DIR})`);

  // `node <argv>`, not `npx next`: no shell, so a node.exe installed under
  // "C:\Program Files\..." isn't split by cmd.exe (DEP0190). The env the child
  // needs is the one distDir was resolved from.
  const code = await run(process.execPath, args, withPortEnv(port, distEnv));
  process.exit(code);
}
