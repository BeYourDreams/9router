// Yuanbao Web (yuanbao.tencent.com) — plain HTTP adapter.
import { randomUUID } from "node:crypto";
import { SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";

const BASE = "https://yuanbao.tencent.com";
const AGENT_ID = "naQivTmsDa";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// Replayed from a captured turn; only the cookie is account-specific.
const CAPTURED_HEADERS = {
  "x-instance-id": "5",
  "x-event-input-type": "11",
  "x-commit-tag": "19b1da57",
  "x-uskey": "DCAxFeb05pDmvvCtOP3B8IOqDrUH5%2F8iba2rGlUpGHRtKIb47nMQesTDg30q2WNwYweR85Vp52Fp%0AvrekG7RB%2FIOzX%2FpM9ucxau2mPTKQUKehd3Uj2vStd11%2F4xQ3sXJ1H2mAkc%2Fp5UDwudOpN8OG8Vmi%0AC6SE4dypb9rqPTTICN7ifjUp1LVgHId74TY3sXJ1eV8V7cw052D5%2B9tnYHHXnwtzBrIK9%2BD2Z99z%0ANTBFXrGqbX%2BgwbA7OBMwkpFq002mcl7G8GJ061DmrvH8PyRY82mmDrSK9r8iZ62rGlSQC%2FZxLXJx%0A2Mbue16%2FyxEq2WN2eT7G5kwc6xCU%2FncTR5e1%2Fs0%2FJ%2BKO4%2FF5fL%2F9NArCWdRzNsLxq%2Bxte2wl8xWt%0A03rmeJtR7H%2FpyVFurdE3PeFUk2OyCrfe99HgMMpsZxdTUNWifsagh%2BU1eBh%2B8wiqsFTmdx8QkcI6%0AkAyo6rekG7DV4Jy%2FWG%2BF5%2BEcb99qPSfcQ%2Fc1NsqtmfThdqw34SiqsFlmdw0f5k%2Fp7Vg7ufmpP7DB%0A%2FJCtEfKG8MjibLqiPhfcQ%2FR0NsqhxfT%2FYIw48x5qiiK0KI3J5nJ05VX7zdQkG7PZ4JyyJ%2BKN9%2FF5%0Aa6N2PxVTU%2FZzNsBtq%2BxhNs%3D%3D",
  "chat_version": "v1",
  "x-input-type": "text",
  "x-bus-params-md5": "afe4e7cde63085e3fd446262787512ec",
  "x-web-third-source": "main",
  "x-language": "zh-CN",
  "x-agentid": AGENT_ID,
  "x-platform": "win",
  "x-source": "web",
  "x-webversion": "2.91.0",
  "x-hy93": "1ab020b35241007e2117a9acffec2b93ab5a63e2f1",
  "x-device-id": "1ab020b35241007e2117a9acffec2b93ab5a63e2f1",
  "x-hy92": "0d938d142117a9acffec2b930200000bd1ab02",
  "x-timestamp": "1793591895474",
  "x-os_version": "Windows(10)-Blink",
  "x-trid-channel": "undefined",
  "x-exp-params": "enableNewPcStyle=2",
  "x-web-ch-id": "null",
  "x-ybuitest": "0",
  "x-webdriver": "0",
  "x-hy106": "",
  "x-traceparent": "31cf124c2df48c02596ab95936a45e5a",
  "x-requested-with": "XMLHttpRequest",
};

export function resolveCookieHeader(credentials) {
  const raw = String(credentials?.apiKey || credentials?.accessToken || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies || [];
      return cookies.filter((c) => /tencent\.com/.test(String(c.domain || "")) && c.value).map((c) => `${c.name}=${c.value}`).join("; ");
    } catch { return raw; }
  }
  return raw.replace(/^Cookie:\s*/i, "");
}

