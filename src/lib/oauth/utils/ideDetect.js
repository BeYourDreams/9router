import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

// Install paths per provider per platform — standard Windsurf IDE locations.
const IDE_PATHS = {
  windsurf: {
    darwin: ["/Applications/Windsurf.app"],
    win32: [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Windsurf", "Windsurf.exe"),
      path.join(process.env.ProgramFiles || "", "Windsurf", "Windsurf.exe"),
    ],
    linux: ["/usr/bin/windsurf", "/usr/local/bin/windsurf", "/opt/windsurf", "/opt/Windsurf"],
  },
};

const IDE_BINARIES = {
  windsurf: "windsurf",
};

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function checkBinary(bin) {
  try {
    const cmd = os.platform() === "win32" ? `where ${bin}` : `which ${bin}`;
    await execAsync(cmd, { windowsHide: true });
    return true;
  } catch { return false; }
}

// Returns { installed: boolean, path: string|null } for the given provider's IDE.
export async function detectIdeInstalled(providerId) {
  const platform = os.platform();
  const paths = IDE_PATHS[providerId];
  if (!paths) return { installed: false, path: null };
  for (const p of paths[platform] || []) {
    if (p && await pathExists(p)) return { installed: true, path: p };
  }
  const bin = IDE_BINARIES[providerId];
  if (bin && await checkBinary(bin)) return { installed: true, path: bin };
  return { installed: false, path: null };
}
