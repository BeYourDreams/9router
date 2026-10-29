import { describe, it, expect } from "vitest";

import { harvest } from "../../open-sse/services/webLogin.js";
import { getWebLoginConfig } from "../../open-sse/services/webLoginConfig.js";

const config = getWebLoginConfig("xiaomimimo-web");

function contextWith(cookies) {
  return {
    cookies: async () => cookies.map(([name, value, domain = ".xiaomimimo.com"]) => ({ name, value, domain })),
    pages: () => [],
  };
}

describe("web login harvest (xiaomimimo)", () => {
  it("anonymous visitor is not ready", async () => {
    const found = await harvest(contextWith([]), config);
    expect(found.ready).toBe(false);
  });

  it("session signature cookie ends the wait", async () => {
    const found = await harvest(contextWith([["ultraspeed_ph", "abc"]]), config);
    expect(found.ready).toBe(true);
    expect(found.cookieHeader).toContain("ultraspeed_ph=abc");
  });

  it("passToken counts and foreign cookies are skipped", async () => {
    const found = await harvest(
      contextWith([["passToken", "v2:abc"], ["csrftoken", "x", ".elsewhere.com"]]),
      config
    );
    expect(found.ready).toBe(true);
    expect(found.cookieHeader).toBe("passToken=v2:abc");
  });
});
