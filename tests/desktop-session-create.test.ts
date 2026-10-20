import { describe, expect, it } from "vitest";
import {
  SESSION_CREATION_IN_FLIGHT_MESSAGE,
  newSessionCreationGate,
} from "../src/cli/commands/desktop.js";

describe("desktop — one session creation at a time per workspace", () => {
  it("refuses the second half of a double action", () => {
    const gate = newSessionCreationGate();
    expect(gate.tryEnter("/repo/alpha")).toBe(true);
    expect(gate.tryEnter("/repo/alpha")).toBe(false);
  });

  it("reopens as soon as the first creation has landed", () => {
    const gate = newSessionCreationGate();
    expect(gate.tryEnter("/repo/alpha")).toBe(true);
    gate.leave("/repo/alpha");
    expect(gate.tryEnter("/repo/alpha")).toBe(true);
  });

  it("only locks the workspace that is creating", () => {
    const gate = newSessionCreationGate();
    expect(gate.tryEnter("/repo/alpha")).toBe(true);
    expect(gate.tryEnter("/repo/beta")).toBe(true);
    gate.leave("/repo/beta");
    expect(gate.tryEnter("/repo/beta")).toBe(true);
    // Releasing beta must not release the workspace still minting its session.
    expect(gate.tryEnter("/repo/alpha")).toBe(false);
  });

  it("treats a relative and an absolute path to the same workspace as one", () => {
    const gate = newSessionCreationGate();
    expect(gate.tryEnter(".")).toBe(true);
    expect(gate.tryEnter(process.cwd())).toBe(false);
  });

  it("shares one refusal wording that names the wait", () => {
    expect(SESSION_CREATION_IN_FLIGHT_MESSAGE).toMatch(/already being created/i);
  });
});
