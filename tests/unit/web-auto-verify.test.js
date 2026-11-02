import { describe, it, expect, vi, beforeEach } from "vitest";

// webLogin.js launches a real headed Chrome and @/models touches the DB, so
// both are stubbed: these tests cover the decision logic (when to open, what
// counts as solved), not Chromium.
vi.mock("open-sse/services/webLogin.js", () => ({
  startWebLogin: vi.fn(async (providerId, profile) => ({
    providerId,
    profile,
    status: "waiting",
    context: {},
    credential: null,
  })),
  getWebLoginStatus: vi.fn(() => null),
  cancelWebLogin: vi.fn(),
}));

vi.mock("@/models", () => ({
  updateProviderConnection: vi.fn(async () => ({ id: "c1" })),
  getProviderConnections: vi.fn(async () => []),
}));

// Production poll is 5s; the knobs are read at module load, so set them first.
process.env.WEB_AUTO_VERIFY_POLL_MS = "60";
process.env.WEB_AUTO_VERIFY_TIMEOUT_MS = "3000";

const {
  autoVerifyEnabled,
  isVerifyChallenge,
  isExpiredSession,
  verifyReason,
  maybeOpenVerifyWindow,
  resetAutoVerify,
} = await import("open-sse/services/webAutoVerify.js");
const webLogin = await import("open-sse/services/webLogin.js");
const models = await import("@/models");

const res = (text, status = 403) =>
  new Response(text, { status, headers: { "Content-Type": "application/json" } });

const args = (over = {}) => ({
  provider: "doubao-web",
  connectionId: "c1",
  credentials: { apiKey: "sessionid=a; sid_tt=a", providerSpecificData: { webLoginProfile: "work" } },
  response: res('{"error":{"message":"rate limited — captcha required"}}'),
  log: { warn: vi.fn() },
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 300));

describe("web auto-verify", () => {
  beforeEach(() => {
    resetAutoVerify();
    vi.clearAllMocks();
    delete process.env.WEB_AUTO_VERIFY;
    webLogin.getWebLoginStatus.mockReturnValue(null);
  });

  it("classifies the signals: 401 always, 403/429 only with a marker", () => {
    expect(verifyReason(401, "anything")).toBe("expired");
    expect(verifyReason(403, "please complete the captcha")).toBe("captcha");
    expect(verifyReason(403, "session cookie is invalid or expired")).toBe("expired");
    expect(verifyReason(429, "Just a moment…")).toBe("captcha"); // Cloudflare masquerading as 429
    expect(verifyReason(403, "region blocked")).toBe(null); // must NOT raise a browser
    expect(verifyReason(429, "daily quota exhausted")).toBe(null);
    expect(verifyReason(200, "captcha")).toBe(null);
    expect(isVerifyChallenge("cf_chl_opt")).toBe(true);
    expect(isExpiredSession("Re-paste your sso cookie value")).toBe(true);
  });

  it("opens the provider's login window on the right profile", async () => {
    expect(maybeOpenVerifyWindow(args())).toBe(true);
    await settle();
    expect(webLogin.startWebLogin).toHaveBeenCalledWith("doubao-web", "work");
  });

  it("does NOT open when the 403 body has no challenge or expiry", async () => {
    maybeOpenVerifyWindow({ ...args(), response: res("insufficient quota", 403) });
    await settle();
    expect(webLogin.startWebLogin).not.toHaveBeenCalled();
  });

  it("opens on a bare 401 without reading the body", async () => {
    expect(maybeOpenVerifyWindow({ ...args(), response: res("nope", 401) })).toBe(true);
    await settle();
    expect(webLogin.startWebLogin).toHaveBeenCalled();
  });

  it("waits for Read key, then mirrors the saved cookie onto the challenged row", async () => {
    models.getProviderConnections.mockResolvedValue([{ id: "other-row", apiKey: "sessionid=NEW" }]);
    webLogin.getWebLoginStatus.mockReturnValue({
      status: "success",
      savedConnectionId: "other-row",
      context: {},
    });
    maybeOpenVerifyWindow(args());
    await new Promise((r) => setTimeout(r, 500)); // ~7 polls at the test interval
    expect(models.updateProviderConnection).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ apiKey: "sessionid=NEW", testStatus: "active", isActive: true }),
    );
    expect(webLogin.cancelWebLogin).toHaveBeenCalledWith("doubao-web");
  });

  it("does not mirror when the route already saved the challenged row itself", async () => {
    models.getProviderConnections.mockResolvedValue([{ id: "c1", apiKey: "sessionid=NEW" }]);
    webLogin.getWebLoginStatus.mockReturnValue({ status: "success", savedConnectionId: "c1", context: {} });
    maybeOpenVerifyWindow(args());
    await new Promise((r) => setTimeout(r, 500));
    expect(models.updateProviderConnection).not.toHaveBeenCalled();
    expect(webLogin.cancelWebLogin).toHaveBeenCalled();
  });

  it("rate-limits a second window for the same connection", async () => {
    expect(maybeOpenVerifyWindow(args())).toBe(true);
    await settle();
    expect(maybeOpenVerifyWindow(args())).toBe(false);
    expect(webLogin.startWebLogin).toHaveBeenCalledTimes(1);
  });

  it("is opt-out", () => {
    process.env.WEB_AUTO_VERIFY = "0";
    expect(autoVerifyEnabled()).toBe(false);
    delete process.env.WEB_AUTO_VERIFY;
    expect(autoVerifyEnabled()).toBe(true);
  });

  it("ignores providers with no login config and never rejects", () => {
    expect(maybeOpenVerifyWindow({ ...args(), provider: "not-a-provider" })).toBe(false);
    expect(() => maybeOpenVerifyWindow(args())).not.toThrow();
  });

  it("survives a launch failure instead of throwing at the caller", async () => {
    webLogin.startWebLogin.mockRejectedValueOnce(new Error("No Chrome/Chromium executable found"));
    maybeOpenVerifyWindow(args());
    await settle();
    expect(models.updateProviderConnection).not.toHaveBeenCalled();
  });
});
