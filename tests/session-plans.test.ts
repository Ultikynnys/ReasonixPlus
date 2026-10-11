import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionPlanRepository } from "../src/code/session-plans.js";

let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "session-plans-"));
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
it("retains partial superseded work across repository recreation", () => {
  const repo = new SessionPlanRepository("first");
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
  const restored = new SessionPlanRepository("first");
  expect(restored.open(first.id)).toMatchObject({
    status: "superseded",
    replacedBy: second.id,
    finishedAt: null,
    completions: { one: { result: "Done", evidence: [{ summary: "Passed" }] } },
  });
  expect(restored.active()?.id).toBe(second.id);
  expect(restored.list()).toHaveLength(2);
  expect(new SessionPlanRepository("second").list()).toEqual([]);
});
it("rejects stale verdicts and out-of-order or duplicate completion", () => {
  const repo = new SessionPlanRepository("order");
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
  const repo = new SessionPlanRepository("attempts");
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
  const first = new SessionPlanRepository("shared");
  expect(first.list()).toEqual([]);
  const second = new SessionPlanRepository("shared");
  const plan = second.propose("New plan");
  expect(first.open(plan.id).body).toBe("New plan");
  first.verdict(plan.id, "active");
  expect(second.active()?.id).toBe(plan.id);
});
it("fails closed on malformed history without overwriting it", () => {
  const repo = new SessionPlanRepository("broken");
  repo.propose("Valid");
  writeFileSync(repo.path, "broken JSON");
  expect(() => repo.propose("Do not overwrite")).toThrow();
  expect(() => new SessionPlanRepository("broken").list()).toThrow();
});
it("retains abandonment reasons and rejects subsequent completion", () => {
  const repo = new SessionPlanRepository("abandon");
  const plan = repo.propose("Plan", steps);
  repo.verdict(plan.id, "active");
  repo.abandon(plan.id, "Requirements changed");
  expect(new SessionPlanRepository("abandon").open(plan.id)).toMatchObject({
    status: "abandoned",
    finishedAt: null,
    dispositionReason: "Requirements changed",
  });
  expect(() =>
    repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" }),
  ).toThrow("no longer active");
});
it("does not steal a live writer lock", () => {
  const repo = new SessionPlanRepository("locked");
  repo.propose("First");
  writeFileSync(`${repo.path}.lock`, String(process.pid));
  expect(() => repo.propose("Second")).toThrow();
  expect(repo.list()).toHaveLength(1);
});
it("keeps original steps when revising and retained completion details", () => {
  const repo = new SessionPlanRepository("revision");
  const plan = repo.propose("Plan", steps);
  repo.verdict(plan.id, "active");
  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" });
  const revised = repo.revise(plan.id, "Different tail", [
    { id: "three", title: "Third", action: "Do third" },
  ]);
  expect(revised.revisions[0].steps).toEqual(steps);
  expect(revised.steps.map((s) => s.id)).toEqual(["one", "three"]);
});
