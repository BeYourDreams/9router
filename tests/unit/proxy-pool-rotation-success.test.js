import { describe, expect, it, vi } from "vitest";

vi.mock("@/models", () => ({ getProxyPoolById: vi.fn() }));

const { pickProxyPoolId, rememberProxyPoolSuccess } = await import("../../src/lib/network/connectionProxy.js");

const ids = ["p1", "p2", "p3"];

describe("round proxy rotation anchors to the last success", () => {
  it("starts at the remembered pool, not the next one in line", () => {
    expect(pickProxyPoolId(ids, "round-robin", "test-a")).toBe("p1");
    rememberProxyPoolSuccess("test-a", "p2");
    expect(pickProxyPoolId(ids, "round-robin", "test-a")).toBe("p2");
  });

  it("moves to the first remaining pool when that pool is spent or gone", () => {
    rememberProxyPoolSuccess("test-a", "p2");
    expect(pickProxyPoolId(["p1", "p3"], "round-robin", "test-a")).toBe("p1");
    rememberProxyPoolSuccess("test-a", "deleted");
    expect(pickProxyPoolId(ids, "round-robin", "test-a")).toBe("p1");
  });

  it("keeps anchors per provider and leaves other strategies alone", () => {
    rememberProxyPoolSuccess("test-a", "p3");
    expect(pickProxyPoolId(ids, "round-robin", "test-b")).toBe("p1");
    expect(pickProxyPoolId(ids, "none", "test-a")).toBe("p1");
  });
});
