import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";

const VERCEL_API = "https://api.vercel.com";

// Relay function source code deployed to Vercel
// Forwards requests to target URL specified in x-relay-target header
const RELAY_FUNCTION_CODE = `
export const config = { runtime: "edge" };

export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const targetUrl = target.replace(/\\/$/, "") + relayPath;

  const rawHeaders = {};
  for (const [k, v] of req.headers.entries()) rawHeaders[k] = v;
  delete rawHeaders["x-relay-target"];
  delete rawHeaders["x-relay-path"];
  delete rawHeaders["host"];

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: rawHeaders,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    duplex: "half",
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
`;

async function pollDeployment(deploymentId, token, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await fetch(`${VERCEL_API}/v13/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.readyState === "READY") return data;
    if (data.readyState === "ERROR" || data.readyState === "CANCELED") {
      throw new Error(`Deployment failed: ${data.readyState}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Deployment timed out");
}

// POST /api/proxy-pools/vercel-deploy
export async function POST(request) {
  try {
    const body = await request.json();
    const vercelToken = body.vercelToken;
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!vercelToken) {
      return NextResponse.json({ error: "Vercel API token is required" }, { status: 400 });
    }

    // Deploy relay function to Vercel
    const deployRes = await fetch(`${VERCEL_API}/v13/deployments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: projectName,
        files: [
          {
            file: "api/relay.js",
            data: RELAY_FUNCTION_CODE,
          },
        ],
        target: "production",
        projectSettings: {
          framework: null,
          buildCommand: null,
          devCommand: null,
          installCommand: null,
        },
      }),
    });

    if (!deployRes.ok) {
      const err = await deployRes.json();
      return NextResponse.json({ error: err.error || "Deployment failed" }, { status: 502 });
    }

    const deployData = await deployRes.json();
    const deploymentId = deployData.id;

    // Poll until ready
    const ready = await pollDeployment(deploymentId, vercelToken);

    // Create proxy pool record with the relay URL
    const relayUrl = `https://${ready.url}/api/relay`;
    const pool = await createProxyPool({
      name: projectName,
      provider: "vercel-relay",
      config: { relayUrl, vercelToken, projectId: deployData.projectId },
      enabled: true,
    });

    return NextResponse.json({
      pool,
      relayUrl,
      deployment: { id: deploymentId, url: ready.url },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}