import { describe, it, expect } from "vitest";
import { statusForAdapterError } from "../../open-sse/executors/xiaomimimo-web.js";

describe("xiaomimimo-web status mapping", () => {
  it("maps an expired upstream session to 401", () => {
    expect(
      statusForAdapterError(
        'Xiaomi MiMo chat HTTP 401: {"code":401,"loginUrl":"https://account.xiaomi.com/pass/serviceLogin"}'
      )
    ).toBe(401);
  });

  it("keeps rate limits and bad requests distinct", () => {
    expect(statusForAdapterError("Xiaomi MiMo chat HTTP 429: slow down")).toBe(429);
    expect(statusForAdapterError("model is not supported")).toBe(400);
  });
});
