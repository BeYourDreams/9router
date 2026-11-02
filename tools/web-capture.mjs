// Generic web-provider capture — the first half of adding a new webCookie provider.
//
//   node tools/web-capture.mjs <login-url> [--out DIR] [--wait SECONDS] [--profile NAME]
//   node tools/web-capture.mjs --schema DIR        # re-print request formats from captured JSON
//   e.g. node tools/web-capture.mjs https://kimi.moonshot.cn/ --wait 240
//        node tools/web-capture.mjs https://www.kimi.com/chat --out kimi-capture --wait 240
//        node tools/web-capture.mjs https://yuanbao.tencent.com/chat --out yuanbao-capture
//        (also: yiyan.baidu.com, xinghuo.xfyun.cn, ling.tbox.cn/chat)
//
// Opens a headed Chrome on a PERSISTENT profile, you log in and send one message,
// then it writes every chat-looking request/response/WebSocket frame into DIR and
// prints two things you need for the registry entry:
//   1. the POST bodies, longest-first (the uplink is the biggest one);
//   2. the cookies that appeared AFTER login → webLoginConfig tokenSources.
//
// Replaces the per-provider doubao-capture.mjs / intern-capture.mjs clones.
// The JSON is raw evidence, not a generated adapter: the request shape still
// needs a human (headers are replayable, per-request signatures are not).

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveSystemChromeExecutable } from "../open-sse/executors/browserExecutableCheck.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};

// ---- request-format inference -------------------------------------------------
// A raw capture is evidence, not a spec: the interesting keys drown in session
// blobs. `describe()` turns one body back into a type tree (real values kept for
// scalars, `<len:N>` for opaque strings, `[…]` collapsed to one element) so the
// adapter author sees the shape instead of 4KB of base64.
const OPAQUE_RE = /^[A-Za-z0-9+/=_\-]{24,}$/; // base64 / jwt / hex token
const MAX_ARRAY_ITEMS = 3;

function describe(value, depth = 0) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const shapes = value.map((v) => describe(v, depth + 1));
    const uniq = new Map(shapes.map((s) => [JSON.stringify(s), s]));
    return {
      type: `array[${value.length}]${uniq.size > 1 ? ` of ${uniq.size} variants` : ""}`,
      items: [...uniq.values()].slice(0, MAX_ARRAY_ITEMS),
    };
  }
  if (typeof value === "object") {
    if (depth >= 4) return `${Object.keys(value).length} keys (nested, read raw)`;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = describe(v, depth + 1);
    return out;
  }
  if (typeof value === "string") {
    if (value.length > 48 || (value.length > 23 && OPAQUE_RE.test(value))) return `<string len:${value.length}${OPAQUE_RE.test(value) ? " base64/hex" : ""}>`;
    return value === "" ? "<empty string>" : value;
  }
  return value;
}

// Connect/gRPC-web frames wrap each JSON in a 5-byte envelope (flag byte +
// uint32 BE length) and stream responses are several frames glued together, so
// a kimi-style uplink is invisible to a naive JSON.parse.
function unwrapEnvelope(buf) {
  const frames = [];
  let i = 0;
  while (i + 5 <= buf.length && (buf[i] === 0 || buf[i] === 2)) {
    const len = buf.readUInt32BE(i + 1);
    if (len > buf.length - i - 5) break;
    frames.push(buf.subarray(i + 5, i + 5 + len).toString("utf8"));
    i += 5 + len;
  }
  if (frames.length) return { envelope: `connect+json (${frames.length} frame: flag 0x00/0x02 + uint32BE len)`, json: frames.join("\n") };
  const start = buf.indexOf(0x7b); // first "{"
  if (start > 0) return { envelope: `binary prefix (${start} bytes)`, json: buf.subarray(start).toString("utf8") };
  return { json: buf.toString("utf8") };
}

