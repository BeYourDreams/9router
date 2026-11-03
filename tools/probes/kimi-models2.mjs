import fs from "node:fs";
const s = JSON.parse(fs.readFileSync("kimi-capture/storage.json", "utf8"));
const tok = String(s.after.localStorage.access_token).replace(/^"|"$/g, "");
async function ask(model, thinking) {
  const payload = JSON.stringify({ scenario: "SCENARIO_CHAT", tools: [], message: { role: "user", blocks: [{ message_id: "", text: { content: "回一个字" } }], scenario: "SCENARIO_CHAT", is_goal: false }, options: { thinking, model } });
  const buf = Buffer.alloc(5 + Buffer.byteLength(payload));
  buf.writeUInt32BE(Buffer.byteLength(payload), 1); buf.write(payload, 5);
  const r = await fetch("https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/connect+json", referer: "https://www.kimi.com/" }, body: buf, signal: AbortSignal.timeout(40000) });
  const b = Buffer.from(await r.arrayBuffer());
  const ok = !/"error":\{/.test(b.toString("utf8"));
  console.log(`${model.padEnd(20)} think=${thinking ? 1 : 0} valid=${ok}`);
  return ok;
}
for (const m of ["k28", "k28-thinking", "k28-instant", "k3-thinking", "k3-web", "ok-computer", "kimi2.8", "k28-web", "moonshot-k28", "k3.1-instant"]) await ask(m, false);
await ask("k28-instant", true);
