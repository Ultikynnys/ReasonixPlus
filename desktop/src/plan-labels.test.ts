import type { PlanHistoryItem } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import { planLabelsBySession } from "./plan-labels";

function plan(
  id: string,
  status: string,
  ownerSession?: string,
  summary?: string,
): PlanHistoryItem {
  return {
    id,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: status === "completed" ? "2026-01-01T00:00:00.000Z" : null,
    totalSteps: 1,
    completedSteps: status === "completed" ? 1 : 0,
    ownerSession,
    summary,
  };
}

describe("planLabelsBySession", () => {
  it("indexes each plan the way the plan section numbers it", () => {
    const labels = planLabelsBySession([
      plan("newest", "active", "session-a"),
      plan("middle", "proposed", "session-b"),
      plan("oldest", "active", "session-c"),
    ]);
    expect(labels.get("session-a")?.index).toBe(1);
    expect(labels.get("session-b")?.index).toBe(2);
    expect(labels.get("session-c")?.index).toBe(3);
  });

  it("counts finished plans in the index so the badge matches the history row", () => {
    // Numbering comes from the whole history, finished entries included, because
    // that is how the plan section numbers its rows. Whether the owning session is
    // running is a render-time question the sidebar answers, never a filter here.
    const labels = planLabelsBySession([
      plan("done", "completed", "session-a"),
      plan("live", "active", "session-b"),
    ]);
    expect(labels.get("session-b")).toMatchObject({ index: 2, status: "active" });
  });

  it("ignores finished plans a session once claimed", () => {
    // Ownership is a live-work fact: a completed plan belongs to nobody, so the
    // session that claimed it must not be labelled with it.
    const labels = planLabelsBySession([
      plan("finished", "completed", "session-a"),
      plan("cancelled", "cancelled", "session-b"),
      plan("superseded", "superseded", "session-c"),
      plan("sent-back", "refinement_requested", "session-d"),
    ]);
    expect(labels.size).toBe(0);
  });

  it("picks the working plan over a newer finished one", () => {
    const labels = planLabelsBySession([
      plan("finished", "completed", "session-a"),
      plan("running", "active", "session-a"),
    ]);
    expect(labels.get("session-a")).toMatchObject({ index: 2, status: "active" });
  });

  it("keeps the newest working plan when a session has two", () => {
    const labels = planLabelsBySession([
      plan("newer-running", "proposed", "session-a"),
      plan("older-running", "active", "session-a"),
    ]);
    expect(labels.get("session-a")?.index).toBe(1);
    expect(labels.get("session-a")?.status).toBe("proposed");
  });

  it("leaves sessions without a plan out of the map", () => {
    const labels = planLabelsBySession([plan("unowned", "active")]);
    expect(labels.size).toBe(0);
  });

  it("labels every owner at once, not just the session a tab is showing", () => {
    // The store is workspace-scoped, so the sidebar of any tab must be able to read
    // the plan state of a session it is not currently viewing.
    const labels = planLabelsBySession([
      plan("mine", "active", "session-a"),
      plan("theirs", "proposed", "session-b"),
    ]);
    expect([...labels.keys()]).toEqual(["session-a", "session-b"]);
  });
});
