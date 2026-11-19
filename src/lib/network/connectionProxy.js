
// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// Sentinel for the direct (no-proxy) lane in round rotation.
export const DIRECT_POOL_ID = "__none__";

const lastSuccessPoolIds = new Map(); // providerId → pool id of last successful proxied request

/** Remember the pool that served a successful proxied request (direct is ignored). */
export function rememberProxyPoolSuccess(providerId, poolId) {
  if (providerId && poolId && poolId !== DIRECT_POOL_ID) lastSuccessPoolIds.set(providerId, poolId);
}

/**
 * Pick the next egress, skipping exclusions.
 * round-robin: direct first, then last successful pool, then pools in order
 * random:      uniform random pool
 * none:        first pool
 */
export function pickProxyPoolId(poolIds, strategy, providerId, excludeProxyPoolIds = new Set()) {
  const pools = (poolIds || []).filter(id => id && !excludeProxyPoolIds.has(id));
  if (strategy === "round-robin") {
    if (!excludeProxyPoolIds.has(DIRECT_POOL_ID)) return DIRECT_POOL_ID;
    const last = lastSuccessPoolIds.get(providerId);
    return last && pools.includes(last) ? last : (pools[0] || null);
  }
  if (pools.length === 0) return null;
  if (strategy === "random") return pools[Math.floor(Math.random() * pools.length)];
  return pools[0];
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

export function proxyConfigFromPool(proxyPool) {
  if (!proxyPool || proxyPool.isActive !== true) return null;

  const proxyUrl = normalizeString(proxyPool.proxyUrl);
  if (!proxyUrl) return null;

  const noProxy = normalizeString(proxyPool.noProxy);
  const isRelay = ["vercel", "cloudflare", "deno", "netlify"].includes(proxyPool.type);

  return {
    source: isRelay ? proxyPool.type : "pool",

    proxyPoolId: proxyPool.id || null,
    proxyPool,

    connectionProxyEnabled: !isRelay,
    connectionProxyUrl: isRelay ? "" : proxyUrl,
    connectionNoProxy: noProxy,

    strictProxy: proxyPool.strictProxy === true,

    vercelRelayUrl: isRelay ? proxyUrl : "",
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === DIRECT_POOL_ID ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    // A strict pool must keep its guarantee even when the pool itself is not
    // usable (inactive, or saved without a url). Otherwise the unusable-pool
    // path below reports strictProxy:false and the request silently leaves
    // over the direct IP — the leak strict mode exists to prevent (#4333).
    let poolStrictProxy = false;

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const { getProxyPoolById } = await import("@/models");
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      poolStrictProxy = proxyPool?.strictProxy === true;

      if (isValidPool) {
        return proxyConfigFromPool(proxyPool);
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrictProxy,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrictProxy,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}
