// CodeBuddy CN must follow the CLI agent's live catalog and show each model's
// credits multiplier — no waiting for a 9router release when Tencent ships one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCodeBuddyCnModels, resolveCodeBuddyCnModels } from "open-sse/services/codebuddyModels.js";

const catalog = {
  code: 0,
  data: {
    agents: [{ name: "cli", models: ["hy4std", "new-model"] }],
    models: [
      { id: "hy4std", name: "Hy4", credits: "x0.29 credits" },
      { id: "new-model", name: "Fresh", credits: "x1.25" },
      { id: "not-in-cli", name: "Hidden", credits: "x9.00" },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("CodeBuddy CN live catalog", () => {
  it("keeps the CLI agent's models with their credits in the name", () => {
    const models = parseCodeBuddyCnModels(catalog);
    expect(models.map((m) => m.id)).toEqual(["hy4std", "new-model"]);
    expect(models[0]).toMatchObject({ name: "Hy4 (x0.29 credits)", credits: "x0.29 credits", rateMultiplier: 0.29 });
  });

  it("falls back to every published model when no agent list exists", () => {
    const models = parseCodeBuddyCnModels({ data: { models: catalog.data.models } });
    expect(models).toHaveLength(3);
  });

  it("fetches the live catalog with the connection's bearer token", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      return Response.json(catalog);
    });
    const result = await resolveCodeBuddyCnModels({ accessToken: "tok", providerSpecificData: {} });
    expect(calls[0].url).toBe("https://copilot.tencent.com/console/enterprises/personal/models");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(result.models.map((m) => m.name)).toEqual(["Hy4 (x0.29 credits)", "Fresh (x1.25)"]);
  });
});
