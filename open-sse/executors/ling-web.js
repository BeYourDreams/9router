// Ling Web (chat.ant-ling.com) — plain HTTP adapter.
import { randomUUID } from "node:crypto";
import { SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";

const BASE = "https://chat.ant-ling.com";
const MODEL = "Ling-3.1-flash";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export function resolveCookieHeader(credentials) {
  const raw = String(credentials?.apiKey || credentials?.accessToken || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies || [];
      return cookies.filter((c) => /ant-ling\.com|tbox\.cn/.test(String(c.domain || "")) && c.value).map((c) => `${c.name}=${c.value}`).join("; ");
    } catch { return raw; }
  }
  return raw.replace(/^Cookie:\s*/i, "");
}

export async function executeLingWeb({ input, fetchImpl }) {
  const { body, credentials, signal } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const cookie = resolveCookieHeader(credentials);
  if (!cookie) throw Object.assign(new Error("Ling Web needs the ant-ling.com login cookie."), { status: 401 });
  const messages = bodyObj?.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("") : "";
  if (!text.trim()) throw Object.assign(new Error("Ling Web needs a user message"), { status: 400 });

  const convRes = await fetchImpl(`${BASE}/meta/conversation/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: BASE, Referer: `${BASE}/chat`, "User-Agent": UA, "Accept-Language": "zh-CN" },
    body: JSON.stringify({ modelCode: MODEL }),
    ...(signal ? { signal } : {}),
  });
  const convJson = await convRes.json().catch(() => ({}));
  const convId = convJson?.data?.id ?? convJson?.id ?? convJson?.conversationId;
  if (!convId) {
    const notLogin = convJson?.errorCode === "USER_NOT_LOGIN" || convJson?.success === false;
    throw Object.assign(new Error(`Ling Web could not open a conversation: ${JSON.stringify(convJson).slice(0,160)}`), { status: notLogin ? 401 : 502 });
  }

  const headers = { "Content-Type": "application/json", "x-webgw-protocol": "chunked", Accept: "text/event-stream", Cookie: cookie, Origin: BASE, Referer: `${BASE}/chat`, "User-Agent": UA, "Accept-Language": "zh-CN" };
  const payload = { input: text, conversationId: convId, model: MODEL, config: {}, files: [] };

  const res = await fetchImpl(`${BASE}/api/v2/chat`, { method: "POST", headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Ling Web rejected the cookie."), { status: 401 });
  if (!res.ok) { const d = await res.text().catch(() => ""); throw Object.assign(new Error(`Ling Web HTTP ${res.status}: ${d.slice(0,200)}`), { status: res.status }); }

  const raw = await res.text();
  let content = "";
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m) continue;
    let j;
    try { j = JSON.parse(m[1]); } catch { continue; }
    let p = j;
    if (typeof p?.payload === "string") { try { p = JSON.parse(p.payload); } catch {} }
    if (typeof p?.content === "string") content += p.content;
    if (typeof p?.reasonContent === "string") { /* ignore reasoning for now */ }
  }
  if (!content) throw Object.assign(new Error("Ling Web returned no content"), { status: 502 });

  const cid = `chatcmpl-ling-${convId}`;
  const model = bodyObj?.model || "ling";
  const chunk = { id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
  const finish = { id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  const queue = [`data: ${JSON.stringify(chunk)}\n\n`, `data: ${JSON.stringify(finish)}\n\n`, "data: [DONE]\n\n"];
  let cursor = 0;
  const stream = new ReadableStream({ pull(c) { if (cursor >= queue.length) { c.close(); return; } c.enqueue(new TextEncoder().encode(queue[cursor++])); } });
  return { response: new Response(stream, { status: 200, headers: SSE_HEADERS_NO_BUFFER }), url: `${BASE}/api/v2/chat`, headers: {}, transformedBody: bodyObj };
}

import { BaseExecutor } from "./base.js";

const LING_BASE = "https://chat.ant-ling.com";

function lingError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "Content-Type": "application/json" } });
}

export class LingWebExecutor extends BaseExecutor {
  constructor() { super("ling-web", { id: "ling-web", baseUrl: LING_BASE }); }
  async testConnection(credentials) { return !!resolveCookieHeader(credentials); }
  async execute(input) {
    try {
      return await executeLingWeb({ input, fetchImpl: (url, options) => this.fetchUpstream(url, options, input.proxyOptions) });
    } catch (error) {
      const status = error.status || 502;
      return { response: lingError(status, error.message || "Ling Web request failed"), url: LING_BASE, headers: {}, transformedBody: input.body };
    }
  }
}
