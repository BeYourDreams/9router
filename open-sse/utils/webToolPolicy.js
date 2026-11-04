// Policy for the web-cookie tool bridge (see utils/webToolBridge.js).
//
// The bridge turns a webUI model's plain-text `<tool>` reply into real OpenAI
// `tool_calls`, and pairs that with a request-side contract injected into the
// prompt (translator/webTools.js). It exists because the great majority of
// webCookie executors have no native function calling.
//
// A handful of webCookie executors DO implement their own tool plumbing
// (grok-web's native cards, gemini-web's prepareToolMessages, chatgpt-web and
// deepseek-web each have a dedicated tools module). Running the generic bridge
// on them would inject the contract twice and parse the same text twice, so
// they are opted out here.

import { PROVIDERS } from "../config/providers.js";

// Executors with their own tool bridge — never apply the generic one.
export const SELF_HANDLED_TOOL_PROVIDERS = new Set([
  "chatgpt-web",
  "deepseek-web",
  "gemini-web",
  "grok-web",
]);

/**
 * True when `provider` is a webCookie browser-login provider whose tool calling
 * should be handled by the generic text bridge.
 */
export function usesWebToolBridge(provider) {
  if (!provider || SELF_HANDLED_TOOL_PROVIDERS.has(provider)) return false;
  return PROVIDERS[provider]?.category === "webCookie";
}

/**
 * True when the request actually carries tools the model could call.
 */
export function requestHasTools(body) {
  const tools = body?.tools;
  if (Array.isArray(tools) && tools.length > 0) return true;
  // OpenAI legacy function calling.
  const legacy = body?.functions;
  return Array.isArray(legacy) && legacy.length > 0;
}
