// Yiyan Web (chat.baidu.com / 文心一言) — plain HTTP adapter.
import { randomUUID } from "node:crypto";
import { SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";

const BASE = "https://chat.baidu.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// We'll inline captured headers/body from the capture file at runtime? Module can't require JSON easily; hardcode minimal.
const CAPTURED_HEADERS = {
  "x-chat-message": "query:hi,anti_ext:%7B%22inputT%22%3Anull%2C%22ck1%22%3A102%2C%22ck9%22%3A760%2C%22ck10%22%3A527%7D,enter_type:yiyan_site,re_rank:1,modelName:smartMode,sa:bkb",
  "isdeepseek": "1",
  "referer": "https://wenxin.baidu.com/",
  "personifiedswitch": "0",
  "source": "pc_csaitab",
  "accept": "text/event-stream",
  "content-type": "application/json",
  "landingpageswitch": "",
};

const BODY_TEMPLATE = {
  "message": {
    "inputMethod": "chat_search",
    "isRebuild": false,
    "content": {
      "query": "",
      "agentInfo": { "agent_id": [""], "params": "{\"agt_rk\":1,\"agt_sess_cnt\":1}" },
      "agentInfoList": [],
      "qtype": 0
    },
    "searchInfo": {
      "srcid": "",
      "order": "",
      "tplname": "",
      "dqaKey": "",
      "re_rank": "1",
      "ori_lid": "",
      "sa": "bkb",
      "enter_type": "yiyan_site",
      "chatParams": { "setype": "csaitab", "chat_samples": "WISE_NEW_CSAITAB", "chat_token": "MjBhY2FkMTd8NDlmNjhhNWM4NDkzZWMyYzBiZjQ4OTgyMWMyMWZjM2J8MTc5MzU5MTk0NTcyN3w2NTczMDY5NDc1OTk1MDk3MDg5-6573069475995097089-3", "scene": "" },
      "isPrivateChat": false,
      "usedModel": { "modelName": "smartMode", "modelFunction": { "deepSearch": "0", "thinkMode": "0" }, "showModelName": "smartMode" },
      "landingPageSwitch": "",
      "landingPage": "aitab",
      "ecomFrom": "",
      "hasLocPermission": "",
      "isInnovate": 2,
      "applid": "",
      "a_lid": "",
      "capsuleSelectMode": "fast",
      "showMindMap": false,
      "deepDecisionInfo": { "isDeepDecision": 0 }
    },
    "from": "",
    "source": "pc_csaitab",
    "query": [{ "type": "TEXT", "data": { "text": { "query": "hi", "extData": "{}", "text_type": "" } } }],
    "anti_ext": { "inputT": null, "ck1": 102, "ck9": 760, "ck10": 527 }
  },
  "sa": "bkb",
  "setype": "csaitab",
  "rank": 1
};

export function resolveCookieHeader(credentials) {
  const raw = String(credentials?.apiKey || credentials?.accessToken || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies || [];
      return cookies.filter((c) => /baidu\.com/.test(String(c.domain || "")) && c.value).map((c) => `${c.name}=${c.value}`).join("; ");
    } catch { return raw; }
  }
  return raw.replace(/^Cookie:\s*/i, "");
}

export async function executeYiyanWeb({ input, fetchImpl }) {
  const { body, credentials, signal } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const cookie = resolveCookieHeader(credentials);
  if (!cookie) throw Object.assign(new Error("Yiyan Web needs the baidu.com login cookie."), { status: 401 });
  const messages = bodyObj?.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("") : "";
  if (!text.trim()) throw Object.assign(new Error("Yiyan Web needs a user message"), { status: 400 });

  const payload = JSON.parse(JSON.stringify(BODY_TEMPLATE));
  payload.message.query[0].data.text.query = text;

  const headers = { ...CAPTURED_HEADERS, Cookie: cookie, "user-agent": UA, referer: "https://wenxin.baidu.com/" };
  const res = await fetchImpl(`${BASE}/aichat/api/conversation`, { method: "POST", headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Yiyan Web rejected the cookie."), { status: 401 });
  if (!res.ok) { const d = await res.text().catch(() => ""); throw Object.assign(new Error(`Yiyan Web HTTP ${res.status}: ${d.slice(0,200)}`), { status: res.status }); }

  const raw = await res.text();
  let content = "";
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dm = block.match(/^data:\s*(.*)$/m);
    if (!dm) continue;
    let j;
    try { j = JSON.parse(dm[1]); } catch { continue; }
    const gen = j?.data?.message?.content?.generator;
    if (gen?.data?.value) content += gen.data.value;
    else if (typeof gen?.text === "string" && gen.text) content += gen.text;
  }
  if (!content) throw Object.assign(new Error("Yiyan Web returned no content"), { status: 502 });

  const cid = `chatcmpl-yiyan-${randomUUID()}`;
  const model = bodyObj?.model || "yiyan";
  const chunk = { id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
  const finish = { id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  const queue = [`data: ${JSON.stringify(chunk)}\n\n`, `data: ${JSON.stringify(finish)}\n\n`, "data: [DONE]\n\n"];
  let cursor = 0;
  const stream = new ReadableStream({ pull(c) { if (cursor >= queue.length) { c.close(); return; } c.enqueue(new TextEncoder().encode(queue[cursor++])); } });
  return { response: new Response(stream, { status: 200, headers: SSE_HEADERS_NO_BUFFER }), url: `${BASE}/aichat/api/conversation`, headers: {}, transformedBody: bodyObj };
}

import { BaseExecutor } from "./base.js";

const YIYAN_BASE = "https://chat.baidu.com";

function yiyanError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "Content-Type": "application/json" } });
}

export class YiyanWebExecutor extends BaseExecutor {
  constructor() { super("yiyan-web", { id: "yiyan-web", baseUrl: YIYAN_BASE }); }
  async testConnection(credentials) { return !!resolveCookieHeader(credentials); }
  async execute(input) {
    try {
      return await executeYiyanWeb({ input, fetchImpl: (url, options) => this.fetchUpstream(url, options, input.proxyOptions) });
    } catch (error) {
      const status = error.status || 502;
      return { response: yiyanError(status, error.message || "Yiyan Web request failed"), url: YIYAN_BASE, headers: {}, transformedBody: input.body };
    }
  }
}
