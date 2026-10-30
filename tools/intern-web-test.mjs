import fs from "node:fs";
import path from "node:path";

const AFTER_FILE = path.join(process.cwd(), "intern-capture", "intern-after-login.json");

function extractUaaToken() {
  const raw = fs.readFileSync(AFTER_FILE, "utf8");
  const data = JSON.parse(raw);
  const cookie = data.cookie || "";
  const m = cookie.match(/(?:^|;\s*)uaa-token=([^;]+)/);
  return m ? m[1] : null;
}

async function main() {
  const token = extractUaaToken();
  if (!token) {
    console.error("❌ 未在 intern-after-login.json 中找到 uaa-token，请先用浏览器登录并抓包");
    process.exit(1);
  }

  console.log(`✅ 提取到 uaa-token (长度 ${token.length})`);
  console.log(`   jti: ${token.split(".")[1] ? JSON.parse(Buffer.from(token.split(".")[1] + "===","base64").toString("utf8")).jti || "?" : "?"}`);

  const res = await fetch("https://discovery.intern-ai.org.cn/api/orbit/v1/chat", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      referer: "https://discovery.intern-ai.org.cn/chat/chat/1644687",
      origin: "https://discovery.intern-ai.org.cn",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
      "accept-language": "zh-CN",
    },
    body: JSON.stringify({
      scenario: 1,
      thinking_mode: true,
      planning_mode: false,
      model: "Auto",
      query: "测试",
      chat_id: 1644687,
    }),
  });

  const text = await res.text();
  console.log(`\nHTTP ${res.status}`);
  console.log(text.slice(0, 1000));

  if (res.status === 200) {
    console.log("\n✅ 测试通过：Authorization: Bearer <uaa-token> 可正常调用 Intern Web");
  } else if (res.status === 401) {
    console.log("\n❌ 401：Token 已过期或值不正确。在浏览器重新登录 discovery.intern-ai.org.cn，再重新抓包。");
  } else {
    console.log(`\n⚠️  状态 ${res.status}，认证已通过但参数可能需要调整。`);
  }
}

main().catch((e) => {
  console.error("❌ 失败:", e.message);
  process.exit(1);
});
