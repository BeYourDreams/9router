// `npm run dev` wrapper.
//
// Injects the resolved port so the port is defined once (scripts/server-port.mjs)
// instead of being repeated — with POSIX-only `${PORT:-...}` syntax — in every
// npm script.

import { spawn } from "node:child_process";
import { resolvePort, withPortEnv } from "./server-port.mjs";
import { resolveDistDir, withoutSandbox } from "./dist-dir.mjs";

// --sandbox gives dev its own compile cache, so it never shares (or wipes) the
// directory a running production server executes from.
const argv = withoutSandbox(process.argv.slice(2));
const port = resolvePort();
const useWebpack = argv.includes("--webpack");

const args = ["next", "dev"];
if (useWebpack) args.push("--webpack");
args.push("--port", String(port));

console.log(`[dev] starting Next dev server on http://localhost:${port} (${resolveDistDir(process.argv.slice(2)).distDir})`);

const child = spawn("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  // The env the child needs is the one distDir was resolved from.
  env: withPortEnv(port, resolveDistDir(process.argv.slice(2)).env),
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
