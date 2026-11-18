import { NextResponse } from "next/server";
import { getComboByName } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";

export const dynamic = "force-dynamic";

// POST /api/combos/reset - Drop the combo's in-memory ordering state (sticky
// fallback pointer, round-robin index, smart session lock) so the next request
// starts again at the first model of the combo's list. Without a name, resets
// every combo (the dashboard's single "Reset All" button).
export async function POST(request) {
  try {
    const { name } = await request.json();
    if (!name) {
      resetComboRotation();
      return NextResponse.json({ success: true, all: true });
    }

    const combo = await getComboByName(name);
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    resetComboRotation(combo.name);
    return NextResponse.json({ success: true, name: combo.name });
  } catch (error) {
    console.log("Error resetting combo order:", error);
    return NextResponse.json({ error: "Failed to reset combo order" }, { status: 500 });
  }
}
