// Which captured yuanbao headers are required? Group-bisect (fewer real requests
// than one-at-a-time — each probe is a live chat turn on a real account).
import fs from "node:fs";

const ss = JSON.parse(fs.readFileSync("yuanbao-capture/storage-state.json", "utf8"));
const cookie = ss
  .cookies.filter((c) => /tencent\.com/.test(c.domain))
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
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
const SKIP = new Set(["content-length", "accept-encoding", "cookie", "user-agent", "origin", "referer", "x-requested-with", "content-type"]);
const ALL = {};
for (const [k, v] of Object.entries(captured.headers)) if (!SKIP.has(k)) ALL[k] = v;

const conv = await fetch("https://yuanbao.tencent.com/api/user/agent/conversation/create", {
  method: "POST",
  headers: BASE,
  body: JSON.stringify({ agentId: "naQivTmsDa", isTemporary: false }),
});
const conversationId = (await conv.json()).id;
const bodyStr = JSON.stringify({ ...JSON.parse(captured.postData), prompt: "回答：好", displayPrompt: "回答：好", conversationId });
console.log("candidate headers:", Object.keys(ALL).length);

async function ok(headers) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch("https://yuanbao.tencent.com/api/chat/" + conversationId, {
      method: "POST",
      headers: { ...BASE, accept: "text/event-stream", ...headers },
      body: bodyStr,
    });
    const text = await res.text();
    if (/"type":"error"/.test(text)) {
      const msg = (text.match(/"msg":"([^"]{0,50})/) || [])[1] || "";
      // "服务繁忙" = rate limit, not a header problem. Back off and retry once.
      if (/繁忙|稍后/.test(msg)) continue;
      return false;
    }
    return true;
  }
  throw new Error("rate limited twice — stop bisecting, wait a minute");
}

const keep = { ...ALL };
let remaining = Object.keys(ALL);
while (remaining.length > 1) {
  const half = Math.ceil(remaining.length / 2);
  const drop = remaining.slice(0, half);
  const trial = {};
  for (const k of remaining.slice(half)) trial[k] = keep[k];
  if (await ok(trial)) {
    console.log(`can drop: ${drop.join(", ")}`);
    for (const k of drop) delete keep[k];
    remaining = remaining.slice(half);
  } else {
    remaining = drop;
  }
}
console.log("\nMINIMAL header set:");
for (const [k, v] of Object.entries(keep)) console.log(`  ${k}: ${String(v).slice(0, 70)}`);
console.log("\nfinal check:", (await ok(keep)) ? "works" : "BROKEN");
