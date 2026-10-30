## Development / verification workflow (required)

1. **Never stop or build over the instance on 20128. Use `--sandbox`.**
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

   Keep `.next-sandbox` — do not delete it. Turbopack's build cache lives in
   `<distDir>/cache/turbopack`, so a warm sandbox build compiles in ~24s vs ~41s cold.
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

- `npm start` runs `node scripts/start-server.mjs` which **requires** a prior `npm run build` (no auto-build any more)
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