export async function executeYuanbaoWeb({ input, fetchImpl }) {
  const { body, credentials, signal } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const cookie = resolveCookieHeader(credentials);
  if (!cookie) throw Object.assign(new Error("Yuanbao Web needs the tencent.com login cookie."), { status: 401 });
  const messages = bodyObj?.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("") : "";
  if (!text.trim()) throw Object.assign(new Error("Yuanbao Web needs a user message"), { status: 400 });

  const convRes = await fetchImpl(`${BASE}/api/user/agent/conversation/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: BASE, Referer: `${BASE}/chat/${AGENT_ID}`, "User-Agent": UA, "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({ agentId: AGENT_ID, isTemporary: false }),
    ...(signal ? { signal } : {}),
  });
  const convJson = await convRes.json().catch(() => ({}));
  const convId = convJson?.id;
  if (!convId) throw Object.assign(new Error(`Yuanbao Web could not open a conversation: ${JSON.stringify(convJson).slice(0,160)}`), { status: 502 });

  const headers = { ...CAPTURED_HEADERS, Cookie: cookie, "content-type": "text/plain;charset=UTF-8", accept: "text/event-stream", referer: `${BASE}/chat/${AGENT_ID}/${convId}`, "user-agent": UA, "x-agentid": `${AGENT_ID}/${convId}`, "x-timestamp": String(Date.now()) };
  const payload = { model: bodyObj?.model || "gpt_175B_0404", prompt: text, displayPrompt: text, displayPromptType: 1, agentId: AGENT_ID, isTemporary: false, projectId: "", chatModelId: bodyObj?.model === "hunyuan" ? "hunyuan_gpt_175B_0404" : "hunyuan_gpt_175B_0404", supportFunctions: ["openAutoSearchSwitch", "autoInternetSearch"], multimedia: [], supportHint: 1, chatModelExtInfo: JSON.stringify({ modelId: "hunyuan_gpt_175B_0404", agentModeModelSetting: { modelId: "hunyuan_gpt_175B_0404" }, supportFunctions: { internetSearch: "" }, internetSearch: "autoInternetSearch" }), applicationIdList: [], version: "v2", extReportParams: null, isAtomInput: false, conversationId: convId, offsetOfHour: 8, offsetOfMinute: 0 };

  const res = await fetchImpl(`${BASE}/api/chat/${convId}`, { method: "POST", headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Yuanbao Web rejected the cookie."), { status: 401 });
  if (!res.ok) { const d = await res.text().catch(() => ""); throw Object.assign(new Error(`Yuanbao Web HTTP ${res.status}: ${d.slice(0,200)}`), { status: res.status }); }

  const raw = await res.text();
  let content = "";
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m) continue;
    try { const j = JSON.parse(m[1]); if (j?.type === "text" && typeof j.msg === "string") content += j.msg; } catch {}
  }
  if (!content) throw Object.assign(new Error("Yuanbao Web returned no content"), { status: 502 });

  const cid = `chatcmpl-yuanbao-${convId}`;
  const chunk = { id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: bodyObj?.model || "yuanbao", choices: [{ index: 0, delta: { content }, finish_reason: null }] };
  const finish = { id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: bodyObj?.model || "yuanbao", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  const queue = [`data: ${JSON.stringify(chunk)}\n\n`, `data: ${JSON.stringify(finish)}\n\n`, "data: [DONE]\n\n"];
  let cursor = 0;
  const stream = new ReadableStream({ pull(c) { if (cursor >= queue.length) { c.close(); return; } c.enqueue(new TextEncoder().encode(queue[cursor++])); } });
  return { response: new Response(stream, { status: 200, headers: SSE_HEADERS_NO_BUFFER }), url: `${BASE}/api/chat/${convId}`, headers: {}, transformedBody: bodyObj };
}

import { BaseExecutor } from "./base.js";

const YUANBAO_BASE = "https://yuanbao.tencent.com";

function yuanbaoError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "Content-Type": "application/json" } });
}

export class YuanbaoWebExecutor extends BaseExecutor {
  constructor() { super("yuanbao-web", { id: "yuanbao-web", baseUrl: YUANBAO_BASE }); }
  async testConnection(credentials) { return !!resolveCookieHeader(credentials); }
  async execute(input) {
    try {
      return await executeYuanbaoWeb({ input, fetchImpl: (url, options) => this.fetchUpstream(url, options, input.proxyOptions) });
    } catch (error) {
      const status = error.status || 502;
      return { response: yuanbaoError(status, error.message || "Yuanbao Web request failed"), url: YUANBAO_BASE, headers: {}, transformedBody: input.body };
    }
  }
}
