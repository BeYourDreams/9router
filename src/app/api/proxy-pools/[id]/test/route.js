import { NextResponse } from "next/server";
import { getProxyPoolById, getProxyPools, updateProxyPool } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// Where a relay probe sends its traffic. Override with PROXY_RELAY_TEST_URL
// (or a `testUrl` in the POST body). Default is a lightweight, globally
// reachable 200 endpoint (httpbin is rate-limited/geo-blocked in places,
// which made a healthy relay look broken).
const DEFAULT_RELAY_TEST_URL = "https://cloudflare.com/cdn-cgi/trace";

function relayTarget(bodyTestUrl) {
  const configured = String(bodyTestUrl || "").trim() || String(process.env.PROXY_RELAY_TEST_URL || "").trim() || DEFAULT_RELAY_TEST_URL;
  try {
    const parsed = new URL(configured);
    return { target: `${parsed.protocol}//${parsed.host}`, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    const parsed = new URL(DEFAULT_RELAY_TEST_URL);
    return { target: `${parsed.protocol}//${parsed.host}`, path: `${parsed.pathname}${parsed.search}` };
  }
}

function relayHint(status, body) {
  const text = typeof body === "string" ? body : "";
  if (status === 400 && /Missing x-relay-target header/i.test(text)) {
    return " Relay endpoint is reachable but not acting as a 9Router-compatible relay (expected x-relay-target/x-relay-path). Redeploy with 9Router or update the worker code.";
  }
  if (status === 404) {
    return " Relay URL not found. Check the worker URL and that its workers.dev route is enabled.";
  }
  if (status >= 500 && status < 600) {
    return " Relay or upstream fetch failed; verify the worker is active and can reach the target URL.";
  }
  if (status === 401 || status === 403) {
    if (/netlify\.com\/edge-access|identity|login/i.test(text)) {
      return " Netlify site access protection is enabled. Disable Visitor/Password protection for this site (or allow public access to the function) in Netlify settings.";
    }
    return " Access denied; if this is the Cloudflare dashboard rather than your worker, the URL/route is wrong.";
  }
  return "";
}

function normalizeProxyUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "";
  try { new URL(s); return s; } catch { return `http://${s}`; }
}

async function relayFallbackProxyUrls(excludePoolId) {
  const urls = [];
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || "";
  if (env.trim()) urls.push(normalizeProxyUrl(env));
  try {
    const pools = await getProxyPools({ isActive: true });
    for (const p of pools || []) {
      if (!p || p.id === excludePoolId) continue;
      const t = p.type || "http";
      if (t !== "http") continue; // ponytail: only plain HTTP proxies can carry relay HTTPS; relays can't reach relays.
      const u = normalizeProxyUrl(p.proxyUrl);
      if (u) urls.push(u);
    }
  } catch {}
  return [...new Set(urls)].filter(Boolean);
}

async function doRelayFetch(relayUrl, headers, timeoutMs, dispatcher) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(new Error("Relay test timed out")), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    let body = "";
    try { body = await res.text(); } catch {}
    return {
      networkOk: true,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
      body,
    };
  } catch (err) {
    const msg = err?.name === "AbortError" || err?.message?.includes("timed out")
      ? "Relay test timed out"
      : (err?.message || String(err));
    return { networkOk: false, ok: false, status: 0, error: msg, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function testVercelRelay(relayUrl, timeoutMs = 10000, bodyTestUrl = "", excludePoolId = null) {
  const { target, path } = relayTarget(bodyTestUrl);
  const headers = {
    "x-relay-target": target,
    "x-relay-path": path,
    "user-agent": "9Router-Test",
  };

  let result = await doRelayFetch(relayUrl, headers, timeoutMs);
  let via = "direct";

  // ponytail: if relay endpoint is unreachable directly (blocked workers.dev/vercel.app etc), retry via env/active HTTP proxy pools.
  if (!result.networkOk) {
    const fallbacks = await relayFallbackProxyUrls(excludePoolId);
    for (const proxyUrl of fallbacks) {
      let dispatcher;
      try { dispatcher = new ProxyAgent({ uri: proxyUrl, connect: { timeout: Math.min(timeoutMs, 8000) } }); } catch { continue; }
      try {
        const r = await doRelayFetch(relayUrl, headers, timeoutMs, dispatcher);
        if (r.networkOk || r.ok) { result = r; via = "proxy"; break; }
        // keep last network error, but prefer any attempt that actually reached the endpoint
        if (!result.networkOk) result = r;
      } finally {
        try { await dispatcher.destroy?.(); await dispatcher.close?.(); } catch {}
      }
    }
  }

  if (!result.networkOk) {
    return { ok: false, status: 500, error: result.error || "Relay unreachable", elapsedMs: result.elapsedMs, via };
  }
  const baseErr = (result.body || "").slice(0, 200) || `Relay test failed with status ${result.status}`;
  return {
    ok: result.ok,
    status: result.status,
    statusText: result.statusText || null,
    elapsedMs: result.elapsedMs || 0,
    via,
    error: result.ok ? undefined : baseErr + relayHint(result.status, result.body),
  };
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    // A `testUrl` in the body overrides the probe target for this one test.
    let bodyTestUrl = "";
    try { bodyTestUrl = (await request.json())?.testUrl || ""; } catch { /* body optional */ }

    const isRelay = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify";
    const result = isRelay
      ? await testVercelRelay(proxyPool.proxyUrl, 10000, bodyTestUrl, proxyPool.id)
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
      via: result.via || "direct",
      testedAt: now,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
