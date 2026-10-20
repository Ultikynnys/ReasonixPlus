import { describe, expect, it } from "vitest";
import {
  WORKSPACE_REMOVE_BLOCKED_MESSAGE,
  WORKSPACE_SWITCH_BLOCKED_MESSAGE,
  newSessionCreationGate,
  newWorkspaceSessionWork,
} from "../src/cli/commands/desktop.js";

describe("desktop — a workspace busy with session work", () => {
  it("stays busy until every booking is released", () => {
    const work = newWorkspaceSessionWork();
    const first = work.begin("/repo/alpha");
    work.begin("/repo/alpha");
    expect(work.isBusy("/repo/alpha")).toBe(true);

    first();
    expect(work.isBusy("/repo/alpha")).toBe(true);
  });

  it("cannot be released twice out from under another booking", () => {
    // A double release must be a no-op for ITS booking: with a bare refcount the
    // second call would drop the other channel's live booking to zero and let a
    // workspace switch through mid-clear.
    const work = newWorkspaceSessionWork();
    const alpha = work.begin("/repo/alpha");
    work.begin("/repo/alpha");

    alpha();
    alpha();
    expect(work.isBusy("/repo/alpha")).toBe(true);
  });

  it("only marks the workspace that booked work", () => {
    const work = newWorkspaceSessionWork();
    const alpha = work.begin("/repo/alpha");
    expect(work.isBusy("/repo/beta")).toBe(false);
    alpha();
    expect(work.isBusy("/repo/alpha")).toBe(false);
  });

  it("treats a relative and an absolute path to one workspace as the same booking", () => {
    const work = newWorkspaceSessionWork();
    const release = work.begin(process.cwd());
    expect(work.isBusy(".")).toBe(true);
    release();
    expect(work.isBusy(".")).toBe(false);
  });

  it("counts a creation as work in the workspace the switch would leave", () => {
    const gate = newSessionCreationGate();
    expect(gate.isBusy("/repo/alpha")).toBe(false);
    expect(gate.tryEnter("/repo/alpha")).toBe(true);
    expect(gate.isBusy("/repo/alpha")).toBe(true);
    gate.leave("/repo/alpha");
    expect(gate.isBusy("/repo/alpha")).toBe(false);
  });

  it("ships refusals that name the wait", () => {
    expect(WORKSPACE_SWITCH_BLOCKED_MESSAGE).toMatch(/created or deleted/i);
    expect(WORKSPACE_REMOVE_BLOCKED_MESSAGE).toMatch(/creating or deleting/i);
  });
});
