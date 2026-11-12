// ModelScope 魔搭 provider registration — present in the registry, resolvable
// through the UI provider maps, and exposing the OpenAI-compatible transport.
import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { AI_PROVIDERS, FREE_TIER_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("modelscope provider", () => {
  const entry = REGISTRY.find((p) => p.id === "modelscope");

  it("is registered as a free-tier API-key provider", () => {
    expect(entry).toBeTruthy();
    expect(entry.category).toBe("freeTier");
    expect(entry.authType).toBe("apikey");
    expect(entry.alias).toBe("modelscope");
  });

  it("points at the ModelScope API-Inference endpoint", () => {
    expect(entry.transport.baseUrl).toBe("https://api-inference.modelscope.cn/v1/chat/completions");
    expect(entry.transport.validateUrl).toBe("https://api-inference.modelscope.cn/v1/models");
  });

  it("exposes seed models through the provider model map", () => {
    const models = PROVIDER_MODELS.modelscope || [];
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === "Qwen/Qwen3.5-27B")).toBe(true);
  });

  it("appears in the dashboard provider maps", () => {
    expect(AI_PROVIDERS.modelscope).toBeTruthy();
    expect(FREE_TIER_PROVIDERS.modelscope).toBeTruthy();
    expect(AI_PROVIDERS.modelscope.authType).toBe("apikey");
  });
});
