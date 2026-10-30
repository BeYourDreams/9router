// Backs the model picker's "Remove Missing" button for combos: a selected value is
// removed as soon as nothing in the client catalog claims it. No network probe —
// by request, an unlistable entry is deleted even if it still routes.
//
// Whitelist-by-default, because a false positive mass-deletes combo rows on one
// click: bare values, combo names, provider wildcards, custom/alias models and any
// passthrough or OpenAI/Anthropic-compatible relay are never reported. Known limits
// (measured 2026-10-30): the static registry lags upstream for the 17 providers that
// declare `modelsFetcher`, so live ids such as `glm-cn/glm-4.7-flash` and
// `nvidia/stepfun-ai/step-5-preview` read as missing here and ARE removed. Re-check
// against /api/models if that ever needs to be conservative again.
import { getModelsByProviderId, isValidModel } from "@/shared/constants/models";
import { getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, ALIAS_TO_ID } from "@/shared/constants/providers";

export function findMissingAddedValues(values, groups, {
  allProviders = {},
  combos = [],
  customModels = [],
  modelAliases = {},
} = {}) {
  // No catalog loaded yet (providers still resolving, or everything disconnected):
  // nothing can be disproved, so remove nothing.
  if (!groups || Object.keys(groups).length === 0) return [];

  const known = new Set();
  const permissive = new Set();
  const prefixes = new Set();

  for (const c of combos) if (c?.name) known.add(c.name);
  for (const m of customModels) if (m?.providerAlias && m?.id) known.add(`${m.providerAlias}/${m.id}`);
  for (const full of Object.values(modelAliases)) if (full) known.add(full);

  for (const [providerId, group] of Object.entries(groups)) {
    const alias = group.alias || getProviderAlias(providerId) || providerId;
    prefixes.add(alias);
    prefixes.add(providerId);
    for (const m of group.models || []) if (!m.isPlaceholder) known.add(m.value);
    // Whole static catalog for the same provider: a model stays "known" even when the
    // provider is disconnected or the entry was hidden by a disabled / enabledModels
    // preference — those are user prefs, not dead models.
    for (const m of getModelsByProviderId(providerId)) known.add(`${alias}/${m.id}`);
    if (allProviders[providerId]?.passthroughModels
      || isOpenAICompatibleProvider(alias) || isAnthropicCompatibleProvider(alias)
      || isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)) {
      permissive.add(alias);
      permissive.add(providerId);
    }
  }

  const catalogHas = (prefix, rest) => {
    // Combo values carry the display alias, but a catalog can be keyed by provider id
    // instead, so resolve the prefix both ways before calling a value missing.
    const candidates = new Set([prefix, ALIAS_TO_ID[prefix], getProviderAlias(prefix)]);
    for (const c of candidates) {
      if (!c) continue;
      if (isValidModel(c, rest)) return true;
      if (getModelsByProviderId(c).some((m) => m.id === rest)) return true;
    }
    return false;
  };

  const isKnown = (value) => {
    if (known.has(value)) return true;
    const slash = value.indexOf("/");
    // Bare values are combo names or provider-as-model ids; both are already in
    // `known`, and a stale bare entry is too risky to batch-remove.
    if (slash === -1) return true;
    const prefix = value.slice(0, slash);
    const rest = value.slice(slash + 1);
    // Passthrough / OpenAI- & Anthropic-compatible relays accept any model id.
    if (permissive.has(prefix)) return true;
    if (rest === "*" && prefixes.has(prefix)) return true;
    return catalogHas(prefix, rest);
  };

  return (Array.isArray(values) ? values : [])
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim())
    .filter((v) => !isKnown(v));
}
