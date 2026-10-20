import { describe, expect, it, vi } from "vitest";
import { PauseGate } from "../src/core/pause-gate.js";
import type { PauseRequest } from "../src/core/pause-gate.js";
import { NEVER_ASK_PICKER_COUNTDOWN_MS, autoResolveVerdict } from "../src/core/pause-policy.js";

// Mirrors the never-ask listener body in src/cli/commands/desktop.ts (the
// desktop backend's pause-gate bridge).
function makeListener(
  opts: { yolo?: boolean; enableChoiceTimer?: boolean },
  configEditMode: "read-only" | "follow" | "never-ask",
) {
  return (gate: PauseGate, onBridge: (reqId: number) => void) => {
    gate.on((req) => {
      const editMode = opts.yolo ? "never-ask" : configEditMode;
      const auto = autoResolveVerdict(req, editMode, {
        enableChoiceTimer: opts.enableChoiceTimer,
      });
      if (auto?.kind === "instant") {
        gate.resolve(req.id, auto.verdict as never);
        return;
      }
      if (auto?.kind === "countdown") {
        setTimeout(() => gate.resolve(req.id, auto.verdict as never), auto.ms);
      }
      onBridge(req.id);
    });
  };
}

describe("autoResolveVerdict (never-ask mode)", () => {
  it("uses a 30-second manual override window for interactive gates", () => {
    expect(NEVER_ASK_PICKER_COUNTDOWN_MS).toBe(30_000);
  });

  /** One sample per pause kind, so this suite covers every gate instead of only the
   *  three pickers. Compiler-enforced exhaustiveness lives in NEVER_ASK_RULES (the
   *  policy), because tests are outside the root tsconfig's include. */
  const SAMPLES: Record<
    PauseRequest["kind"],
    { payload: unknown; behavior: "countdown" | "instant" | "manual" }
  > = {
    run_command: { payload: { command: "ls" }, behavior: "instant" },
    run_background: { payload: { command: "npm dev" }, behavior: "instant" },
    path_access: {
      payload: {
        path: "/tmp/x",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/work",
        allowPrefix: "/tmp",
      },
      behavior: "instant",
    },
    edit: {
      payload: {
        path: "/work/a.ts",
        toolName: "edit_file",
        sandboxRoot: "/work",
        allowPrefix: "/work",
      },
      behavior: "manual",
    },
    outlook_send: {
      payload: {
        toolName: "send-mail",
        from: "a@b.c",
        to: [],
        cc: [],
        bcc: [],
        subject: "s",
        body: "b",
        attachments: [],
      },
      behavior: "manual",
    },
    plan_checkpoint: { payload: { stepId: "s1", result: "done" }, behavior: "instant" },
    plan_proposed: { payload: { plan: "p", steps: [{ id: "s1" }] }, behavior: "countdown" },
    plan_revision: {
      payload: { reason: "why", remainingSteps: [{ id: "s2" }] },
      behavior: "countdown",
    },
    choice: {
      payload: { question: "q", options: [{ id: "a", title: "A" }], allowCustom: false },
      behavior: "countdown",
    },
  };

  const sampleRequest = (kind: PauseRequest["kind"]): PauseRequest => ({
    id: 1,
    kind,
    payload: SAMPLES[kind].payload,
  });

  it("gives every pause kind an explicit never-ask outcome, all pickers on one window", () => {
    for (const [kind, sample] of Object.entries(SAMPLES)) {
      const outcome = autoResolveVerdict(sampleRequest(kind as PauseRequest["kind"]), "never-ask");
      if (sample.behavior === "manual") {
        expect(outcome, kind).toBeNull();
        continue;
      }
      expect(outcome?.kind, kind).toBe(sample.behavior);
      if (outcome?.kind === "countdown") {
        expect(outcome.ms, kind).toBe(NEVER_ASK_PICKER_COUNTDOWN_MS);
      }
    }
  });

  it("auto-advances every picker to its first option", () => {
    const verdictOf = (kind: PauseRequest["kind"]) =>
      autoResolveVerdict(sampleRequest(kind), "never-ask")?.verdict;
    expect(verdictOf("plan_checkpoint")).toEqual({ type: "continue" });
    expect(verdictOf("plan_proposed")).toEqual({ type: "approve" });
    expect(verdictOf("plan_revision")).toEqual({ type: "accepted" });
    expect(verdictOf("choice")).toEqual({ type: "pick", optionId: "a" });
  });

  it("leaves gates alone outside never-ask, so read-only and follow still ask", () => {
    for (const kind of Object.keys(SAMPLES) as PauseRequest["kind"][]) {
      const req = sampleRequest(kind);
      expect(autoResolveVerdict(req, "read-only"), `${kind} read-only`).toBeNull();
      // Checkpoints auto-continue in follow too - it mirrors shell.ts's allowAll.
      const follow = autoResolveVerdict(req, "follow");
      const behavior = follow === null ? "manual" : follow.kind;
      expect(behavior, `${kind} follow`).toBe(kind === "plan_checkpoint" ? "instant" : "manual");
    }
  });

  it("surfaces an unknown gate kind instead of throwing (a caller outside the types)", () => {
    const req = { id: 1, kind: "not_a_gate", payload: {} } as unknown as PauseRequest;
    // A throw here would be swallowed by the gate listener and strand the caller.
    expect(autoResolveVerdict(req, "never-ask")).toBeNull();
  });

  it("auto-continues plan_checkpoint when opts.yolo is true even if config says read-only", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "read-only")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "plan_checkpoint",
      payload: { stepId: "s1", result: "done" },
    });

    await expect(promise).resolves.toEqual({ type: "continue" });
    expect(bridged).toBe(false);
  });

  it("bridges plan_checkpoint to the client when opts.yolo is false and config is read-only", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "read-only")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "continue" } as never);
    });

    await gate.ask({ kind: "plan_checkpoint", payload: { stepId: "s1", result: "done" } });
    expect(bridgedReqId).not.toBeNull();
  });

  it("falls back to config editMode when opts.yolo is undefined", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({}, "follow")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "plan_checkpoint",
      payload: { stepId: "s1", result: "done" },
    });
    await expect(promise).resolves.toEqual({ type: "continue" });
    expect(bridged).toBe(false);
  });

  it("auto-resolves run_command (run_once) with --yolo - shell.ts's allowAll closure can't see --yolo when config still says read-only (#1448)", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "read-only")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({ kind: "run_command", payload: { command: "rm -rf /" } });
    await expect(promise).resolves.toEqual({ type: "run_once" });
    expect(bridged).toBe(false);
  });

  it("never auto-resolves Outlook sends in never-ask mode", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: true }, "read-only")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "deny" } as never);
    });

    const result = await gate.ask({
      kind: "outlook_send",
      payload: {
        toolName: "send-mail",
        from: "sender@outlook.com",
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Application",
        body: "Complete body",
        attachments: ["CV.pdf"],
      },
    });
    expect(bridgedReqId).not.toBeNull();
    expect(result).toEqual({ type: "deny" });
  });

  it("auto-resolves run_background (run_once) with --yolo for the same reason", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "read-only")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "run_background",
      payload: { command: "npm dev", cwd: "/work" },
    });
    await expect(promise).resolves.toEqual({ type: "run_once" });
    expect(bridged).toBe(false);
  });

  it("bridges run_command to the client in follow mode (only never-ask bypasses)", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "follow")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "deny" } as never);
    });

    await gate.ask({ kind: "run_command", payload: { command: "ls" } });
    expect(bridgedReqId).not.toBeNull();
  });

  it("auto-allows path_access (run_once) when yolo - mirrors shell.ts allowAll bypass", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "read-only")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "path_access",
      payload: {
        path: "/tmp/foo",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/work",
        allowPrefix: "/tmp",
      },
    });
    await expect(promise).resolves.toEqual({ type: "run_once" });
    expect(bridged).toBe(false);
  });

  it("bridges path_access to the client in follow mode (only never-ask bypasses)", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "follow")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "deny" } as never);
    });

    await gate.ask({
      kind: "path_access",
      payload: {
        path: "/etc/passwd",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/work",
        allowPrefix: "/etc",
      },
    });
    expect(bridgedReqId).not.toBeNull();
  });

  it("counts down before auto-approving plan_proposed with --yolo - the host gets a 30s window to override", async () => {
    vi.useFakeTimers();
    try {
      const gate = new PauseGate();
      let bridged = false;
      makeListener({ yolo: true }, "read-only")(gate, () => {
        bridged = true;
      });

      const promise = gate.ask({
        kind: "plan_proposed",
        payload: { plan: "Step 1\nStep 2", steps: [{ id: "s1" }, { id: "s2" }], summary: "do it" },
      });

      // Not resolved instantly - the picker gets its full countdown window.
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(NEVER_ASK_PICKER_COUNTDOWN_MS - 1);
      expect(settled).toBe(false);
      expect(bridged).toBe(true);

      // First option (approve) is auto-selected when the window elapses.
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toEqual({ type: "approve" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bridges plan_proposed to the client in follow mode (only never-ask bypasses)", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "follow")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "approve" } as never);
    });

    await gate.ask({
      kind: "plan_proposed",
      payload: { plan: "Step 1" },
    });
    expect(bridgedReqId).not.toBeNull();
  });

  it("auto-accepts plan_revision (REWRITE) after the countdown with --yolo - previously stalled forever", async () => {
    vi.useFakeTimers();
    try {
      const gate = new PauseGate();
      let bridged = false;
      makeListener({ yolo: true }, "read-only")(gate, () => {
        bridged = true;
      });

      const promise = gate.ask({
        kind: "plan_revision",
        payload: { reason: "scope changed", remainingSteps: [{ id: "s2" }], summary: "rev" },
      });

      // The rewrite picker used to hang indefinitely in never-ask; now the
      // first option (accept rewrite) is auto-selected once the window elapses.
      await vi.advanceTimersByTimeAsync(NEVER_ASK_PICKER_COUNTDOWN_MS);
      await expect(promise).resolves.toEqual({ type: "accepted" });
      expect(bridged).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still bridges plan_revision in read-only mode - the countdown is never-ask-only", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "read-only")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "rejected" } as never);
    });

    const promise = gate.ask({
      kind: "plan_revision",
      payload: { reason: "scope changed", remainingSteps: [{ id: "s2" }] },
    });
    await expect(promise).resolves.toEqual({ type: "rejected" });
    expect(bridgedReqId).not.toBeNull();
  });

  it("counts down and auto-picks the first ask_choice option by default with --yolo - same window as the plan gates", async () => {
    vi.useFakeTimers();
    try {
      const gate = new PauseGate();
      let bridged = false;
      makeListener({ yolo: true }, "read-only")(gate, () => {
        bridged = true;
      });

      const promise = gate.ask({
        kind: "choice",
        payload: {
          question: "Which approach?",
          options: [
            { id: "option-1", title: "First" },
            { id: "option-2", title: "Second" },
          ],
          allowCustom: true,
        },
      });

      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(NEVER_ASK_PICKER_COUNTDOWN_MS - 1);
      expect(settled).toBe(false);
      expect(bridged).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toEqual({ type: "pick", optionId: "option-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a manual pick when the host explicitly opts out of the choice timer", async () => {
    vi.useFakeTimers();
    try {
      const gate = new PauseGate();
      let bridged = false;
      makeListener({ yolo: true, enableChoiceTimer: false }, "read-only")(gate, () => {
        bridged = true;
      });

      const promise = gate.ask({
        kind: "choice",
        payload: {
          question: "Which approach?",
          options: [
            { id: "option-1", title: "First" },
            { id: "option-2", title: "Second" },
          ],
          allowCustom: true,
        },
      });

      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(NEVER_ASK_PICKER_COUNTDOWN_MS + 5_000);
      expect(settled).toBe(false);
      expect(bridged).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a manual choice made during the countdown instead of overwriting it at expiry", async () => {
    vi.useFakeTimers();
    try {
      const gate = new PauseGate();
      let bridgedReqId: number | null = null;
      makeListener({ yolo: true }, "read-only")(gate, (id) => {
        bridgedReqId = id;
      });

      const promise = gate.ask({
        kind: "choice",
        payload: {
          question: "Which approach?",
          options: [
            { id: "option-1", title: "First" },
            { id: "option-2", title: "Second" },
          ],
          allowCustom: true,
        },
      });

      await vi.advanceTimersByTimeAsync(NEVER_ASK_PICKER_COUNTDOWN_MS - 1_000);
      expect(bridgedReqId).not.toBeNull();
      gate.resolve(bridgedReqId!, { type: "pick", optionId: "option-2" });
      await expect(promise).resolves.toEqual({ type: "pick", optionId: "option-2" });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(promise).resolves.toEqual({ type: "pick", optionId: "option-2" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a malformed choice (no well-formed options) rather than hanging by default", async () => {
    const gate = new PauseGate();
    let bridged = false;
    makeListener({ yolo: true }, "read-only")(gate, () => {
      bridged = true;
    });

    const promise = gate.ask({
      kind: "choice",
      payload: { question: "Which approach?", options: [], allowCustom: true },
    });
    await expect(promise).resolves.toEqual({ type: "cancel" });
    expect(bridged).toBe(false);
  });

  it("bridges ask_choice to the client in follow mode (only never-ask bypasses)", async () => {
    const gate = new PauseGate();
    let bridgedReqId: number | null = null;
    makeListener({ yolo: false }, "follow")(gate, (id) => {
      bridgedReqId = id;
      gate.resolve(id, { type: "pick", optionId: "option-1" } as never);
    });

    await gate.ask({
      kind: "choice",
      payload: {
        question: "Which approach?",
        options: [{ id: "option-1", title: "First" }],
        allowCustom: true,
      },
    });
    expect(bridgedReqId).not.toBeNull();
  });
});
