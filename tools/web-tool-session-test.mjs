// Probe web-cookie providers for (1) tool-call support and (2) history forwarding.
// Two upstream requests per model, never more — these are free-tier web quotas.
//
//   node tools/web-tool-session-test.mjs deepseek-web/deepseek-v4-flash
//   node tools/web-tool-session-test.mjs --all --delay 20000
//   node tools/web-tool-session-test.mjs --selfcheck      # no network
//
// Env: WEB_TEST_BASE (default http://localhost:20127), API_KEY (optional).
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.WEB_TEST_BASE || "http://localhost:20127";
const KEY = process.env.API_KEY || "sk-web-probe";
const TIMEOUT = Number(process.env.TIMEOUT || 150000);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const DELAY = Number(value("--delay", 15000)) || 0;

const TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

// The magic number is arbitrary: the only pass condition is that it survives
// being replayed back as prior turns.
const SECRET = "7391";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(model, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, stream: false, max_tokens: 256, ...body }),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e.name === "AbortError" ? `timeout ${TIMEOUT}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// One verdict function per probe, so --selfcheck exercises the real logic.
function judgeTool(r) {
  const msg = r.json?.choices?.[0]?.message;
  const calls = msg?.tool_calls || [];
  if (calls.length) return { ok: true, detail: `${calls[0].function?.name}(${calls[0].function?.arguments ?? ""})`.slice(0, 90) };
  const content = String(msg?.content ?? "");
  if (/<tool/i.test(content)) return { ok: false, detail: "tool text leaked, not parsed to tool_calls" };
  return { ok: false, detail: `no tool_calls: ${content.slice(0, 70).replace(/\s+/g, " ") || `HTTP ${r.status}`}` };
}

function judgeSession(r) {
  const content = String(r.json?.choices?.[0]?.message?.content ?? "");
  if (content.includes(SECRET)) return { ok: true, detail: content.slice(0, 60).replace(/\s+/g, " ") };
  return { ok: false, detail: `lost ${SECRET}: ${content.slice(0, 70).replace(/\s+/g, " ") || `HTTP ${r.status}`}` };
}

const toolBody = {
  tools: [TOOL],
  tool_choice: "auto",
  messages: [{ role: "user", content: "北京现在天气怎么样？调用工具查询。" }],
};
const sessionBody = {
  messages: [
    { role: "user", content: `记住这个数字：${SECRET}。只回复 OK。` },
    { role: "assistant", content: "OK" },
    { role: "user", content: "我刚才让你记的数字是多少？只回复数字。" },
  ],
};

async function probe(model) {
  const r = { model };
  const t0 = Date.now();
  r.tool = judgeTool(await chat(model, toolBody));
  await sleep(1500);
  r.session = judgeSession(await chat(model, sessionBody));
  r.ms = Date.now() - t0;
  return r;
}

if (flag("--selfcheck")) {
  const assert = (await import("node:assert")).strict;
  assert(judgeTool({ status: 200, json: { choices: [{ message: { tool_calls: [{ function: { name: "get_weather", arguments: '{"city":"北京"}' } }] } }] } }).ok);
  assert(!judgeTool({ status: 200, json: { choices: [{ message: { content: "<tool>{}</tool>" } }] } }).ok);
  assert(!judgeTool({ status: 200, json: { choices: [{ message: { content: "晴天" } }] } }).ok);
  assert(judgeSession({ status: 200, json: { choices: [{ message: { content: SECRET } }] } }).ok);
  assert(!judgeSession({ status: 200, json: { choices: [{ message: { content: "不知道" } }] } }).ok);
  console.log("✅ selfcheck ok");
  process.exit(0);
}

let models = argv.filter((a) => !a.startsWith("--") && a !== String(DELAY) && a !== BASE);
if (flag("--all") || !models.length) {
  const res = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const list = (await res.json()).data?.map((m) => m.id) || [];
  models = list.filter((id) => /-web\//.test(id));
}
if (!models.length) {
  console.error("no web models found — pass ids explicitly");
  process.exit(1);
}

console.log(`${models.length} model(s) × 2 requests, ${DELAY}ms apart, base ${BASE}\n`);
const results = [];
for (const [i, model] of models.entries()) {
  if (i) await sleep(DELAY);
  const row = await probe(model);
  results.push(row);
  const mark = (v) => (v.ok ? "✅" : "❌");
  console.log(`${mark(row.tool)} tool   ${mark(row.session)} session  ${row.model}  (${row.ms}ms)`);
  console.log(`   tool:    ${row.tool.detail}`);
  console.log(`   session: ${row.session.detail}`);
}

mkdirSync("tmp", { recursive: true });
const out = `tmp/web-tool-session-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
writeFileSync(out, JSON.stringify(results, null, 2));
const pass = (k) => `${results.filter((r) => r[k].ok).length}/${results.length}`;
console.log(`\ntool ${pass("tool")}   session ${pass("session")}   → ${out}`);