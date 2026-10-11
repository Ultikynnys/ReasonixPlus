// Background-job Close/Stop routing: pickJobOwner must target the owning tab.
// Job ids restart at 1 in every per-tab registry, so a global first-match can
// land on another tab's (often already-exited) job and the stop silently no-ops.

import { describe, expect, it } from "vitest";
import { pickJobOwner } from "../src/cli/commands/desktop.js";

function owner(tabId: string, ids: number[]) {
  return { tabId, jobIds: new Set(ids), owner: { tabId } };
}

describe("pickJobOwner (jobs_stop targets the owning tab)", () => {
  it("prefers the named tab when the job id collides across tabs", () => {
    const a = owner("A", [7]);
    const b = owner("B", [7]);
    expect(pickJobOwner([a, b], 7, "B")).toBe(b.owner);
    expect(pickJobOwner([a, b], 7, "A")).toBe(a.owner);
  });

  it("keeps first-match when no tab is supplied (legacy callers)", () => {
    const a = owner("A", [7]);
    const b = owner("B", [7]);
    expect(pickJobOwner([a, b], 7, undefined)).toBe(a.owner);
  });

  it("returns nothing for an unknown tab or a missing job id", () => {
    const owners = [owner("A", [1, 2]), owner("B", [3])];
    expect(pickJobOwner(owners, 3, "A")).toBeUndefined();
    expect(pickJobOwner(owners, 9, undefined)).toBeUndefined();
  });
});
