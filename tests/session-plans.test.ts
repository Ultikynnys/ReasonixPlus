import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PlanRepository, workspacePlansDir } from "../src/code/plans.js";
import { sessionPlansDir } from "../src/memory/session-layout.js";
import { appendSessionMessage, patchSessionMeta } from "../src/memory/session.js";

let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plans-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  process.env.HOME = oldHome;
  process.env.USERPROFILE = oldProfile;
  rmSync(home, { recursive: true, force: true });
});
const steps = [
  { id: "one", title: "First", action: "Do first" },
  { id: "two", title: "Second", action: "Do second" },
];
it("persists a first-read migration so the next boot does not re-aggregate it", () => {
  const workspace = join(home, "proj");
  appendSessionMessage("carried-plan", { role: "user", content: "x" });
  patchSessionMeta("carried-plan", { workspace });
  // A plan that lived only in the session's own (retired) store.
  const carried = new PlanRepository(join(home, "scratch")).propose(
    "Carried body",
    steps,
    "Carried plan",
  );
  mkdirSync(sessionPlansDir("carried-plan"), { recursive: true });
  writeFileSync(
    join(sessionPlansDir("carried-plan"), "history.json"),
    JSON.stringify({ version: 1, revision: 1, plans: [carried] }),
    "utf8",
  );

  expect(new PlanRepository(workspace).list().map((p) => p.summary)).toEqual(["Carried plan"]);
  expect(existsSync(join(workspacePlansDir(workspace), "history.json"))).toBe(true);

  // The workspace store now answers on its own: a later boot reads the file it was
  // adopted into instead of walking every session again.
  rmSync(sessionPlansDir("carried-plan"), { recursive: true, force: true });
  expect(new PlanRepository(workspace).list().map((p) => p.summary)).toEqual(["Carried plan"]);
});

