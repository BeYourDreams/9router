// Per-provider login-capture configs for web-cookie providers.
//
// Each entry describes how to log the user in through a real (headed) browser
// window and what to harvest afterwards — pattern of OmniRoute's
// tokenExtractionConfig: open loginUrl, poll until every required token is
// present, then turn the browser context into a connection credential.

/** @typedef {{ type: "cookie" | "localStorage", name: string }} TokenSource */

export const WEB_LOGIN_CONFIGS = {
  "grok-web": {
    loginUrl: "https://grok.com/",
    cookieDomain: ".grok.com",
    // sso appears on login; sso-rw follows. cf_clearance/__cf_bm ride along
    // when Cloudflare challenges the fresh profile — capture them all.
    tokenSources: [{ type: "cookie", name: "sso" }],
  },
  "chatgpt-web": {
    loginUrl: "https://chatgpt.com/",
    cookieDomain: ".chatgpt.com",
    // NextAuth splits large session tokens into `.0`, `.1`, … chunks.
    tokenSources: [{ type: "cookie", name: "__Secure-next-auth.session-token" }],
  },
  "gemini-web": {
    loginUrl: "https://gemini.google.com/",
    cookieDomain: ".google.com",
    // PSID alone identifies the session; PSIDTS rotates and is often absent.
    tokenSources: [
      { type: "cookie", name: "__Secure-1PSID" },
      { type: "cookie", name: "__Secure-1PSIDTS", optional: true },
    ],
  },
  "muse-web": {
    loginUrl: "https://muse.ai/",
    cookieDomain: ".muse.ai",
    // hatch_sess identifies the login; the rest rotate and only enrich the jar.
    tokenSources: [
      { type: "cookie", name: "hatch_sess" },
      { type: "cookie", name: "hatch_gw", optional: true },
      { type: "cookie", name: "hatch_vml", optional: true },
      { type: "cookie", name: "hatch_native_auth_device", optional: true },
    ],
  },
  "deepseek-web": {
    loginUrl: "https://chat.deepseek.com/sign_in",
    cookieDomain: ".deepseek.com",
    tokenSources: [{ type: "localStorage", name: "userToken" }],
    // The executor expects the raw token value, not a cookie header.
    credentialFrom: "localStorageValue",
    validateToken: (value) => {
      if (typeof value !== "string" || !value.trim()) return false;
      try {
        const parsed = JSON.parse(value);
        const token = typeof parsed?.value === "string" ? parsed.value : value;
        return typeof token === "string" && token.length >= 20;
      } catch {
        return value.length >= 20;
      }
    },
  },
  "qwen-web": {
    loginUrl: "https://www.qianwen.com/",
    cookieDomain: ".qianwen.com",
    // `isg` is the session cookie the page's security SDK sets after login;
    // `tfstk` rides along and enriches the jar without gating on it.
    tokenSources: [
      { type: "cookie", name: "isg" },
      { type: "cookie", name: "tfstk", optional: true },
    ],
  },
  "uc-web": {
    loginUrl: "https://uncensored.com/",
    cookieDomain: ".uncensored.com",
    // Clerk hands every anonymous visitor a `__client` cookie, so its presence
    // alone would end the capture before the browser window even paints.
    // `__client_uat` only becomes a real timestamp once a session exists.
    tokenSources: [
      { type: "cookie", name: "__client" },
      {
        type: "cookie",
        name: "__client_uat",
        validateCookie: (value) => Number(value) > 0,
      },
    ],
  },
  "chatglm-web": {
    loginUrl: "https://chatglm.cn/signin",
    cookieDomain: ".chatglm.cn",
    // chatglm_token carries the JWT access token; refresh_token for renewal.
    tokenSources: [
      { type: "cookie", name: "chatglm_token" },
      { type: "cookie", name: "chatglm_refresh_token", optional: true },
      { type: "cookie", name: "chatglm_user_id", optional: true },
    ],
  },
  "xiaomimimo-web": {
    loginUrl: "https://aistudio.xiaomimimo.com/",
    cookieDomain: ".xiaomimimo.com",
    tokenSources: [
      { type: "cookie", namePattern: /^(deviceId|passToken|serviceToken|userId|cUserId|.+_ph)$/ },
    ],
  },
  "intern-web": {
    loginUrl: "https://discovery.intern-ai.org.cn/chat",
    cookieDomain: ".intern-ai.org.cn",
    // 登录后以 `uaa-token` (JWT) 形式设在 discovery.intern-ai.org.cn 域名下；
    // chat 接口 /api/orbit/v1/chat 带 Cookie 即可鉴权。
    tokenSources: [{ type: "cookie", name: "uaa-token" }],
  },
};

export function getWebLoginConfig(providerId) {
  return WEB_LOGIN_CONFIGS[providerId] || null;
}

export function listWebLoginProviders() {
  return Object.keys(WEB_LOGIN_CONFIGS);
}
