import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NO_WORKSPACE_MESSAGE,
  abandonedSessionOnClose,
  clearSessionPlan,
  deletableSessionNames,
  missingSessionRefusal,
  sessionRunningRefusal,
  sessionsWithLiveTurn,
  shouldDetachDeletedSession,
  skeletonSessionFor,
  tabNeedsWorkspace,
} from "../src/cli/commands/desktop.js";

describe("desktop session deletion synchronization", () => {
  it("detaches the backend-bound session after deleting the active session", () => {
    expect(shouldDetachDeletedSession("active-session", "active-session", true)).toBe(true);
  });

  it("keeps the current conversation when an inactive session is deleted", () => {
    expect(shouldDetachDeletedSession("active-session", "older-session", true)).toBe(false);
  });

  it("does not detach the current session when deletion fails", () => {
    expect(shouldDetachDeletedSession("active-session", "active-session", false)).toBe(false);
  });

  it("never leaves a channel in the deleted session it kept after a failed delete", () => {
    // The session is still on disk, so the channel keeps it: only a successful
    // delete may move the channel out of a session.
    expect(shouldDetachDeletedSession("doomed", "doomed", false)).toBe(false);
  });
});

describe("desktop — how a channel skeleton gets its session", () => {
  it("adopts a persisted session that still exists", () => {
    expect(skeletonSessionFor({ session: "kept" }, "kept")).toEqual({
      kind: "adopt",
      name: "kept",
    });
  });

  it("mints for a genuinely new channel", () => {
    expect(skeletonSessionFor(undefined, undefined)).toEqual({ kind: "mint" });
    expect(skeletonSessionFor({ active: true }, undefined)).toEqual({ kind: "mint" });
  });

  it("lands neutral when the persisted session is gone", () => {
    // No name may be bound to a session that is absent from disk.
    expect(skeletonSessionFor({ session: "deleted-session" }, undefined)).toEqual({
      kind: "neutral",
    });
  });

  it("restores a channel persisted neutral as neutral instead of minting", () => {
    expect(skeletonSessionFor({ detached: true }, undefined)).toEqual({ kind: "neutral" });
  });

  it("treats a channel persisted as both detached and named as neutral", () => {
    expect(skeletonSessionFor({ session: "kept", detached: true }, "kept")).toEqual({
      kind: "neutral",
    });
  });

  it("does not adopt a session another workspace owns", () => {
    expect(skeletonSessionFor({ session: "foreign" }, undefined)).toEqual({ kind: "neutral" });
  });
});

describe("desktop — a running session is never deleted", () => {
  const channel = (currentSession: string, aborter: unknown) => ({ currentSession, aborter });

  it("collects only the sessions whose channel has a turn in flight", () => {
    const running = sessionsWithLiveTurn([
      channel("working", new AbortController()),
      channel("idle", null),
    ]);
    expect([...running]).toEqual(["working"]);
  });

  it("ignores a channel with no session bound yet", () => {
    expect(sessionsWithLiveTurn([channel("", new AbortController())]).size).toBe(0);
  });

  it("protects a turn whose body is still unwinding after its aborter cleared", () => {
    // Stop hooks and cleanup awaits run with the aborter gone but the turn body
    // alive, and the row still reads as running: deleting it would abort work the
    // user was told is kept.
    const unwinding = { ...channel("draining", null), activeTurn: Promise.resolve() };
    expect([...sessionsWithLiveTurn([unwinding])]).toEqual(["draining"]);
  });

  it("protects a session in the middle of a manual context fold", () => {
    // A fold awaits the turn before it starts, so both turn markers are clear while
    // the daemon still works on that session.
    const folding = { ...channel("folding", null), compactingManual: true };
    expect([...sessionsWithLiveTurn([folding])]).toEqual(["folding"]);
  });

  it("leaves a running session out of a clear-all", () => {
    const doomed = deletableSessionNames(["working", "idle", "older"], new Set(["working"]));
    expect(doomed).toEqual(["idle", "older"]);
  });

  it("keeps every name the confirm dialog promised to keep", () => {
    // The caller's list wins over the daemon's own view: a session the dialog
    // labeled running survives a clear even when this daemon sees it idle, so the
    // promise costs an undeleted row instead of a deleted session.
    const plan = clearSessionPlan(["working", "promised", "older"], new Set(["working"]), [
      "promised",
    ]);
    expect(plan.doomed).toEqual(["older"]);
    expect(plan.kept).toEqual(["working", "promised"]);
  });

  it("clears everything when nothing is live or promised", () => {
    const plan = clearSessionPlan(["a", "b"], new Set());
    expect(plan.doomed).toEqual(["a", "b"]);
    expect(plan.kept).toEqual([]);
  });

  it("ships a refusal that names the session and the way out", () => {
    const message = sessionRunningRefusal("working");
    expect(message).toContain("working");
    expect(message).toMatch(/running/i);
    expect(message).toMatch(/stop/i);
  });
});

