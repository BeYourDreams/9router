// temporary end-to-end check for opencodeFreeBridge bun resolution
const PORT = process.env.OPENCODE_FREE_BRIDGE_PORT || 20135;
const t0 = Date.now();
console.log("importing (triggers sidecar boot)...");
await import("../open-sse/services/opencodeFreeBridge.js");
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const ok = await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.ok).catch(() => false);
  console.log("t+" + (i + 1) + "s health:", ok);
  if (ok) break;
}
console.log("elapsed_ms", Date.now() - t0);
process.exit(0);
