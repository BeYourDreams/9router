// Guard for src/shared/utils/modelCatalogLookup.js, which backs the model picker's
// "Remove Missing" button for combos. The button deletes on the catalog verdict alone
// (no network probe), so these cases pin the boundary between "unlistable" (deleted)
// and the shapes that must never be swept up by a one-click remove.

import { PROVIDER_MODELS, getModelsByProviderId } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { findMissingAddedValues } from "@/shared/utils/modelCatalogLookup";

const ALIAS = Object.keys(PROVIDER_MODELS).find(
  (a) => (PROVIDER_MODELS[a] || []).length > 1 && AI_PROVIDERS[a]?.id === a,
);
const REAL_ID = PROVIDER_MODELS[ALIAS][0].id;
const SECOND_REAL_ID = PROVIDER_MODELS[ALIAS][1].id;

// A provider whose storage id differs from its display alias, so the id/alias
// resolution path is exercised with real data instead of a guessed fixture.
const RENAMED = Object.keys(AI_PROVIDERS).find(
  (id) => AI_PROVIDERS[id].alias && AI_PROVIDERS[id].alias !== id && (PROVIDER_MODELS[id] || []).length > 0,
);
const RENAMED_ALIAS = RENAMED && getProviderAlias(RENAMED);
const RENAMED_ID = RENAMED && PROVIDER_MODELS[RENAMED][0].id;

const PT = Object.entries(AI_PROVIDERS).find(([, p]) => p.passthroughModels);
const PT_ID = PT?.[0];
const PT_ALIAS = PT?.[1].alias || PT_ID;

const groupsFor = (alias, models) => ({ [alias]: { alias, models } });
const groups = groupsFor(ALIAS, [
  { id: REAL_ID, value: `${ALIAS}/${REAL_ID}` },
  { id: SECOND_REAL_ID, value: `${ALIAS}/${SECOND_REAL_ID}` },
]);
const allProviders = PT_ID ? { [PT_ID]: { passthroughModels: true } } : {};

const call = (values, extra = {}) =>
  findMissingAddedValues(values, groups, { allProviders, ...extra });

describe("findMissingAddedValues", () => {
  it("keeps models the picker lists", () => {
    expect(call([`${ALIAS}/${REAL_ID}`, `${ALIAS}/${SECOND_REAL_ID}`])).toEqual([]);
  });

  it("keeps a catalog model the picker hid (disabled / enabledModels whitelist)", () => {
    const hidden = groupsFor(ALIAS, [{ id: REAL_ID, value: `${ALIAS}/${REAL_ID}` }]);
    expect(findMissingAddedValues([`${ALIAS}/${SECOND_REAL_ID}`], hidden, { allProviders })).toEqual([]);
  });

  it("keeps a model of a provider absent from the picker entirely (disconnected)", () => {
    const other = Object.keys(PROVIDER_MODELS).find(
      (a) => a !== ALIAS && (PROVIDER_MODELS[a] || []).length > 0 && AI_PROVIDERS[a],
    );
    expect(call([`${other}/${PROVIDER_MODELS[other][0].id}`])).toEqual([]);
  });

  it("keeps a model addressed by storage id under a non-alias provider (id != alias)", () => {
    expect(RENAMED).toBeTruthy();
    expect(RENAMED_ALIAS).not.toBe(RENAMED);
    expect(call([`${RENAMED}/${RENAMED_ID}`, `${RENAMED_ALIAS}/${RENAMED_ID}`])).toEqual([]);
  });

  it("keeps combo names, bare values, wildcards, custom and alias models", () => {
    expect(call([
      "my-combo",
      "some-bare-thing",
      `${ALIAS}/*`,
      `${ALIAS}/my-custom`,
      `${ALIAS}/${REAL_ID}`,
    ], {
      combos: [{ name: "my-combo" }],
      customModels: [{ providerAlias: ALIAS, id: "my-custom" }],
      modelAliases: { nice: `${ALIAS}/${REAL_ID}` },
    })).toEqual([]);
  });

  it("keeps any id under a passthrough provider", () => {
    if (!PT_ID) return;
    expect(call([`${PT_ALIAS}/who-knows`, `${PT_ID}/who-knows`])).toEqual([]);
  });

  it("reports a prefixed id that nothing can claim", () => {
    const bogus = `${ALIAS}/definitely-not-a-model-${Date.now()}`;
    expect(call([bogus])).toEqual([bogus]);
  });

  it("ignores blanks and non-strings instead of treating them as missing", () => {
    expect(call([null, undefined, 42, "", "  "])).toEqual([]);
  });

  it("trims before comparing", () => {
    expect(call([`  ${ALIAS}/${REAL_ID}  `])).toEqual([]);
  });

  it("reports nothing when the catalog is empty (never wipes a whole combo)", () => {
    expect(findMissingAddedValues([`${ALIAS}/${REAL_ID}`], {}, { allProviders })).toEqual([]);
    expect(findMissingAddedValues([`${ALIAS}/${REAL_ID}`], null, { allProviders })).toEqual([]);
  });

  it("documents the accepted false positive: registry lag deletes live models", () => {
    // Measured 2026-10-30 against the running router: both returned HTTP 200 while
    // absent from the static registry (providers with `modelsFetcher` lag upstream).
    // Per product decision the button deletes them anyway, so this asserts the
    // behavior rather than defending against it — flip it if a probe is ever added.
    const live = ["glm-cn/glm-4.7-flash", "nvidia/stepfun-ai/step-5-preview"];
    for (const value of live) {
      const alias = value.slice(0, value.indexOf("/"));
      const id = value.slice(value.indexOf("/") + 1);
      expect(getModelsByProviderId(alias).some((m) => m.id === id)).toBe(false);
    }
    expect(call(live)).toEqual(live);
  });
});
