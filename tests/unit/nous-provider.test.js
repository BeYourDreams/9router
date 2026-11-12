import { afterEach, describe, expect, it, vi } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  PROVIDERS,
  PROVIDER_MODELS,
  PROVIDER_OAUTH,
} from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { refreshNousToken } from "../../open-sse/services/tokenRefresh.js";
import nousOAuth from "../../src/lib/oauth/providers/nous.js";
import {
  NOUS_AGENT_KEY_URL,
  NOUS_CHAT_COMPLETIONS_URL,
  NOUS_DEVICE_CODE_URL,
  NOUS_MODELS_URL,
  NOUS_OAUTH_CLIENT_ID,
  NOUS_OAUTH_SCOPE,
  NOUS_TOKEN_URL,
  NOUS_VALIDATION_MODEL,
  createNousApiKeyProbe,
  getNousApiKeyValidationError,
  isNousApiKeyAccepted,
  normalizeNousFreeModels,
  normalizeNousModels,
} from "../../open-sse/services/nous.js";

const originalFetch = global.fetch;

describe("Nous Research provider", () => {
  const entry = REGISTRY.find((candidate) => candidate.id === "nous");
  const sampleFreeModel = "poolside/laguna-s-2.1:free";

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("is registered with dual OAuth (Device Code) + API-key authentication in freeTier", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("freeTier");
    expect(entry.hasFree).toBe(true);
    expect(entry.hasOAuth).toBe(true);
    expect(entry.authType).toBe("oauth");
    expect(entry.authModes).toEqual(["oauth", "apikey"]);
    expect(entry.display.name).toBe("Nous Research");
    expect(entry.display.notice.apiKeyUrl).toBe("https://portal.nousresearch.com/api-keys");
    expect(PROVIDER_OAUTH.nous).toMatchObject({
      clientId: NOUS_OAUTH_CLIENT_ID,
      scope: NOUS_OAUTH_SCOPE,
      deviceCodeUrl: NOUS_DEVICE_CODE_URL,
      tokenUrl: NOUS_TOKEN_URL,
      agentKeyUrl: NOUS_AGENT_KEY_URL,
    });
  });

  it("uses the documented OpenAI-compatible inference endpoint", () => {
    expect(PROVIDERS.nous).toBeDefined();
    expect(PROVIDERS.nous.format).toBe("openai");
    expect(PROVIDERS.nous.baseUrl).toBe(NOUS_CHAT_COMPLETIONS_URL);
    expect(NOUS_MODELS_URL).toBe("https://inference-api.nousresearch.com/v1/models");
  });

  it("seeds the 8 current live free-tier models with advertised context", () => {
    const expectedIds = [
      "meituan/longcat-2.0:free",
      "meituan/longcat-2.5-preview:free",
      "stepfun/step-5-preview:free",
      "upstage/solar-mini4:free",
      "stepfun/step-3.7-flash:free",
      "poolside/laguna-s-2.1:free",
      "poolside/laguna-xs-2.1:free",
      "stealth/missingno",
    ];
    const models = PROVIDER_MODELS.nous || [];

    expect(models.map((model) => model.id)).toEqual(expectedIds);
    expect(models.every((model) => model.contextLength >= 262144)).toBe(true);
    expect(getModelsByProviderId("nous").map((model) => model.id)).toEqual(expectedIds);
    expect(entry.passthroughModels).toBe(true);
    expect(entry.modelsFetcher).toEqual({
      url: NOUS_MODELS_URL,
      type: "nous-free",
    });
  });

  it("resolves the provider's public names without alias collisions", () => {
    for (const alias of ["nous", "nous-portal", "nous-research", "ns"]) {
      expect(resolveProviderAlias(alias)).toBe("nous");
    }
    expect(resolveProviderAlias("nousresearch")).toBe("nousresearch");
    expect(parseModel("nous/poolside/laguna-s-2.1:free")).toMatchObject({
      provider: "nous",
      model: "poolside/laguna-s-2.1:free",
    });

    const ids = REGISTRY.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("advertises tool calling and reasoning capabilities for seeded Nous models", () => {
    for (const model of PROVIDER_MODELS.nous) {
      const capabilities = getCapabilitiesForModel("nous", model.id);
      expect(capabilities).toMatchObject({
        tools: true,
        reasoning: true,
        thinkingFormat: "nous",
      });
      expect(capabilities.contextWindow).toBeGreaterThanOrEqual(262144);
    }
  });

  it("maps reasoning controls to Nous's nested wire format", () => {
    const enabled = {
      model: sampleFreeModel,
      messages: [{ role: "user", content: "reason about this" }],
      reasoning_effort: "high",
    };
    applyThinking("openai", sampleFreeModel, enabled, "nous");
    expect(enabled.reasoning_effort).toBeUndefined();
    expect(enabled.reasoning).toEqual({ enabled: true, effort: "high" });

    const disabled = {
      model: sampleFreeModel,
      messages: [{ role: "user", content: "answer directly" }],
      reasoning_effort: "none",
    };
    applyThinking("openai", sampleFreeModel, disabled, "nous");
    expect(disabled.reasoning_effort).toBeUndefined();
    expect(disabled.reasoning).toBeUndefined();
  });

  it("builds a minimal authenticated chat probe instead of trusting public models", () => {
    const probe = createNousApiKeyProbe("test-api-key");
    const body = JSON.parse(probe.options.body);

    expect(probe.url).toBe(NOUS_CHAT_COMPLETIONS_URL);
    expect(probe.url).not.toBe(NOUS_MODELS_URL);
    expect(probe.options.method).toBe("POST");
    expect(probe.options.headers.Authorization).toBe("Bearer test-api-key");
    expect(body).toEqual({
      model: NOUS_VALIDATION_MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    });
    expect(NOUS_VALIDATION_MODEL).toMatch(/:free$/);
  });

  it("accepts only successful inference as proof of authentication", () => {
    expect(isNousApiKeyAccepted(200)).toBe(true);
    expect(isNousApiKeyAccepted(204)).toBe(true);
    expect(isNousApiKeyAccepted(400)).toBe(false);
    expect(isNousApiKeyAccepted(401)).toBe(false);
    expect(isNousApiKeyAccepted(402)).toBe(false);
    expect(isNousApiKeyAccepted(403)).toBe(false);
    expect(isNousApiKeyAccepted(404)).toBe(false);
    expect(isNousApiKeyAccepted(429)).toBe(false);
    expect(isNousApiKeyAccepted(500)).toBe(false);
    expect(getNousApiKeyValidationError(401)).toBe("Invalid or inactive API key");
    expect(getNousApiKeyValidationError(503)).toBe(
      "Unable to verify API key (Nous returned 503)",
    );
  });

  it("normalizes the live catalogue and removes non-chat models", () => {
    const models = normalizeNousModels({
      data: [
        {
          id: "vendor/text-model",
          name: "Vendor Text Model",
          context_length: 262144,
          top_provider: { max_completion_tokens: 65536 },
          architecture: { output_modalities: ["text"] },
        },
        {
          id: "vendor/embedding-model",
          architecture: { output_modalities: ["embeddings"] },
        },
        {
          id: "nousresearch/first-party-model",
          name: "Nous First Party",
          description: "Hybrid reasoning model",
          context_length: 262144,
          architecture: { output_modalities: ["text"] },
        },
        { id: "  " },
      ],
    });

    expect(models).toEqual([
      {
        id: "nousresearch/first-party-model",
        name: "Nous First Party",
        contextLength: 262144,
        description: "Hybrid reasoning model",
      },
      {
        id: "vendor/text-model",
        name: "Vendor Text Model",
        contextLength: 262144,
        maxOutputTokens: 65536,
      },
    ]);
  });

  it("suggests only zero-cost text models with at least 200K context", () => {
    const models = normalizeNousFreeModels([
      {
        id: "vendor/free-chat",
        name: "Free Chat",
        context_length: 262144,
        pricing: { prompt: "0", completion: "0.0000000000" },
        architecture: { output_modalities: ["text"] },
      },
      {
        id: "vendor/paid-chat",
        context_length: 262144,
        pricing: { prompt: "0.0000001", completion: "0" },
        architecture: { output_modalities: ["text"] },
      },
      {
        id: "vendor/free-short-chat",
        context_length: 131072,
        pricing: { prompt: "0", completion: "0" },
        architecture: { output_modalities: ["text"] },
      },
      {
        id: "vendor/free-embedding",
        context_length: 262144,
        pricing: { prompt: "0", completion: "0" },
        architecture: { output_modalities: ["embeddings"] },
      },
    ]);

    expect(models).toEqual([{
      id: "vendor/free-chat",
      name: "Free Chat",
      contextLength: 262144,
    }]);
  });

  it("supports OAuth Device Code exchange and agent-key minting with fallback", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: "dev_123",
        user_code: "NOUS-1234",
        verification_uri: "https://portal.nousresearch.com/device",
        verification_uri_complete: "https://portal.nousresearch.com/device?user_code=NOUS-1234",
        expires_in: 900,
        interval: 5,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        api_key: "sk-nous-agent-minted",
        key_id: "key_abc",
        expires_at: "2026-10-15T00:00:00Z",
        expires_in: 7200,
      }), { status: 200 }));

    const device = await nousOAuth.requestDeviceCode(nousOAuth.config);
    expect(device.user_code).toBe("NOUS-1234");

    const extra = await nousOAuth.postExchange({ access_token: "at_raw" });
    expect(extra.agentKey).toBe("sk-nous-agent-minted");

    const mapped = nousOAuth.mapTokens({
      access_token: "at_raw",
      refresh_token: "rt_raw",
      expires_in: 3600,
      scope: NOUS_OAUTH_SCOPE,
    }, extra);
    expect(mapped.apiKey).toBe("sk-nous-agent-minted");
    expect(mapped.accessToken).toBe("at_raw");
    expect(mapped.refreshToken).toBe("rt_raw");
    expect(mapped.providerSpecificData.agentKeyId).toBe("key_abc");

    const fallbackMapped = nousOAuth.mapTokens({
      access_token: "at_raw",
      refresh_token: "rt_raw",
      expires_in: 3600,
    }, { agentKey: null });
    expect(fallbackMapped.apiKey).toBe("at_raw");
    // A failed/retired mint must null out the agent-key fields so a stale
    // expiry from a previous login cannot survive the shallow merge.
    expect(fallbackMapped.providerSpecificData.agentKeyExpiresAt).toBeNull();
    expect(fallbackMapped.providerSpecificData.agentKeyId).toBeNull();
  });

  it("treats retired agent-key minting as expected state during sign-in", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: "session_key_minting_retired",
      error_description: "Hermes Agent session key minting has been retired.",
    }), { status: 400 }));

    const extra = await nousOAuth.postExchange({ access_token: "at_raw" });
    expect(extra.agentKey).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();

    const mapped = nousOAuth.mapTokens({ access_token: "at_raw", expires_in: 3600 }, extra);
    expect(mapped.apiKey).toBe("at_raw");
    expect(mapped.providerSpecificData.agentKeyExpiresAt).toBeNull();
  });

  it("refreshes Nous OAuth token and mints a fresh agent key", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "at_refreshed",
        refresh_token: "rt_refreshed",
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        api_key: "sk-nous-agent-refreshed",
        key_id: "key_refreshed",
        expires_at: "2026-10-15T02:00:00Z",
      }), { status: 200 }));

    const refreshed = await refreshNousToken("rt_initial");
    expect(refreshed).toMatchObject({
      accessToken: "at_refreshed",
      refreshToken: "rt_refreshed",
      expiresIn: 3600,
      apiKey: "sk-nous-agent-refreshed",
      agentKey: "sk-nous-agent-refreshed",
      providerSpecificData: {
        agentKeyId: "key_refreshed",
        agentKeyExpiresAt: "2026-10-15T02:00:00Z",
      },
    });
  });

  it("falls back to access_token when agent-key minting is retired and clears stale expiry", async () => {
    // Isolate the module-level retirement flag so this test observes the
    // first encounter with the retired endpoint regardless of test order.
    vi.resetModules();
    const { refreshNousToken: freshRefresh } = await import(
      "../../open-sse/services/tokenRefresh/providers.js"
    );

    const warn = vi.fn();
    const debug = vi.fn();
    const log = { info: vi.fn(), warn, debug, error: vi.fn() };

    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "at_retired",
        refresh_token: "rt_retired",
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "session_key_minting_retired",
        error_description: "Hermes Agent session key minting has been retired.",
      }), { status: 400 }));

    const refreshed = await freshRefresh("rt_initial_retired", log);

    // The OAuth access_token is used directly as the inference credential.
    expect(refreshed.apiKey).toBe("at_retired");
    expect(refreshed.agentKey).toBeNull();
    expect(refreshed.accessToken).toBe("at_retired");

    // Retired minting is expected state: no warning, and a debug breadcrumb.
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();

    // Stale agent-key fields are explicitly nulled so a shallow merge into the
    // stored connection overwrites the poisoned past expiry.
    expect(refreshed.providerSpecificData).toEqual({
      agentKeyId: null,
      agentKeyExpiresAt: null,
      agentKeyExpiresIn: null,
    });
  });

  it("stops calling the retired agent-key endpoint after the first observation", async () => {
    vi.resetModules();
    const { refreshNousToken: freshRefresh } = await import(
      "../../open-sse/services/tokenRefresh/providers.js"
    );

    const fetchMock = vi.fn()
      // First refresh: token + retired mint.
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "at_1",
        refresh_token: "rt_1",
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "session_key_minting_retired",
      }), { status: 400 }))
      // Second refresh: token only — the mint endpoint must not be hit again.
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "at_2",
        refresh_token: "rt_2",
        expires_in: 3600,
      }), { status: 200 }));
    global.fetch = fetchMock;

    const first = await freshRefresh("rt_initial_a", { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
    expect(first.apiKey).toBe("at_1");

    const second = await freshRefresh("rt_initial_b", { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
    expect(second.apiKey).toBe("at_2");

    // Exactly three fetches: token, retired mint, token. No second mint call.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const mintCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/agent-key"));
    expect(mintCalls).toHaveLength(1);
  });

  it("still warns when agent-key minting fails for an unrelated reason", async () => {
    vi.resetModules();
    const { refreshNousToken: freshRefresh } = await import(
      "../../open-sse/services/tokenRefresh/providers.js"
    );

    const warn = vi.fn();
    const log = { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() };

    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "at_transient",
        refresh_token: "rt_transient",
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "server_error",
      }), { status: 500 }));

    const refreshed = await freshRefresh("rt_initial_transient", log);

    expect(refreshed.apiKey).toBe("at_transient");
    expect(warn).toHaveBeenCalled();
  });
});
