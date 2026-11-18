// Rotation Strategy: a 429 from a proxy pool spends that egress, not the
// account. Walk remaining pools, then go direct once all of them are spent.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  pools: [
    { id: "p1", name: "P1", proxyUrl: "http://127.0.0.1:1", isActive: true },
    { id: "p2", name: "P2", proxyUrl: "http://127.0.0.1:2", isActive: true },
  ],
  attempts: [],
  succeedIds: new Set(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ providerStrategies: { "opencode-free-v2": { rotateStrategy: "round-robin" } } }),
  getProxyPools: async () => fx.pools,
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/models", () => ({
  getProxyPoolById: async (id) => fx.pools.find((p) => p.id === id) || null,
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "opencode-free-v2", model: "iceman-free" }),
  getComboModels: async () => null,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: async ({ credentials, onRequestSuccess }) => {
    const id = credentials?.providerSpecificData?.connectionProxyPoolId || "direct";
    fx.attempts.push(id);
    if (id === "direct" || fx.succeedIds.has(id)) {
      await onRequestSuccess?.();
      return { success: true, response: new Response("ok", { status: 200 }) };
    }
    return {
      success: false,
      status: 429,
      error: "rate limited",
      response: new Response("rate limited", { status: 429 }),
    };
  },
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const chatRequest = () => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "opencode-free-v2/iceman-free",
    messages: [{ role: "user", content: "hi" }],
  }),
});

beforeEach(() => { fx.attempts = []; fx.succeedIds = new Set(); });

describe("no-auth proxy rotation 429 fallback", () => {
  it("tries each rotated pool, then direct (free v2 included)", async () => {
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(200);
    expect(fx.attempts).toEqual(["p1", "p2", "direct"]);
  });

  it("free v2 mirrors OpenCode Free's live model catalogue", async () => {
    const { default: v1 } = await import("../../open-sse/providers/registry/opencode.js");
    const { default: v2 } = await import("../../open-sse/providers/registry/opencode-free-v2.js");
    expect(v2.modelsFetcher).toEqual(v1.modelsFetcher);
  });

  it("starts the next request from the pool that just succeeded", async () => {
    fx.succeedIds = new Set(["p2"]);
    await handleChat(chatRequest());
    fx.attempts = [];
    await handleChat(chatRequest());
    expect(fx.attempts).toEqual(["p2"]);
  });
});
