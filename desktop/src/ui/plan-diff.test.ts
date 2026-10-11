import { describe, expect, it } from "vitest";
import { countPlanStepDiff, diffPlanSteps } from "./plan-diff";

function step(
  id: string,
  title: string,
  action = `${title} action`,
  risk?: "low" | "med" | "high",
): { id: string; title: string; action: string; risk?: "low" | "med" | "high" } {
  return { id, title, action, risk };
}

describe("diffPlanSteps", () => {
  it("marks an id that only appears in the new list as added", () => {
    const rows = diffPlanSteps([step("s1", "One")], [step("s1", "One"), step("s2", "Two")]);
    expect(rows.map((r) => r.kind)).toEqual(["unchanged", "added"]);
    expect(rows[1]?.step.id).toBe("s2");
  });

  it("reports changed fields with before and after values", () => {
    const rows = diffPlanSteps(
      [step("s1", "One", "do one", "low")],
      [step("s1", "One!", "do one", "high")],
    );
    expect(rows[0]?.kind).toBe("changed");
    expect(rows[0]?.fields).toEqual([
      { field: "title", from: "One", to: "One!" },
      { field: "risk", from: "low", to: "high" },
    ]);
  });

  it("appends a dropped id as removed after the surviving steps", () => {
    const rows = diffPlanSteps([step("s1", "One"), step("s2", "Two")], [step("s1", "One")]);
    expect(rows.map((r) => r.kind)).toEqual(["unchanged", "removed"]);
    expect(rows[1]?.step.id).toBe("s2");
  });

  it("treats an unset risk as low so adding an explicit low is not churn", () => {
    const rows = diffPlanSteps([step("s1", "One")], [step("s1", "One", "One action", "low")]);
    expect(rows[0]?.kind).toBe("unchanged");
  });

  it("counts each change kind across the rewrite", () => {
    const rows = diffPlanSteps(
      [step("s1", "One"), step("s2", "Two")],
      [step("s1", "One!"), step("s3", "Three")],
    );
    expect(countPlanStepDiff(rows)).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 0 });
  });
});
