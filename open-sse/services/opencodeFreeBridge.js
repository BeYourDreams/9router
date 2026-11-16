import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { existsSync } from "node:fs";

const PORT = Number(process.env.OPENCODE_FREE_BRIDGE_PORT || 20135);
const HOST = process.env.OPENCODE_FREE_BRIDGE_HOST || "0.0.0.0";

// ---- Bun resolution & auto-install -----------------------------------
// The sidecar must run on Bun: upstream's free-tier gate inspects the TLS
// ClientHello fingerprint, and only the compiled Bun binary reproduces the
// OpenCode CLI transport. `npm install -g bun` drops bun shims (.cmd/.ps1/
// extensionless) onto PATH, which Node's spawn() cannot execute on Windows —
// probe the real bun.exe instead. If nothing is found, attempt one
// auto-install so the bridge comes up without manual setup.
let bunBinCache;          // resolved executable path, or null when unavailable
let bunInstallPromise = null;

function bunCandidates() {
  if (process.env.OPENCODE_BUN_BIN) return [process.env.OPENCODE_BUN_BIN];
  if (process.platform !== "win32") return ["bun"];
  const ap = process.env.APPDATA || "";
  const home = os.homedir();
  return [
    ap && `${ap}/npm/node_modules/bun/bin/bun.exe`,
    `${home}/.bun/bin/bun.exe`,
  ].filter(Boolean);
}

function resolveBunBinSync() {
  for (const c of bunCandidates()) {
    if (c === "bun") return c; // non-win: let spawn resolve via PATH
    if (existsSync(c)) return c;
  }
  return null;
}

function bunRuns(bin) {
  return new Promise((resolve) => {
    try {
      const p = spawn(bin, ["--version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function runInstallScriptFor(candidate) {
  // bun.exe lives at <prefix>/npm/node_modules/bun/bin/bun.exe; install.js is
  // one level up. npm may block the postinstall via allowScripts, so run it
  // directly as the documented fallback.
  if (!candidate) return;
  const installJs = path.join(path.dirname(path.dirname(candidate)), "install.js");
  if (!existsSync(installJs)) return;
  try {
    execFileSync(process.execPath, [installJs], { stdio: "ignore" });
  } catch {}
}

async function installBun() {
  // npm on Windows is a .cmd shim that Node's spawn cannot execute directly;
  // the string form runs it through the shell. The command is a fixed literal
  // (no user input), so this is not an injection surface, and it sidesteps the
  // deprecated execFileSync(args + shell) path.
  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = ["install", "-g", "bun"];
    if (process.platform === "win32") {
      execFileSync(`${npmCmd} ${args.join(" ")}`, {
        stdio: "ignore",
        cwd: process.cwd(),
        shell: true,
      });
    } else {
      execFileSync(npmCmd, args, { stdio: "ignore", cwd: process.cwd() });
    }
  } catch {}
  runInstallScriptFor(resolveBunBinSync());
  return resolveBunBinSync();
}

async function ensureBun() {
  if (bunBinCache !== undefined) return bunBinCache;
  let bin = resolveBunBinSync();
  if (bin && (await bunRuns(bin))) {
    bunBinCache = bin;
    return bin;
  }
  if (!bunInstallPromise) {
    bunInstallPromise = installBun()
      .then(async (installed) => (installed && (await bunRuns(installed)) ? installed : null))
      .catch(() => null);
  }
  bin = await bunInstallPromise;
  bunBinCache = bin;
  return bin;
}

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
    const spawnBun = async () => {
      const bin = await ensureBun();
      if (!bin) {
        console.warn(
          "[opencode-free-bridge] Bun not found and auto-install failed. Install it: npm install -g bun"
        );
        return null;
      }
      const child = spawn(bin, [sidecarPath()], {
        cwd: process.cwd(),
        env: { ...process.env, PORT: String(PORT), HOST },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return child;
    };
    spawnBun().then((child) => {
      if (!child) {
        starting = null;
        resolve(null);
        return;
      }
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
