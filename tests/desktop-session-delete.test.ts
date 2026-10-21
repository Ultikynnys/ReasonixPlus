import { describe, expect, it } from "vitest";
import {
  NO_WORKSPACE_MESSAGE,
  deletableSessionNames,
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

  it("leaves a running session out of a clear-all", () => {
    const doomed = deletableSessionNames(["working", "idle", "older"], new Set(["working"]));
    expect(doomed).toEqual(["idle", "older"]);
  });

  it("ships a refusal that names the session and the way out", () => {
    const message = sessionRunningRefusal("working");
    expect(message).toContain("working");
    expect(message).toMatch(/running/i);
    expect(message).toMatch(/stop/i);
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
