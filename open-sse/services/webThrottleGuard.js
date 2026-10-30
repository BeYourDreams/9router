// Applies web-request pacing to every web-cookie provider at one seam.
//
// Each web provider could import the throttle itself, but then every new web
// provider has to remember to — and the ones that forget are the ones that get
// their accounts banned. Hooking the EXECUTOR call in chatCore means the
// throttle is on by default and a provider opts OUT (because it drives a real
// browser, or because it has its own pacing), rather than opting in.

import { WEB_THROTTLE_ENABLED, WEB_THROTTLE_CONFIG } from "../config/runtimeConfig.js";
import REGISTRY from "../providers/registry/index.js";
import { webThrottleKey, withWebThrottle } from "./webRequestThrottle.js";

const WEB_COOKIE_PROVIDERS = new Set(
  REGISTRY.filter((e) => e.category === "webCookie").map((e) => e.id),
);

// Providers whose requests already leave at a natural pace and must not be
// double-paced: they drive a real browser (typing, waiting on the DOM, polling
// for the reply), so every request is already seconds apart by construction.
// Adding a token bucket on top only delays without protecting.
const SELF_PACED = new Set(["gemini-web", "muse-web", "qwen-web", "chatglm-web", "uc-web"]);

export function isWebCookieProvider(provider) {
  return WEB_COOKIE_PROVIDERS.has(provider);
}

/** Skip when disabled globally, or when the provider is not a web-cookie one. */
export function shouldThrottleWebProvider(provider) {
  return WEB_THROTTLE_ENABLED && WEB_COOKIE_PROVIDERS.has(provider) && !SELF_PACED.has(provider);
}

/**
 * Run an executor's `execute` under the account's throttle.
 * Signature-compatible with BaseExecutor#execute for the fields we pass through.
 */
export async function throttledExecute(executor, args) {
  const { provider, credentials, connectionId, log } = args;
  if (!shouldThrottleWebProvider(provider)) return executor.execute(args);

  const key = webThrottleKey({ connectionId, provider, credentials });
  try {
    return await withWebThrottle(
      key,
      () => executor.execute(args),
      { log, tag: "THROTTLE", statusOf: (r) => r?.response?.status },
    );
  } catch (err) {
    if (err?.code === "WEB_THROTTLE_TIMEOUT") {
      // Surface it as 429 so the existing 429 machinery (account fallback,
      // combo rotation, retry-after handling) treats it like any throttle.
      log?.warn?.("THROTTLE", `${provider}: ${err.message}`);
      const response = new Response(
        JSON.stringify({
          error: {
            message: err.message,
            type: "rate_limit_error",
            code: "web_throttle_timeout",
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
      return { response, url: "", headers: {}, transformedBody: args.body };
    }
    throw err;
  }
}

export { WEB_COOKIE_PROVIDERS, SELF_PACED, WEB_THROTTLE_CONFIG };
