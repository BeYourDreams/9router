// MossAI (mossai.cc) was removed: its web access token could not complete the
// daily check-in claim, so the provider is gone from the registry, the usage
// dispatcher, the daily check-in families and the quota tracker. Any account of
// it left in a database is dead weight (see the one-off cleanup in tmp/).
import { describe, expect, it } from "vitest";

import { AI_PROVIDERS, USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS, getProviderByAlias } from "../../src/shared/constants/providers.js";
import { AUTO_SIGNIN_CONFIGS, AUTO_SIGNIN_AUTH_TYPES } from "../../src/shared/constants/config.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";

describe("mossai provider removed", () => {
  it("is no longer a registered provider", () => {
    expect(Object.keys(AI_PROVIDERS)).not.toContain("mossai");
    expect(getProviderByAlias("mossai")).toBeFalsy();
  });

  it("is out of the quota tracker and the usage dispatcher", async () => {
    expect(USAGE_SUPPORTED_PROVIDERS).not.toContain("mossai");
    expect(USAGE_APIKEY_PROVIDERS).not.toContain("mossai");
    const result = await getUsageForProvider({ provider: "mossai", apiKey: "sk-test" });
    expect(result.message).toBe("Usage API not implemented for mossai");
  });

  it("is out of the daily check-in families", () => {
    expect(AUTO_SIGNIN_CONFIGS.map((c) => c.settingsKey)).not.toContain("mossaiAutoSignin");
    expect(AUTO_SIGNIN_AUTH_TYPES).not.toHaveProperty("mossai");
  });
});
