// Bulk daily check-in switch (每日自动签到) for the quota page master toggle.
//
// The quota page fetches connections *paginated* (/api/providers/client, 20 per
// page), so the browser never holds the full account list. Turning check-in on
// "for everything" from that page could therefore only ever reach the visible
// page. This endpoint does the fan-out server-side against the complete
// connection table, and persists the result to settings (SQLite), so the switch
// survives a browser change, a private window, or a fresh install — unlike a
// localStorage flag.
//
//   GET                    -> { on, partial, total, optedIn, byFamily }
//   PUT { on: boolean }    -> the same summary, after persisting
//
// Eligibility is the shared isAutoSigninEligibleConnection rule, so the server
// and the per-card toggles on the dashboard can never disagree.

import { NextResponse } from "next/server";
import { getSettings, getProviderConnections, updateSettings } from "@/lib/localDb";
import { summarizeAutoSignin, buildAutoSigninPatch } from "@/shared/services/autoSigninBulk";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RESPONSE_HEADERS = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const [settings, connections] = await Promise.all([getSettings(), getProviderConnections()]);
    return NextResponse.json(summarizeAutoSignin(connections, settings), { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error reading auto check-in state:", error);
    return NextResponse.json({ error: "Failed to read auto check-in state" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.on !== "boolean") {
      return NextResponse.json({ error: "`on` must be a boolean" }, { status: 400 });
    }

    const [settings, connections] = await Promise.all([getSettings(), getProviderConnections()]);
    const patch = buildAutoSigninPatch(connections, settings, body.on);
    if (Object.keys(patch).length === 0) {
      // Nothing eligible: report the (unchanged) state rather than a silent no-op.
      return NextResponse.json(summarizeAutoSignin(connections, settings), { headers: RESPONSE_HEADERS });
    }

    const saved = await updateSettings(patch);

    // Load / unload each scheduler to match the new opt-in set. Mirrors what
    // PATCH /api/settings does for a single family, so the master switch starts
    // the hourly tick immediately instead of waiting for a restart.
    if (patch.minimaxAutoSignin) {
      import("@/shared/services/minimaxAutoSignin")
        .then(({ configureMiniMaxAutoSignin }) => configureMiniMaxAutoSignin(saved))
        .catch((e) => console.warn("[AutoSignin] bulk configure failed:", e.message));
    }
    if (patch.codebuddyAutoSignin) {
      import("@/shared/services/codebuddyAutoSignin")
        .then(({ configureCodeBuddyAutoSignin }) => configureCodeBuddyAutoSignin(saved))
        .catch((e) => console.warn("[CodeBuddySignin] bulk configure failed:", e.message));
    }
    if (patch.modelscopeAutoSignin) {
      import("@/shared/services/modelscopeAutoSignin")
        .then(({ configureModelScopeAutoSignin }) => configureModelScopeAutoSignin(saved))
        .catch((e) => console.warn("[ModelScopeLogin] bulk configure failed:", e.message));
    }

    return NextResponse.json(summarizeAutoSignin(connections, saved), { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating auto check-in state:", error);
    return NextResponse.json({ error: "Failed to update auto check-in state" }, { status: 500 });
  }
}
