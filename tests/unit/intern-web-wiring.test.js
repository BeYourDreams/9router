import assert from "node:assert/strict";
import { getWebLoginConfig, listWebLoginProviders } from "../../open-sse/services/webLoginConfig.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

const entry = REGISTRY.find((e) => e.id === "intern-web");
assert.ok(entry, "intern-web registry entry missing");
assert.equal(entry.category, "webCookie");
assert.equal(entry.authType, "cookie");

const config = getWebLoginConfig("intern-web");
assert.ok(config, "intern-web webLogin config missing");
assert.equal(config.loginUrl, "https://discovery.intern-ai.org.cn/chat");

assert.ok(listWebLoginProviders().includes("intern-web"), "intern-web not in web-login provider list");

console.log("✓ intern-web wired into registry + webLoginConfig + web-login providers list");
