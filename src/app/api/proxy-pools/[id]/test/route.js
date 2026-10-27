import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { fetch as undiciFetch } from "undici";

async function testVercelRelay(relayUrl, timeoutMs = 10000) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(new Error("Relay test timed out")), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/get",
        "user-agent": "9Router-Test",
      },
      signal: controller.signal,
    });
    const ok = res.ok;
    let body = "";
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    return {
      ok,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
      error: ok ? undefined : (body.slice(0, 200) || `Relay test failed with status ${res.status}`),
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" || err?.message?.includes("timed out") ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const result = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify"
      ? await testVercelRelay(proxyPool.proxyUrl)
      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });
    const now = new Date().toISOString();

    await updateProxyPool(id, {
      testStatus: result.ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
      isActive: result.ok,
    });

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: result.elapsedMs || 0,
      testedAt: now,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
