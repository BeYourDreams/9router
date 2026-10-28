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

    const base = target.replace(/\/$/, "");
    const targetUrl = relayPath.startsWith("http") ? relayPath : base + relayPath;

    const headers = new Headers(request.headers);
    headers.delete("x-relay-target");
    headers.delete("x-relay-path");
    headers.delete("host");

    const init = {
      method: request.method,
      headers,
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    try {
      const response = await fetch(targetUrl, init);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
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
s2 = s.slice(0,start) + neu + '\n\n' + s.slice(end);
fs.writeFileSync(path, s2);
console.log('ok');
