/** Desktop plan projection — the stored claim only reaches the wire as an owner
 *  while the plan is still being worked. */

import { describe, expect, it } from "vitest";
import type { PlanSummary } from "../src/code/plans.js";
import { toPlanHistoryItems } from "../src/desktop/plan-listing.js";

function summary(status: string, session?: string): PlanSummary {
  const plan = {
    id: `plan-${status}-${session ?? "none"}`,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    totalSteps: 2,
    completedSteps: 0,
  } as PlanSummary;
  if (session) plan.claim = { session, pid: 1, since: "2026-01-01T00:00:00.000Z" };
  return plan;
}

describe("toPlanHistoryItems", () => {
  it("projects the owner of a plan a session is still working", () => {
    const [active, proposed] = toPlanHistoryItems([
      summary("active", "session-a"),
      summary("proposed", "session-b"),
    ]);
    expect(active?.ownerSession).toBe("session-a");
    expect(proposed?.ownerSession).toBe("session-b");
  });

  it("never projects an owner for a closed plan, whatever claim it carries", () => {
    const items = toPlanHistoryItems(
      ["completed", "cancelled", "abandoned", "superseded", "refinement_requested"].map((status) =>
        summary(status, "session-a"),
      ),
    );
    expect(items.map((item) => item.ownerSession)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // The internal claim is stripped either way, so no surface can re-derive one.
    expect(items.every((item) => !("claim" in item))).toBe(true);
  });

  it("leaves an in-flight plan unowned when no session claimed it", () => {
    const [item] = toPlanHistoryItems([summary("active")]);
    expect(item?.ownerSession).toBeUndefined();
    expect(item?.status).toBe("active");
  });
});
