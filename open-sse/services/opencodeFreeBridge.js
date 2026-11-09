import { spawn } from "node:child_process";
import path from "node:path";
import http from "node:http";

const PORT = Number(process.env.OPENCODE_FREE_BRIDGE_PORT || 20135);
const HOST = process.env.OPENCODE_FREE_BRIDGE_HOST || "0.0.0.0";
const BUN_BIN = process.env.OPENCODE_BUN_BIN || "bun";

let active = null;
let starting = null;

function sidecarPath() {
  return path.join(process.cwd(), "scripts", "opencode-free-bridge", "server.js");
}

export function isOpencodeFreeBridgeProvider(provider) {
  return provider === "opencode-free-v2" || provider === "ocfv2" || provider === "opencode-zen-v2" || provider === "oczv2";
}

export function getOpencodeFreeBridgeBaseUrl() {
  // Clients reach the loopback bind even when the sidecar binds 0.0.0.0.
  return `http://127.0.0.1:${PORT}/v1`;
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

let syncedEgress = null;

/**
 * Install the provider's proxy on the sidecar, where the request to
 * opencode.ai actually leaves from. Pointing 9router's own proxy at the
 * loopback hop instead only wraps a call to 127.0.0.1, and the real egress
 * stays direct. One POST per change; the sidecar persists it.
 */
export async function syncBridgeEgress(proxyUrl) {
  const next = proxyUrl || "";
  if (next === syncedEgress) return true;
  if (!(await ensureOpencodeFreeBridge())) return false;
  const res = await fetch(`http://127.0.0.1:${PORT}/api/proxy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: next }),
  }).catch(() => null);
  if (!res?.ok) {
    console.warn(`[opencode-free-bridge] egress sync failed (${res?.status ?? "network"})`);
    return false;
  }
  syncedEgress = next;
  return true;
}

export async function ensureOpencodeFreeBridge() {
  if (active) return active;
  if (starting) return starting;
  if (await ping()) {
    active = { port: PORT };
    return active;
  }
  starting = new Promise((resolve) => {
    const child = spawn(BUN_BIN, [sidecarPath()], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(PORT), HOST },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("opencode-free-bridge did not report ready")), 20000);
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { child.kill("SIGKILL"); } catch {}
        starting = null;
        console.warn(`[opencode-free-bridge] ${err.message}`);
        resolve(null);
        return;
      }
      active = { child, port: PORT };
      starting = null;
      resolve(active);
    }
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) finish(null);
    });
    child.stderr.on("data", (chunk) => {
      // keep last lines; do not fail on stderr alone
    });
    child.on("error", (e) => finish(new Error(`spawn failed: ${e.message}`)));
    child.on("exit", (code, signal) => {
      if (!settled) finish(new Error(`sidecar exited (${code ?? signal})`));
      else if (active?.child === child) active = null;
    });
  });
  // Also poll health in case stdout missed
  const result = await starting;
  if (!result) {
    // retry health once
    if (await ping()) {
      active = { port: PORT };
      return active;
    }
  }
  return result;
}

// Best-effort startup at module load (server side only).
if (typeof process !== "undefined" && process.versions?.node) {
  ensureOpencodeFreeBridge().catch(() => {});
}

for (const ev of ["exit", "beforeExit"]) process.on(ev, () => {
  if (active?.child) try { active.child.kill("SIGKILL"); } catch {}
});
process.on("SIGTERM", () => { if (active?.child) try { active.child.kill("SIGKILL"); } catch {} });
process.on("SIGINT", () => { if (active?.child) try { active.child.kill("SIGKILL"); } catch {} });
