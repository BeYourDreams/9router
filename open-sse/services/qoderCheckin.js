/**
 * Qoder daily credit claim (每日签到领 100 Credits).
 *
 * The IDE's growth-page campaigns live on the openapi host:
 *   GET  {openApi}/sash/api/v1/me/campaigns
 *   POST {openApi}/sash/api/v1/me/campaigns/{campaignId}/claim
 *
 * A daily campaign arrives with actionType "CLAIM_BENEFIT" and claimStatus
 * "CLAIMABLE" (100 credits, valid 30 days, resets 10:00 UTC+8); claiming it
 * flips the status to "CLAIMED", so a second run the same day is a no-op
 * rather than a double grant.
 *
 * Qoder publishes no docs for this endpoint — it was recovered from the
 * community script github.com/wallechfox/qoder-checkin.
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { qoderOpenApiBase, qoderRegionOf } from "../shared/qoder/constants.js";

const CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
const CLAIM_PATH = "/sash/api/v1/me/campaigns/{cid}/claim";

// The IDE tags its calls with Cosy-* headers; the campaign API only needs the
// client type (10 = desktop). The rest of the device fingerprint is optional.
const DEVICE_HEADERS = { "Cosy-ClientType": "10" };

function openApiBase(connection) {
  return qoderOpenApiBase(qoderRegionOf(connection?.provider));
}

function authHeaders(connection) {
  const token = connection?.accessToken || connection?.apiKey;
  if (!token) return null;
  return {
    Accept: "application/json",
    "User-Agent": "Qoder/1.0 (9router)",
    ...DEVICE_HEADERS,
    Authorization: `Bearer ${token}`,
  };
}

/** Normalize the campaign list: only what the claim flow needs. */
export function parseCampaigns(body) {
  const list = Array.isArray(body?.campaigns) ? body.campaigns : [];
  return list
    .filter((c) => c && typeof c === "object")
    .map((c) => ({
      campaignId: String(c.campaignId || ""),
      actionType: c.actionType || "",
      claimStatus: c.claimStatus || "",
      amount: Number(c.benefit?.amount) || 0,
      startAt: Number(c.startAt) || 0,
      endAt: Number(c.endAt) || 0,
    }))
    .filter((c) => c.campaignId);
}

/** Campaigns that can be claimed right now (daily credit drops). */
export function pickClaimable(campaigns) {
  return (campaigns || []).filter(
    (c) => c.actionType === "CLAIM_BENEFIT" && c.claimStatus === "CLAIMABLE",
  );
}

/** Campaigns already claimed inside their active window. */
export function pickClaimedToday(campaigns, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  return (campaigns || []).filter(
    (c) => c.actionType === "CLAIM_BENEFIT" && c.claimStatus === "CLAIMED"
      && (!c.startAt || c.startAt <= now) && (!c.endAt || now < c.endAt),
  );
}

/** List the account's campaigns. */
export async function getQoderCampaigns(connection, proxyOptions = null) {
  const headers = authHeaders(connection);
  if (!headers) return { ok: false, error: "no Qoder access token on this connection" };
  try {
    const res = await proxyAwareFetch(
      `${openApiBase(connection)}${CAMPAIGNS_PATH}`,
      { method: "GET", headers },
      proxyOptions,
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, authExpired: true, error: `Qoder campaigns returned ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, error: `Qoder campaigns returned ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    return { ok: true, campaigns: parseCampaigns(body) };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Claim one campaign. Idempotent upstream: a claimed id reports CLAIMED. */
export async function claimQoderCampaign(connection, campaignId, proxyOptions = null) {
  const headers = authHeaders(connection);
  if (!headers) return { ok: false, error: "no Qoder access token on this connection" };
  try {
    const res = await proxyAwareFetch(
      `${openApiBase(connection)}${CLAIM_PATH.replace("{cid}", encodeURIComponent(campaignId))}`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" },
      proxyOptions,
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, authExpired: true, error: `Qoder claim returned ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, error: `Qoder claim returned ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    const data = body?.data && typeof body.data === "object" ? body.data : body;
    return {
      ok: data?.status === "CLAIMED",
      status: data?.status || "",
      amount: Number(data?.benefit?.amount) || 0,
      error: data?.status === "CLAIMED" ? undefined : `claim status ${data?.status || "unknown"}`,
    };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Claim every claimable daily campaign of an account.
 * Returns { ok, claimed, credits, alreadyClaimed, error }.
 */
export async function claimQoderDailyCredits(connection, proxyOptions = null) {
  const list = await getQoderCampaigns(connection, proxyOptions);
  if (!list.ok) return { ok: false, claimed: 0, credits: 0, error: list.error, authExpired: list.authExpired === true };

  const claimable = pickClaimable(list.campaigns);
  if (claimable.length === 0) {
    return {
      ok: true,
      claimed: 0,
      credits: 0,
      alreadyClaimed: pickClaimedToday(list.campaigns).length > 0,
      campaigns: list.campaigns,
    };
  }

  let claimed = 0;
  let credits = 0;
  let error;
  for (const campaign of claimable) {
    const res = await claimQoderCampaign(connection, campaign.campaignId, proxyOptions);
    if (res.ok) {
      claimed += 1;
      credits += res.amount || campaign.amount || 0;
    } else if (res.authExpired) {
      return { ok: false, claimed, credits, error: res.error, authExpired: true };
    } else {
      error = res.error;
    }
  }
  return { ok: !error, claimed, credits, error, campaigns: list.campaigns };
}
