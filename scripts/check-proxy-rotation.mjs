import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Load the real module source without Next's "@/models" alias (only used by
// resolveConnectionProxyConfig, which this check never calls).
const src = readFileSync(new URL("../src/lib/network/connectionProxy.js", import.meta.url), "utf8");
const { DIRECT_POOL_ID, pickProxyPoolId, rememberProxyPoolSuccess } = await import(
  `data:text/javascript,${encodeURIComponent(src)}`
);

const provider = "check-provider";
assert.equal(pickProxyPoolId(["p1", "p2"], "round-robin", provider), DIRECT_POOL_ID, "round starts direct");
rememberProxyPoolSuccess(provider, "p2");
assert.equal(pickProxyPoolId(["p1", "p2"], "round-robin", provider, new Set([DIRECT_POOL_ID])), "p2", "then last successful pool");
assert.equal(pickProxyPoolId(["p1", "p2"], "round-robin", provider, new Set([DIRECT_POOL_ID, "p2"])), "p1", "then remaining pools");
assert.equal(pickProxyPoolId(["p1", "p2"], "round-robin", provider, new Set([DIRECT_POOL_ID, "p1", "p2"])), null);
assert.equal(pickProxyPoolId([], "round-robin", provider), DIRECT_POOL_ID);
rememberProxyPoolSuccess(provider, DIRECT_POOL_ID);
assert.equal(pickProxyPoolId(["p1", "p2"], "round-robin", provider, new Set([DIRECT_POOL_ID])), "p2", "direct success does not replace last pool");
assert.equal(pickProxyPoolId(["p1", "p2"], "none", provider), "p1");
const random = Math.random;
Math.random = () => 0.99;
assert.equal(pickProxyPoolId(["p1", "p2"], "random", provider, new Set(["p2"])), "p1");
Math.random = random;
console.log("proxy rotation check passed");
