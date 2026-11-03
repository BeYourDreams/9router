import fs from "node:fs";
const s = JSON.parse(fs.readFileSync("kimi-capture/storage.json", "utf8"));
const tok = String(s.after.localStorage.access_token).replace(/^"|"$/g, "");
const TEXT_RE = /"mask":"block\.text(?:\.content)?".*?"content":"((?:[^"\\]|\\.)*)"/;

async function ask(model, thinking) {
  const payload = JSON.stringify({ scenario: "SCENARIO_CHAT", tools: [], message: { role: "user", blocks: [{ message_id: "", text: { content: "回一个字" } }], scenario: "SCENARIO_CHAT", is_goal: false }, options: { thinking, model }, project_id: "" });
  const buf = Buffer.alloc(5 + Buffer.byteLength(payload));
  buf.writeUInt32BE(Buffer.byteLength(payload), 1);
  buf.write(payload, 5);
  const r = await fetch("https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat", {
    method: "POST",
    headers: { authorization: "Bearer " + tok, "content-type": "application/connect+json", referer: "https://www.kimi.com/", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36" },
    body: buf,
    signal: AbortSignal.timeout(45000),
  });
  const b = Buffer.from(await r.arrayBuffer());
  let i = 0, answer = "", think = "", err = "";
  while (i + 5 <= b.length) {
    const flag = b[i], len = b.readUInt32BE(i + 1);
    if (len > b.length - i - 5) break;
    const t = b.subarray(i + 5, i + 5 + len).toString("utf8");
    const m = TEXT_RE.exec(t);
    if (m) answer += JSON.parse('"' + m[1] + '"');
    if (/"mask":"block\.think/.test(t)) think += "T";
    if (flag === 2 || /"error":\{/.test(t)) err += t.slice(0, 100);
    i += 5 + len;
  }
  console.log(`${(model + (thinking ? "+think" : "")).padEnd(22)} HTTP ${r.status} bytes=${String(b.length).padStart(6)} ans="${answer.slice(0, 10)}" think=${think.length} ${err.slice(0, 90)}`);
}

const cases = [["k28-instant", false], ["k28-instant", true], ["k3", false], ["k3-instant", false], ["k26-instant", false], ["k25", false], ["kimi-k3", false], ["k3-agent", false], ["", false], ["bogus-xyz", false]];
for (const [m, th] of cases) {
  try { await ask(m, th); } catch (e) { console.log(m, "ERR", String(e).slice(0, 90)); }
}
