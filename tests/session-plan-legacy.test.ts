/** Legacy per-session plan.json / .done.json records aggregate into the one
 *  workspace plan history on first read. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanRepository, planRepository } from "../src/code/plans.js";
import {
  ensureSessionDir,
  patchSessionMeta,
  sessionPlanPath,
  sessionPlansDir,
} from "../src/memory/session.js";

let tempHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "plan-legacy-"));
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

function writeFixture(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function archivePath(session: string, name: string): string {
  return join(sessionPlansDir(session), name);
}

/** A workspace root plus one session folder stamped to belong to it. */
function workspace(): string {
  return join(tempHome, "workspace");
}

function sessionFor(ws: string, name: string): void {
  ensureSessionDir(name);
  patchSessionMeta(name, { workspace: ws });
}

describe("legacy plan migration", () => {
  it("imports an active plan.json as the single active plan", () => {
    const ws = workspace();
    const session = "legacy-active";
    sessionFor(ws, session);
    writeFixture(sessionPlanPath(session), {
      version: 2,
      steps: [
        { id: "one", title: "First", action: "Do first" },
        { id: "two", title: "Second", action: "Do second" },
      ],
      completedStepIds: ["one"],
      updatedAt: "2026-01-02T00:00:00.000Z",
      body: "# Legacy body",
      summary: "Legacy summary",
    });

    const active = new PlanRepository(ws).active();
    expect(active?.status).toBe("active");
    expect(active?.steps.map((s) => s.id)).toEqual(["one", "two"]);
    expect(active?.completions.one?.result).toMatch(/Legacy completion/);
    expect(active?.body).toBe("# Legacy body");
    expect(active?.summary).toBe("Legacy summary");
    // The original creation date is unknowable from a legacy file.
    expect(active?.createdAt).toBeNull();
  });

  it("imports a fully-completed plan.json as completed, not in-flight", () => {
    const ws = workspace();
    const session = "legacy-done";
    sessionFor(ws, session);
    writeFixture(sessionPlanPath(session), {
      version: 2,
      steps: [{ id: "one", title: "First", action: "Do first" }],
      completedStepIds: ["one"],
      updatedAt: "2026-01-09T00:00:00.000Z",
    });

    const repo = new PlanRepository(ws);
    // A finished leftover must not resurrect as the active plan (that would
    // keep re-injecting "continue the next step").
    expect(repo.active()).toBeNull();
    const [plan] = repo.list();
    expect(plan?.status).toBe("completed");
    expect(plan?.finishedAt).toBe("2026-01-09T00:00:00.000Z");
  });

  it("imports .done.json archives as completed when every step is done, else abandoned", () => {
    const ws = workspace();
    const session = "legacy-archives";
    sessionFor(ws, session);
    writeFixture(archivePath(session, "2026-01-03T00-00-00-000Z-aaaa.done.json"), {
      version: 2,
      steps: [{ id: "s1", title: "t", action: "a" }],
      completedStepIds: ["s1"],
      updatedAt: "2026-01-03T00:00:00.000Z",
      body: "done body",
    });
    writeFixture(archivePath(session, "2026-01-04T00-00-00-000Z-bbbb.done.json"), {
      version: 2,
      steps: [
        { id: "s1", title: "t", action: "a" },
        { id: "s2", title: "t2", action: "a2" },
      ],
      completedStepIds: ["s1"],
      updatedAt: "2026-01-04T00:00:00.000Z",
    });

    const [newest, oldest] = new PlanRepository(ws).list();
    expect(newest.status).toBe("abandoned");
    expect(newest.finishedAt).toBeNull();
    expect(newest.completedSteps).toBe(1);
    expect(newest.totalSteps).toBe(2);
    expect(newest.dispositionReason).toMatch(/legacy archive/i);
    expect(oldest.status).toBe("completed");
    expect(oldest.finishedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("filters malformed legacy steps and non-string completed ids instead of failing", () => {
    const ws = workspace();
    const session = "legacy-partial";
    sessionFor(ws, session);
    writeFixture(sessionPlanPath(session), {
      version: 1,
      steps: [
        { id: "ok", title: "good", action: "do" },
        { id: "", title: "no id", action: "x" },
        null,
        { id: "ok-2", title: "also good", action: "do2" },
        { id: "ok-3", title: "third", action: "do3" },
      ],
      completedStepIds: ["ok", null, 42, "", "ok-2"],
      updatedAt: "2026-01-05T00:00:00.000Z",
    });

    // One step stays unfinished, so this leftover keeps importing as active.
    const active = new PlanRepository(ws).active();
    expect(active?.steps.map((s) => s.id)).toEqual(["ok", "ok-2", "ok-3"]);
    expect(Object.keys(active?.completions ?? {})).toEqual(["ok", "ok-2"]);
  });

  it("ignores a legacy file that sanitizes to zero steps", () => {
    const ws = workspace();
    const session = "legacy-empty";
    sessionFor(ws, session);
    writeFixture(sessionPlanPath(session), {
      version: 1,
      steps: [{ id: "", title: "", action: "" }],
      completedStepIds: [],
      updatedAt: "2026-01-06T00:00:00.000Z",
    });
    expect(new PlanRepository(ws).active()).toBeNull();
  });

  it("ignores malformed JSON and unknown versions", () => {
    const ws = workspace();
    sessionFor(ws, "legacy-broken");
    sessionFor(ws, "legacy-v0");
    writeFixture(sessionPlanPath("legacy-broken"), "not json {");
    writeFixture(sessionPlanPath("legacy-v0"), {
      version: 0,
      steps: [{ id: "x", title: "y", action: "z" }],
      completedStepIds: [],
      updatedAt: "2026-01-07T00:00:00.000Z",
    });
    expect(new PlanRepository(ws).active()).toBeNull();
  });

  it("seals legacy records into the unified history on first write", () => {
    const ws = workspace();
    const session = "legacy-shadowed";
    sessionFor(ws, session);
    writeFixture(sessionPlanPath(session), {
      version: 2,
      steps: [{ id: "legacy", title: "t", action: "a" }],
      completedStepIds: [],
      updatedAt: "2026-01-08T00:00:00.000Z",
    });
    const repo = new PlanRepository(ws);
    const created = repo.propose("New unified plan", [{ id: "one", title: "t", action: "a" }]);
    repo.verdict(created.id, "active");

    // The legacy plan is retained (superseded) and the new plan is active.
    expect(repo.active()?.id).toBe(created.id);
    expect(repo.list()).toHaveLength(2);

    // Once history.json exists it is authoritative — removing the leftover plan.json changes nothing.
    rmSync(sessionPlanPath(session));
    const reread = new PlanRepository(ws);
    expect(reread.active()?.id).toBe(created.id);
    expect(reread.list()).toHaveLength(2);
  });

  it("aggregates the plan histories of every session in the same workspace", () => {
    const ws = workspace();
    sessionFor(ws, "agg-a");
    sessionFor(ws, "agg-b");
    writeFixture(sessionPlanPath("agg-a"), {
      version: 2,
      steps: [{ id: "a", title: "ta", action: "x" }],
      completedStepIds: [],
      updatedAt: "2026-01-02T00:00:00.000Z",
      body: "# a",
    });
    writeFixture(sessionPlanPath("agg-b"), {
      version: 2,
      steps: [{ id: "b", title: "tb", action: "y" }],
      completedStepIds: [],
      updatedAt: "2026-01-03T00:00:00.000Z",
      body: "# b",
    });

    const repo = new PlanRepository(ws);
    const items = repo.list();
    expect(items).toHaveLength(2);
    // Two actives can't coexist: the newest wins, the older is superseded.
    expect(repo.active()?.body).toBe("# b");
    expect(new Set(items.map((p) => p.status))).toEqual(new Set(["active", "superseded"]));
  });

  it("shares one cached repository per workspace path", () => {
    expect(planRepository("shared-cache")).toBe(planRepository("shared-cache"));
    expect(planRepository("shared-cache")).not.toBe(planRepository("other-cache"));
  });
});
