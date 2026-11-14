// Black-box self-check: importing the service must resolve a runnable bun and
// boot the bridge from a cold state, then answer /health. Mirrors the
// production path (instrumentation.js imports the service; the module-level
// boot is the only start). Exits non-zero on failure.
//
// Usage: node selfcheck-bun.js
import http from "node:http";

const PORT = Number(process.env.OPENCODE_FREE_BRIDGE_PORT || 20135);
const log = (...a) => console.log("[selfcheck-bun]", ...a);

function health() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

log("importing service (triggers boot)...");
await import("../../open-sse/services/opencodeFreeBridge.js");
log("imported; waiting for bridge...");

let alive = false;
for (let i = 0; i < 15; i++) {
  await new Promise((r2) => setTimeout(r2, 1000));
  alive = await health();
  log("t+" + (i + 1) + "s health:", alive);
  if (alive) break;
}

process.exit(alive ? 0 : 1);