// Playwright hands bodies back as bytes, which must survive JSON round-trip
// byte-for-byte or a connect envelope's length prefix decodes as a different
// frame boundary. A utf8 round-trip is lossless only for valid utf8 AND only if
// the reader decodes utf8 too, so anything that is not pure ASCII goes to base64.
function putBytes(target, textField, b64Field, buf) {
  if (!buf || !buf.length) return target;
  if (/^[\x00-\x7F]*$/.test(buf.toString("latin1"))) target[textField] = buf.toString("latin1");
  else target[b64Field] = buf.toString("base64");
  return target;
}

function getBytes(rec, textField, b64Field) {
  if (rec[b64Field]) return Buffer.from(rec[b64Field], "base64");
  return Buffer.from(String(rec[textField] || ""), "latin1");
}

function parseBody(r) {
  const raw = getBytes(r, "postData", "postDataBase64").toString("latin1");
  const ct = String(r.headers?.["content-type"] || "");
  if (/multipart\/form-data/i.test(ct)) {
    const boundary = ct.match(/boundary=(.+)/i)?.[1];
    const fields = {};
    if (boundary) {
      for (const part of raw.split(new RegExp(`-?--?${boundary}-?`))) {
        const m = part.match(/name="([^"]+)"\r?\n\r?\n([\s\S]*?)\s*$/);
        if (m) (fields[m[1]] ||= []).push(m[2]);
      }
    }
    const flat = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.length > 1 ? v : v[0]]));
    return { contentType: "multipart/form-data", body: describe(JSON.parse(JSON.stringify(flat), (k, v) => (typeof v === "string" && /^\{.*\}$/.test(v) ? JSON.parse(v) : v))) };
  }
  try {
    return { contentType: ct || "application/json", body: describe(JSON.parse(raw)) };
  } catch {
    // urlencoded form (the fallback when a site posts `a=1&b=2`)
    if (/^[-\w.]+=[^&]*(&[-\w.]+=[^&]*)*$/.test(raw) && raw.includes("=")) {
      return { contentType: "application/x-www-form-urlencoded", body: describe(Object.fromEntries(new URLSearchParams(raw))) };
    }
    // binary-framed JSON (connect / grpc-web): strip the envelope, then describe
    // each frame — a streamed response is many frames, not one document.
    const { envelope, json } = unwrapEnvelope(Buffer.from(raw, "latin1"));
    const frames = json.split("\n").map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
    if (!frames.length) return { contentType: ct || "raw", body: raw.slice(0, 600) };
    return {
      contentType: `${ct || "application/octet-stream"}${envelope ? ` + ${envelope}` : ""}`,
      body: describe(frames.length === 1 ? frames[0] : { frames: [...new Set(frames.map((f) => JSON.stringify(f)))].map((f) => JSON.parse(f)) }),
    };
  }
}

// The uplink is the request whose *parsed* body carries the typed prompt, so a
// list/history POST is never mistaken for the chat call.
function isUplink(r) {
  return (
    /[\\"](query|text|content|prompt|messages|input|question|chatId)[\\"]\s*:/.test(JSON.stringify(parseBody(r).body)) &&
    !/\/collect|monitor|telemetry|feedback|report|ListKimiPlus|\/collect\b/i.test(r.url || "")
  );
}

function requiredHeaders(r) {
  const hop = /^(host|connection|content-length|cookie$|user-agent|accept-encoding|priority|sec-)/i;
  const keepHdr = Object.fromEntries(Object.entries(r.headers || {}).filter(([k]) => !hop.test(k)));
  const auth = Object.fromEntries(Object.entries(r.headers || {}).filter(([k]) => /cookie|authorization|x-.*token|csrf|signature|x-sign/i.test(k)));
  return { headers: keepHdr, authHeaders: Object.keys(auth) };
}

