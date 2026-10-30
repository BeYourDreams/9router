import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel } from "@/models";
import { getCombos, updateCombo } from "@/lib/localDb";
import { CAPACITY_META, isSttTransport } from "@/shared/constants/models";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// Accepted STT transport markers live in the shared whitelist
// (src/shared/constants/models STT_TRANSPORT_META) — the dashboard transport
// select and this validator must agree on one set, so neither owns a copy.
// Unknown or mistyped values are silently dropped, the same policy
// sanitizeCaps applies to capability keys.
function sanitizeTransport(transport, type) {
  if (type !== "stt" || !isSttTransport(transport)) return null;
  return transport.trim();
}

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model(s)
// Body takes either a single { providerAlias, id, ... } or a bulk { providerAlias, type, ids: [...] }.
export async function POST(request) {
  try {
    const body = await request.json();
    const { providerAlias, name, caps, transport, type = "llm" } = body;
    const ids = Array.isArray(body.ids) ? body.ids : [body.id];
    if (!providerAlias || ids.length === 0 || ids.some((id) => !id || typeof id !== "string")) {
      return NextResponse.json({ error: "providerAlias and id (or ids[]) required" }, { status: 400 });
    }
    const cleanCaps = sanitizeCaps(caps);
    const cleanTransport = sanitizeTransport(transport, type);
    let added = 0;
    for (const id of [...new Set(ids)]) {
      // `name` only makes sense for a single model; a bulk import keeps id-as-name.
      const rowName = ids.length === 1 ? name : undefined;
      const ok = await addCustomModel({ providerAlias, id, type, name: rowName, ...(cleanCaps ? { caps: cleanCaps } : {}), ...(cleanTransport ? { transport: cleanTransport } : {}) });
      if (ok) added += 1;
    }
    return NextResponse.json({ success: true, added, count: ids.length });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
// Bulk: same URL, JSON body { ids: [...] }.
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias) {
      return NextResponse.json({ error: "providerAlias and id (or ids[]) required" }, { status: 400 });
    }
    let body = null;
    try { body = await request.json(); } catch { /* no body — single delete via query */ }
    const ids = Array.isArray(body?.ids) ? body.ids : [searchParams.get("id")];
    if (ids.some((id) => !id || typeof id !== "string")) {
      return NextResponse.json({ error: "providerAlias and id (or ids[]) required" }, { status: 400 });
    }

    const removedModels = [];
    for (const id of [...new Set(ids)]) {
      await deleteCustomModel({ providerAlias, id, type });
      removedModels.push(`${providerAlias}/${id}`);
    }

    // Sync: strip the removed provider-internal models from any combo that referenced them.
    // One pass over combos for the whole batch instead of one per model.
    const removed = new Set(removedModels);
    const combos = await getCombos();
    for (const combo of combos) {
      const models = combo.models || [];
      const next = models.filter((m) => !removed.has(m));
      if (next.length !== models.length) {
        await updateCombo(combo.id, { models: next });
      }
    }
    return NextResponse.json({ success: true, removed: removedModels.length });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
