// Copilot answers an id it does not serve with "model_not_available_for_integrator",
// which reads like a header bug. The message must point at the model catalog instead.
import { describe, it, expect } from "vitest";
import { GithubExecutor } from "../../open-sse/executors/github.js";

const res = (status) => ({ status, headers: { get: () => null } });

describe("github parseError", () => {
  const gh = new GithubExecutor();

  it("rewrites model_not_available_for_integrator to a catalog hint", () => {
    const body = '{"error":{"code":"model_not_available_for_integrator","message":"The requested model is not available for integrator \\"vscode-chat\\""}}';
    const out = gh.parseError(res(400), body);
    expect(out.status).toBe(400);
    expect(out.message).toContain("Copilot-Integration-Id header is already correct");
    expect(out.message).toContain("model_not_available_for_integrator");
  });

  it("leaves other errors untouched", () => {
    const out = gh.parseError(res(400), '{"error":{"message":"bad body"}}');
    expect(out.message).toBe('{"error":{"message":"bad body"}}');
  });
});
