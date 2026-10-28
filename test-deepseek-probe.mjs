// Quick probe test for deepseek-web
// Usage: node test-deepseek-probe.mjs "<userToken>"

// Uses native fetch (Node 18+)

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

async function probe(userToken) {
  console.log("Testing token:", userToken?.slice(0, 20) + "...");
  
  const res = await fetch("https://chat.deepseek.com/api/v0/users/current", {
    headers: {
      Authorization: `Bearer ${userToken}`,
      Accept: "*/*",
      Origin: "https://chat.deepseek.com",
      Referer: "https://chat.deepseek.com/",
      "X-Client-Bundle-Id": "com.deepseek.chat",
      "X-Client-Platform": "web",
      "X-Client-Version": "2.0.0",
      "User-Agent": UA,
    },
  });
  
  console.log("Status:", res.status);
  console.log("Headers:", Object.fromEntries(res.headers.entries()));
  
  const text = await res.text();
  console.log("Raw response:", text.slice(0, 500));
  
  try {
    const json = JSON.parse(text);
    console.log("Parsed:", JSON.stringify(json, null, 2));
  } catch (e) {
    console.log("Not valid JSON");
  }
}

const token = process.argv[2];
if (!token) {
  console.log("Usage: node test-deepseek-probe.mjs \"<userToken>\"");
  console.log("Get token from chat.deepseek.com localStorage -> userToken");
  process.exit(1);
}

probe(token).catch(console.error);