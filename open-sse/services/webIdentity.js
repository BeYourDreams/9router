// Identity + liveness probes for web-cookie providers.
//
// Two callers share this: "Login via Browser" names the captured connection
// after the account it belongs to, and the connection Test button needs a real
// probe per provider (the generic API-key probe has no idea how to talk to a
// web session). A probe answers three things — ok / rejected / unknown — so a
// flaky network never flips a healthy connection to "error".
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { extractCookieValue, normalizeSessionCookieHeader } from "../utils/webCookieAuth.js";
import { normalizeGeminiValidationCookie } from "../utils/geminiCookies.js";
import { grokTlsFetch, GROK_TLS_USER_AGENT } from "./grokTlsClient.js";

// chatglm.cn signs every first-party call with md5(`ts-nonce-salt`).
const CHATGLM_SIGN_SALT = "8a1317a7468aa3ad86e997d08f3f31cb";

/** Mirrors the web client's obfuscated timestamp (identity for 13-char ms values). */
function obfuscateTimestamp(now = Date.now()) {
  const raw = String(now);
  const digits = [...raw].map(Number);
  const total = digits.reduce((sum, d) => sum + d, 0);
  const replacement = (total - digits[digits.length - 2]) % 10;
  return `${raw.slice(0, -2)}${replacement}${raw.slice(-1)}`;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15000;

const OK = (email = "") => ({ ok: true, status: "valid", email });
const REJECTED = (error) => ({ ok: false, status: "invalid", error });
const UNKNOWN = (error) => ({ ok: false, status: "unknown", error });

export function cookieJar(raw) {
  const jar = new Map();
  for (const part of String(raw || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar;
}


function decodeJwtPayload(token) {
  try {
    const b64 = String(token || "").replace(/^base64-/, "").split(".")[1];
    if (!b64) return null;
    return JSON.parse(Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8"));
  } catch {
    return null;
  }
}


async function request(url, { method = "GET", headers = {}, body } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": UA, ...headers },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, ok: res.ok, text };
  } catch (error) {
    return { status: 0, ok: false, error: error?.message || String(error) };
  }
}

/** Gemini sends response headers too large for undici's default cap. */
function geminiHttpsGet(url, headers) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: "gemini.google.com", path: url, method: "GET", maxHeaderSize: 2 * 1024 * 1024, headers: { "User-Agent": UA, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { if (body.length < 2 * 1024 * 1024) body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, ok: res.statusCode === 200, text: body }));
      }
    );
    req.on("error", (error) => resolve({ status: 0, ok: false, error: error.message }));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

