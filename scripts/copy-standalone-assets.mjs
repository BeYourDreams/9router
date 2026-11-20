import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // The OpenCode free-lane sidecar is spawned by path from cwd; standalone tracing
  // never picks it up (it is not imported). Same copy the Dockerfile does by hand.
  const scriptsSource = resolve(projectRoot, "scripts");
  const scriptsDestination = resolve(standaloneDir, "scripts");
  if (existsSync(scriptsSource)) {
    cpSync(scriptsSource, scriptsDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied scripts/ to ${scriptsDestination}`);
  }

  // serverExternalPackages keeps undici real, but dynamic import("undici") in
  // open-sse/utils/proxyFetch.js is invisible to file tracing. Copy it once
  // here instead of forcing ./node_modules/undici/**/* into every route's trace.
  const undiciSource = resolve(projectRoot, "node_modules", "undici");
  const undiciDestination = resolve(standaloneDir, "node_modules", "undici");
  if (existsSync(undiciSource)) {
    cpSync(undiciSource, undiciDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied undici to ${undiciDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
