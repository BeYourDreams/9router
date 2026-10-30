## Development / verification workflow (required)

1. **Test changes on port 20127, never 20128.**
   A long-lived production instance (`npm run start`) occupies **20128**. Start your dev server on 20127 so you never fight it for the port:

   ```bash
   PORT=20127 npx next dev
   ```

   Whichever command you use, confirm the log actually says `Ready` on `http://localhost:20127` before you probe it. If a previous dev server is still holding the port, free it (or pick another) rather than assuming yours came up.

2. **Verify before you report done.** A green unit test file is not verification — exercise the changed path against the running 20127 server (`curl` the API, or log in at `http://localhost:20127/dashboard`) and show the real result.

3. **`npm run build` then `npm run start` must both succeed before the work is finished.** `start` serves the built `.next/standalone` output and exits with an error if the build is missing or incomplete, so it is the only check that proves the change actually ships. Do not skip it because dev worked — dev compiles nothing.

   To run the built output on a non-default port afterwards:
   `PORT=20127 npm run start` (Windows cmd: `set PORT=20127 && npm run start`).

### ⚠️ Never build while an instance is running

`next build` does `rmdir .next/standalone`, and **both** the production server *and* `next dev` execute the code inside that directory — there is no copy, so this is their own working directory, not a stale artifact. Building underneath a live instance therefore makes it **crash / flash-exit** mid-run, and on Windows the build *itself* fails first with:

   ```text
   EBUSY: resource busy or locked, rmdir 'D:\...\.next\standalone'
   ```

So before any `npm run build`:

   ```bash
   netstat -ano | grep LISTENING | grep -E "20127|20128"   # note the PID(s)
   taskkill //PID <pid> //F                                # repeat per PID
   ```

This is deliberately a manual, explicit step: only stop instances **you** started, and leave someone else's running gateway alone. If you must not stop it, do **not** run `npm run build` — report that the build check is blocked and needs the instance stopped, instead of clearing build output by hand (deleting `.next` under a live server has exactly the same effect as `rmdir` did).

Do not delete or otherwise prune build output to "make room" for a build: `.next/standalone` is live working code for whatever is currently serving traffic.

## ⚠️ npm start build requirement

- `npm start` runs `node scripts/start-server.mjs` which **requires** a prior `npm run build`
- The script will exit with error if `.next/standalone/custom-server.js` is missing or assets are incomplete
- Always run `npm run build` (or `npm run dev`) before `npm start` after code changes


<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
