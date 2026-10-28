const fs = require('fs');
const path = 'D:/AI/9router/src/app/api/proxy-pools/cloudflare-deploy/route.js';
let s = fs.readFileSync(path,'utf8');
const neu = `const RELAY_WORKER_CODE = \`
export default {
  async fetch(request, env, ctx) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";

    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    let targetUrl;
    try {
      const base = target.replace(/\/$/, "");
      targetUrl = relayPath.startsWith("http") ? relayPath : base + relayPath;
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid target" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const method = request.method;
    const headers = new Headers();
    for (const [k, v] of request.headers.entries()) {
      const key = k.toLowerCase();
      if (key === "x-relay-target" || key === "x-relay-path" || key === "host" || key === "cf-connecting-ip" || key === "cf-ipcountry" || key === "cf-ray" || key === "cf-visitor" || key === "cf-worker" || key === "cf-request-id") continue;
      headers.set(k, v);
    }
    if (!headers.has("user-agent")) headers.set("user-agent", "9Router-Relay");

    const init = {
      method,
      headers,
      redirect: "follow",
    };

    if (method !== "GET" && method !== "HEAD") {
      init.body = request.body;
    }

    try {
      const response = await fetch(targetUrl, init);
      const resHeaders = new Headers(response.headers);
      resHeaders.delete("cf-ray");
      resHeaders.set("x-relay-status", String(response.status));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: resHeaders,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message || String(error) }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
\`;`;
const start = s.indexOf('const RELAY_WORKER_CODE');
const end = s.indexOf('// POST /api/proxy-pools/cloudflare-deploy');
if (start === -1 || end === -1) { console.log('bad'); process.exit(1); }
// include newline before POST
s2 = s.slice(0,start) + neu + '\n\n' + s.slice(end);
fs.writeFileSync(path, s2);
console.log('ok');
