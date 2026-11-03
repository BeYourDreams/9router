import fs from "node:fs";
const s = JSON.parse(fs.readFileSync("kimi-capture/storage.json", "utf8"));
const tok = String(s.after.localStorage.access_token).replace(/^"|"$/g, "");
const claims = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString());
const e = JSON.parse(fs.readFileSync("kimi-capture/all-requests.json", "utf8"));
const reqs = e.filter((x) => x.method === "POST" && /ChatService\/Chat/.test(x.url || ""));
const h = reqs[reqs.length - 1].headers;
const payload = JSON.stringify({ scenario: "SCENARIO_CHAT", tools: [], message: { role: "user", blocks: [{ message_id: "", text: { content: "用一个字回答：地是什么颜色" } }], scenario: "SCENARIO_CHAT", is_goal: false }, options: { thinking: false, model: "k28-instant" }, project_id: "" });
const buf = Buffer.alloc(5 + Buffer.byteLength(payload));
buf.writeUInt32BE(Buffer.byteLength(payload), 1); buf.write(payload, 5);

async function run(name, headers) {
  try {
    const r = await fetch("https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat", { method: "POST", headers, body: buf, signal: AbortSignal.timeout(45000) });
    const b = Buffer.from(await r.arrayBuffer());
    let i = 0; const texts = []; const errs = [];
    while (i + 5 <= b.length) { const flag = b[i], len = b.readUInt32BE(i + 1); if (len > b.length - i - 5) break; const t = b.subarray(i + 5, i + 5 + len).toString("utf8"); if (flag === 2) errs.push(t.slice(0, 120)); else { const m = /"mask":"block\.text(?:\.content)?".*?"content":"(.*?)"/.exec(t); if (m) texts.push(JSON.parse(`"${m[1]}"`)); if (/"error"/.test(t)) errs.push(t.slice(0, 120)); } i += 5 + len; }
    console.log(`${name}: HTTP ${r.status} bytes=${b.length} answer="${texts.join("")}" err=${errs.join("|").slice(0, 160)}`);
  } catch (err) { console.log(`${name}: ERR ${String(err).slice(0, 120)}`); }
}
const base = { authorization: "Bearer " + tok, "content-type": "application/connect+json", referer: "https://www.kimi.com/", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36" };
await run("full", { ...base, "connect-protocol-version": "1", "x-msh-device-id": h["x-msh-device-id"], "x-msh-session-id": h["x-msh-session-id"], "x-msh-platform": "web", "x-msh-version": "2.3.0", "x-language": "zh-CN" });
await run("no-session-id", { ...base, "connect-protocol-version": "1", "x-msh-device-id": h["x-msh-device-id"], "x-msh-platform": "web", "x-msh-version": "2.3.0" });
await run("jwt-only", { ...base, "connect-protocol-version": "1", "x-msh-device-id": claims.device_id, "x-msh-session-id": claims.sssid, "x-msh-platform": "web", "x-msh-version": "2.3.0" });
await run("minimal(auth+ct)", base);
console.log("claims keys:", Object.keys(claims).join(","), "| sssid", claims.sssid, "device_id", claims.device_id, "captured sess", h["x-msh-session-id"], "cap dev", h["x-msh-device-id"]);
