/** Desktop plan projection — the daemon derives plan UI events from the single
 *  workspace repository and writes no plan file of its own. */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restorePlanForTab } from "../src/cli/commands/desktop.js";
import { planRepository } from "../src/code/plans.js";
import { sessionPlanPath } from "../src/memory/session.js";

let tempHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "reasonix-desktop-plan-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  rmSync(tempHome, { recursive: true, force: true });
});

const twoSteps = [
  { id: "step-1", title: "extract", action: "split tokens" },
  { id: "step-2", title: "rewire", action: "wire middleware" },
];

function tab(workspace: string): { rootDir: string } {
  return { rootDir: workspace };
}

function startPlan(workspace: string, body: string, steps = twoSteps) {
  const repo = planRepository(workspace);
  const plan = repo.propose(body, steps);
  repo.verdict(plan.id, "active");
  return { repo, plan };
}

describe("desktop plan projection", () => {
  it("builds the $plan_restored hydrate event from the repository's active plan", () => {
    const { repo, plan } = startPlan("s1", "# Body");
    repo.complete(plan.id, { kind: "step_completed", stepId: "step-1", result: "r1" });

    const ev = restorePlanForTab(tab("s1"), true);
    expect(ev?.type).toBe("$plan_restored");
    expect(ev?.steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
    expect(ev?.completedStepIds).toEqual(["step-1"]);
    expect(ev?.stepResults).toEqual({ "step-1": "r1" });
    expect(ev?.plan).toBe("# Body");
    expect(ev?.status).toBe("active");
  });

  it("writes no legacy plan.json — the repository is the only store", () => {
    const { repo, plan } = startPlan("s2", "body");
    repo.complete(plan.id, { kind: "step_completed", stepId: "step-1", result: "ok" });
    expect(existsSync(sessionPlanPath("s2"))).toBe(false);
    // The store lives under the workspace, not the session folder.
    expect(existsSync(planRepository("s2").path)).toBe(true);
  });

  it("returns null without a workspace or prior messages", () => {
    startPlan("s3", "b");
    expect(restorePlanForTab(tab(""), true)).toBeNull();
    expect(restorePlanForTab(tab("s3"), false)).toBeNull();
  });

  it("returns null when no plan is in flight (completed plans stay history only)", () => {
    const { repo, plan } = startPlan("s4", "b", [{ id: "step-1", title: "t", action: "a" }]);
    repo.complete(plan.id, { kind: "step_completed", stepId: "step-1", result: "done" });
    expect(repo.newestActivePlan()).toBeNull();
    expect(restorePlanForTab(tab("s4"), true)).toBeNull();
    // The completed attempt remains an inspectable history record.
    expect(repo.list()[0]?.status).toBe("completed");
  });

  it("scopes projection per workspace", () => {
    startPlan("ws-a", "A body", [{ id: "a-1", title: "ta", action: "x" }]);
    startPlan("ws-b", "B body", [
      { id: "b-1", title: "tb", action: "y" },
      { id: "b-2", title: "tb2", action: "z" },
    ]);

    expect(restorePlanForTab(tab("ws-a"), true)?.steps.map((s) => s.id)).toEqual(["a-1"]);
    expect(restorePlanForTab(tab("ws-b"), true)?.steps.map((s) => s.id)).toEqual(["b-1", "b-2"]);
    expect(restorePlanForTab(tab("ws-empty"), true)).toBeNull();
  });

  it("shares one history across sessions in the same workspace", () => {
    // Two independent sessions rooted at the same workspace read and write the
    // same store, so a plan started in one is visible from the other.
    const { plan } = startPlan("/repo/shared", "shared body", [
      { id: "step-1", title: "t", action: "a" },
    ]);
    const otherSession = planRepository("/repo/shared");
    expect(otherSession.open(plan.id).body).toBe("shared body");
    expect(otherSession.newestActivePlan()?.id).toBe(plan.id);
  });
});
