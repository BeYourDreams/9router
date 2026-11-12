import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { describe, it } = testApi;

const { KIRO_CLIENT_HEADERS, KIRO_IDE_VERSION } = await import("../../open-sse/config/kiroClient.js");
const { default: registry } = await import("../../open-sse/providers/registry/kiro.js");
const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");

const VERSIONED_UA = /KiroIDE-\d+\.\d+\.\d+$/;

describe("Kiro client fingerprint", () => {
  it("declares a KiroIDE-<semver> User-Agent in both forms", () => {
    assert.match(KIRO_CLIENT_HEADERS["User-Agent"], VERSIONED_UA);
    assert.match(KIRO_CLIENT_HEADERS["X-Amz-User-Agent"], VERSIONED_UA);
    assert.equal(KIRO_IDE_VERSION, "1.4.154");
  });

  it("ships the same fingerprint on the inference request", () => {
    const headers = new KiroExecutor().buildHeaders({ accessToken: "t" }, true, "");
    assert.match(headers["User-Agent"], VERSIONED_UA);
    assert.match(headers["X-Amz-User-Agent"], VERSIONED_UA);
  });

  it("keeps the registry transport on that fingerprint", () => {
    assert.equal(registry.transport.headers["User-Agent"], KIRO_CLIENT_HEADERS["User-Agent"]);
    assert.equal(registry.transport.headers["X-Amz-User-Agent"], KIRO_CLIENT_HEADERS["X-Amz-User-Agent"]);
  });

  // Kiro answers a slash-form token ("KiroIDE/1.4.154", "kiro-ide/1.0.0") with
  // 400 "This version of Kiro is no longer supported", so no source file may
  // hand-roll one again.
  it("hand-rolls no slash-form Kiro User-Agent anywhere", () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", ".next-sandbox", "tests"].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|cjs)$/.test(entry.name) && entry.name !== "kiro-client-fingerprint.test.js") {
          const text = fs.readFileSync(full, "utf8");
          if (/KiroIDE\/|kiro-ide\//.test(text)) offenders.push(full);
        }
      }
    };
    walk(path.resolve(process.cwd()));
    assert.deepEqual(offenders, []);
  });
});