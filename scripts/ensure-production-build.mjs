import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const distDir = process.env.NEXT_DIST_DIR || ".next";
const buildId = path.join(root, distDir, "BUILD_ID");

if (fs.existsSync(buildId)) process.exit(0);

console.log(`[ensure-build] No production build found in "${distDir}", running "npm run build"...`);

const npmCli = process.env.npm_execpath;
const result = npmCli
  ? spawnSync(process.execPath, [npmCli, "run", "build"], { cwd: root, stdio: "inherit" })
  : spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });

if (result.status !== 0) {
  console.error("[ensure-build] Build failed, cannot start the production server.");
  process.exit(result.status || 1);
}