const PROBES = {
  async "deepseek-web"(credential) {
    let token = String(credential || "").trim();
    try {
      const parsed = JSON.parse(token);
      if (typeof parsed?.value === "string") token = parsed.value;
    } catch { /* raw token */ }
    if (!token) return REJECTED("Missing userToken");

    const res = await request("https://chat.deepseek.com/api/v0/users/current", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "*/*",
        Origin: "https://chat.deepseek.com",
        Referer: "https://chat.deepseek.com/",
        "X-Client-Bundle-Id": "com.deepseek.chat",
        "X-Client-Platform": "web",
        "X-Client-Version": "2.0.0",
      },
    });
    if (!res.status) return UNKNOWN(res.error);
    if (res.status === 401 || res.status === 403) return REJECTED("userToken is invalid or expired");
    if (!res.ok) return UNKNOWN(`DeepSeek returned HTTP ${res.status}`);

    let json = null;
    try { json = JSON.parse(res.text); } catch { return UNKNOWN("DeepSeek returned invalid JSON"); }
    // Auth failures arrive as HTTP 200 with application-level code 40003.
    if (Number(json?.code) === 40003) return REJECTED("userToken is invalid or expired");
    const biz = json?.data?.biz_data;
    if (!biz?.token) return REJECTED("DeepSeek rejected the userToken");
    return OK(biz.email || "");
  },

  async "chatgpt-web"(credential) {
    const cookie = normalizeSessionCookieHeader(credential, "__Secure-next-auth.session-token");
    if (!cookie) return REJECTED("Missing session cookie");
    const res = await request("https://chatgpt.com/api/auth/session", {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    if (!res.status) return UNKNOWN(res.error);
    if (res.status === 401 || res.status === 403) return REJECTED("Session cookie is invalid or expired");
    if (!res.ok) return UNKNOWN(`ChatGPT returned HTTP ${res.status}`);
    let json = null;
    try { json = JSON.parse(res.text); } catch { return UNKNOWN("ChatGPT returned invalid JSON"); }
    const email = json?.user?.email;
    if (!email) return REJECTED("ChatGPT session is not signed in");
    return OK(email);
  },

  async "grok-web"(credential) {
    const cookie = [extractCookieValue(credential, "sso") ? `sso=${extractCookieValue(credential, "sso")}` : ""]
      .filter(Boolean).join("; ");
    if (!cookie) return REJECTED("Missing sso cookie");
    const headers = { Cookie: credential, "User-Agent": GROK_TLS_USER_AGENT, Accept: "application/json", Origin: "https://grok.com", Referer: "https://grok.com/" };
    let res = null;
    try {
      const tls = await grokTlsFetch("https://grok.com/api/auth/session", { method: "GET", headers, timeoutMs: TIMEOUT_MS });
      res = { status: tls.status, ok: tls.ok, text: await tls.text().catch(() => "") };
    } catch {
      res = await request("https://grok.com/api/auth/session", { headers });
    }
    if (!res.status) return UNKNOWN(res.error);
    if (res.status === 401 || res.status === 403) return REJECTED("sso cookie is invalid or expired");
    if (!res.ok) return UNKNOWN(`Grok returned HTTP ${res.status}`);
    let json = null;
    try { json = JSON.parse(res.text); } catch { return UNKNOWN("Grok returned invalid JSON"); }
    if (json?.status !== "authenticated") return REJECTED("Grok session is not signed in");
    return OK(json?.session?.email || "");
  },


  async "gemini-web"(credential) {
    const cookie = normalizeGeminiValidationCookie(String(credential || ""));
    if (!cookie) return REJECTED("Missing __Secure-1PSID cookie");
    const res = await geminiHttpsGet("/app", { Cookie: cookie, Accept: "text/html,application/xhtml+xml" });
    if (!res.status) return UNKNOWN(res.error);
    if (res.status === 401 || res.status === 403) return REJECTED("__Secure-1PSID cookie is invalid or expired");
    if (!res.ok) return UNKNOWN(`Gemini returned HTTP ${res.status}`);
    // A signed-out landing page also answers 200; only a real session carries SNlM0e.
    if (!/"SNlM0e"\s*:\s*"[^"]+"/.test(res.text)) return REJECTED("Gemini session is not signed in");
    return OK("");
  },

  async "muse-web"(credential) {
    if (!cookieJar(credential).get("hatch_sess")) return REJECTED("Missing hatch_sess cookie");
    const res = await request("https://muse.ai/api/session", {
      headers: { Cookie: credential, Accept: "application/json", Origin: "https://muse.ai", Referer: "https://muse.ai/thread/new" },
    });
    if (!res.status) return UNKNOWN(res.error);
    if (res.status === 401 || res.status === 403) return REJECTED("muse.ai session cookie is invalid or expired");
    if (!res.ok) return UNKNOWN(`muse.ai returned HTTP ${res.status}`);
    return OK("");
  },


  // The identity lives inside the Supabase SSR auth cookie — no network needed.

  async "uc-web"(credential) {
    const jar = cookieJar(credential);
    const client = jar.get("__client");
    if (!client) return REJECTED("Missing __client cookie");
    const clerkOrigin = "https://uncensored.com";
    // Legacy __client JWTs carry `sid`; current ones only `{id, rotating_token}`,
    // so fall back to the client's own session list.
    let sid = decodeJwtPayload(client)?.sid;
    if (typeof sid !== "string" || !sid) {
      const list = await request("https://clerk.uncensored.com/v1/client?_clerk_js_version=5.127.1", {
        headers: { Cookie: `__client=${client}`, Accept: "application/json", Origin: clerkOrigin, Referer: `${clerkOrigin}/` },
      });
      if (!list.status) return UNKNOWN(list.error);
      if (list.status === 401 || list.status === 403) return REJECTED("Clerk session is invalid or expired");
      if (!list.ok) return UNKNOWN(`Clerk returned HTTP ${list.status}`);
      let body = null;
      try { body = JSON.parse(list.text); } catch { return UNKNOWN("Clerk returned invalid JSON"); }
      const payload = body?.response ?? body?.client ?? body;
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      const active = sessions.find((s) => s?.status === "active") ?? sessions[0];
      sid = typeof active?.id === "string" ? active.id : "";
      if (!sid) return REJECTED("Not signed in to uncensored.com — use Login via Browser");
    }
    const res = await request(
      `https://clerk.uncensored.com/v1/client/sessions/${encodeURIComponent(sid)}/tokens?_clerk_js_version=5.127.1`,
      { method: "POST", headers: { Cookie: `__client=${client}`, "Content-Type": "application/x-www-form-urlencoded", Origin: clerkOrigin }, body: "" }
    );
    if (!res.status) return UNKNOWN(res.error);
    if (res.status === 401 || res.status === 403) return REJECTED("Clerk session is invalid or expired");
    if (!res.ok) return UNKNOWN(`Clerk returned HTTP ${res.status}`);
    let json = null;
    try { json = JSON.parse(res.text); } catch { return UNKNOWN("Clerk returned invalid JSON"); }
    if (typeof json?.jwt !== "string" || !json.jwt) return REJECTED("Clerk did not mint a session token");
    const uid = decodeJwtPayload(json.jwt)?.uid;
    const email = typeof uid === "string" ? uid : "";
    return OK(email.includes("@") ? email : "");
  },

  async "qwen-web"(credential) {
    const jar = cookieJar(credential);
    if (!jar.get("isg")) return REJECTED("Missing isg session cookie");
    const res = await request("https://chat2-api.qianwen.com/api/v1/model/list?biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&la=zh-CN&tz=Asia%2FShanghai&wv=4.12.0&ve=4.12.0", {
      headers: { Cookie: credential, Accept: "application/json", Origin: "https://www.qianwen.com", Referer: "https://www.qianwen.com/" },
    });
    if (!res.status) return UNKNOWN(res.error);
    if (res.status === 401 || res.status === 403) return REJECTED("qianwen.com session cookie is invalid or expired");
    if (!res.ok) return UNKNOWN(`qianwen.com returned HTTP ${res.status}`);
    let json = null;
    try { json = JSON.parse(res.text); } catch { return UNKNOWN("qianwen.com returned invalid JSON"); }
    if (Number(json?.code) !== 0) return REJECTED("qianwen.com rejected the session cookie");
    return OK("");
  },

  async "chatglm-web"(credential) {
    // The session is a Cookie header (or bare JWT) with a `chatglm_token` cookie.
    const jar = cookieJar(credential);
    const token = (jar.get("chatglm_token") || "").replace(/^Bearer\s+/i, "")
      || String(credential || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return REJECTED("Missing chatglm_token cookie");

    // /user-api/user/info requires the same signature triple as the chat call:
    //   md5(`<timestamp>-<nonce>-8a1317a7468aa3ad86e997d08f3f31cb`)
    const timestamp = obfuscateTimestamp();
    const nonce = randomUUID().replace(/-/g, "");
    const sign = createHash("md5").update(`${timestamp}-${nonce}-${CHATGLM_SIGN_SALT}`, "utf8").digest("hex");
    const deviceId = jar.get("chatglm-deid") || `device-${randomUUID().replace(/-/g, "")}`;

    const res = await request("https://chatglm.cn/chatglm/user-api/user/info", {
      headers: {
        Cookie: credential.includes("=") ? credential : `chatglm_token=${token}`,
        Accept: "application/json, text/plain, */*",
        "App-Name": "chatglm",
        "X-Lang": "zh",
        "X-App-Platform": "pc",
        "X-App-Version": "0.0.1",
        "X-App-fr": "default",
        "X-Device-Id": deviceId,
        "X-Device-Model": "",
        "X-Device-Brand": "",
        "X-Request-Id": randomUUID().replace(/-/g, ""),
        "X-Exp-Groups": "",
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Sign": sign,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.status) return UNKNOWN(res.error);
    if (res.status === 401 || res.status === 403) return REJECTED("chatglm_token is invalid or expired");
    if (!res.ok) return UNKNOWN(`chatglm.cn returned HTTP ${res.status}`);

    let json = null;
    try { json = JSON.parse(res.text); } catch { return UNKNOWN("chatglm.cn returned invalid JSON"); }
    // App-level auth failure: the gateway answers 200 with a numeric status.
    const code = Number(json?.status ?? json?.code ?? 0);
    if (code === 40103 || code === 401 || code === 400) return REJECTED("chatglm_token is invalid or expired");
    const result = json?.result;
    if (!result || typeof result !== "object") return REJECTED("chatglm.cn did not return a profile");
    const email = typeof result.email === "string" ? result.email : "";
    return OK(email);
  },

  async "intern-web"(credential) {
    const jar = cookieJar(credential);
    const token = jar.get("uaa-token");
    if (!token) return REJECTED("Missing uaa-token cookie");
    const origin = "https://discovery.intern-ai.org.cn";
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Origin: origin,
      Referer: `${origin}/chat`,
    };
    // Two probes, because they fail in different ways:
    //  · POST /getUserInfo {jwt}  — the identity endpoint (nickname/uid).
    //  · GET  /models             — the gateway's own auth check; answers 401
    //    {"msgCode":"A0202","msg":"user authenticate failed"} even when the
    //    user-center path is reachable, so it is the authoritative answer.
    // A bad token must be reported "invalid", never "unknown".
    const res = await request("https://discovery.intern-ai.org.cn/api/user-center/v1/users/getUserInfo", {
      method: "POST",
      headers,
      body: JSON.stringify({ jwt: token }),
    });
    if (res.status === 401 || res.status === 403) return REJECTED("uaa-token is invalid or expired");
    const models = await request("https://discovery.intern-ai.org.cn/api/orbit/v1/models", { headers });
    if (models.status === 401 || models.status === 403) return REJECTED("uaa-token is invalid or expired");
    if (!res.status && models.status === 200) return OK("");
    if (!res.status) return UNKNOWN(res.error);
    if (!res.ok) return UNKNOWN(`Intern returned HTTP ${res.status}`);
    let json = null;
    try { json = JSON.parse(res.text); } catch { return UNKNOWN("Intern returned invalid JSON"); }
    if (Number(json?.code) !== 0 || !json?.data) return REJECTED("Intern rejected the uaa-token");
    const data = json.data;
    const email = typeof data.sso_email === "string" ? data.sso_email : "";
    // Intern accounts are phone/GitHub logins, so sso_email is usually empty and
    // the row would be named after the provider. Fall back to the visible handle.
    const handle = typeof data.nickname === "string" ? data.nickname : "";
    return OK(email || (handle ? `${handle}@intern` : ""));
  },

};

export function hasWebIdentityProbe(providerId) {
  return Object.hasOwn(PROBES, providerId);
}

/**
 * Probe a web-cookie credential.
 * @returns {Promise<{ok: boolean, status: "valid"|"invalid"|"unknown", email?: string, error?: string}>}
 */
export async function fetchWebIdentity(providerId, credential) {
  const probe = PROBES[providerId];
  if (!probe) return UNKNOWN("No identity probe for this provider");
  try {
    const result = await probe(credential);
    return { email: "", ...result };
  } catch (error) {
    return UNKNOWN(error?.message || String(error));
  }
}
