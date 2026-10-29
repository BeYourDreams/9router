import { NextResponse } from "next/server";
import { createProviderConnection, deleteProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getWebLoginConfig } from "open-sse/services/webLoginConfig.js";
import { fetchWebIdentity } from "open-sse/services/webIdentity.js";

/**
 * POST /api/providers/web-login/token
 * { provider, token } → save connection using token from current browser
 *
 * Bypasses Playwright browser launch. Used by "Current Browser" mode where
 * the user logs in manually and extracts the token via bookmarklet.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { provider, token } = body;

    if (!provider || !token) {
      return NextResponse.json({ error: "Missing provider or token" }, { status: 400 });
    }

    const config = getWebLoginConfig(provider);
    if (!config) {
      return NextResponse.json({ error: `No web-login config for provider "${provider}"` }, { status: 400 });
    }

    // Validate the token with the provider's identity probe
    const identity = await fetchWebIdentity(provider, token);
    if (identity.status === "invalid") {
      return NextResponse.json({ error: identity.error || "The captured session was rejected" }, { status: 401 });
    }

    const providerName = AI_PROVIDERS[provider]?.name || provider;
    const email = identity.email || "";
    const name = email || providerName;
    const providerSpecificData = {
      authMethod: "web-login",
      ...(config?.credentialFrom === "localStorageValue" ? { tokenSource: "localStorage" } : {}),
    };

    // Re-login refreshes the credential in place. Match by account email.
    const webLoginRows = (await getProviderConnections({ provider }))
      .filter((c) => c.providerSpecificData?.authMethod === "web-login")
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    const existing = email
      ? webLoginRows.find((c) => c.email === email)
      : webLoginRows.length === 1 ? webLoginRows[0] : null;

    if (existing) {
      const updated = await updateProviderConnection(existing.id, {
        apiKey: token,
        name,
        email: email || existing.email || null,
        providerSpecificData: { ...existing.providerSpecificData, ...providerSpecificData },
        testStatus: "active",
        lastError: null,
        lastErrorAt: null,
        isActive: true,
      });
      // Same account logged in twice used to leave a stale duplicate row.
      for (const duplicate of webLoginRows) {
        if (duplicate.id === existing.id || duplicate.email !== email || !email) continue;
        await deleteProviderConnection(duplicate.id);
      }
    } else {
      await createProviderConnection({
        provider,
        authType: "cookie",
        name,
        email: email || null,
        apiKey: token,
        priority: 1,
        providerSpecificData,
        isActive: true,
        testStatus: "active",
        allowOverwrite: false,
      });
    }

    return NextResponse.json({ ok: true, email: identity.email || "" });
  } catch (error) {
    return NextResponse.json(
      { error: error?.code === "PROVIDER_NAME_CONFLICT"
        ? `A connection named "${error.existingName}" already exists — edit or delete it first`
        : error?.message || "Failed to save connection" },
      { status: 500 }
    );
  }
}