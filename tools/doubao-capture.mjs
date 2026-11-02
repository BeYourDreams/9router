// Capture doubao.com web chat: endpoints, headers, request body, response frame shape.
// Headed browser → log in manually → send ONE message and wait for the reply to finish.
// Everything lands in doubao-capture/. Usage: node tools/doubao-capture.mjs [waitSeconds]
//
// Chat traffic may be plain fetch/SSE or a WebSocket/long-poll uplink (the doubao
// `im/*` commands look like an IM protocol), so both are recorded.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "doubao-capture");
const LOGIN_URL = process.env.DOUBAO_URL || "https://www.doubao.com/chat/";
const WAIT_MS = (Number(process.argv[2]) || 240) * 1000;
// Non-chat noise to drop: CDN assets, telemetry, login/SSO, rate-limit ping.
const CHAT_RE = /chat|complet|message|generate|stream|conversation|convers|sse|dialog|im\/|bff|api\/(v\d+)/i;
const NOISE_RE = /static\/js|static\/css|\.js(\?|$)|\.css(\?|$|\.)|\.png|\.svg|\.woff|monit|slardar|tea|webcast|sentry|mlog|verify|captcha|\.(tiktok|bytedance|volces)\./;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const entries = [];
  const sockets = [];
  const keep = (url) => CHAT_RE.test(url) && !NOISE_RE.test(url);

  page.on("request", (req) => {
    if (!keep(req.url()) || !["POST", "GET", "PUT"].includes(req.method())) return;
    entries.push({ method: req.method(), url: req.url(), headers: req.headers(), postData: req.postData() });
  });
  page.on("response", async (res) => {
    if (!keep(res.url())) return;
    try {
      entries.push({
        method: "RESPONSE",
        url: res.url(),
        status: res.status(),
        contentType: res.headers()["content-type"],
        headers: await res.allHeaders(),
        body: (await res.text().catch(() => "")).slice(0, 20000),
      });
    } catch {}
  });

  // WebSocket frames, paired per socket so direction is unambiguous.
  const bySocket = new Map();
  page.on("websocket", (ws) => {
    const rec = { url: ws.url(), sent: [], received: [] };
    bySocket.set(ws, rec);
    sockets.push(rec);
    ws.on("framesent", (f) => rec.sent.push(String(f.payload ?? "").slice(0, 4000)));
    ws.on("framereceived", (f) => rec.received.push(String(f.payload ?? "").slice(0, 4000)));
  });

  console.log("📍 打开", LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  console.log(`\n⏳ 请在 ${WAIT_MS / 1000}s 内：1) 登录 doubao.com  2) 发一条消息（如 "hi"）并等回复完整结束`);
  console.log("   （跑满全程，不提前退出，免得漏掉登录后的真正聊天请求）");
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(5000);
    await ctx.storageState({ path: path.join(OUT_DIR, "doubao-storage-state.json") });
    process.stdout.write(`   … ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s 剩余 | HTTP ${entries.length} 条 | WS ${sockets.length} 个\r`);
  }

  fs.writeFileSync(path.join(OUT_DIR, "doubao-all-requests.json"), JSON.stringify(entries, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "doubao-websockets.json"), JSON.stringify(sockets, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, "doubao-storage.json"),
    JSON.stringify(
      await page.evaluate(() => ({
        cookie: document.cookie,
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
      })),
      null,
      2
    )
  );
  const posts = entries.filter((e) => e.method === "POST" && e.postData);
  console.log(`\n📊 HTTP ${entries.length} 条（POST 带 body ${posts.length}），WebSocket ${sockets.length} 个`);
  posts.forEach((r, i) => console.log(`\n--- POST ${i + 1}: ${r.url}\n${String(r.postData).slice(0, 1500)}`));
  entries
    .filter((e) => e.method === "RESPONSE" && /event-stream|json/.test(e.contentType || ""))
    .forEach((r) => console.log(`\n--- RESP ${r.status} ${r.contentType} ${r.url}\n${r.body.slice(0, 1500)}`));
  sockets.forEach((s, i) =>
    console.log(`\n--- WS ${i + 1}: ${s.url}\nsent: ${s.sent.slice(0, 3).join("\n").slice(0, 1500)}\nrecv: ${s.received.slice(0, 3).join("\n").slice(0, 1500)}`)
  );
  await browser.close();
  console.log(`\n✅ 保存到 ${OUT_DIR}/`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
