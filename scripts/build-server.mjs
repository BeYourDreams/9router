// `npm run build` wrapper — caps memory and CPU.
//
// Why: a build here spawns Node (JS/SSG workers, which inherit NODE_OPTIONS)
// plus Turbopack's Rust core, and each takes a whole core and grows its heap
// until the OS says stop. On a 16-20GB box that already has a dev or production
// instance resident, that is the OOM kill or a pegged machine. `next build` has
// no flag for it, so it is set through the env Node and Rayon read.
//
// `npm run build -- --sandbox` builds into .next-sandbox instead of .next, which
// is the running production server's own working directory. See scripts/dist-dir.mjs.
//
// Every number is env-overridable — these are defaults, not a ceiling you can
// only raise by editing this file:
//   NINEROUTER_BUILD_HEAP_MB   per-process V8 heap cap (default: auto, see below)
//   NINEROUTER_BUILD_JOBS      parallelism/worker cap (default: auto, see below)
//   NINEROUTER_BUILD_MEM=0     lift everything (raw `next build` behaviour)
//
// Deliberately NOT used: experimental.webpackMemoryOptimizations /
// webpackBuildWorker — this project builds with Turbopack, they don't apply.

import { spawn } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { resolveDistDir, withoutSandbox } from "./dist-dir.mjs";
import { copyStandaloneAssets } from "./copy-standalone-assets.mjs";

const HEAP_CAP_MB = 8192; // more only delays the OOM, it doesn't prevent it
const HEAP_FLOOR_MB = 2048; // below this the build thrashes instead of finishing
// Memory is the failure mode (an OOM kill loses the build); CPU is only a
// preference, so workers are NOT cut by default — set NINEROUTER_BUILD_JOBS to
// free up cores while a build runs.

/** Caps for the build child env, or null when disabled. Pure — unit-tested. */
export function buildLimits(env = process.env, memoryBytes = totalmem(), coreCount = cpus().length) {
  if (env.NINEROUTER_BUILD_MEM === "0") return null;
  const heapFromEnv = Number.parseInt(env.NINEROUTER_BUILD_HEAP_MB, 10);
  const jobsFromEnv = Number.parseInt(env.NINEROUTER_BUILD_JOBS, 10);
  // ~40% of RAM: the rest belongs to the resident server, the browser, the OS.
  const heapMb = Number.isFinite(heapFromEnv) && heapFromEnv > 0
    ? heapFromEnv
    : Math.max(HEAP_FLOOR_MB, Math.min(HEAP_CAP_MB, Math.floor(memoryBytes / 1024 / 1024 * 0.4)));
  const jobs = Number.isFinite(jobsFromEnv) && jobsFromEnv > 0 ? jobsFromEnv : coreCount;
  return { heapMb, jobs };
}

// Importable without launching a build.
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/build-server.mjs");

if (isMain) {
  const argv = process.argv.slice(2);
  const limits = buildLimits();
  // `--sandbox` sets NEXT_DIST_DIR; anything else after `--` goes to the CLI.
  const { env } = resolveDistDir(argv, { ...process.env, NEXT_TELEMETRY_DISABLED: "1" });
  const passthrough = withoutSandbox(argv); // e.g. `npm run build -- --webpack --sandbox`

  if (limits) {
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --max-old-space-size=${limits.heapMb}`.trim();
    env.RAYON_NUM_THREADS = String(limits.jobs);
    env.UV_THREADPOOL_SIZE = String(limits.jobs);
    env.NEXT_WEBPACK_PARALLELISM = process.env.NEXT_WEBPACK_PARALLELISM || String(limits.jobs);
    // Turbopack recurses deep through the module graph; a capped thread stack
    // turns that into a worker abort that looks like a mystery build failure.
    env.RUST_MIN_STACK = process.env.RUST_MIN_STACK || "16777216";
    console.log(`[build] capped: heap ${limits.heapMb}MB, ${limits.jobs} jobs (NINEROUTER_BUILD_MEM=0 lifts this)`);
  }

  console.log(`[build] next build → ${env.NEXT_DIST_DIR}${passthrough.length ? " " + passthrough.join(" ") : ""}`);
  const child = spawn("npx", ["next", "build", ...passthrough], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("exit", (code, signal) => {
    if (code !== 0) process.exit(signal ? 1 : (code ?? 0));
    // The asset copy lives here rather than in a `postbuild` hook: npm runs
    // lifecycle scripts in its own env, which cannot carry `--sandbox`, so
    // postbuild would copy into .next and leave the sandbox serving a page
    // with no JS. The copy is idempotent (force), so re-running is cheap.
    copyStandaloneAssets({ distDir: env.NEXT_DIST_DIR });
  });
}
