import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";

const OUT_DIR = path.join(process.cwd(), "intern-capture");
const LOGIN_URL = "https://discovery.intern-ai.org.cn/chat";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chromePath = process.env.CHROME_PATH || undefined;
  const browser = await chromium.launch({
    headless: false,
    executablePath: chromePath,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const allRequests = [];
  page.on("request", (req) => {
    if (["POST", "GET", "PUT", "DELETE"].includes(req.method())) {
      allRequests.push({
        method: req.method(),
        url: req.url(),
        headers: req.headers(),
        postData: req.postData(),
      });
    }
  });
  page.on("response", async (res) => {
    try {
      const url = res.url();
      if (/chat|complet|api|user|login|session/i.test(url)) {
        const text = await res.text().catch(() => "");
        allRequests.push({
          method: "RESPONSE",
          url,
          status: res.status(),
          body: text.slice(0, 2000),
        });
      }
    } catch {}
  });

  console.log("📍 打开", LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(3000);

  const storage = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
    cookie: document.cookie,
  }));
  fs.writeFileSync(
    path.join(OUT_DIR, "intern-initial.json"),
    JSON.stringify(storage, null, 2),
  );
  console.log("📦 初始 localStorage keys:", Object.keys(storage.localStorage));
  console.log("🍪 初始 cookie:", storage.cookie.slice(0, 300));

  console.log("\n⏳ 等待 60 秒，请在打开的 Edge 里完成登录，并在页面发一条消息（如 “hi”）");
  console.log("   时间到后脚本会自动抓取登录后的 Cookie 和接口参数...");
  await sleep(60000);

  const afterLogin = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
    cookie: document.cookie,
  }));
  fs.writeFileSync(
    path.join(OUT_DIR, "intern-after-login.json"),
    JSON.stringify(afterLogin, null, 2),
  );
  console.log("📦 登录后 localStorage keys:", Object.keys(afterLogin.localStorage));
  console.log("🍪 登录后 cookie:", afterLogin.cookie.slice(0, 500));

  await sleep(15000);

  const chatCandidates = allRequests.filter((r) =>
    /chat|complet|message|generate|stream|conversation|api\/v/i.test(r.url)
  );

  fs.writeFileSync(
    path.join(OUT_DIR, "intern-all-requests.json"),
    JSON.stringify(allRequests, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "intern-chat-candidates.json"),
    JSON.stringify(chatCandidates, null, 2),
  );

  console.log("\n📊 所有请求:", allRequests.length);
  console.log("🎯 疑似业务请求:", chatCandidates.length);
  chatCandidates.forEach((req, i) => {
    console.log(`\n--- 候选 ${i + 1} ---`);
    console.log(`${req.method} ${req.url}`);
    if (req.postData) console.log("Body:", req.postData.slice(0, 1000));
    if (req.body) console.log("Response:", req.body.slice(0, 1000));
  });

  console.log(`\n✅ 已保存到 ${OUT_DIR}/`);
  await browser.close();
}

main().catch((err) => {
  console.error("❌ 出错:", err);
  process.exit(1);
});