it("retains partial superseded work across repository recreation", () => {
  const repo = new PlanRepository("first");
  const first = repo.propose("First plan", steps);
  repo.verdict(first.id, "active");
  repo.complete(first.id, {
    kind: "step_completed",
    stepId: "one",
    result: "Done",
    evidence: [{ kind: "verification", summary: "Passed" }],
  });
  const second = repo.propose("Replacement");
  repo.verdict(second.id, "active");
  const restored = new PlanRepository("first");
  expect(restored.open(first.id)).toMatchObject({
    status: "superseded",
    replacedBy: second.id,
    finishedAt: null,
    completions: { one: { result: "Done", evidence: [{ summary: "Passed" }] } },
  });
  expect(restored.newestActivePlan()?.id).toBe(second.id);
  expect(restored.list()).toHaveLength(2);
  expect(new PlanRepository("second").list()).toEqual([]);
});
it("rejects stale verdicts and out-of-order or duplicate completion", () => {
  const repo = new PlanRepository("order");
  const plan = repo.propose("Plan", steps);
  repo.verdict(plan.id, "active");
  expect(() => repo.verdict(plan.id, "active")).toThrow("Stale");
  expect(() =>
    repo.complete(plan.id, { kind: "step_completed", stepId: "two", result: "Done" }),
  ).toThrow("next unfinished");
  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" });
  expect(() =>
    repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" }),
  ).toThrow("next unfinished");
  const done = repo.complete(plan.id, { kind: "step_completed", stepId: "two", result: "Done" });
  expect(done.status).toBe("completed");
  expect(done.finishedAt).toBe(done.updatedAt);
});
it("preserves markdown-only cancelled and refined attempts", () => {
  const repo = new PlanRepository("attempts");
  const first = repo.propose("Markdown only");
  repo.verdict(first.id, "cancelled");
  const second = repo.propose("Refine me");
  repo.verdict(second.id, "refinement_requested");
  expect(repo.list().map((p) => [p.status, p.finishedAt])).toEqual([
    ["refinement_requested", null],
    ["cancelled", null],
  ]);
});
it("refreshes an existing repository after another instance writes", () => {
  const first = new PlanRepository("shared");
  expect(first.list()).toEqual([]);
  const second = new PlanRepository("shared");
  const plan = second.propose("New plan");
  expect(first.open(plan.id).body).toBe("New plan");
  first.verdict(plan.id, "active");
  expect(second.newestActivePlan()?.id).toBe(plan.id);
});
it("fails closed on malformed history without overwriting it", () => {
  const repo = new PlanRepository("broken");
  repo.propose("Valid");
  writeFileSync(repo.path, "broken JSON");
  expect(() => repo.propose("Do not overwrite")).toThrow();
  expect(() => new PlanRepository("broken").list()).toThrow();
});
it("retains abandonment reasons and rejects subsequent completion", () => {
  const repo = new PlanRepository("abandon");
  const plan = repo.propose("Plan", steps);
  repo.verdict(plan.id, "active");
  repo.abandon(plan.id, "Requirements changed");
  expect(new PlanRepository("abandon").open(plan.id)).toMatchObject({
    status: "abandoned",
    finishedAt: null,
    dispositionReason: "Requirements changed",
  });
  expect(() =>
    repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" }),
  ).toThrow("no longer active");
});
it("does not steal a live writer lock", () => {
  const repo = new PlanRepository("locked");
  repo.propose("First");
  writeFileSync(`${repo.path}.lock`, String(process.pid));
  expect(() => repo.propose("Second")).toThrow();
  expect(repo.list()).toHaveLength(1);
});
it("keeps original steps when revising and retained completion details", () => {
  const repo = new PlanRepository("revision");
  const plan = repo.propose("Plan", steps);
  repo.verdict(plan.id, "active");
  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" });
  const revised = repo.revise(plan.id, "Different tail", [
    { id: "three", title: "Third", action: "Do third" },
  ]);
  expect(revised.revisions[0].steps).toEqual(steps);
  expect(revised.steps.map((s) => s.id)).toEqual(["one", "three"]);
});
it("treats a sealed fully-completed active plan as complete, never in-flight", () => {
  const repo = new PlanRepository("sealed");
  const plan = repo.propose("Plan", [{ id: "one", title: "First", action: "Do first" }]);
  repo.verdict(plan.id, "active");
  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" });
  // Simulate a stale file that still says "active" even though every step is done.
  const raw = JSON.parse(readFileSync(repo.path, "utf8")) as {
    plans: Array<{ status: string; finishedAt: string | null }>;
  };
  raw.plans[0]!.status = "active";
  raw.plans[0]!.finishedAt = null;
  writeFileSync(repo.path, JSON.stringify(raw));

  const reread = new PlanRepository("sealed");
  expect(reread.newestActivePlan()).toBeNull();
  expect(reread.list()[0]?.status).toBe("completed");
});
it("freezes a completed plan: it cannot be completed, revised, abandoned or activated", () => {
  const repo = new PlanRepository("frozen");
  const plan = repo.propose("Plan", steps);
  repo.verdict(plan.id, "active");
  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" });
  repo.complete(plan.id, { kind: "step_completed", stepId: "two", result: "Done" });
  expect(repo.open(plan.id).status).toBe("completed");
  expect(() =>
    repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Changed" }),
  ).toThrow(/completed/);
  expect(() => repo.revise(plan.id, "nope", [{ id: "x", title: "t", action: "a" }])).toThrow(
    /completed/,
  );
  expect(() => repo.abandon(plan.id, "nope")).toThrow(/completed/);
  expect(() => repo.activate(plan.id)).toThrow(/completed/);
});
it("activates any non-completed plan, superseding the current active", () => {
  const repo = new PlanRepository("activate");
  const first = repo.propose("First", steps);
  repo.verdict(first.id, "active");
  const second = repo.propose("Second", steps);
  repo.verdict(second.id, "active");
  expect(repo.newestActivePlan()?.id).toBe(second.id);

  const reactivated = repo.activate(first.id);
  expect(reactivated.status).toBe("active");
  expect(repo.newestActivePlan()?.id).toBe(first.id);
  expect(repo.open(second.id).status).toBe("superseded");
  expect(repo.open(second.id).replacedBy).toBe(first.id);

  const third = repo.propose("Third");
  repo.verdict(third.id, "cancelled");
  expect(repo.activate(third.id).status).toBe("active");
  expect(repo.newestActivePlan()?.id).toBe(third.id);
});
it("removes a plan for good in every state and refuses an unknown id", () => {
  const repo = new PlanRepository("remove");
  const active = repo.propose("Active", steps);
  repo.verdict(active.id, "active");
  const completed = repo.propose("Done", [{ id: "one", title: "t", action: "a" }]);
  repo.verdict(completed.id, "active");
  repo.complete(completed.id, { kind: "step_completed", stepId: "one", result: "Done" });
  const cancelled = repo.propose("Cancelled");
  repo.verdict(cancelled.id, "cancelled");
  expect(repo.list()).toHaveLength(3);

  // Removing the active plan is allowed and leaves no in-flight plan behind.
  repo.remove(active.id);
  expect(repo.newestActivePlan()).toBeNull();
  expect(() => repo.open(active.id)).toThrow("Unknown plan ID");
  // A completed record can be removed too — a manual delete is the user's explicit call.
  repo.remove(completed.id);
  repo.remove(cancelled.id);
  expect(repo.list()).toEqual([]);
  expect(new PlanRepository("remove").list()).toEqual([]);
  expect(() => repo.remove("does-not-exist")).toThrow("Unknown plan ID");
});
