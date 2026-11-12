## Development / verification workflow (required)

1. **Never stop or build over the instance on 20128. Use `--sandbox`.**

   > ⛔ **HARD RULE (user-mandated): ABSOLUTELY FORBIDDEN to kill, taskkill, or
   > terminate any process listening on port 20128.** This includes `taskkill /PID`,
   > `kill`, `Stop-Process`, or any signal (SIGTERM/SIGKILL) targeting the 9Router
   > production instance. The 20128 server is a long-lived production instance; it is
   > never to be stopped by an agent or a script. If the code needs to be rebuilt or
   > the instance restarted, do so ONLY via the sanctioned paths below, never by
   > killing the port owner.

   A long-lived production instance occupies **20128** and `.next/standalone` is its own
   working directory (`next build` does `rmdir` on it). Verify everything in a separate
   directory instead — every wrapper understands `--sandbox`:

   ```bash
   npm run build -- --sandbox                             # → .next-sandbox, .next untouched
   npm run dev -- --sandbox --port 20127                  # dev with its own compile cache
   node scripts/start-server.mjs --sandbox --port 20127   # serve the sandbox build
   ```

   `--port` is required with `--sandbox`: port resolution reads `PORT`/`.env` and both
   wrappers exit rather than let a sandbox run bind the production port (20128).

   Confirm the log says `Ready` on `http://localhost:20127` before probing it. Never
   `taskkill` a process on 20128 and never delete `.next`.

   If the 20128 instance must be brought back up (e.g. after a machine reboot or an
   authorized deploy), start it with the wrapper — **never by killing first**:
   `node scripts/start-server.mjs --port 20128` (production) or, for a verified
   preview of a change, the `--sandbox` variants on a different port. Port 20128 is
   reserved exclusively for the long-lived production instance; a sandbox run may
   never bind it (`--port` is required with `--sandbox` and both wrappers refuse to
   bind 20128 when running sandboxed).

   Keep `.next-sandbox` — do not delete it.
   `<distDir>/cache/turbopack`, and `next.config.mjs` sets `cleanDistDir: false` so the
   cache survives between builds: a warm sandbox build is ~35-55s (compile ~2s).
   Deleting the dist dir makes the next build ~115s — 30s to recreate the tree, 25s cold compile
   and ~59s writing `standalone/`.
   (A plain `.next` build is only for an actual release, and only when nothing is
   running on 20128.)

2. **Verify before you report done.** A green unit test file is not verification — exercise the changed path against the running 20127 server (`curl` the API, or log in at `http://localhost:20127/dashboard`) and show the real result.

3. **`npm run build -- --sandbox` must succeed before the work is finished** (plus
   `node scripts/start-server.mjs --sandbox --port 20127` when the change touches the
   server itself). Do not skip it because dev worked — dev compiles nothing.

### ⚠️ Why the sandbox directory exists

Building into `.next` while a server runs from it either crashes that instance mid-task
or fails the build outright on Windows:

   ```text
   EBUSY: resource busy or locked, rmdir 'D:\...\.next\standalone'
   ```

`--sandbox` sets `NEXT_DIST_DIR=.next-sandbox` for build, dev and start alike
(`scripts/dist-dir.mjs`), so the two trees never collide. `npm run build -- --sandbox`
also runs the standalone asset copy itself, because npm lifecycle hooks (`postbuild`
was removed for this reason) cannot carry the flag into their own env.

## ⚠️ npm start build requirement

- `npm start` runs `node scripts/start-server.mjs`, which **auto-rebuilds** when `<distDir>/BUILD_ID`
  is older than any build input (`src`, `open-sse`, `i18n`, `public`, `scripts`, `custom-server.js`,
  `next.config.mjs`, …). A fresh build costs one mtime scan (~60 ms), not a compile.
- It refuses to rebuild while the port is already serving: that server's working directory *is*
  `<distDir>/standalone`, which `next build` deletes (EBUSY on Windows, a crashed instance otherwise).
  So a stale build + a live 20128 is an error message pointing at `--sandbox`, never a silent kill.
- The script exits with an error if `<distDir>/standalone/custom-server.js` is missing or assets are incomplete
- Always `npm run build` (or `npm run build -- --sandbox`) before serving after code changes
- `npm run build` is capped: heap ≈40% of RAM (2–8GB). `NINEROUTER_BUILD_HEAP_MB` /
  `NINEROUTER_BUILD_JOBS` / `NINEROUTER_BUILD_MEM=0` tune it. CPU is left uncapped on
  purpose — halving workers cost 74% more wall time and OOM, not CPU, is the failure mode.


<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
