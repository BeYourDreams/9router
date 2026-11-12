import { NOUS_CONFIG } from "../constants/oauth.js";

const isAgentKeyMintingRetired = (status, body) =>
  status === 404 ||
  status === 410 ||
  /session_key_minting_retired/.test(body || "");

const nous = {
  config: NOUS_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        scope: config.scope,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Nous device code request failed: ${error}`);
    }

    const data = await response.json();
    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete,
      expires_in: data.expires_in,
      interval: data.interval,
    };
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        device_code: deviceCode,
      }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      const text = await response.text().catch(() => "");
      data = { error: "invalid_response", error_description: text };
    }

    const pending =
      data?.error === "authorization_pending" ||
      data?.error === "slow_down";
    return {
      ok: response.ok || pending,
      data,
    };
  },
  postExchange: async (tokens) => {
    try {
      const response = await fetch(NOUS_CONFIG.agentKeyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({
          min_ttl_seconds: 7200,
        }),
      });

      if (!response.ok) {
        const error = await response.text().catch(() => "");
        // The Portal retired agent-key minting (session_key_minting_retired).
        // The access_token is itself a valid inference credential, so this is
        // an expected steady state rather than a failure worth warning about.
        if (isAgentKeyMintingRetired(response.status, error)) {
          console.debug("[oauth] Nous agent key minting retired upstream; using access_token");
        } else {
          console.warn(`[oauth] Nous agent key mint failed (${response.status}): ${error}`);
        }
        return { agentKey: null };
      }

      const data = await response.json();
      const agentKeyExpiresAt = data.expires_at
        || (data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null);
      return {
        agentKey: data.api_key || null,
        agentKeyId: data.key_id || null,
        agentKeyExpiresAt,
        agentKeyExpiresIn: data.expires_in || null,
      };
    } catch (err) {
      console.warn(`[oauth] Nous agent key mint error: ${err?.message || err}`);
      return { agentKey: null };
    }
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    apiKey: extra?.agentKey || tokens.access_token,
    providerSpecificData: {
      inferenceBaseUrl: NOUS_CONFIG.inferenceBaseUrl,
      // Emit explicit nulls so a stale agent-key expiry left over from a prior
      // login cannot survive the shallow merge and pin the connection to an
      // already-past expiry (which would trigger a refresh on every request).
      agentKeyId: extra?.agentKeyId || null,
      agentKeyExpiresAt: extra?.agentKeyExpiresAt
        || (extra?.agentKeyExpiresIn
          ? new Date(Date.now() + extra.agentKeyExpiresIn * 1000).toISOString()
          : null),
      agentKeyExpiresIn: extra?.agentKeyExpiresIn || null,
    },
  }),
};

export default nous;
