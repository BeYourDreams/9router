// `npm run dev` wrapper.
//
// Injects the resolved port so the port is defined once (scripts/server-port.mjs)
// instead of being repeated — with POSIX-only `${PORT:-...}` syntax — in every
// npm script.

import { spawn } from "node:child_process";
import { resolvePort, withPortEnv } from "./server-port.mjs";

const port = resolvePort();
const useWebpack = process.argv.includes("--webpack");

const args = ["next", "dev"];
if (useWebpack) args.push("--webpack");
args.push("--port", String(port));

console.log(`[dev] starting Next dev server on http://localhost:${port}`);

const child = spawn("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: withPortEnv(port),
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