describe("desktop — a row whose session is gone cannot be opened", () => {
  it("refuses in one shared wording that names the session", () => {
    const message = missingSessionRefusal("session_open", "ghost-1");
    expect(message).toContain("ghost-1");
    expect(message).toMatch(/no longer exists/i);
    expect(message).toMatch(/refreshed/i);
  });

  it("checks the session is on disk before it bootstraps a tab", () => {
    // Opening a missing session would show a blank chat and, through the load's
    // workspace stamp, rebuild its folder: the existence check has to run first.
    const src = readFileSync(join(process.cwd(), "src/cli/commands/desktop.ts"), "utf8");
    const open = src.slice(
      src.indexOf("function openOrFocusSession("),
      src.indexOf("function patchSessionMetaAndResync("),
    );
    expect(open).toContain("if (!sessionExists(name)) {");
    expect(open).toContain("emitSessionsForWorkspace(tab.rootDir);");
    expect(open.indexOf("if (!sessionExists(name))")).toBeLessThan(open.indexOf("bootstrapTab("));
  });
});

describe("desktop — a closing channel releases the chat it never filled", () => {
  it("releases an empty session no other channel serves", () => {
    expect(
      abandonedSessionOnClose({ session: "fresh", empty: true, heldByAnotherChannel: false }),
    ).toBe("fresh");
  });

  it("keeps a session that holds any conversation", () => {
    expect(
      abandonedSessionOnClose({ session: "talked", empty: false, heldByAnotherChannel: false }),
    ).toBeUndefined();
  });

  it("keeps a session another channel still serves", () => {
    expect(
      abandonedSessionOnClose({ session: "shared", empty: true, heldByAnotherChannel: true }),
    ).toBeUndefined();
  });

  it("releases nothing from a channel with no session", () => {
    expect(
      abandonedSessionOnClose({ session: undefined, empty: true, heldByAnotherChannel: false }),
    ).toBeUndefined();
  });
});

describe("desktop — refusing a session command without a workspace", () => {
  it("flags a pending tab and a tab with no root dir", () => {
    expect(tabNeedsWorkspace({ pending: true, rootDir: "/ws" })).toBe(true);
    expect(tabNeedsWorkspace({ pending: false, rootDir: "" })).toBe(true);
  });

  it("lets a normal workspace tab through", () => {
    expect(tabNeedsWorkspace({ pending: false, rootDir: "/ws" })).toBe(false);
  });

  it("ships one user-facing refusal wording", () => {
    // The daemon echoes this instead of returning silently, so a refused click
    // still tells the user what to do next.
    expect(NO_WORKSPACE_MESSAGE).toMatch(/workspace/i);
  });
});

describe("desktop — a session mutation owns its workspace while it settles", () => {
  const daemon = readFileSync(join(process.cwd(), "src/cli/commands/desktop.ts"), "utf8");
  const app = readFileSync(join(process.cwd(), "desktop/src/App.tsx"), "utf8");

  it("books the workspace for a single delete, exactly like a clear", () => {
    const remove = daemon.slice(
      daemon.indexOf('if (msg.cmd === "session_delete") {'),
      daemon.indexOf('if (msg.cmd === "session_clear") {'),
    );
    expect(remove).toContain("const releaseDeleteBooking = sessionWork.begin(tab.rootDir);");
    expect(remove).toContain("releaseDeleteBooking();");
    // The booking has to cover the detach as well: that is what re-targets the channel.
    expect(remove.indexOf("sessionWork.begin(tab.rootDir)")).toBeLessThan(
      remove.indexOf("detachDoomedSessionWriters("),
    );
  });

  it("never publishes a second listing over a mutation on tab activation", () => {
    const activate = daemon.slice(
      daemon.indexOf('if (msg.cmd === "tab_activate") {'),
      daemon.indexOf('if (msg.cmd === "confirm_response") {'),
    );
    expect(activate).toContain(
      "if (!workspaceSessionBusy(activated.rootDir)) void emitSessions(activated);",
    );
  });

  it("routes every user tab switch through the one gate", () => {
    expect(app).toContain("const tabSwitchBlocked = hasOpenSessionIntent(sessionsStore);");
    expect(app).toContain("if (hasOpenSessionIntent(sessionsStoreRef.current)) return;");
    expect(app).toContain("setActiveTabId={activateWorkspaceTab}");
    expect(app).toContain("tabSwitchBlocked={tabSwitchBlocked}");
  });

  it("stands the focus reconcile down while a mutation is settling", () => {
    // Every extra listing counts as one that did not confirm an open hide, so the
    // outside-deletion reconcile must not run against a workspace mid-settle.
    const focus = app.slice(
      app.indexOf("const lastFocusRefreshRef = useRef(0);"),
      app.indexOf("// Tracks each tab's running-agent flag"),
    );
    expect(focus).toContain("if (hasOpenSessionIntent(sessionsStoreRef.current)) return;");
    expect(focus.indexOf("hasOpenSessionIntent")).toBeLessThan(focus.indexOf("requestSessionList"));
  });
});
