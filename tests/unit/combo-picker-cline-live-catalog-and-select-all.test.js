// ModelSelectModal regressions, checked on source text (the component is JSX, so
// this suite has no React transform — same approach as
// kenari-deepseek-vision-zed-modal.test.js).
//
// 1. Cline/ClinePass must not be overridden by the live per-account catalog: their
//    provider page curates the catalog with "Import from /models", so pushing the
//    whole live feed into the picker resurrected every model the user deleted.
//    Cursor/Zed keep the live override because their page renders it too.
// 2. "Select All" must really select all. Looping the per-model onSelect reads a
//    list snapshot captured before the loop (state and props both stay stale), so
//    every bulk consumer now wires onSelectBatch/onDeselectBatch = one update.

import fs from "fs";

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf-8");

const MODAL = "src/shared/components/ModelSelectModal.js";
const src = read(MODAL);

const liveCatalogConst = () => {
  const match = src.match(/const LIVE_CATALOG_PROVIDERS\s*=\s*\[([^\]]*)\]/);
  expect(match).toBeTruthy();
  return match[1];
};

describe("ModelSelectModal live catalog scope", () => {
  it("keeps cursor and zed (their provider page renders the live catalog)", () => {
    const list = liveCatalogConst();
    expect(list).toContain('"cursor"');
    expect(list).toContain('"zed"');
  });

  it("drops cline / clinepass so provider-page deletions stick in the picker", () => {
    const list = liveCatalogConst();
    expect(list).not.toContain("cline");
    expect(src).not.toContain("clineModels");
    expect(src).not.toContain("clinepassModels");
  });

  it("still falls back to the static registry + imported models for cline", () => {
    expect(src).toContain("getModelsByProviderId(providerId)");
    expect(src).toContain("customRegisteredModels");
  });
});

// Every picker opened with closeOnSelect={false} shows the Select All / Deselect
// All bar. Without batch handlers the modal falls back to onSelect-in-a-loop,
// which is a known data-loss bug (only the last item survives).
describe("select all is a real batch", () => {
  const CONSUMERS = [
    "src/shared/components/ComboFormModal.js",
    "src/app/(dashboard)/dashboard/combos/page.js",
    "src/app/(dashboard)/dashboard/media-providers/combo/[id]/page.js",
    "src/app/(dashboard)/dashboard/endpoint/components/KeyAccessControls.js",
    "src/app/(dashboard)/dashboard/cli-tools/components/CopilotToolCard.js",
    "src/app/(dashboard)/dashboard/cli-tools/components/OpenCodeToolCard.js",
    "src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js",
  ];

  it("prefers the batch callback when a consumer provides one", () => {
    expect(src).toMatch(/if \(onSelectBatch\) \{\s*\n\s*onSelectBatch\(visibleUnadded\);/);
    expect(src).toMatch(/if \(onDeselectBatch\) \{\s*\n\s*onDeselectBatch\(visibleAdded\);/);
  });

  it.each(CONSUMERS)("%s wires batch handlers", (rel) => {
    const file = read(rel);
    // Split per <ModelSelectModal ... /> usage; only multi-select ones must batch.
    const usages = file.split("<ModelSelectModal").slice(1);
    const multi = usages.filter((u) => u.includes("closeOnSelect={false}"));
    expect(multi.length).toBeGreaterThan(0);
    for (const usage of multi) {
      expect(usage).toContain("onSelectBatch");
      expect(usage).toContain("onDeselectBatch");
    }
  });
});

// The contract onSelectBatch implementations rely on: accumulate from the running
// list, dedupe, keep any "never empty" floor.
describe("batch handler contract", () => {
  const applyBatch = (prev, items) => {
    const values = (items || []).map((m) => m?.value || m?.name || m).filter(Boolean);
    return [...new Set([...prev, ...values])];
  };

  it("adds every picked model exactly once", () => {
    expect(applyBatch(["a/keep"], [{ value: "cl/a" }, { value: "cl/b" }, { value: "cl/a" }])).toEqual([
      "a/keep",
      "cl/a",
      "cl/b",
    ]);
  });

  it("leaves the list untouched when everything is already added", () => {
    expect(applyBatch(["cl/a"], [{ value: "cl/a" }])).toEqual(["cl/a"]);
  });
});
