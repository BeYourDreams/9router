# 浏览器自动登录抓包 + Web 供应商接入流程

本文档总结将任意 Web 供应商（如 Intern / discovery.intern-ai.org.cn）接入 9Router "Login via Browser" 流程的完整步骤。

## 1. 原理

复用 9Router 现有的 `webLogin` 基础设施：

1. 服务端用 Playwright 启动**有头 Chromium/Edge**，指向供应商登录页，用户在浏览器里手动完成登录（含验证码、扫码等人机交互）。
2. 用户点击"Read key"后，服务端从浏览器上下文里抓取登录所需的 Cookie / localStorage，序列化为凭据，自动在 9Router 后台创建该供应商的连接。
3. 整个流程**不新增 UI 页面、不新增依赖**（Playwright 已在 `devDependencies` 中），只需配置几处登录参数即可。

## 2. 前置条件

- 已安装 Edge 或 Google Chrome，且可被 Playwright 找到。
- 在运行脚本前设置 `CHROME_PATH` 环境变量指向浏览器可执行文件。

Windows（PowerShell）：
```powershell
$env:CHROME_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

macOS：
```bash
export CHROME_PATH="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
```

Linux：
```bash
export CHROME_PATH="/usr/bin/microsoft-edge-stable"
```

不确定路径时，在 Edge 中打开 `edge://version`，复制"可执行文件"一行。

## 3. 抓包阶段（开发者）

### 3.1 编写抓包脚本

新建 `tools/<供应商>-capture.mjs`，模板如下：

```js
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";

const OUT_DIR = path.join(process.cwd(), "<供应商>-capture");
const LOGIN_URL = "https://供应商登录页";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH || undefined,
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
  fs.writeFileSync(path.join(OUT_DIR, "<供应商>-initial.json"), JSON.stringify(storage, null, 2));

  console.log("\n⏳ 等待 N 秒，请在打开的浏览器里完成登录，并在页面发一条消息...");
  await sleep(60000); // 给足够的手动登录时间

  const afterLogin = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
    cookie: document.cookie,
  }));
  fs.writeFileSync(path.join(OUT_DIR, "<供应商>-after-login.json"), JSON.stringify(afterLogin, null, 2));

  await sleep(15000); // 等发消息产生的接口请求

  const chatCandidates = allRequests.filter((r) =>
    /chat|complet|message|generate|stream|conversation|api\/v/i.test(r.url)
  );

  fs.writeFileSync(path.join(OUT_DIR, "<供应商>-all-requests.json"), JSON.stringify(allRequests, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "<供应商>-chat-candidates.json"), JSON.stringify(chatCandidates, null, 2));

  console.log(`\n✅ 已保存到 ${OUT_DIR}/`);
  await browser.close();
}

main().catch((err) => {
  console.error("❌ 出错:", err);
  process.exit(1);
});
```

### 3.2 运行脚本

```bash
node tools/<供应商>-capture.mjs
```

脚本会打开浏览器，暂停等待你手动登录并发一条消息，时间到后自动保存抓包结果到 `<供应商>-capture/` 目录。

### 3.3 分析抓包结果

重点查看以下文件：

| 文件 | 作用 |
|------|------|
| `<供应商>-initial.json` | 登录前的 Cookie / localStorage（对比用） |
| `<供应商>-after-login.json` | **登录后的 Cookie / localStorage**，从中确定登录凭据 Cookie 名 |
| `<供应商>-chat-candidates.json` | 疑似聊天/业务接口，确定发消息的 API URL、请求体格式、响应格式 |
| `<供应商>-all-requests.json` | 全量请求记录，排查用 |

关键要确认：

1. **登录凭据 Cookie**：登录后 `document.cookie` 中哪个字段携带会话标识（如 Intern 的 `uaa-token` JWT）。
2. **Chat 接口**：发消息的 API URL（如 `POST /api/orbit/v1/chat`）、请求体字段（如 `model`、`query`、`chat_id`）、响应格式（SSE 流式或 JSON）。
3. **用户信息接口**：用于探测登录身份的接口（如 `/api/user-center/v1/users/getUserInfo`），返回中包含邮箱/昵称等字段，用于给 9Router 连接命名。

## 4. 接入阶段（开发者）

基于抓包结果，按以下步骤将供应商接入 9Router Web 供应商体系。

### 4.1 新建供应商 Registry 条目

新建 `open-sse/providers/registry/<供应商>-web.js`：

```js
export default {
  id: "<供应商>-web",
  priority: 230,
  alias: "<供应商>-web",
  aliases: ["<供应商>", "<供应商>-ai"],
  uiAlias: "<供应商>-web",
  display: {
    name: "<供应商> Web",
    icon: "auto_awesome",
    color: "#6366F1",
    textIcon: "<缩写>",
    website: "https://供应商域名",
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint: "在 DevTools → Application → Cookies 中找到登录后的会话 Cookie，粘贴到这里；或点“Login via Browser”自动抓取。",
  transport: {
    baseUrl: "https://供应商域名",
    format: "openai",
    authType: "cookie",
  },
  models: [
    { id: "<模型id>", name: "<模型名称>" },
  ],
  passthroughModels: true,
};
```

### 4.2 注册到 Registry 索引

编辑 `open-sse/providers/registry/index.js`：

1. 在文件末尾导入：`import pNNN from "./<供应商>-web.js";`
2. 在 `export default [` 数组末尾加入 `pNNN,`。

该条目的 `category: "webCookie"` 会自动进入 `WEB_COOKIE_PROVIDERS`，在供应商列表页可见。

### 4.3 配置 Web Login 抓参

