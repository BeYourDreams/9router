// Probe doubao.com web chat uplink. Reuses doubao-capture/doubao-storage-state.json (must be logged in).
// Hooks fetch/XHR/WebSocket inside the page (Playwright's listeners miss worker/early sockets),
// auto-types one prompt, then dumps every non-telemetry call with full headers + body.
// Usage: node tools/doubao-probe.mjs ["prompt"]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "doubao-capture");
const STATE = path.join(OUT_DIR, "doubao-storage-state.json");
const PROMPT = process.argv[2] || "用一句话回答：1+1等于几";
// Telemetry/CDN/passport noise — everything else is interesting.
const NOISE = /mcs\.|vcs\.|mssdk|moment\.bytedance|zijieapi|accounts\.doubao|byteacctimg|bytetcc|slardar|\.js(\?|$)|\.css(\?|$|\.)|woff|\.png|\.svg|ico|abtest|ttwid|token\/beat|security_token|get_oauth_token|check_and_get_text|active_switch_banner/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOOK = `(() => {
  window.__cap = [];
  const push = (e) => { if (window.__cap.length < 400) window.__cap.push(e); };
  const of = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    const rec = { kind: "fetch", method: init?.method || (input instanceof Request ? input.method : "GET"), url,
      headers: Object.fromEntries(new Headers(init?.headers || (input instanceof Request ? input.headers : [])).entries()),
      body: typeof init?.body === "string" ? init.body : null };
    try {
      const res = await of(input, init);
      res.clone().text().then((t) => { rec.status = res.status; rec.type = res.headers.get("content-type"); rec.resp = t.slice(0, 4000); }).catch(() => {});
      push(rec);
      return res;
    } catch (err) { rec.error = String(err); push(rec); throw err; }
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__r = { kind: "xhr", method: m, url: u }; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const r = this.__r; if (r) { r.body = typeof b === "string" ? b.slice(0, 4000) : null;
      this.addEventListener("load", () => { try { r.status = this.status; r.resp = this.responseText.slice(0, 4000); } catch {} push(r); }); }
    return os.apply(this, arguments);
  };
  const OW = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = new OW(url, protocols);
    const rec = { kind: "ws", url, sent: [], received: [] };
    push(rec);
    const send = ws.send.bind(ws);
    ws.send = (d) => { rec.sent.push(typeof d === "string" ? d.slice(0, 3000) : "<binary " + (d?.byteLength ?? 0) + "B>"); return send(d); };
    ws.addEventListener("message", (ev) => rec.received.push(typeof ev.data === "string" ? ev.data.slice(0, 3000) : "<binary>"));
    return ws;
  };
  window.WebSocket.prototype = OW.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSED", "CLOSED"]) window.WebSocket[k] = OW[k];
})();`;

const NOISE_SRC = /mcs\.|vcs\.|mssdk|moment\.|zijieapi|accounts\.|byteacctimg|bytetcc|slardar|\.(js|css|woff2?|png|svg|ico|webp)(\?|$)|abtest|ttwid|token\/beat|security_token|get_oauth_token|check_and_get_text|active_switch_banner|lf-flow-web-cdn/i;

async function main() {
  if (!fs.existsSync(STATE)) {
    console.error(`❌ 缺少 ${STATE} —— 先跑 node tools/doubao-capture.mjs 手动登录一次（登录态会存进去）`);
    process.exit(1);
  }
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  });
  const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(HOOK);
  const page = await ctx.newPage();
  // Also mirror at protocol level so worker traffic is not lost.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});

  console.log("📍 打开 /chat/（已带登录态 + 页内 hook）");
  await page.goto("https://www.doubao.com/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(8000);

  const box = await page.$('div[contenteditable="true"], textarea');
  if (!box) {
    console.error("❌ 没有输入框：登录态可能失效。重跑 tools/doubao-capture.mjs 手动登录。");
  } else {
    await box.click();
    await sleep(400);
    await page.keyboard.type(PROMPT, { delay: 30 });
    await sleep(1000);
    await page.keyboard.press("Enter");
    console.log("⌨️ 已发送:", PROMPT, "— 等回复 40s");
    await sleep(40000);
  }

  // Diagnostic: resource timing sees requests the page initiated even when a service worker
  // (or a worker) performed the fetch, which Playwright's page listeners do not report.
  const res = await page.evaluate((noise) => {
    const re = new RegExp(noise, "i");
    return performance
      .getEntriesByType("resource")
      .map((e) => `${e.initiatorType} ${Math.round(e.duration)}ms ${e.name}`)
      .filter((l) => !re.test(l));
  }, NOISE_SRC.source);
  fs.writeFileSync(path.join(OUT_DIR, "probe-resources.txt"), res.join("\n"));
  console.log(`\n🧭 资源计时（非遥测 ${res.length} 条）:\n${res.join("\n")}`);

  const cap = await page.evaluate(() => window.__cap || []).catch(() => []);
  const interesting = cap.filter((c) => !NOISE.test(c.url || ""));
  fs.writeFileSync(path.join(OUT_DIR, "probe-hook.json"), JSON.stringify(cap, null, 2));
  await page.screenshot({ path: path.join(OUT_DIR, "probe.png") }).catch(() => {});
  console.log(`\n📊 hook 记录 ${cap.length} 条，非遥测 ${interesting.length} 条`);
  for (const c of interesting) {
    console.log(`\n### [${c.kind}] ${c.method || ""} ${c.url?.split("?")[0]} ${c.status ?? ""} ${c.type ?? ""}`);
    if (c.body) console.log("REQ ", c.body.slice(0, 1200));
    if (c.resp) console.log("RESP", c.resp.slice(0, 800));
    if (c.sent?.length) console.log("WS>", c.sent.slice(0, 2).join("\n").slice(0, 1200), "\nWS<", c.received?.slice(0, 2).join("\n").slice(0, 800));
    if (c.headers) {
      const h = Object.fromEntries(Object.entries(c.headers).filter(([k]) => !/^(sec-|accept|content-type|origin|referer|user-agent|priority|cookie$)/i.test(k)));
      const ck = c.headers.cookie ? `…cookie(${c.headers.cookie.length}B)` : "";
      console.log("HDR ", JSON.stringify({ ...h, ck }).slice(0, 600));
    }
  }
  await browser.close();
  console.log(`\n✅ ${OUT_DIR}/probe-hook.json`);
}

main().catch((e) => console.error("❌", e));
