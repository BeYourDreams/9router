import fs from "node:fs";
const s = JSON.parse(fs.readFileSync("kimi-capture/storage.json", "utf8"));
const tok = String(s.after.localStorage.access_token).replace(/^"|"$/g, "");
const e = JSON.parse(fs.readFileSync("kimi-capture/all-requests.json", "utf8"));
const reqs = e.filter((x) => x.method === "POST" && /ChatService\/Chat/.test(x.url || ""));
const h = reqs[reqs.length - 1].headers;
const payload = JSON.stringify({ scenario: "SCENARIO_CHAT", tools: [], message: { role: "user", blocks: [{ message_id: "", text: { content: "用一个字回答：天是什么颜色" } }], scenario: "SCENARIO_CHAT", is_goal: false }, options: { thinking: false, model: "k28-instant" }, project_id: "" });
const buf = Buffer.alloc(5 + Buffer.byteLength(payload));
buf.writeUInt32BE(Buffer.byteLength(payload), 1); buf.write(payload, 5);
const r = await fetch("https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat", {
  method: "POST",
  headers: { authorization: "Bearer " + tok, "content-type": "application/connect+json", "connect-protocol-version": "1", "x-msh-device-id": h["x-msh-device-id"], "x-msh-session-id": h["x-msh-session-id"], "x-msh-platform": "web", "x-msh-version": "2.3.0", "x-language": "zh-CN", referer: "https://www.kimi.com/", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36" },
  body: buf, signal: AbortSignal.timeout(60000),
});
console.log("status", r.status, "ct", r.headers.get("content-type"));
const b = Buffer.from(await r.arrayBuffer());
let i = 0; const frames = [];
while (i + 5 <= b.length) { const flag = b[i], len = b.readUInt32BE(i + 1); if (len > b.length - i - 5) { frames.push([flag, b.subarray(i).toString("utf8")]); break; } frames.push([flag, b.subarray(i + 5, i + 5 + len).toString("utf8")]); i += 5 + len; }
console.log("bytes", b.length, "frames", frames.length);
frames.forEach(([f, t], k) => console.log(`#${k} F${f} ${t.slice(0, 190)}`));
console.log("\nANSWER:", frames.filter(([, t]) => t.includes('"block.text.content"')).map(([, t]) => { const m = /"content":"(.*?)"/.exec(t); return m ? JSON.parse(`"${m[1]}"`) : ""; }).join(""));
