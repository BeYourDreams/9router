// Regression tests for the "'C:\Program' is not recognized as an internal or
// external command" startup failure (DEP0190).
//
// Root cause: `spawn(process.execPath, args, { shell: true })` and
// `spawn("npx", ["next", …], { shell: true })`. On Windows execPath is usually
// `C:\Program Files\nodejs\node.exe`; cmd.exe receives an unquoted
// concatenation and splits on the space. Quoting the command alone is not
// enough — args with spaces break the same way. These tests lock in that every
// npm script child is spawned as `node <real-cli-file>` with no shell, and that
// the end-to-end call actually runs.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { needsShell, quoteForShell, run, runSync, resolveNextBin, nextCliArgs } from "../../scripts/spawn.mjs";
import { resolveDevArgs, isEntrypoint } from "../../scripts/dev-server.mjs";

function spaceyScript() {
  // A path containing spaces — the exact shape that used to break cmd.exe.
  const dir = mkdtempSync(join(tmpdir(), "9router spawn dir "));
  const file = join(dir, "echo args.js");
  writeFileSync(file, 'console.log(JSON.stringify(process.argv.slice(2)));');
  return { dir, file };
}

describe("spawn.mjs — shell-free process launching", () => {
  it("does not use a shell for real executables (node)", () => {
    expect(needsShell(process.execPath)).toBe(false);
  });

  it("uses a shell only for Windows .cmd/.bat shims", () => {
    expect(needsShell("npm.cmd")).toBe(process.platform === "win32");
    expect(needsShell("npm")).toBe(false);
    expect(needsShell("/usr/bin/node")).toBe(false);
  });

  it("quotes commands that contain spaces before handing them to a shell", () => {
    expect(quoteForShell("C:\\Program Files\\nodejs\\node.exe")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"'
    );
    expect(quoteForShell("node")).toBe("node");
  });

  it("runs node even when execPath contains spaces (the C:\\Program Files bug)", async () => {
    const { dir, file } = spaceyScript();
    try {
      // Would print "'C:\Program' is not recognized..." if a shell were used.
      const code = await run(process.execPath, [file, "hello world"]);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a space-containing argument through unharmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "9router-spawn-"));
    const out = join(dir, "out.txt");
    const script = join(dir, "write.js");
    writeFileSync(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(out)}, process.argv[2]);`
    );
    try {
      const code = await run(process.execPath, [script, "C:\\Program Files\\x"]);
      expect(code).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("C:\\Program Files\\x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runSync returns the child's exit code", () => {
    expect(runSync(process.execPath, ["-e", "process.exit(0)"], process.env)).toBe(0);
    expect(runSync(process.execPath, ["-e", "process.exit(3)"], process.env)).toBe(3);
  });

  it("run() resolves to 1 when the executable does not exist", async () => {
    const missing = join(tmpdir(), "9router-no-such-binary-9f3a");
    expect(await run(missing, [], process.env)).toBe(1);
  });

  it("resolves the local Next CLI so dev/build never depend on PATH", () => {
    // Installed in this repo; if absent, callers fall back to the npm CLI.
    const bin = resolveNextBin();
    if (bin === null) return;
    expect(bin).toMatch(/next/);
  });

  it("survives a project path that contains spaces", async () => {
    // Every child here is `node <script>` — a spacey path is precisely what
    // produced the original failure.
    const dir = mkdtempSync(join(tmpdir(), "9router spacey root "));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const script = join(dir, "scripts", "noop.mjs");
    writeFileSync(script, 'process.exit(0);');
    try {
      expect(await run(process.execPath, [script], process.env)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawn.mjs — next CLI argv", () => {
  it("hands `node` a real CLI file, never a PATH-resolved `npx`", () => {
    const args = nextCliArgs(["build"]);
    // argv[1] for the child node process — not the string "npx" (a bare PATH
    // lookup needing cmd.exe on Windows).
    expect(args[0]).not.toBe("npx");
    expect(needsShell(args[0]) || args[0].includes("node_modules")).toBe(true);
    expect(args[args.length - 1]).toBe("build");
  });

  it("forwards extra CLI flags verbatim", () => {
    expect(nextCliArgs(["build", "--webpack"])).toContain("--webpack");
  });
});

describe("dev-server.mjs — shell-free dev launch", () => {
  it("starts the dev server with `node <next-cli>`, never through a shell", () => {
    const args = resolveDevArgs({ port: 20127 });
    // The first element is argv[1] handed to node — a real file, not `npx`.
    expect(needsShell(args[0])).toBe(false);
    expect(args).toContain("dev");
    expect(args).toContain("--port");
    expect(args[args.length - 1]).toBe("20127");
  });

  it("forwards --webpack when the caller asks for the webpack dev server", () => {
    expect(resolveDevArgs({ port: 20127, webpack: true })).toContain("--webpack");
    expect(resolveDevArgs({ port: 20127, webpack: false })).not.toContain("--webpack");
  });

  it("puts --webpack before the value-taking --port flag", () => {
    // next's arg parser reads `--webpack --port N` correctly, but the reverse
    // order would make it swallow "--port" as webpack's value.
    const args = resolveDevArgs({ port: 20127, webpack: true });
    expect(args.indexOf("--webpack")).toBeLessThan(args.indexOf("--port"));
  });

  it("recognizes itself as the entrypoint only when run as a script", () => {
    // A bare `import` must never boot a dev server, and `npm run dev` must.
    // The old `import.meta.url === pathToFileURL(argv[1]).href` guard got this
    // backwards when argv[1] was relative (`node -e "..." scripts/dev-server.mjs`),
    // which launched a dev server out of an unrelated smoke check.
    expect(isEntrypoint("D:\\repo\\scripts\\dev-server.mjs")).toBe(true);
    expect(isEntrypoint("scripts/dev-server.mjs")).toBe(true); // relative still runs it
    expect(isEntrypoint("./scripts/dev-server.mjs")).toBe(true);
    expect(isEntrypoint(undefined)).toBe(false);
    expect(isEntrypoint(null)).toBe(false);
    expect(isEntrypoint("")).toBe(false);
    expect(isEntrypoint("D:\\repo\\tests\\unit\\spawn-shell-quoting.test.js")).toBe(false);
    // vitest's own entrypoint — importing this file must stay inert.
    expect(isEntrypoint(process.argv[1])).toBe(false);
  });

  it("rejects lookalike paths and answers false for non-string argv", () => {
    // A suffix match has to still mean *this* script, and argv[1] is untrusted
    // caller input (a non-string used to throw instead of answering "no").
    expect(isEntrypoint("/repo/scripts/webpack-dev-server.mjs")).toBe(false);
    expect(isEntrypoint("/repo/scripts/dev-server.mjs.old")).toBe(false);
    expect(isEntrypoint(0)).toBe(false);
    expect(isEntrypoint(123)).toBe(false);
    expect(isEntrypoint({})).toBe(false);
    expect(isEntrypoint([])).toBe(false);
  });

  it("never relies on a shell-resolved PATH entry", () => {
    // Either the local CLI or the npm CLI — both real executables; `npx` alone
    // (a bare PATH lookup needing cmd.exe on Windows) is out.
    const args = resolveDevArgs({ port: 20127 });
    expect(args[0]).not.toBe("npx");
    expect(args[0].length).toBeGreaterThan(0);
  });
});
