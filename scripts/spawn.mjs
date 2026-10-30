// Shell-free child-process helpers.
//
// WHY THIS FILE EXISTS — the "'C:\Program' is not recognized" bug:
//
// On Windows `process.execPath` is usually `C:\Program Files\nodejs\node.exe`.
// With `spawn(cmd, args, { shell: true })`, Node concatenates command + args
// into a single `cmd.exe` string WITHOUT quoting them (see DEP0190). cmd.exe
// then splits on the space and tries to run `C:\Program`, producing:
//
//   "'C:\Program' is not recognized as an internal or external command,
//    operable program or batch file."
//
// Quoting only the command is NOT sufficient — every argument that contains a
// space (project paths, `--flag "some value"`, temp dirs) breaks identically.
// The dependable fix is to not use a shell at all: spawn the executable
// directly and let the OS pass argv verbatim.
//
// Every npm/next invocation in `npm run dev|build|start` therefore goes through
// here as `node <real-cli-file>`, never `npx <cmd>` through cmd.exe.
//
// Only Windows `.cmd`/`.bat` shims (npm, npx) genuinely require cmd.exe, since
// they aren't real executables. Those go through the shell with the command
// quoted — and they're the one place a shell is unavoidable.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Windows needs cmd.exe for .cmd/.bat shims (npm, npx); nothing else does. */
export function needsShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/** Quote a command so cmd.exe doesn't split it on spaces. */
export function quoteForShell(command) {
  return command.includes(" ") ? `"${command}"` : command;
}

/** Options shared by every spawn in this module. */
function spawnOptions(env, useShell) {
  return { stdio: "inherit", shell: useShell, windowsHide: true, env };
}

/**
 * Spawn a child process, shell-free unless the command is a Windows shim.
 * Resolves with the exit code (1 if the process could not be started).
 */
export function run(command, args, env) {
  return new Promise((done) => {
    const useShell = needsShell(command);
    const child = spawn(
      useShell ? quoteForShell(command) : command,
      args,
      spawnOptions(env, useShell)
    );
    const forward = (signal) => () => child.kill(signal);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      child.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      console.error(`\n[9router] Failed to start "${command}": ${error.message}`);
      done(1);
    };
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.on("error", onError);
    child.on("exit", (code, signal) => {
      cleanup();
      done(signal ? 1 : (code ?? 0));
    });
  });
}

/** Synchronous `run()`. Returns an exit code. */
export function runSync(command, args, env) {
  const useShell = needsShell(command);
  const result = spawnSync(
    useShell ? quoteForShell(command) : command,
    args,
    spawnOptions(env, useShell)
  );
  if (result.error) {
    console.error(`\n[9router] Failed to start "${command}": ${result.error.message}`);
    return 1;
  }
  return result.signal ? 1 : (result.status ?? 1);
}

/**
 * Resolve the locally installed Next CLI (the same file its own bin/ scripts
 * run), so dev/build never depend on `next`/`npx` being on PATH.
 * Returns null when Next isn't installed.
 */
export function resolveNextBin() {
  const candidates = [
    resolve(here, "..", "node_modules", "next", "dist", "bin", "next"),
    resolve(here, "..", "node_modules", ".bin", "next"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * argv for `node <argv>` that runs the Next CLI with `args`
 * (e.g. ["dev"], ["build", "--webpack"]).
 *
 * Prefers the locally installed CLI. When Next isn't installed it falls back to
 * the npm CLI (`node <npm-cli> next …`), which npm guarantees is a real .js
 * file — so no branch here needs a shell.
 */
export function nextCliArgs(args = []) {
  const nextBin = resolveNextBin();
  if (nextBin) return [nextBin, ...args];

  const npmCli = process.env.npm_execpath;
  if (npmCli) return [npmCli, "next", ...args];

  // Last resort: the npm shim (requires a shell on Windows).
  return [process.platform === "win32" ? "npm.cmd" : "npm", "next", ...args];
}

/**
 * Run `node <next-cli> <args>`, never `npx next <args>` through cmd.exe.
 * Returns the child's exit code.
 */
export function runNext(args, env) {
  return run(process.execPath, nextCliArgs(args), env);
}