编辑 `open-sse/services/webLoginConfig.js`，在 `WEB_LOGIN_CONFIGS` 中加入：

```js
"<供应商>-web": {
  loginUrl: "https://供应商登录页",
  cookieDomain: ".供应商域名",
  tokenSources: [{ type: "cookie", name: "<登录凭据 Cookie 名>" }],
},
```

- `loginUrl`：抓包阶段打开的登录页 URL。
- `cookieDomain`：Cookie 所属域名（去掉前面的点，或按需匹配）。
- `tokenSources`：抓包后确认的登录凭据 Cookie 名。可选字段支持 `namePattern` 正则匹配、可选字段 `optional: true`。

### 4.4 加入身份探测器（可选但推荐）

编辑 `open-sse/services/webIdentity.js`，在 `PROBES` 对象中加入该供应商的探测器，用于登录成功后解析账号邮箱并命名连接：

```js
async "<供应商>-web"(credential) {
  const jar = cookieJar(credential);
  const token = jar.get("<登录凭据 Cookie 名>");
  if (!token) return REJECTED("Missing <登录凭据 Cookie 名> cookie");
  const res = await request("https://供应商域名/api/用户信息接口", {
    headers: {
      Cookie: `<登录凭据 Cookie 名>=${token}`,
      Accept: "application/json",
      Origin: "https://供应商域名",
      Referer: "https://供应商域名/",
    },
  });
  if (!res.status) return UNKNOWN(res.error);
  if (res.status === 401 || res.status === 403) return REJECTED("<登录凭据 Cookie 名> is invalid or expired");
  if (!res.ok) return UNKNOWN(`<供应商> returned HTTP ${res.status}`);
  let json = null;
  try { json = JSON.parse(res.text); } catch { return UNKNOWN("<供应商> returned invalid JSON"); }
  // 根据实际响应格式解析 email / nickname
  const email = typeof json?.data?.sso_email === "string" ? json.data.sso_email : "";
  return OK(email);
},
```

### 4.5 加入 WebLoginButton 白名单

编辑 `src/app/(dashboard)/dashboard/providers/components/WebLoginButton.js`，把供应商 ID 加入 `WEB_LOGIN_PROVIDERS`：

```js
export const WEB_LOGIN_PROVIDERS = new Set([
  "grok-web",
  "chatgpt-web",
  "gemini-web",
  "muse-web",
  "uc-web",
  "chatglm-web",
  "xiaomimimo-web",
  "qwen-web",
  "<供应商>-web", // 新增
]);
```

只有加入此白名单，供应商详情页才会显示"Login via Browser"按钮。

### 4.6 添加自测（可选）

新建 `tests/unit/<供应商>-web-wiring.test.js`，断言：

- Registry 条目存在且 `category === "webCookie"`；
- `webLoginConfig` 中有对应 `loginUrl`；
- `listWebLoginProviders()` 包含该供应商 ID。

运行 `node tests/unit/<供应商>-web-wiring.test.js` 验证。

## 5. 使用阶段（最终用户）

在 9Router 后台：

1. 进入**供应商**页，找到新接入的 Web 供应商（如 "Intern Web"）。
2. 点**Login via Browser**，选择浏览器配置文件（默认 `default`）。
3. 弹窗打开一个 Edge/Chrome 窗口，加载供应商登录页。
4. 在浏览器里完成登录（账号密码 / 扫码 / Continue with Google 等，人工操作）。
5. 回到 9Router 弹窗，点**Read key**。服务端从浏览器抓取 Cookie，自动创建连接并保存。
6. 连接保存后，即可在对话页选择该供应商的模型进行对话。

## 6. 常见问题与排查

| 问题 | 排查方向 |
|------|----------|
| 浏览器打不开 | 确认 `CHROME_PATH` 指向正确；确认系统安装了 Edge/Chrome |
| "Read key" 抓不到 token | 对比 `<供应商>-after-login.json` 中的 Cookie 名，修正 `webLoginConfig.js` 的 `tokenSources.name` |
| 抓到 Cookie 但接口返回 401 | 确认 `cookieDomain` 是否正确；部分供应商 Cookie 带 `Domain` 属性，需与配置一致 |
| 连接保存后聊天仍报错 | 对比抓包阶段的 chat 接口请求头/请求体，确认 9Router 传输层是否带上了 Cookie |
| 身份探测器返回 unknown | 检查 `/api/用户信息接口` 响应格式，调整 `webIdentity.js` 中的字段解析逻辑 |

## 7. 范例：Intern Web 接入记录

本流程已按 Intern 供应商实践一次，相关改动：

- `open-sse/providers/registry/intern-web.js`（新）
- `open-sse/providers/registry/index.js`（引入注册）
- `open-sse/services/webLoginConfig.js`（`tokenSources: [{ name: "uaa-token" }]`）
- `open-sse/services/webIdentity.js`（探测器调用 `/api/user-center/v1/users/getUserInfo`）
- `src/app/(dashboard)/dashboard/providers/components/WebLoginButton.js`（白名单加 `intern-web`）
- `tests/unit/intern-web-wiring.test.js`（新，自测）
- `tools/intern-capture.mjs`（新，抓包脚本）

抓包关键发现：

- 登录凭据：Cookie `uaa-token`（JWT）
- 聊天接口：`POST https://discovery.intern-ai.org.cn/api/orbit/v1/chat`，Body `{"scenario":1,"thinking_mode":true,"planning_mode":false,"model":"Auto","query":"...","chat_id":...}`，SSE 流式返回
- 用户信息：`GET https://discovery.intern-ai.org.cn/api/user-center/v1/users/getUserInfo`
