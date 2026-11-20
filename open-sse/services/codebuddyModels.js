// CodeBuddy CN model discovery — the CLI agent's catalog is the same payload
// WorkBuddy reads from /console/enterprises/<id>/models. A static registry goes
// stale the moment Tencent ships a model, so both /v1/models and the dashboard
// provider page resolve it from the connection instead.
import { PROVIDERS } from "../config/providers.js";
import { refreshCodebuddyToken } from "./tokenRefresh.js";

const CN = PROVIDERS["codebuddy-cn"]; // transport itself, not { transport }

/** Keep only the models the CLI agent actually publishes, with their credits. */
export function parseCodeBuddyCnModels(payload) {
  const data = payload?.data || payload || {};
  const all = Array.isArray(data.models) ? data.models : [];
  const cliIds = data?.agents?.find?.((agent) => agent?.name === "cli")?.models;
  const ids = Array.isArray(cliIds) && cliIds.length ? cliIds : all.map((m) => m?.id);

  return ids
    .map((id) => all.find((m) => m?.id === id))
    .filter((m) => m && typeof m.id === "string" && m.id)
    .map((m) => {
      const credits = typeof m.credits === "string" ? m.credits.trim() : "";
      const name = String(m.name || m.id).trim();
      const model = {
        id: m.id,
        // Official client shows the multiplier next to the name; Kiro does the
        // same. Raw string keeps "x0.29 credits" exactly as upstream writes it.
        name: credits ? `${name} (${credits})` : name,
      };
      if (credits) {
        model.credits = credits;
        const rate = Number(credits.match(/x\s*(\d+(?:\.\d+)?)/i)?.[1]);
        if (Number.isFinite(rate)) model.rateMultiplier = rate;
      }
      return model;
    });
}

/** Resolve the live CN catalog for one connection; never throws. */
export async function resolveCodeBuddyCnModels(connection, { onCredentialsRefreshed, log } = {}) {
  const token = connection?.apiKey || connection?.accessToken;
  if (!token) return { models: [], warning: "CodeBuddy CN credential not available." };

  const enterpriseId = connection?.providerSpecificData?.enterpriseId || "personal";
  const url = new URL(`/console/enterprises/${encodeURIComponent(enterpriseId)}/models`, CN.baseUrl);
  const headers = {
    ...CN.headers,
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  const fetchCatalog = (accessToken) => fetch(url, {
    headers: { ...headers, Authorization: `Bearer ${accessToken}` },
  });

  try {
    let response = await fetchCatalog(token);
    if ((response.status === 401 || response.status === 403) && connection?.refreshToken) {
      const refreshed = await refreshCodebuddyToken(connection.refreshToken, log);
      if (refreshed?.accessToken) {
        await onCredentialsRefreshed?.(refreshed);
        response = await fetchCatalog(refreshed.accessToken);
      }
    }
    if (!response.ok) {
      return { models: [], warning: `CodeBuddy CN model catalog error (${response.status}).` };
    }
    const payload = await response.json();
    if (payload?.code && payload.code !== 0) {
      return { models: [], warning: `CodeBuddy CN catalog error: ${payload.msg || payload.code}` };
    }
    const models = parseCodeBuddyCnModels(payload);
    if (!models.length) return { models: [], warning: "CodeBuddy CN returned no models." };
    return { models };
  } catch (error) {
    console.log("Failed to fetch CodeBuddy CN models:", error.message);
    return { models: [], warning: `Failed to fetch CodeBuddy CN models: ${error.message}` };
  }
}
