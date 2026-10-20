/** Plan ownership: one workspace plan belongs to exactly one live session, while two
 *  sessions may run two plans in one workspace in parallel. A deleted session holds none. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setLiveSessionProbe } from "../src/code/plan-claim.js";
import { PlanRepository } from "../src/code/plans.js";
import { PauseGate } from "../src/core/pause-gate.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { deleteSession, ensureSessionDir } from "../src/memory/session.js";
import { ToolRegistry } from "../src/tools.js";
import { registerPlanTool } from "../src/tools/plan.js";
import type { ChatMessage } from "../src/types.js";
import { makeFakeClient } from "./support/fake-client.js";

let home: string;
let previous: [string | undefined, string | undefined];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plan-ownership-"));
  previous = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  setLiveSessionProbe(null);
  [process.env.HOME, process.env.USERPROFILE] = previous;
  rmSync(home, { recursive: true, force: true });
});

const steps = [
  { id: "one", title: "First", action: "Do first" },
  { id: "two", title: "Second", action: "Do second" },
];

/** Rewrite the stored history in place, to fabricate states only another process (or a
 *  crash) could produce. */
function patchPlan(path: string, id: string, mutate: (plan: Record<string, unknown>) => void) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    plans: Array<Record<string, unknown>>;
  };
  const plan = raw.plans.find((entry) => entry.id === id);
  if (!plan) throw new Error(`plan ${id} not in history`);
  mutate(plan);
  writeFileSync(path, JSON.stringify(raw));
}

it("runs one plan per session in parallel in a single workspace", () => {
  const repo = new PlanRepository("parallel");
  const first = repo.propose("First session plan", steps, undefined, "s1");
  repo.verdict(first.id, "active", "s1");
  const second = repo.propose("Second session plan", steps, undefined, "s2");
  repo.verdict(second.id, "active", "s2");

  // Both plans stay in flight: activating one session's plan never supersedes another's.
  expect(repo.open(first.id).status).toBe("active");
  expect(repo.open(second.id).status).toBe("active");
  expect(repo.activeFor("s1")?.id).toBe(first.id);
  expect(repo.activeFor("s2")?.id).toBe(second.id);
  expect(new PlanRepository("parallel").activeFor("s2")?.id).toBe(second.id);
});

