import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";

// Relay worker source code deployed to Cloudflare
const RELAY_WORKER_CODE = `
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

    const base = target.endsWith("/") ? target.slice(0, -1) : target;
    const targetUrl = relayPath.startsWith("http") ? relayPath : base + relayPath;

    const headers = new Headers(request.headers);
    headers.delete("x-relay-target");
    headers.delete("x-relay-path");
    headers.delete("host");

    const init = {
      method: request.method,
      headers,
      redirect: "follow",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
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
`;

function cfErrorMessage(payload, fallback) {
  const msg = payload?.errors?.[0]?.message || payload?.error || payload?.message;
  return typeof msg === "string" && msg.trim() ? msg : fallback;
}

// POST /api/proxy-pools/cloudflare-deploy
export async function POST(request) {
  try {
    const body = await request.json();
    const accountId = body.accountId?.trim();
    const apiToken = body.apiToken?.trim();
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!accountId || !apiToken) {
      return NextResponse.json({ error: "Cloudflare Account ID and API Token are required" }, { status: 400 });
    }

    // 1. Upload Worker Script
    const workerScriptUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${projectName}`;

    // ponytail: manual multipart — global FormData/fetch can omit/garble the boundary in some runtimes,
    // causing Cloudflare 10001 'Content-Type must be ... multipart/form-data'. Ceiling: no file uploads; upgrade: form-data pkg.
    const boundary = "----9router" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const metadata = JSON.stringify({
      main_module: "index.js",
      compatibility_date: "2024-03-20",
      observability: { enabled: true },
    });
    const uploadBody =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"; filename="metadata.json"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      metadata + `\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n` +
      `Content-Type: application/javascript+module\r\n\r\n` +
      RELAY_WORKER_CODE + `\r\n` +
      `--${boundary}--\r\n`;

    const uploadRes = await fetch(workerScriptUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: uploadBody,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      console.error("Cloudflare upload error:", err);
      return NextResponse.json(
        { error: cfErrorMessage(err, "Failed to upload Worker to Cloudflare") },
        { status: uploadRes.status }
      );
    }

    // 2. Enable workers.dev subdomain for the script
    const enableSubdomainRes = await fetch(`${workerScriptUrl}/subdomain`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });

    if (!enableSubdomainRes.ok) {
      const err = await enableSubdomainRes.json().catch(() => ({}));
      console.error("Cloudflare subdomain enable error:", err);
      return NextResponse.json(
        {
          error:
            cfErrorMessage(err, "Failed to enable workers.dev route for the Worker") +
            ". Worker script was uploaded, but the relay URL is not active. Check that your account has a workers.dev subdomain and the API token can edit Workers Scripts.",
        },
        { status: enableSubdomainRes.status }
      );
    }

    // 3. Get the workers.dev subdomain for the account to construct the final URL
    const subdomainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    let deployUrl = "";
    if (subdomainRes.ok) {
      const subdomainData = await subdomainRes.json().catch(() => ({}));
      const subdomain = subdomainData?.result?.subdomain;
      if (typeof subdomain === "string" && subdomain.trim()) {
        deployUrl = `https://${projectName}.${subdomain.trim()}.workers.dev`;
      }
    } else {
      const err = await subdomainRes.json().catch(() => ({}));
      console.error("Cloudflare subdomain lookup error:", err);
      return NextResponse.json(
        {
          error:
            cfErrorMessage(err, "Failed to retrieve workers.dev subdomain") +
            ". Worker script was uploaded. Set up a workers.dev subdomain in Cloudflare Dashboard, then add the relay URL manually if needed.",
        },
        { status: subdomainRes.status }
      );
    }

    if (!deployUrl) {
      return NextResponse.json(
        { error: "Worker deployed but no workers.dev subdomain is configured for this account. Set one in Cloudflare Dashboard (Workers & Pages → workers.dev), then redeploy or add the relay URL manually." },
        { status: 400 }
      );
    }

    // Create proxy pool entry with type cloudflare
    const proxyPool = await createProxyPool({
      name: projectName,
      proxyUrl: deployUrl,
      type: "cloudflare",
      noProxy: "",
      isActive: true,
      strictProxy: false,
    });

    return NextResponse.json({ proxyPool, deployUrl }, { status: 201 });
  } catch (error) {
    console.log("Error deploying Cloudflare relay:", error);
    return NextResponse.json({ error: error.message || "Deploy failed" }, { status: 500 });
  }
}
