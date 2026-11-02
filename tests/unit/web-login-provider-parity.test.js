import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { listWebLoginProviders } from "open-sse/services/webLoginConfig.js";

// WebLoginButton used to hand-mirror the server list; every provider added to
// webLoginConfig.js since then lost its "Login via Browser" button. The set is
// now derived from the config, so the guard is "no literals in the client".
describe("Login via Browser button list", () => {
  const source = readFileSync(
    new URL("../../src/app/(dashboard)/dashboard/providers/components/WebLoginButton.js", import.meta.url),
    "utf8",
  );

  it("has no hand-copied provider ids left in the client", () => {
    expect(source.match(/"[a-z0-9-]+-web"/g)).toBeNull();
  });

  it("derives the set from the server config, which lists doubao-web", () => {
    expect(source).toContain("new Set(listWebLoginProviders())");
    expect(listWebLoginProviders()).toContain("doubao-web");
  });
});
