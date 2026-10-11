/** Legacy plan.json / .done.json migration into the unified session plan history. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionPlanRepository, sessionPlanRepository } from "../src/code/session-plans.js";
import { sessionPlanPath, sessionPlansDir } from "../src/memory/session.js";

let tempHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "session-plan-legacy-"));
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

describe("legacy plan migration", () => {
  it("imports an active plan.json as the single active plan", () => {
    writeFixture(sessionPlanPath("legacy-active"), {
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

    const active = new SessionPlanRepository("legacy-active").active();
    expect(active?.status).toBe("active");
    expect(active?.steps.map((s) => s.id)).toEqual(["one", "two"]);
    expect(active?.completions.one?.result).toMatch(/Legacy completion/);
    expect(active?.body).toBe("# Legacy body");
    expect(active?.summary).toBe("Legacy summary");
    // The original creation date is unknowable from a legacy file.
    expect(active?.createdAt).toBeNull();
  });

  it("imports a fully-completed plan.json as completed, not in-flight", () => {
    writeFixture(sessionPlanPath("legacy-done"), {
      version: 2,
      steps: [{ id: "one", title: "First", action: "Do first" }],
      completedStepIds: ["one"],
      updatedAt: "2026-01-09T00:00:00.000Z",
    });

    const repo = new SessionPlanRepository("legacy-done");
    // A finished leftover must not resurrect as the active plan (that would
    // keep re-injecting "continue the next step").
    expect(repo.active()).toBeNull();
    const [plan] = repo.list();
    expect(plan?.status).toBe("completed");
    expect(plan?.finishedAt).toBe("2026-01-09T00:00:00.000Z");
  });

  it("imports .done.json archives as completed when every step is done, else abandoned", () => {
    writeFixture(archivePath("legacy-archives", "2026-01-03T00-00-00-000Z-aaaa.done.json"), {
      version: 2,
      steps: [{ id: "s1", title: "t", action: "a" }],
      completedStepIds: ["s1"],
      updatedAt: "2026-01-03T00:00:00.000Z",
      body: "done body",
    });
    writeFixture(archivePath("legacy-archives", "2026-01-04T00-00-00-000Z-bbbb.done.json"), {
      version: 2,
      steps: [
        { id: "s1", title: "t", action: "a" },
        { id: "s2", title: "t2", action: "a2" },
      ],
      completedStepIds: ["s1"],
      updatedAt: "2026-01-04T00:00:00.000Z",
    });

    const [newest, oldest] = new SessionPlanRepository("legacy-archives").list();
    expect(newest.status).toBe("abandoned");
    expect(newest.finishedAt).toBeNull();
    expect(newest.completedSteps).toBe(1);
    expect(newest.totalSteps).toBe(2);
    expect(newest.dispositionReason).toMatch(/legacy archive/i);
    expect(oldest.status).toBe("completed");
    expect(oldest.finishedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("filters malformed legacy steps and non-string completed ids instead of failing", () => {
    writeFixture(sessionPlanPath("legacy-partial"), {
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
    const active = new SessionPlanRepository("legacy-partial").active();
    expect(active?.steps.map((s) => s.id)).toEqual(["ok", "ok-2", "ok-3"]);
    expect(Object.keys(active?.completions ?? {})).toEqual(["ok", "ok-2"]);
  });

  it("ignores a legacy file that sanitizes to zero steps", () => {
    writeFixture(sessionPlanPath("legacy-empty"), {
      version: 1,
      steps: [{ id: "", title: "", action: "" }],
      completedStepIds: [],
      updatedAt: "2026-01-06T00:00:00.000Z",
    });
    expect(new SessionPlanRepository("legacy-empty").active()).toBeNull();
  });

  it("ignores malformed JSON and unknown versions", () => {
    writeFixture(sessionPlanPath("legacy-broken"), "not json {");
    writeFixture(sessionPlanPath("legacy-v0"), {
      version: 0,
      steps: [{ id: "x", title: "y", action: "z" }],
      completedStepIds: [],
      updatedAt: "2026-01-07T00:00:00.000Z",
    });
    expect(new SessionPlanRepository("legacy-broken").active()).toBeNull();
    expect(new SessionPlanRepository("legacy-v0").active()).toBeNull();
  });

  it("seals legacy records into the unified history on first write", () => {
    writeFixture(sessionPlanPath("legacy-shadowed"), {
      version: 2,
      steps: [{ id: "legacy", title: "t", action: "a" }],
      completedStepIds: [],
      updatedAt: "2026-01-08T00:00:00.000Z",
    });
    const repo = new SessionPlanRepository("legacy-shadowed");
    const created = repo.propose("New unified plan", [{ id: "one", title: "t", action: "a" }]);
    repo.verdict(created.id, "active");

    // The legacy plan is retained (superseded) and the new plan is active.
    expect(repo.active()?.id).toBe(created.id);
    expect(repo.list()).toHaveLength(2);

    // Once history.json exists it is authoritative — removing the leftover plan.json changes nothing.
    rmSync(sessionPlanPath("legacy-shadowed"));
    const reread = new SessionPlanRepository("legacy-shadowed");
    expect(reread.active()?.id).toBe(created.id);
    expect(reread.list()).toHaveLength(2);
  });

  it("shares one cached repository per session path", () => {
    expect(sessionPlanRepository("shared-cache")).toBe(sessionPlanRepository("shared-cache"));
    expect(sessionPlanRepository("shared-cache")).not.toBe(sessionPlanRepository("other-cache"));
  });
});
