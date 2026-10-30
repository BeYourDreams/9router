import { describe, it, expect } from "vitest";
import { getWebLoginConfig, listWebLoginProviders } from "open-sse/services/webLoginConfig.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Before this was a suite it was a bare script; vitest reported "No test suite
// found" for it on every run, which showed up as a failure in the totals.
describe("intern-web wiring", () => {
  it("is registered as a webCookie provider", () => {
    const entry = REGISTRY.find((e) => e.id === "intern-web");
    expect(entry, "intern-web registry entry missing").toBeTruthy();
    expect(entry.category).toBe("webCookie");
    expect(entry.authType).toBe("cookie");
  });

  it("has a web-login config pointing at the chat origin", () => {
    const config = getWebLoginConfig("intern-web");
    expect(config, "intern-web webLogin config missing").toBeTruthy();
    expect(config.loginUrl).toBe("https://discovery.intern-ai.org.cn/chat");
    // The client sends Authorization: Bearer <token>, so the stored credential
    // must be the bare cookie value, not "uaa-token=<jwt>".
    expect(config.credentialFrom).toBe("cookieValue");
    expect(config.cookieValueName).toBe("uaa-token");
  });

  it("is offered in the Login-via-Browser provider list", () => {
    expect(listWebLoginProviders()).toContain("intern-web");
  });

  it("exposes the models the upstream /models endpoint actually returns", () => {
    const entry = REGISTRY.find((e) => e.id === "intern-web");
    const ids = entry.models.map((m) => m.id);
    expect(ids).toContain("Auto");
    expect(ids).toContain("Default");
    expect(ids).toContain("书生-A1.5");
    expect(entry.passthroughModels).toBe(true);
  });
});
