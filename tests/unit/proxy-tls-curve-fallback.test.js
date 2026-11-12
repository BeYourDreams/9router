// Single-curve ClientHello (TLS_ECDH_CURVE, default X25519) is what some DPI
// middleboxes want; other edges RST it outright — AWS OIDC/Cognito answers
// ECONNRESET "before secure TLS connection was established", which is why
// Connect Kiro (device-code/social exchange) failed with a bare "fetch failed".
// The fix replays once on the runtime's default curve list.
import { describe, it, expect, beforeEach, vi } from "vitest";

const reset = () => vi.resetModules();

describe("TLS curve fallback on handshake reset", () => {
  beforeEach(reset);

  it("gives the default-curve path its own dispatcher", async () => {
    const { getDirectDispatcher, resetDirectDispatchersForTests } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );
    resetDirectDispatchersForTests();

    const curved = await getDirectDispatcher(false);
    const defaultCurves = await getDirectDispatcher(false, null);

    expect(curved).not.toBe(defaultCurves);
    expect(await getDirectDispatcher(false, null)).toBe(defaultCurves);
  });

  it("replays the same request once on the default curves when the handshake is reset", async () => {
    const handshakeReset = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(
        new Error("Client network socket disconnected before secure TLS connection was established"),
        { code: "ECONNRESET" }
      ),
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(handshakeReset)
      .mockResolvedValueOnce({ status: 200, ok: true });

    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, getDirectDispatcher, resetDirectDispatchersForTests } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );
    resetDirectDispatchersForTests();

    const res = await proxyAwareFetch("https://oidc.us-east-1.amazonaws.com/client/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"clientName":"kiro"}',
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(await getDirectDispatcher(false));
    expect(fetchMock.mock.calls[1][1].dispatcher).toBe(await getDirectDispatcher(false, null));
    expect(fetchMock.mock.calls[1][1].body).toBe('{"clientName":"kiro"}');
  });

  it("does not replay a reset that a proxy attempt produced", async () => {
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return {
        ...actual,
        fetch: vi.fn().mockRejectedValue(
          Object.assign(new Error("fetch failed"), {
            cause: Object.assign(
              new Error("Client network socket disconnected before secure TLS connection was established"),
              { code: "ECONNRESET" }
            ),
          })
        ),
      };
    });

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(
      proxyAwareFetch("https://oidc.us-east-1.amazonaws.com/client/register", { method: "POST", body: "{}" }, {
        enabled: true,
        url: "http://127.0.0.1:7890",
      })
    ).rejects.toThrow(/fetch failed/);
  });
});
