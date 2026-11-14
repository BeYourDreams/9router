/**
 * Free-tier detection for the OpenCode lanes (oc / ocfv2 / ocz / oczv2).
 * Upstream marks the free tier with a "-free" id suffix; one id never carries it
 * (big-pickle), and one used to be dead upstream (deepseek-v4-flash-free).
 */
const KNOWN_FREE = new Set(["big-pickle"]);
const DEAD_FREE = new Set(["deepseek-v4-flash-free"]);
const FREE_SUFFIX_RE = /[-.:/]free$/i;

// The four OpenCode lanes. opencode-zen-v2 reuses opencode-zen's catalogue.
export const OPENCODE_FREE_PROVIDER_IDS = [
  "opencode",
  "opencode-free-v2",
  "opencode-zen",
  "opencode-zen-v2",
];

export function isFreeModelId(id) {
  if (typeof id !== "string" || !id || DEAD_FREE.has(id)) return false;
  return FREE_SUFFIX_RE.test(id) || KNOWN_FREE.has(id);
}

/**
 * Free models inside buildModelGroups()/ModelSelectModal-shaped groups, as
 * { id, value } pairs — value ("alias/model-id") is what callers add. Optional
 * providerIds narrows to those lanes (groups are keyed by provider id).
 */
export function collectFreeModelIds(groups, providerIds) {
  const allowed = providerIds ? new Set(providerIds) : null;
  const out = [];
  const seen = new Set();
  Object.entries(groups || {}).forEach(([providerId, group]) => {
    if (allowed && !allowed.has(providerId)) return;
    const models = Array.isArray(group?.models) ? group.models : [];
    models.forEach((model) => {
      const id = model?.id;
      const value = model?.value;
      if (!id || !value || seen.has(value) || !isFreeModelId(id)) return;
      seen.add(value);
      out.push({ id, value });
    });
  });
  return out;
}