function printSchema(dirName, posts, sse, ws) {
  // One sample per endpoint: a capture replays the same uplink every few seconds.
  const seen = new Set();
  const ups = posts.filter(isUplink).filter((r) => !seen.has(r.url) && seen.add(r.url));
  console.log(`\n${"=".repeat(70)}\n📐 ${dirName} — 请求参数格式（自动推导，${ups.length}/${posts.length} 个 POST 像 uplink）\n${"=".repeat(70)}`);
  for (const r of (ups.length ? ups : posts).slice(0, 3)) {
    const { contentType, body } = parseBody(r);
    console.log(`\n### ${r.method} ${r.url}\ncontent-type: ${contentType}`);
    console.log(JSON.stringify({ ...requiredHeaders(r), body }, null, 2).slice(0, 3000));
    console.log(`raw: ${JSON.stringify(getBytes(r, "postData", "postDataBase64").toString("latin1").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "·").slice(0, 400))}`);
  }
  sse.slice(0, 2).forEach((r) => {
    // Same envelope on the way down: print the frame shapes, not 800 chars of raw.
    const { contentType, body } = parseBody({ url: r.url, headers: { "content-type": r.contentType }, bodyBase64: r.bodyBase64, postData: r.body, postDataBase64: r.bodyBase64 });
    console.log(`\n### RESP ${r.status} ${contentType} ${r.url}`);
    console.log(JSON.stringify(body, null, 2).slice(0, 1500));
  });
  ws.forEach((s, i) => console.log(`\n### WS ${i + 1} ${s.url}\nsent: ${String(s.sent?.[0] || "").slice(0, 500)}\nrecv: ${String(s.received?.[0] || "").slice(0, 500)}`));
}

// Read a capture dir back for --schema.
function listCaptures(root) {
  const dirs = [root, ...(existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.endsWith("-capture")).map((d) => path.join(root, d.name)) : [])];
  const out = [];
  for (const dir of dirs) {
    const file = path.join(dir, "all-requests.json");
    if (!existsSync(file)) continue;
    const entries = JSON.parse(readFileSync(file, "utf8"));
    out.push({
      name: path.basename(dir),
      posts: entries.filter((e) => e.method === "POST" && (e.postData || e.postDataBase64)),
      sse: entries.filter((e) => e.method === "RESPONSE" && /event-stream|connect|octet-stream/.test(e.contentType || "")),
      ws: existsSync(path.join(dir, "websockets.json")) ? JSON.parse(readFileSync(path.join(dir, "websockets.json"), "utf8")) : [],
    });
  }
  if (!out.length) console.error(`--schema: ${root} 下没有 all-requests.json（先跑抓包）`);
  return out;
}


const loginUrl = process.argv[2];
if (loginUrl === "--selfcheck") {
  // A rule with no example is a guess: these four cases are the real shapes
  // captured from xinghuo (multipart), yiyan (json), kimi (connect-framed).
  const assert = (await import("node:assert")).strict;
  const json = { method: "POST", url: "https://x/chat", headers: { "content-type": "application/json" }, postData: '{"query":"hi","tok":"' + "A".repeat(40) + '","arr":[{"a":1},{"a":1},{"b":3}],"deep":{"l1":{"l2":{"l3":{"l4":{"l5":1}}}}}}' };
  assert(isUplink(json), "json uplink detected");
  assert.equal(parseBody(json).body.query, "hi");
  assert.match(parseBody(json).body.tok, /base64\/hex/);
  assert.equal(parseBody(json).body.arr.items.length, 2, "array variants collapsed");
  assert.match(parseBody(json).body.deep.l1.l2.l3, /nested, read raw/);
  const form = { method: "POST", url: "https://x/chat", headers: { "content-type": 'multipart/form-data; boundary=----B' }, postData: '------B\r\nContent-Disposition: form-data; name="text"\r\n\r\nhi\r\n------B--' };
  assert(isUplink(form), "multipart uplink detected");
  assert.equal(parseBody(form).body.text, "hi");
  const framed = Buffer.concat([Buffer.from([0, 0, 0, 0, 7]), Buffer.from('{"a":1}'), Buffer.from([0, 0, 0, 0, 7]), Buffer.from('{"b":2}')]);
  assert.equal(unwrapEnvelope(framed).json, '{"a":1}\n{"b":2}', "stream frames split");
  // Byte-exact storage: a multibyte payload makes the length prefix non-ASCII, and
  // a latin1/utf8 mixup silently shifts every later frame boundary.
  const cjk = Buffer.from('{"text":"用一句话说明你现在能做什么，谢谢"}');
  const one = Buffer.concat([Buffer.alloc(4), Buffer.from([cjk.length]), cjk]);
  const rec = putBytes({}, "body", "bodyBase64", one);
  assert.deepEqual([...getBytes(rec, "body", "bodyBase64")], [...one], "round-trip byte-exact");
  assert.equal(unwrapEnvelope(getBytes(rec, "body", "bodyBase64")).json, cjk.toString("utf8"));
  const noise = { method: "POST", url: "https://x/monitor_browser/collect", headers: {}, postData: '{"query":"x"}' };
  assert(!isUplink(noise), "telemetry never wins");
  console.log("✅ selfcheck ok (json / multipart / connect-framed / byte-exact storage / telemetry-reject)");
  process.exit(0);
}
if (loginUrl === "--schema") {
  // Offline mode: print the param format of an existing capture, no browser.
  const dir = path.join(process.cwd(), process.argv[3] || ".");
  for (const f of listCaptures(dir)) printSchema(f.name, f.posts, f.sse, f.ws);
  process.exit(0);
}

