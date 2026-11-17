// The Qoder card used to render no quota rows at all for an account whose
// plan bucket is empty (userQuota 0/0, no add-on grant): parseQuotaData dropped
// every 0-total bucket. The personal row stays now, so an empty plan reads as
// "No credits" instead of a blank card; org/add-on still dropped at 0.
import { describe, expect, it } from "vitest";

import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("qoder quota rows", () => {
  it("keeps the empty personal row", () => {
    const rows = parseQuotaData("qoder", {
      quotas: {
        user: { total: 0, used: 0, remaining: 0, unit: "credits", resetAt: null, neverExpires: true },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Personal",
      used: 0,
      total: 0,
      unit: "credits",
      remainingPercentage: 0,
      emptyMessage: "No credits",
    });
  });

  it("renders a funded plan and add-on unchanged", () => {
    const rows = parseQuotaData("qoder-cn", {
      quotas: {
        user: { total: 1100, used: 100, remaining: 1000, unit: "credits", resetAt: "2026-12-01T00:00:00.000Z" },
        addOn: { total: 2200, used: 0, remaining: 2200, unit: "credits", detailUrl: "https://qoder.com.cn/usage" },
      },
    });
    expect(rows.map((r) => r.name)).toEqual(["Personal", "Add-on"]);
    expect(rows[0]).toMatchObject({ used: 100, total: 1100, resetAt: "2026-12-01T00:00:00.000Z" });
    expect(rows[0].emptyMessage).toBeUndefined();
    expect(rows[1]).toMatchObject({ name: "Add-on", total: 2200, detailUrl: "https://qoder.com.cn/usage" });
  });
});
