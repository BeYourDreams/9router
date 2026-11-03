// Throwaway probe: does yuanbao's /api/chat need its signature headers?
import fs from "node:fs";

const ss = JSON.parse(fs.readFileSync("yuanbao-capture/storage-state.json", "utf8"));
const cookie = ss.cookies.filter((c) => /tencent\.com/.test(c.domain)).map((c) => `${c.name}=${c.value}`).join("; ");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const BASE = {
  "content-type": "application/json",
  cookie,
  "user-agent": UA,
  origin: "https://yuanbao.tencent.com",
  referer: "https://yuanbao.tencent.com/chat/naQivTmsDa",
  "x-requested-with": "XMLHttpRequest",
};
const captured = JSON.parse(fs.readFileSync("yuanbao-capture/all-requests.json", "utf8")).find(
  (e) => e.method === "POST" && /\/api\/chat\//.test(e.url)
);

async function chat(label, { headers, body }) {
  const res = await fetch("https://yuanbao.tencent.com/api/chat/" + body.conversationId, {
    method: "POST",
    headers: { ...BASE, accept: "text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const first = text.split("\n\n").find((b) => /"msg"/.test(b)) || text.slice(0, 200);
  console.log(`\n[${label}] HTTP ${res.status} :: ${first.replace(/\n/g, " ").slice(0, 220)}`);
}

const conv = await fetch("https://yuanbao.tencent.com/api/user/agent/conversation/create", {
  method: "POST",
  headers: BASE,
  body: JSON.stringify({ agentId: "naQivTmsDa", isTemporary: false }),
});
const id = (await conv.json()).id;
console.log("conversation:", id);

const clean = {
  model: "gpt_175B_0404",
  prompt: "说一个字",
  displayPrompt: "说一个字",
  displayPromptType: 1,
  agentId: "naQivTmsDa",
  isTemporary: false,
  projectId: "",
  chatModelId: "hunyuan_gpt_175B_0404",
  supportFunctions: ["openAutoSearchSwitch", "autoInternetSearch"],
  multimedia: [],
  supportHint: 1,
  version: "v2",
  conversationId: id,
  offsetOfHour: 8,
  offsetOfMinute: 0,
};

// A: no signature headers at all
await chat("A bare", { headers: {}, body: clean });

// B: only the identity-ish static headers from the capture (no x-uskey, no per-request md5)
const c = captured.headers;
await chat("B static ids", {
  headers: {
    "x-device-id": c["x-device-id"],
    "x-hy92": c["x-hy92"],
    "x-hy93": c["x-hy93"],
    "x-agentid": c["x-agentid"],
    "x-platform": "web",
    "x-source": "web",
    "x-webversion": c["x-webversion"],
    "x-chat_version": "v1",
    chat_version: "v1",
    "x-language": "zh-CN",
    "x-input-type": "text",
    "x-event-input-type": "11",
    "x-instance-id": "5",
    "x-commit-tag": c["x-commit-tag"],
    "x-web-third-source": "main",
  },
  body: clean,
});

// C: everything captured, verbatim, but our own body + conversation
const all = {};
for (const [k, v] of Object.entries(c)) {
  if (["content-length", "accept-encoding", "cookie", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"].includes(k)) continue;
  all[k] = v;
}
await chat("C replayed headers", { headers: all, body: clean });

// D: exact original request replayed (same body, same conversation id) — proves
//    whether x-uskey/x-bus-params-md5 are bound to the body
await chat("D full replay", {
  headers: all,
  body: JSON.parse(captured.postData),
});