if (!/^https?:\/\//.test(loginUrl || "")) {
  console.error("usage: node tools/web-capture.mjs <https://login-url> [--out DIR] [--wait SEC] [--profile NAME]");
  console.error("       node tools/web-capture.mjs --schema DIR   # 从已有抓包重打参数格式");
  process.exit(1);
}
const host = new URL(loginUrl).hostname.replace(/^www\./, "");
const OUT_DIR = path.join(process.cwd(), arg("--out", `${host.split(".")[0]}-capture`));
const WAIT_MS = (Number(arg("--wait", 240)) || 240) * 1000;
const PROFILE = path.join(process.cwd(), "tools", ".capture-profiles", arg("--profile", host));

// Chat uplinks live under these words; CDNs, telemetry and captcha pings do not.
const CHAT_RE = /chat|complet|message|generate|stream|conversation|convers|dialog|session|qa|ask|sse|bff|api\/(v\d+|chat)/i;
const NOISE_RE = /\.(js|css|png|jpe?g|svg|woff2?|ico|gif)(\?|$)|monit|slardar|tea|webcast|sentry|mlog|log[_.]|beacon|analytics|captcha|verify|report|upload|trace/i;

const entries = [];
const sockets = [];
const keep = (url) => CHAT_RE.test(url) && !NOISE_RE.test(url);

mkdirSync(OUT_DIR, { recursive: true });
const executablePath = resolveSystemChromeExecutable();
if (!executablePath) {
  console.error("no Chrome found — set CHROME_PATH");
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  executablePath,
  viewport: null,
  args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
// Hide webdriver before navigation — these sites' risk engines read it.
await page.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));

page.on("request", (req) => {
  if (!keep(req.url()) || !["POST", "GET", "PUT"].includes(req.method())) return;
  entries.push(
    putBytes({ method: req.method(), url: req.url(), headers: req.headers() }, "postData", "postDataBase64", req.postDataBuffer?.() ?? null),
  );
});
page.on("response", async (res) => {
  if (!keep(res.url())) return;
  const contentType = res.headers()["content-type"] || "";
  // Full bytes, no cap: 20k truncated a real kimi streaming frame mid-envelope.
  const buf = /stream|json/.test(contentType) ? await res.body().catch(() => null) : null;
  entries.push(putBytes({ method: "RESPONSE", url: res.url(), status: res.status(), contentType }, "body", "bodyBase64", buf));
});
page.on("websocket", (ws) => {
  const rec = { url: ws.url(), sent: [], received: [] };
  sockets.push(rec);
  ws.on("framesent", (f) => rec.sent.push(String(f.payload ?? "").slice(0, 4000)));
  ws.on("framereceived", (f) => rec.received.push(String(f.payload ?? "").slice(0, 4000)));
});

