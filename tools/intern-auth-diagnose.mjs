import fs from "node:fs";
import path from "node:path";

const CAPTURE_DIR = path.join(process.cwd(), "intern-capture");
const ALL_FILE = path.join(CAPTURE_DIR, "intern-all-requests.json");
const AFTER_FILE = path.join(CAPTURE_DIR, "intern-after-login.json");

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`❌ 读取失败: ${file} — ${e.message}`);
    process.exit(1);
  }
}

const all = loadJson(ALL_FILE);
const after = loadJson(AFTER_FILE);

// 1. 提取登录后 Cookie 中的 uaa-token
const cookieStr = after.cookie || "";
const uaaMatch = cookieStr.match(/(?:^|;\s*)uaa-token=([^;]+)/);
const uaaToken = uaaMatch ? uaaMatch[1] : null;

// 2. 定位 chat 请求
const chatRequests = all.filter(
  (r) => r.method === "POST" && r.url.includes("/api/orbit/v1/chat")
);

console.log("==== Intern Web 认证自动化诊断 ====");
console.log(`抓包文件: ${ALL_FILE}`);
console.log(`请求总数: ${all.length}`);
console.log(`POST /api/orbit/v1/chat 请求数: ${chatRequests.length}`);

// 3. 分析 Cookie 里的 uaa-token
console.log("\n---- 登录后 Cookie 分析 ----");
if (uaaToken) {
  console.log(`✅ 发现 uaa-token (长度 ${uaaToken.length})`);
  // 简单 JWT payload 解码（不验证签名）
  try {
    const payloadPart = uaaToken.split(".")[1];
    const padded = payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    console.log(`   jti (用户ID): ${payload.jti || "未知"}`);
    console.log(`   角色: ${payload.rol || "未知"}`);
    console.log(`   过期时间: ${new Date((payload.exp || 0) * 1000).toISOString()}`);
    const now = Date.now() / 1000;
    if (payload.exp && payload.exp < now) {
      console.log(`   ⚠️  Token 已过期 (${Math.floor(now - payload.exp)}秒前)`);
    } else {
      console.log(`   ✅ Token 未过期`);
    }
  } catch (e) {
    console.log(`   ⚠️  JWT 解析失败: ${e.message}`);
  }
} else {
  console.log("❌ 未在 Cookie 中发现 uaa-token");
}

// 4. 对比请求头：哪些请求带了 Authorization，哪些没带
console.log("\n---- 请求头 Auth 对比 ----");
for (const req of chatRequests) {
  const headers = req.headers || {};
  const auth = headers.authorization || headers.Authorization || "";
  const referer = headers.referer || headers.Referer || "";
  const hasBearer = auth.startsWith("Bearer ");
  console.log(
    `${req.method} ${req.url} | status: ${req.status || "REQUEST"} | ` +
    `Authorization: ${hasBearer ? "Bearer <present>" : "MISSING"} | ` +
    `Referer: ${referer ? "present" : "MISSING"}`
  );
  if (hasBearer && auth.length > 20) {
    console.log(`   Bearer token 前20字符: ${auth.slice(0, 20)}...`);
  }
}

// 5. 提取成功请求的完整参数模板
console.log("\n---- 成功请求参数模板 (用于修复) ----");
const successChat = chatRequests.find((r) => (r.status || 200) === 200 && r.postData);
if (successChat) {
  console.log(`URL: ${successChat.url}`);
  console.log(`Body: ${successChat.postData}`);
  const h = successChat.headers || {};
  console.log(`Key Headers:`);
  console.log(`  authorization: Bearer <uaa-token 值>`);
  console.log(`  referer: ${h.referer || "https://discovery.intern-ai.org.cn/chat/chat/<chat_id>"}`);
  console.log(`  content-type: ${h["content-type"] || "application/json"}`);
} else {
  console.log("未找到状态为 200 的 chat 请求，使用抓包默认模板:");
  console.log(`URL: https://discovery.intern-ai.org.cn/api/orbit/v1/chat`);
  console.log(`Body: {"scenario":1,"thinking_mode":true,"planning_mode":false,"model":"Auto","query":"测试","chat_id":1644687}`);
}

// 6. 自动生成修复代码
console.log("\n---- 自动生成的修复代码 (Node.js fetch) ----");
const template = successChat ? successChat.postData : '{"scenario":1,"thinking_mode":true,"planning_mode":false,"model":"Auto","query":"测试","chat_id":1644687}';
console.log(`
const TOKEN = "${uaaToken || "<从浏览器 Cookie 复制的 uaa-token 纯值>"}";

const res = await fetch("https://discovery.intern-ai.org.cn/api/orbit/v1/chat", {
  method: "POST",
  headers: {
    "authorization": "Bearer " + TOKEN,
    "content-type": "application/json",
    "referer": "https://discovery.intern-ai.org.cn/chat/chat/1644687",
    "origin": "https://discovery.intern-ai.org.cn",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
    "accept-language": "zh-CN",
  },
  body: ${template},
});
`);

// 7. 如果 token 存在，尝试实际发送请求验证（可选，网络不通会报错但不中断）
if (uaaToken) {
  console.log("\n---- 实际请求验证 (可选) ----");
  try {
    const res = await fetch("https://discovery.intern-ai.org.cn/api/orbit/v1/chat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${uaaToken}`,
        "content-type": "application/json",
        referer: "https://discovery.intern-ai.org.cn/chat/chat/1644687",
        origin: "https://discovery.intern-ai.org.cn",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
        "accept-language": "zh-CN",
      },
      body: template,
    });
    const text = await res.text();
    console.log(`HTTP ${res.status}`);
    console.log(`Body: ${text.slice(0, 500)}`);
    if (res.status === 200) {
      console.log("✅ 验证通过：Bearer <uaa-token> 可正常调用接口");
    } else if (res.status === 401) {
      console.log("❌ 验证失败：401，Token 已过期或值不正确，需重新登录获取");
    } else {
      console.log(`⚠️  返回状态 ${res.status}，可能需要调整参数`);
    }
  } catch (e) {
    console.log(`⚠️  网络请求失败（可能是环境限制）: ${e.message}`);
    console.log("   请将上面生成的修复代码放到你的自动化脚本中运行。");
  }
}

console.log("\n==== 诊断结束 ====");
