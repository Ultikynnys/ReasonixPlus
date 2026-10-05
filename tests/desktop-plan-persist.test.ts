/** Desktop plan persistence — the daemon helpers that write/restore plan.json.
 *  Points HOME at a temp dir so the real ~/.reasonix is never touched. */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PlanTrackingTab,
  adoptProposedPlan,
  applyPlanRevision,
  archivePlanForTab,
  clearPlanForTab,
  persistPlanState,
  recordPlanStepCompletion,
  restorePlanForTab,
} from "../src/cli/commands/desktop.js";
import { listPlanArchives, loadPlanState, planStatePath } from "../src/code/plan-store.js";

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

function makeTab(session: string): PlanTrackingTab {
  return {
    currentSession: session,
    planSteps: [],
    planBody: null,
    planSummary: null,
    completedStepIds: new Set<string>(),
    planTotalSteps: 0,
    planStepCompletions: new Map(),
    planPendingRevisionSteps: null,
  };
}

const twoSteps = [
  { id: "step-1", title: "extract", action: "split tokens" },
  { id: "step-2", title: "rewire", action: "wire middleware" },
];

describe("desktop plan persistence helpers", () => {
  it("persists steps, progress, body and summary on approval", () => {
    const tab = makeTab("s1");
    adoptProposedPlan(tab, { plan: "# Body", summary: "Do X", steps: twoSteps });
    recordPlanStepCompletion(tab, { stepId: "step-1", result: "done-1", title: "extract" });
    persistPlanState(tab);

    const loaded = loadPlanState("s1");
    expect(loaded?.steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
    expect(loaded?.completedStepIds).toEqual(["step-1"]);
    expect(loaded?.body).toBe("# Body");
    expect(loaded?.summary).toBe("Do X");
    expect(loaded?.stepCompletions?.["step-1"]?.result).toBe("done-1");
    expect(tab.planTotalSteps).toBe(2);
  });

  it("no-ops for a pure-markdown plan with no steps", () => {
    const tab = makeTab("s2");
    adoptProposedPlan(tab, { plan: "just prose, no checklist" });
    persistPlanState(tab);
    expect(loadPlanState("s2")).toBeNull();
    expect(existsSync(planStatePath("s2"))).toBe(false);
  });

  it("archives a completed plan and resets the tab", () => {
    const tab = makeTab("s3");
    adoptProposedPlan(tab, { plan: "body", steps: [{ id: "step-1", title: "t", action: "a" }] });
    recordPlanStepCompletion(tab, { stepId: "step-1", result: "ok" });
    persistPlanState(tab);
    archivePlanForTab(tab);

    expect(loadPlanState("s3")).toBeNull();
    expect(existsSync(planStatePath("s3"))).toBe(false);
    const archives = listPlanArchives("s3");
    expect(archives).toHaveLength(1);
    expect(archives[0]?.completedStepIds).toEqual(["step-1"]);
    expect(tab.planSteps).toHaveLength(0);
    expect(tab.planTotalSteps).toBe(0);
  });

  it("clears plan.json without archiving on cancel", () => {
    const tab = makeTab("s4");
    adoptProposedPlan(tab, { plan: "body", steps: [{ id: "step-1", title: "t", action: "a" }] });
    persistPlanState(tab);
    clearPlanForTab(tab);

    expect(loadPlanState("s4")).toBeNull();
    expect(listPlanArchives("s4")).toHaveLength(0);
  });

  it("restores the active plan into a fresh tab and returns the hydrate event", () => {
    const tab = makeTab("s5");
    adoptProposedPlan(tab, {
      plan: "# Body",
      summary: "Resume me",
      steps: twoSteps,
    });
    recordPlanStepCompletion(tab, { stepId: "step-1", result: "r1" });
    persistPlanState(tab);

    const fresh = makeTab("s5");
    const ev = restorePlanForTab(fresh, true);
    expect(ev?.type).toBe("$plan_restored");
    expect(ev?.steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
    expect(ev?.completedStepIds).toEqual(["step-1"]);
    expect(ev?.stepResults).toEqual({ "step-1": "r1" });
    expect(ev?.plan).toBe("# Body");
    expect(ev?.summary).toBe("Resume me");
    expect(fresh.completedStepIds.has("step-1")).toBe(true);
    expect(fresh.planTotalSteps).toBe(2);
  });

  it("does not restore when the session has no prior messages", () => {
    const tab = makeTab("s6");
    adoptProposedPlan(tab, { plan: "b", steps: [{ id: "step-1", title: "t", action: "a" }] });
    persistPlanState(tab);
    expect(restorePlanForTab(makeTab("s6"), false)).toBeNull();
  });

  it("archives a fully-completed leftover instead of resurrecting it", () => {
    const tab = makeTab("s7");
    adoptProposedPlan(tab, { plan: "b", steps: [{ id: "step-1", title: "t", action: "a" }] });
    recordPlanStepCompletion(tab, { stepId: "step-1", result: "r" });
    persistPlanState(tab);

    const ev = restorePlanForTab(makeTab("s7"), true);
    expect(ev).toBeNull();
    expect(loadPlanState("s7")).toBeNull();
    expect(listPlanArchives("s7")).toHaveLength(1);
  });

  it("merges an accepted revision (kept-done prefix + remaining tail) and persists", () => {
    const tab = makeTab("s8");
    adoptProposedPlan(tab, {
      plan: "b",
      steps: [
        { id: "step-1", title: "t1", action: "a1" },
        { id: "step-2", title: "t2", action: "a2" },
      ],
    });
    recordPlanStepCompletion(tab, { stepId: "step-1", result: "r1" });
    persistPlanState(tab);

    tab.planPendingRevisionSteps = [{ id: "step-3", title: "t3", action: "a3" }];
    applyPlanRevision(tab);

    const loaded = loadPlanState("s8");
    expect(loaded?.steps.map((s) => s.id)).toEqual(["step-1", "step-3"]);
    expect(loaded?.completedStepIds).toEqual(["step-1"]);
    expect(tab.planPendingRevisionSteps).toBeNull();
  });

  it("scopes persistence per session — two sessions never share a plan file", () => {
    const a = makeTab("sess-a");
    const b = makeTab("sess-b");
    adoptProposedPlan(a, { plan: "A body", steps: [{ id: "a-1", title: "ta", action: "x" }] });
    adoptProposedPlan(b, {
      plan: "B body",
      steps: [
        { id: "b-1", title: "tb", action: "y" },
        { id: "b-2", title: "tb2", action: "z" },
      ],
    });
    persistPlanState(a);
    persistPlanState(b);

    expect(planStatePath("sess-a")).not.toBe(planStatePath("sess-b"));
    expect(loadPlanState("sess-a")?.steps.map((s) => s.id)).toEqual(["a-1"]);
    expect(loadPlanState("sess-b")?.steps.map((s) => s.id)).toEqual(["b-1", "b-2"]);

    // Completing + archiving A must not touch B's active plan or archives.
    recordPlanStepCompletion(a, { stepId: "a-1", result: "done" });
    archivePlanForTab(a);
    expect(loadPlanState("sess-a")).toBeNull();
    expect(listPlanArchives("sess-a")).toHaveLength(1);
    expect(listPlanArchives("sess-b")).toHaveLength(0);
    expect(loadPlanState("sess-b")?.steps.map((s) => s.id)).toEqual(["b-1", "b-2"]);

    // Restore is scoped too: a fresh tab on B restores B, never A.
    const ev = restorePlanForTab(makeTab("sess-b"), true);
    expect(ev?.steps.map((s) => s.id)).toEqual(["b-1", "b-2"]);
    expect(restorePlanForTab(makeTab("sess-a"), true)).toBeNull();
  });
});