const snapshot = () =>
  page.evaluate(() => ({ cookie: document.cookie, localStorage: { ...localStorage } })).catch(() => ({ cookie: "", localStorage: {} }));

console.log("📍", loginUrl, "→ profile", PROFILE, "(login persists between runs)");
await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
const before = await snapshot();

// Flush everything to disk. A login redirect closes the page mid-run, so this
// must be safe to call from a signal handler or an uncaught exception.
let saved = false;
async function save() {
  if (saved) return null;
  saved = true;
  const after = await snapshot();
  const names = (cookie) => new Set(cookie.split(/;\s*/).filter(Boolean).map((c) => c.split("=")[0]));
  const newCookies = [...names(after.cookie)].filter((n) => !names(before.cookie).has(n));
  const posts = entries.filter((e) => e.method === "POST" && (e.postData || e.postDataBase64));
  const write = (name, data) => {
    try {
      writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("write failed:", name, error.message);
    }
  };
  write("all-requests.json", entries);
  write("websockets.json", sockets);
  write("storage.json", { before, after, newCookies });
  return { after, newCookies, posts };
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await save();
    console.log(`\n已中断，${entries.length} 条已存到 ${OUT_DIR}/`);
    process.exit(0);
  });
}
process.on("uncaughtException", async (error) => {
  await save();
  console.error(`\n抓包异常（${entries.length} 条已存到 ${OUT_DIR}/）:`, error.message);
  process.exit(1);
});

console.log(`\n⏳ ${WAIT_MS / 1000}s 内完成：1) 登录  2) 发一条消息（如 "hi"）并等回复完整结束`);
const deadline = Date.now() + WAIT_MS;
const PROMPT = arg("--type", "");
let typed = false;
while (Date.now() < deadline) {
  await sleep(5000);
  // Throws while the page navigates (every SSO redirect does) — must not end the run.
  await ctx.storageState({ path: path.join(OUT_DIR, "storage-state.json") }).catch(() => {});
  // --type: auto-send one prompt once a composer exists (profile already logged in).
  if (PROMPT && !typed) {
    const box = await page.$('div[contenteditable="true"], textarea').catch(() => null);
    if (box) {
      await box.click().catch(() => {});
      await page.keyboard.type(PROMPT, { delay: 40 }).catch(() => {});
      await sleep(800);
      await page.keyboard.press("Enter").catch(() => {});
      typed = true;
      console.log(`\n⌨️ 已自动发送: ${PROMPT}`);
    }
  }
  process.stdout.write(`   … ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s | HTTP ${entries.length} | WS ${sockets.length}\r`);
}

const flushed = await save();
if (!flushed) process.exit(0);
const { after, newCookies, posts } = flushed;

// Biggest POST is the uplink; a model/session list call is always smaller.
posts.sort((a, b) => getBytes(b, "postData", "postDataBase64").length - getBytes(a, "postData", "postDataBase64").length);
// The format dump is the deliverable — raw bodies stay in all-requests.json.
printSchema(
  path.basename(OUT_DIR),
  posts,
  entries.filter((e) => e.method === "RESPONSE" && /event-stream|connect|octet-stream/.test(e.contentType)),
  sockets
);

console.log(`\n🍪 登录后新增 cookie（webLoginConfig.tokenSources 候选）: ${newCookies.join(", ") || "（无，可能用 localStorage）"}`);
const authish = Object.keys(after.localStorage).filter((k) => /token|auth|user|session|jwt|ticket/i.test(k));
if (authish.length) console.log(`   localStorage 候选: ${authish.join(", ")}`);
console.log(`\n✅ 保存到 ${OUT_DIR}/  — 下一步：照 all-requests.json 写 open-sse/executors/<id>.js + registry/<id>.js`);
await ctx.close().catch(() => {});