it("refuses a plan a live session is working and keeps it out of the asking session", () => {
  const repo = new PlanRepository("exclusive");
  ensureSessionDir("s1");
  const plan = repo.propose("Only one driver", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");

  const refusal = repo.claimable(plan.id, "s2");
  expect(refusal?.owner).toMatchObject({ session: "s1", pid: process.pid });
  expect(repo.activeFor("s2")).toBeNull();
  expect(() => repo.activate(plan.id, "s2")).toThrow(/being worked on by session "s1"/);
  expect(() =>
    repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" }, "s2"),
  ).toThrow(/owned by session "s1"/);
  expect(repo.open(plan.id).claim?.session).toBe("s1");
  // The owner is unaffected by the refusals.
  expect(
    repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" }, "s1")
      .completions.one?.result,
  ).toBe("Done");
});

it("hands a plan over once the claiming session is no longer live in this process", () => {
  const repo = new PlanRepository("handover");
  ensureSessionDir("s1");
  const plan = repo.propose("Tab closes mid-plan", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");

  // The daemon reports s1 bound to a tab: the plan is locked.
  const live = new Set(["s1"]);
  setLiveSessionProbe((_workspace, session) => live.has(session));
  expect(repo.claimable(plan.id, "s2")?.owner.session).toBe("s1");

  // Tab s1 is closed: the very same pid no longer holds it, so s2 takes over.
  live.delete("s1");
  expect(repo.claimable(plan.id, "s2")).toBeNull();
  const taken = repo.activate(plan.id, "s2");
  expect(taken.claim?.session).toBe("s2");
  expect(repo.activeFor("s1")).toBeNull();
  expect(repo.activeFor("s2")?.id).toBe(plan.id);
});

it("hands a plan over once the claiming process is dead", () => {
  const repo = new PlanRepository("dead-owner");
  ensureSessionDir("s1");
  const plan = repo.propose("Owner crashed", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  // A pid that cannot be running: the claim is a leftover, not a live holder.
  patchPlan(repo.path, plan.id, (record) => {
    record.claim = { session: "s1", pid: 2_147_483_646, since: new Date().toISOString() };
  });

  expect(repo.claimable(plan.id, "s2")).toBeNull();
  expect(repo.activate(plan.id, "s2").claim?.session).toBe("s2");
});

it("keeps a plan locked against takeover while its claiming process is alive", () => {
  const repo = new PlanRepository("live-owner");
  ensureSessionDir("s1");
  const plan = repo.propose("Other process", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  // The parent process is alive and is never this process, so the claim stands.
  patchPlan(repo.path, plan.id, (record) => {
    record.claim = { session: "s1", pid: process.ppid, since: new Date().toISOString() };
  });

  expect(repo.claimable(plan.id, "s2")?.owner.session).toBe("s1");
  expect(() => repo.activate(plan.id, "s2")).toThrow(/being worked on by session "s1"/);
});

it("makes a plan available again when the session that worked it is deleted", () => {
  const repo = new PlanRepository("session-deleted");
  ensureSessionDir("s1");
  ensureSessionDir("s2");
  const plan = repo.propose("Deleted mid-plan", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  expect(repo.claimable(plan.id, "s2")?.owner.session).toBe("s1");

  deleteSession("s1");

  // The claim is a leftover, so the plan belongs to nobody: no session is refused it,
  // whatever pid the stale claim carries, and s2 takes it over.
  expect(repo.claimable(plan.id, "s2")).toBeNull();
  expect(repo.activate(plan.id, "s2").claim).toMatchObject({
    session: "s2",
    pid: process.pid,
  });
  expect(repo.open(plan.id).claim?.session).toBe("s2");
  expect(repo.activeFor("s2")?.id).toBe(plan.id);
});

it("lets any session adopt the active plan a deleted session left behind", () => {
  const repo = new PlanRepository("orphan-adopt");
  ensureSessionDir("s1");
  ensureSessionDir("s2");
  const plan = repo.propose("Orphan", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  deleteSession("s1");

  // No session is refused the plan any more, so the first one that asks picks it up...
  expect(repo.claimable(plan.id, "s2")).toBeNull();
  expect(repo.activeFor("s2", { adoptUnclaimed: true })?.id).toBe(plan.id);
  expect(repo.open(plan.id).claim?.session).toBe("s2");
  // ...and the adoption is exclusive: a third session neither adopts nor takes it.
  expect(repo.activeFor("s3", { adoptUnclaimed: true })).toBeNull();
  expect(repo.claimable(plan.id, "s3")?.owner.session).toBe("s2");
  // One plan per session, and the store stays valid: asking again returns that plan.
  expect(repo.activeFor("s2", { adoptUnclaimed: true })?.id).toBe(plan.id);
  expect(new PlanRepository("orphan-adopt").list().map((p) => p.claim?.session)).toEqual(["s2"]);
});

it("stops attributing a plan to a session that was deleted", () => {
  const repo = new PlanRepository("orphan-projection");
  ensureSessionDir("s1");
  const plan = repo.propose("Orphan", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  expect(repo.list()[0]).toMatchObject({ id: plan.id, claim: { session: "s1" } });

  deleteSession("s1");

  // Every read surface answers "no owner", so no sidebar can label the plan with a
  // session that no longer exists — even before a session takes the plan over.
  expect(repo.list()[0]?.claim).toBeUndefined();
  expect(repo.open(plan.id).claim).toBeUndefined();
  expect(repo.newestActivePlan()?.claim).toBeUndefined();
});

it("holds an unnamed owner's plan on its pid, having no session record to check", () => {
  const repo = new PlanRepository("anonymous-owner");
  const plan = repo.propose("Owned by an embed", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  // An unnamed caller (library embed) never has a session folder by design.
  patchPlan(repo.path, plan.id, (record) => {
    record.claim = {
      session: `anonymous-${process.ppid}`,
      pid: process.ppid,
      since: new Date().toISOString(),
    };
  });

  expect(repo.claimable(plan.id, "s2")?.owner.session).toBe(`anonymous-${process.ppid}`);
  expect(() => repo.activate(plan.id, "s2")).toThrow(/being worked on by session/);
});

it("keeps a live-but-idle session's plan out of adoption until it is deleted", () => {
  const repo = new PlanRepository("idle-owner");
  ensureSessionDir("s1");
  const plan = repo.propose("Idle owner", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");

  // The session still exists, so it may resume: nobody adopts the plan out from under it.
  expect(repo.activeFor("s2", { adoptUnclaimed: true })).toBeNull();

  deleteSession("s1");
  expect(repo.activeFor("s2", { adoptUnclaimed: true })?.id).toBe(plan.id);
});

it("refreshes the claim's pid when the owning session advances its own plan", () => {
  const repo = new PlanRepository("pid-refresh");
  ensureSessionDir("s1");
  const plan = repo.propose("Resumed", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  // A resumed session: same name, an EARLIER process's pid in the stored claim.
  patchPlan(repo.path, plan.id, (record) => {
    record.claim = { session: "s1", pid: process.ppid, since: "2026-01-01T00:00:00.000Z" };
  });

  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" }, "s1");

  // The takeover signal now names the process that drove the step, and the takeover time
  // is preserved, so a recycled pid can never stand in for a live holder of this plan.
  expect(repo.open(plan.id).claim).toMatchObject({
    session: "s1",
    pid: process.pid,
    since: "2026-01-01T00:00:00.000Z",
  });
});

it("adopts an unclaimed pre-ownership plan exactly once", () => {
  const repo = new PlanRepository("adopt");
  ensureSessionDir("s1");
  const plan = repo.propose("Imported plan", steps);
  repo.verdict(plan.id, "active");

  // The first live session that asks gets it and owns it from then on.
  expect(repo.activeFor("s1", { adoptUnclaimed: true })?.id).toBe(plan.id);
  expect(repo.open(plan.id).claim?.session).toBe("s1");
  // A second session in the same workspace gets nothing and cannot take it.
  expect(repo.activeFor("s2", { adoptUnclaimed: true })).toBeNull();
  expect(repo.claimable(plan.id, "s2")?.owner.session).toBe("s1");
});

it("keeps its own plan across a repository recreation and re-reads it", () => {
  const repo = new PlanRepository("reentry");
  const plan = repo.propose("Mine", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");

  // A second reader (another tab process, a restarted daemon) must not refuse the owner.
  const reread = new PlanRepository("reentry");
  expect(reread.activeFor("s1")?.id).toBe(plan.id);
  expect(reread.claimable(plan.id, "s1")).toBeNull();
  expect(reread.activate(plan.id, "s1").claim?.session).toBe("s1");
  expect(
    reread.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Done" }, "s1")
      .completions.one?.result,
  ).toBe("Done");
});

it("treats a probe that cannot answer as a live owner", () => {
  const repo = new PlanRepository("probe-fault");
  ensureSessionDir("s1");
  const plan = repo.propose("Guarded", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  setLiveSessionProbe(() => {
    throw new Error("tab registry unavailable");
  });

  // Fail safe: an unanswerable liveness question never frees a plan.
  expect(repo.claimable(plan.id, "s2")?.owner.session).toBe("s1");
});

it("survives a store locked by a live writer without adopting or throwing", () => {
  const repo = new PlanRepository("locked-adopt");
  const plan = repo.propose("Imported", steps);
  repo.verdict(plan.id, "active");
  const lock = `${repo.path}.lock`;
  writeFileSync(lock, String(process.pid));

  // The adoption write cannot take the lock, so the read degrades to "no plan here".
  expect(repo.activeFor("s1", { adoptUnclaimed: true })).toBeNull();
  expect(repo.activeFor("s1")).toBeNull();

  rmSync(lock);
  expect(repo.activeFor("s1", { adoptUnclaimed: true })?.id).toBe(plan.id);
});

it("fails closed on a stored claim it cannot parse", () => {
  const repo = new PlanRepository("bad-claim");
  const plan = repo.propose("Mine", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  patchPlan(repo.path, plan.id, (record) => {
    record.claim = { session: 42, pid: "nope" };
  });

  // An unreadable owner must never be read as "unowned, take it".
  expect(() => new PlanRepository("bad-claim").list()).toThrow(/claim/);
});

it("supersedes only the same session's plan when that session starts a new one", () => {
  const repo = new PlanRepository("supersede");
  const mine = repo.propose("Mine", steps, undefined, "s1");
  repo.verdict(mine.id, "active", "s1");
  const theirs = repo.propose("Theirs", steps, undefined, "s2");
  repo.verdict(theirs.id, "active", "s2");

  const replacement = repo.propose("Mine, again", steps, undefined, "s1");
  repo.verdict(replacement.id, "active", "s1");

  expect(repo.open(mine.id)).toMatchObject({ status: "superseded", replacedBy: replacement.id });
  expect(repo.open(theirs.id).status).toBe("active");
  expect(repo.activeFor("s1")?.id).toBe(replacement.id);
  expect(repo.activeFor("s2")?.id).toBe(theirs.id);
});

it("fails closed on a history holding two active plans for one session", () => {
  const repo = new PlanRepository("double-active");
  const first = repo.propose("First", steps, undefined, "s1");
  repo.verdict(first.id, "active", "s1");
  const second = repo.propose("Second", steps, undefined, "s1");
  repo.verdict(second.id, "active", "s1");
  // Force the forbidden state: two in-flight plans for the same session.
  patchPlan(repo.path, first.id, (record) => {
    record.status = "active";
  });

  expect(() => new PlanRepository("double-active").list()).toThrow(/one session/);
});

// Tool-level: a live session that asks for a plan gets an accept or a reject.

function gate(type: string, optionId?: string): PauseGate {
  const pauseGate = new PauseGate();
  pauseGate.on((request) => pauseGate.resolve(request.id, { type, optionId } as never));
  return pauseGate;
}

async function submitted(
  tools: ToolRegistry,
  workspace: string,
  sessionName: string,
  plan: string,
): Promise<string> {
  const created = await tools.dispatch(
    "submit_plan",
    { plan, steps: [{ id: "one", title: "First", action: "Do first" }] },
    { rootDir: workspace, sessionName, confirmationGate: gate("approve") },
  );
  return String(created).split("planId: ")[1] as string;
}

it("answers a session asking for another live session's plan with a reject", async () => {
  const tools = registerPlanTool(new ToolRegistry());
  const workspace = "tool-ownership";
  ensureSessionDir("s1");
  const planId = await submitted(tools, workspace, "s1", "Owned by s1");

  const activated = String(
    await tools.dispatch(
      "activate_plan",
      { planId },
      { rootDir: workspace, sessionName: "s2", confirmationGate: gate("pick", "activate") },
    ),
  );
  expect(activated).toContain("rejected:");
  expect(activated).toContain('session "s1"');

  for (const [tool, args] of [
    ["mark_step_complete", { planId, stepId: "one", result: "Done" }],
    [
      "revise_plan",
      { planId, reason: "Mine now", remainingSteps: [{ id: "two", title: "t", action: "a" }] },
    ],
    ["abandon_plan", { planId, reason: "not mine" }],
  ] as const) {
    const refusal = String(
      await tools.dispatch(tool, args as never, { rootDir: workspace, sessionName: "s2" }),
    );
    expect(refusal).toContain("rejected:");
    expect(refusal).toContain('session "s1"');
  }

  // s1 is untouched by any of that and can still drive the plan.
  const owned = await tools.dispatch(
    "mark_step_complete",
    { planId, stepId: "one", result: "Done" },
    { rootDir: workspace, sessionName: "s1", confirmationGate: gate("continue") },
  );
  expect(JSON.parse(String(owned))).toMatchObject({ stepId: "one", status: "completed" });
});

it("rejects a foreign planId even when the asking session has its own plan", async () => {
  const tools = registerPlanTool(new ToolRegistry());
  const workspace = "two-own-plans";
  ensureSessionDir("s1");
  const theirs = await submitted(tools, workspace, "s1", "Owned by s1");
  await submitted(tools, workspace, "s2", "Owned by s2");

  const refusal = String(
    await tools.dispatch(
      "mark_step_complete",
      { planId: theirs, stepId: "one", result: "Done" },
      { rootDir: workspace, sessionName: "s2" },
    ),
  );
  expect(refusal).toContain("rejected:");
  expect(refusal).toContain('session "s1"');
});

it("injects nothing when the plan store is unreadable instead of failing the turn", () => {
  const workspace = "loop-corrupt";
  const repo = new PlanRepository(workspace);
  const plan = repo.propose("Mine", steps, undefined, "s1");
  repo.verdict(plan.id, "active", "s1");
  writeFileSync(repo.path, "not json");

  const loop = new CacheFirstLoop({
    client: makeFakeClient([]).client,
    prefix: new ImmutablePrefix({ system: "System" }),
    model: "deepseek-chat",
    session: "s1",
    hookCwd: workspace,
    stream: false,
  });
  const context = (loop as unknown as { buildMessages(): ChatMessage[] }).buildMessages();
  expect(context.some((message) => String(message.content).includes(plan.id))).toBe(false);
});

it("injects only the plan the loop's own session owns", () => {
  const workspace = "loop-ownership";
  const repo = new PlanRepository(workspace);
  const mine = repo.propose("s1 plan", steps, undefined, "s1");
  repo.verdict(mine.id, "active", "s1");
  const theirs = repo.propose("s2 plan", steps, undefined, "s2");
  repo.verdict(theirs.id, "active", "s2");

  const contextFor = (sessionName: string): string => {
    const loop = new CacheFirstLoop({
      client: makeFakeClient([]).client,
      prefix: new ImmutablePrefix({ system: "System" }),
      model: "deepseek-chat",
      session: sessionName,
      hookCwd: workspace,
      stream: false,
    });
    const context = (loop as unknown as { buildMessages(): ChatMessage[] }).buildMessages();
    return context.map((message) => String(message.content)).join("\n");
  };

  const s1 = contextFor("s1");
  expect(s1).toContain(mine.id);
  expect(s1).not.toContain(theirs.id);
  const s2 = contextFor("s2");
  expect(s2).toContain(theirs.id);
  expect(s2).not.toContain(mine.id);
});
