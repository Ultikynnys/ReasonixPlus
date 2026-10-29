// Consolidated from 7 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, Usage, normalizeStopReason } from "../src/client.js";
import { InflightSet } from "../src/core/inflight.js";
import { type ConfirmationChoice, PauseGate, type PauseRequest } from "../src/core/pause-gate.js";
import { NEVER_ASK_PICKER_COUNTDOWN_MS, autoResolveVerdict } from "../src/core/pause-policy.js";
import { isRetryableProviderFailure } from "../src/core/retry-shared.js";
import { CacheFirstLoop } from "../src/loop.js";
import type { LoopEvent } from "../src/loop/types.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { fetchWithRetry, fetchWithRetryProgress } from "../src/retry.js";
import {
  DEFAULT_SPAWN_STORM_THRESHOLD,
  type SpawnDistillation,
  SubagentTelemetry,
  computeSpawnDistillation,
  countSpawnStorms,
  summarizeSubagentSession,
} from "../src/telemetry/subagent-distillation.js";
import { countTokens } from "../src/tokenizer.js";
import { RegexRunner } from "../src/tools/fs/regex-runner.js";
import type { SubagentResult } from "../src/tools/subagent.js";

// Tests for the PauseGate core — ask/resolve/on/current.
describe("pause-gate", () => {
  describe("PauseGate", () => {
    it("ask creates a pending request and notifies listeners", async () => {
      const gate = new PauseGate();
      const listener = vi.fn();
      gate.on(listener);

      const promise = gate.ask({ kind: "run_command", payload: { command: "echo hi" } });
      expect(listener).toHaveBeenCalledTimes(1);
      const req = listener.mock.calls[0]![0]! as { id: number; kind: string; payload: unknown };
      expect(req.kind).toBe("run_command");
      expect((req.payload as { command: string }).command).toBe("echo hi");
      expect(gate.current).not.toBeNull();
      expect(gate.current?.kind).toBe("run_command");

      gate.resolve(req.id, { type: "run_once" } as ConfirmationChoice);
      await expect(promise).resolves.toEqual({ type: "run_once" });
      expect(gate.current).toBeNull();
    });

    it("resolve with unknown id is a no-op (does not throw)", () => {
      const gate = new PauseGate();
      expect(() => gate.resolve(999, { type: "cancel" })).not.toThrow();
    });

    it("on() returns an unsubscribe function", async () => {
      const gate = new PauseGate();
      const listener = vi.fn();
      const unsub = gate.on(listener);
      unsub();

      // After unsubscribe, ask should throw (no listeners)
      expect(() => gate.ask({ kind: "run_command", payload: { command: "test" } })).toThrow(
        "no confirmation listener",
      );
      expect(listener).not.toHaveBeenCalled();
    });

    it("supports all pause kinds with their payload shapes", async () => {
      const gate = new PauseGate();
      const listener = vi.fn();
      gate.on(listener);

      const entries: Array<{ opts: { kind: string; payload: Record<string, unknown> } }> = [
        { opts: { kind: "run_command", payload: { command: "x" } } },
        { opts: { kind: "plan_proposed", payload: { plan: "#", steps: [], summary: "test" } } },
        { opts: { kind: "plan_checkpoint", payload: { stepId: "s1", result: "done" } } },
        { opts: { kind: "plan_revision", payload: { reason: "r", remainingSteps: [] } } },
        { opts: { kind: "choice", payload: { question: "q", options: [], allowCustom: false } } },
      ];

      for (const { opts } of entries) {
        const p = gate.ask(opts as any);
        const req = listener.mock.lastCall?.[0] as { kind: string };
        expect(req.kind).toBe(opts.kind);
        gate.resolve(req.id, { type: "run_once" } as ConfirmationChoice);
        await expect(p).resolves.toBeDefined();
      }
    });

    it("listener errors do not break the gate", async () => {
      const gate = new PauseGate();
      gate.on(() => {
        throw new Error("listener crash");
      });
      const listener2 = vi.fn();
      gate.on(listener2);

      const promise = gate.ask({ kind: "run_command", payload: { command: "crash" } });
      // Second listener should still fire despite the first throwing
      expect(listener2).toHaveBeenCalledTimes(1);
      const req = listener2.mock.calls[0]![0]! as { id: number };
      gate.resolve(req.id, { type: "run_once" } as ConfirmationChoice);
      await expect(promise).resolves.toEqual({ type: "run_once" });
    });

    it("CheckpointVerdict carries feedback on revise", async () => {
      const gate = new PauseGate();
      gate.on(() => {});

      const promise = gate.ask({
        kind: "plan_checkpoint",
        payload: { stepId: "step-1", result: "done" },
      });
      const req = gate.current!;
      gate.resolve(req.id, { type: "revise", feedback: "rename to auth-tokens.ts instead" });
      await expect(promise).resolves.toEqual({
        type: "revise",
        feedback: "rename to auth-tokens.ts instead",
      });
    });

    it("CheckpointVerdict revise without feedback is accepted", async () => {
      const gate = new PauseGate();
      gate.on(() => {});

      const promise = gate.ask({
        kind: "plan_checkpoint",
        payload: { stepId: "step-2", result: "added tests" },
      });
      const req = gate.current!;
      // Bare revise — no feedback string
      gate.resolve(req.id, { type: "revise" });
      await expect(promise).resolves.toEqual({ type: "revise" });
    });

    it("multiple pending requests queue independently", async () => {
      const gate = new PauseGate();
      const listener = vi.fn();
      gate.on(listener);

      const p1 = gate.ask({ kind: "run_command", payload: { command: "first" } });
      const p2 = gate.ask({ kind: "run_command", payload: { command: "second" } });

      // current should return the first one (FIFO by insertion order)
      expect((gate.current?.payload as { command: string }).command).toBe("first");

      const calls = listener.mock.calls;
      const id1 = (calls[0]![0]! as { id: number }).id;
      const id2 = (calls[1]![0]! as { id: number }).id;

      // Resolve in reverse order — should still work independently
      gate.resolve(id2, { type: "deny" } as ConfirmationChoice);
      gate.resolve(id1, { type: "run_once" } as ConfirmationChoice);

      await expect(p1).resolves.toEqual({ type: "run_once" });
      await expect(p2).resolves.toEqual({ type: "deny" });
      expect(gate.current).toBeNull();
    });

    it("emits audit events for run_once / deny / always_allow shell decisions", async () => {
      const gate = new PauseGate();
      const audit = vi.fn();
      gate.setAuditListener(audit);
      gate.on(() => {});

      const allow = gate.ask({ kind: "run_command", payload: { command: "npm test" } });
      gate.resolve(gate.current!.id, { type: "run_once" } as ConfirmationChoice);
      await expect(allow).resolves.toEqual({ type: "run_once" });

      const deny = gate.ask({ kind: "run_background", payload: { command: "npm run dev" } });
      gate.resolve(gate.current!.id, {
        type: "deny",
        denyContext: "too risky",
      } as ConfirmationChoice);
      await expect(deny).resolves.toEqual({ type: "deny", denyContext: "too risky" });

      const always = gate.ask({ kind: "run_command", payload: { command: "npm run lint" } });
      gate.resolve(gate.current!.id, {
        type: "always_allow",
        prefix: "npm run",
      } as ConfirmationChoice);
      await expect(always).resolves.toEqual({ type: "always_allow", prefix: "npm run" });

      expect(audit.mock.calls).toEqual([
        [
          {
            type: "tool.confirm.allow",
            kind: "run_command",
            payload: { command: "npm test" },
          },
        ],
        [
          {
            type: "tool.confirm.deny",
            kind: "run_background",
            payload: { command: "npm run dev" },
            denyContext: "too risky",
          },
        ],
        [
          {
            type: "tool.confirm.always_allow",
            kind: "run_command",
            payload: { command: "npm run lint" },
            prefix: "npm run",
          },
        ],
      ]);
    });

    it("cancelAll resolves every pending request with its kind's safe-cancel verdict", async () => {
      const gate = new PauseGate();
      gate.on(() => {});

      const shell = gate.ask({ kind: "run_command", payload: { command: "rm -rf /" } });
      const plan = gate.ask({ kind: "plan_proposed", payload: { plan: "#", steps: [] } });
      const cp = gate.ask({ kind: "plan_checkpoint", payload: { stepId: "s1", result: "ok" } });
      const rev = gate.ask({ kind: "plan_revision", payload: { reason: "r", remainingSteps: [] } });
      const ch = gate.ask({
        kind: "choice",
        payload: { question: "q", options: [], allowCustom: false },
      });

      gate.cancelAll();

      await expect(shell).resolves.toEqual({ type: "deny" });
      await expect(plan).resolves.toEqual({ type: "cancel" });
      await expect(cp).resolves.toEqual({ type: "stop" });
      await expect(rev).resolves.toEqual({ type: "cancelled" });
      await expect(ch).resolves.toEqual({ type: "cancel" });
      expect(gate.current).toBeNull();
    });

    it("cancelAll on an empty gate is a no-op", () => {
      const gate = new PauseGate();
      gate.on(() => {});
      expect(() => gate.cancelAll()).not.toThrow();
      expect(gate.current).toBeNull();
    });

    it("does not emit audit events for non-tool pauses", async () => {
      const gate = new PauseGate();
      const audit = vi.fn();
      gate.setAuditListener(audit);
      gate.on(() => {});

      const promise = gate.ask({
        kind: "plan_proposed",
        payload: { plan: "# Plan", steps: [], summary: "ship it" },
      });
      gate.resolve(gate.current!.id, { type: "approve" });
      await expect(promise).resolves.toEqual({ type: "approve" });
      expect(audit).not.toHaveBeenCalled();
    });
  });
});

describe("pause-policy", () => {
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
        const outcome = autoResolveVerdict(
          sampleRequest(kind as PauseRequest["kind"]),
          "never-ask",
        );
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
          payload: {
            plan: "Step 1\nStep 2",
            steps: [{ id: "s1" }, { id: "s2" }],
            summary: "do it",
          },
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
});

describe("retry", () => {
  function makeFetch(responses: Array<Response | Error | (() => Response | Error)>): {
    fn: typeof fetch;
    calls: number;
  } {
    let i = 0;
    const fn = vi.fn(async () => {
      const r = responses[i++] ?? responses[responses.length - 1]!;
      const resolved = typeof r === "function" ? r() : r;
      if (resolved instanceof Error) throw resolved;
      return resolved;
    }) as unknown as typeof fetch;
    return {
      fn,
      get calls() {
        return (fn as any).mock.calls.length as number;
      },
    };
  }

  const BASE: Parameters<typeof fetchWithRetry>[3] = { initialBackoffMs: 1, maxBackoffMs: 50 };

  describe("fetchWithRetry", () => {
    it("returns immediately on success", async () => {
      const f = makeFetch([new Response("ok", { status: 200 })]);
      const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
      expect(r.status).toBe(200);
      expect(f.calls).toBe(1);
    });

    it("retries on 429 and succeeds", async () => {
      const f = makeFetch([
        new Response("", { status: 429 }),
        new Response("", { status: 429 }),
        new Response("ok", { status: 200 }),
      ]);
      const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
      expect(r.status).toBe(200);
      expect(f.calls).toBe(3);
    });

    it("retries on 503 and eventually surfaces the failure", async () => {
      const f = makeFetch([
        new Response("", { status: 503 }),
        new Response("", { status: 503 }),
        new Response("", { status: 503 }),
      ]);
      const r = await fetchWithRetry(f.fn, "https://x", {}, { ...BASE, maxAttempts: 3 });
      expect(r.status).toBe(503);
      expect(f.calls).toBe(3);
    });

    it("does NOT retry on 401 Unauthorized", async () => {
      const f = makeFetch([new Response("bad key", { status: 401 })]);
      const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
      expect(r.status).toBe(401);
      expect(f.calls).toBe(1);
    });

    it("does NOT retry on 400 Bad Request", async () => {
      const f = makeFetch([new Response("oops", { status: 400 })]);
      const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
      expect(r.status).toBe(400);
      expect(f.calls).toBe(1);
    });

    it("retries on network error and recovers", async () => {
      const f = makeFetch([new TypeError("fetch failed"), new Response("ok", { status: 200 })]);
      const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
      expect(r.status).toBe(200);
      expect(f.calls).toBe(2);
    });

    it("gives up after maxAttempts and rethrows the last network error", async () => {
      const err = new TypeError("dns lookup failed");
      const f = makeFetch([err, err, err]);
      await expect(
        fetchWithRetry(f.fn, "https://x", {}, { ...BASE, maxAttempts: 3 }),
      ).rejects.toThrow(/dns lookup failed/);
      expect(f.calls).toBe(3);
    });

    it("does NOT retry when request is aborted", async () => {
      const ctrl = new AbortController();
      const abortErr = new Error("user aborted");
      abortErr.name = "AbortError";
      const f = makeFetch([abortErr]);
      await expect(
        fetchWithRetry(
          f.fn,
          "https://x",
          { signal: ctrl.signal },
          { ...BASE, signal: ctrl.signal },
        ),
      ).rejects.toThrow();
      expect(f.calls).toBe(1);
    });

    it("honours Retry-After header within the cap", async () => {
      const f = makeFetch([
        new Response("", {
          status: 429,
          headers: { "Retry-After": "0.05" },
        }),
        new Response("ok", { status: 200 }),
      ]);
      const started = Date.now();
      const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
      const elapsed = Date.now() - started;
      expect(r.status).toBe(200);
      // Retry-After of 0.05s = 50ms. Allow some scheduler slack.
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it("fires onRetry callback between attempts", async () => {
      const onRetry = vi.fn();
      const f = makeFetch([new Response("", { status: 429 }), new Response("ok", { status: 200 })]);
      await fetchWithRetry(f.fn, "https://x", {}, { ...BASE, onRetry });
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry.mock.calls[0]![0].reason).toMatch(/http 429/);
    });

    it("maxAttempts=1 effectively disables retry", async () => {
      const f = makeFetch([new Response("", { status: 503 })]);
      const r = await fetchWithRetry(f.fn, "https://x", {}, { ...BASE, maxAttempts: 1 });
      expect(r.status).toBe(503);
      expect(f.calls).toBe(1);
    });

    it("fetchWithRetryProgress reports each wait BEFORE taking it", async () => {
      const f = makeFetch([new Response("", { status: 429 }), new Response("ok", { status: 200 })]);
      const waits = fetchWithRetryProgress(f.fn, "https://x", {}, BASE);

      const first = await waits.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({ attempt: 1, reason: "http 429" });
      // Announced while the request is still unanswered: one attempt so far, not two.
      expect(f.calls).toBe(1);

      const settled = await waits.next();
      expect(settled.done).toBe(true);
      expect((settled.value as Response).status).toBe(200);
    });

    it("fetchWithRetryProgress yields nothing when the first attempt succeeds", async () => {
      const f = makeFetch([new Response("ok", { status: 200 })]);
      const waits = fetchWithRetryProgress(f.fn, "https://x", {}, BASE);
      const only = await waits.next();

      expect(only.done).toBe(true);
      expect((only.value as Response).status).toBe(200);
    });
  });

  describe("isRetryableProviderFailure", () => {
    it("recognizes the OpenCode upstream-failure error the loop surfaces", () => {
      expect(
        isRetryableProviderFailure(
          "OpenCode 500: Upstream request failed: [server_error] The model failed to generate a response.",
        ),
      ).toBe(true);
    });

    it("recognizes retryable status lines under any provider brand", () => {
      expect(isRetryableProviderFailure("DeepSeek 429: rate limited")).toBe(true);
      expect(isRetryableProviderFailure("OpenCode 503: overloaded")).toBe(true);
      expect(isRetryableProviderFailure("Z.AI 502: bad gateway")).toBe(true);
    });

    it("rejects 4xx request rejections and unknown errors", () => {
      expect(isRetryableProviderFailure("OpenCode 400: bad request")).toBe(false);
      expect(isRetryableProviderFailure("DeepSeek 401: bad key")).toBe(false);
      expect(isRetryableProviderFailure("TypeError: cannot read properties of undefined")).toBe(
        false,
      );
    });

    it("recognizes upstream-relayed failure phrases even without a status line", () => {
      expect(
        isRetryableProviderFailure(
          "Upstream request failed: [server_error] The model failed to generate a response.",
        ),
      ).toBe(true);
    });
  });
});

// InflightSet — finally-driven cleanup contract.
describe("inflight", () => {
  describe("InflightSet", () => {
    it("add / has / delete round-trips", () => {
      const s = new InflightSet();
      expect(s.has("a")).toBe(false);
      s.add("a");
      expect(s.has("a")).toBe(true);
      expect(s.size).toBe(1);
      s.delete("a");
      expect(s.has("a")).toBe(false);
      expect(s.size).toBe(0);
    });

    it("add is idempotent — re-adding the same id is a no-op + does not re-notify", () => {
      const s = new InflightSet();
      const sub = vi.fn();
      s.subscribe(sub);
      s.add("a");
      s.add("a");
      s.add("a");
      expect(sub).toHaveBeenCalledTimes(1);
    });

    it("delete on a missing id does not notify", () => {
      const s = new InflightSet();
      const sub = vi.fn();
      s.subscribe(sub);
      s.delete("never-added");
      expect(sub).not.toHaveBeenCalled();
    });

    it("subscribe fires on add and on delete", () => {
      const s = new InflightSet();
      const sub = vi.fn();
      s.subscribe(sub);
      s.add("a");
      s.add("b");
      s.delete("a");
      expect(sub).toHaveBeenCalledTimes(3);
    });

    it("subscribe returns an unsubscribe function", () => {
      const s = new InflightSet();
      const sub = vi.fn();
      const unsub = s.subscribe(sub);
      s.add("a");
      expect(sub).toHaveBeenCalledTimes(1);
      unsub();
      s.add("b");
      expect(sub).toHaveBeenCalledTimes(1);
    });

    it("listener errors do not propagate or break further notifications", () => {
      const s = new InflightSet();
      s.subscribe(() => {
        throw new Error("boom");
      });
      const ok = vi.fn();
      s.subscribe(ok);
      expect(() => s.add("a")).not.toThrow();
      expect(ok).toHaveBeenCalledTimes(1);
    });

    it("clear empties the set and notifies once", () => {
      const s = new InflightSet();
      s.add("a");
      s.add("b");
      const sub = vi.fn();
      s.subscribe(sub);
      s.clear();
      expect(s.size).toBe(0);
      expect(s.has("a")).toBe(false);
      expect(s.has("b")).toBe(false);
      expect(sub).toHaveBeenCalledTimes(1);
    });

    it("clear on an empty set is a no-op + does not notify", () => {
      const s = new InflightSet();
      const sub = vi.fn();
      s.subscribe(sub);
      s.clear();
      expect(sub).not.toHaveBeenCalled();
    });

    it("models the finally contract — id is removed even when work throws", async () => {
      const s = new InflightSet();
      const work = async () => {
        s.add("job-1");
        try {
          throw new Error("simulated tool failure");
        } finally {
          s.delete("job-1");
        }
      };
      await expect(work()).rejects.toThrow("simulated tool failure");
      // The whole point of the refactor: regardless of how the work exits,
      // the inflight bit is gone, so the spinner stops.
      expect(s.has("job-1")).toBe(false);
      expect(s.size).toBe(0);
    });

    it("models the finally contract — id is removed when work is aborted mid-flight", async () => {
      const s = new InflightSet();
      const ctl = new AbortController();
      const work = async (signal: AbortSignal) => {
        s.add("abortable");
        try {
          // Simulated tool that hangs until the signal fires.
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted before await"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        } finally {
          s.delete("abortable");
        }
      };
      const promise = work(ctl.signal);
      expect(s.has("abortable")).toBe(true);
      ctl.abort();
      await expect(promise).rejects.toThrow();
      expect(s.has("abortable")).toBe(false);
    });

    it("parallel adds with concurrent settle — every id leaves the set on completion", async () => {
      const s = new InflightSet();
      const work = async (id: string, ms: number, fail: boolean) => {
        s.add(id);
        try {
          await new Promise((r) => setTimeout(r, ms));
          if (fail) throw new Error(`${id} failed`);
        } finally {
          s.delete(id);
        }
      };
      const settled = await Promise.allSettled([
        work("a", 5, false),
        work("b", 1, true),
        work("c", 3, false),
      ]);
      expect(settled.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
      expect(s.size).toBe(0);
    });

    it("startedBefore reports only the ids inserted before it", () => {
      const s = new InflightSet();
      s.add("older");
      s.add("self");
      s.add("newer");
      expect(s.startedBefore("self")).toEqual(["older"]);
      // An id the set never saw has no predecessor boundary: everything running is older.
      expect(s.startedBefore("untracked")).toEqual(["older", "self", "newer"]);
    });

    it("settledBefore waits for older work and ignores work that started later", async () => {
      const s = new InflightSet();
      s.add("older");
      s.add("self");
      s.add("newer");
      let settled = false;
      const waiting = s.settledBefore("self").then(() => {
        settled = true;
      });
      // The asking call never holds itself open, and a newer sibling is not its problem.
      s.delete("newer");
      await Promise.resolve();
      expect(settled).toBe(false);
      s.delete("older");
      await waiting;
      expect(settled).toBe(true);
      expect(s.has("self")).toBe(true);
    });

    it("settledBefore resolves at once when nothing older is running", async () => {
      const s = new InflightSet();
      s.add("self");
      await expect(s.settledBefore("self")).resolves.toBeUndefined();
    });

    it("settledBefore gives up on abort and leaves no listener behind", async () => {
      const s = new InflightSet();
      const ctl = new AbortController();
      s.add("older");
      s.add("self");
      const waiting = s.settledBefore("self", ctl.signal);
      ctl.abort();
      await expect(waiting).resolves.toBeUndefined();
      // The abandoned hold must not still be watching the set.
      const sub = vi.fn();
      s.subscribe(sub);
      s.delete("older");
      expect(sub).toHaveBeenCalledTimes(1);
    });
  });
});

// Model refusal / filter / empty-stop handling — the loop must explain stops, never fail silently.
describe("turn-stop-reason", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function chatBody(message: Record<string, unknown>, finishReason: string): unknown {
    return {
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 0,
        total_tokens: 5,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 5,
      },
    };
  }

  describe("normalizeStopReason", () => {
    it("surfaces an explicit refusal string", () => {
      expect(normalizeStopReason({ refusal: "I can't help with that." })).toBe(
        "the model refused: I can't help with that.",
      );
    });

    it("maps refusal / safety / filter finish reasons case-insensitively", () => {
      expect(normalizeStopReason({ finishReason: "content_filter" })).toMatch(/content filter/);
      expect(normalizeStopReason({ finishReason: "SAFETY" })).toMatch(/safety/);
      expect(normalizeStopReason({ finishReason: "RECITATION" })).toMatch(/recitation/);
      expect(normalizeStopReason({ finishReason: "stop" })).toBeUndefined();
      expect(normalizeStopReason({})).toBeUndefined();
    });
  });

  describe("client.chat stop-reason wiring", () => {
    it("captures a chat-completions refusal field", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: vi.fn(async () =>
          jsonResponse(chatBody({ role: "assistant", content: null, refusal: "No." }, "stop")),
        ) as unknown as typeof fetch,
      });
      const resp = await client.chat({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(resp.content).toBe("");
      expect(resp.stopReason).toBe("the model refused: No.");
    });

    it("captures a content-filter finish reason", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: vi.fn(async () =>
          jsonResponse(chatBody({ role: "assistant", content: "" }, "content_filter")),
        ) as unknown as typeof fetch,
      });
      const resp = await client.chat({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(resp.stopReason).toMatch(/content filter/);
    });
  });

  describe("loop — a model that refuses to answer", () => {
    it("surfaces the stop reason instead of ending the turn silently", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: vi.fn(async () =>
          jsonResponse(chatBody({ role: "assistant", content: "" }, "content_filter")),
        ) as unknown as typeof fetch,
      });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
      });

      const events: LoopEvent[] = [];
      for await (const ev of loop.step("do the thing")) events.push(ev);

      const giveUp = events.find(
        (ev) =>
          ev.role === "warning" && ev.severity === "high" && /content filter/i.test(ev.content),
      );
      expect(giveUp).toBeDefined();
      // No answer was produced — the turn must not look like a success.
      expect(events.some((ev) => ev.role === "assistant_final")).toBe(false);
    });
  });
});

describe("subagent-distillation", () => {
  function fakeResult(opts: { output: string; completionTokens?: number }): SubagentResult {
    const usage = new Usage();
    usage.completionTokens = opts.completionTokens ?? 0;
    return {
      success: true,
      output: opts.output,
      turns: 1,
      toolIters: 0,
      elapsedMs: 0,
      model: "deepseek-chat",
      usage,
    };
  }

  describe("computeSpawnDistillation", () => {
    it("computes the read-heavy strength case: heavy completion, short output", () => {
      const d = computeSpawnDistillation(
        fakeResult({ output: "module A: counter; module B: stack.", completionTokens: 1000 }),
      );
      expect(d.completionTokens).toBe(1000);
      expect(d.outputTokens).toBeGreaterThan(0);
      expect(d.outputTokens).toBeLessThan(50);
      expect(d.savingsTokens).toBeGreaterThan(900);
      expect(d.compressionRatio).toBeLessThan(0.1);
      expect(d.hasOutput).toBe(true);
    });

    it("computes the write-heavy near-1 case", () => {
      const code = "```ts\nfunction add(a:number,b:number){return a+b;}\n```";
      const d = computeSpawnDistillation(
        fakeResult({ output: code, completionTokens: countTokens(code) }),
      );
      expect(d.compressionRatio).toBe(1);
      expect(d.savingsTokens).toBe(0);
    });

    it("flags empty output as not useful", () => {
      const d = computeSpawnDistillation(fakeResult({ output: "", completionTokens: 500 }));
      expect(d.hasOutput).toBe(false);
      expect(d.outputTokens).toBe(0);
      expect(d.savingsTokens).toBe(500);
    });

    it("flags whitespace-only output as not useful", () => {
      const d = computeSpawnDistillation(
        fakeResult({ output: "   \n\t\n", completionTokens: 200 }),
      );
      expect(d.hasOutput).toBe(false);
    });

    it("clamps savings to 0 when output is somehow larger than completion (passthrough)", () => {
      const d = computeSpawnDistillation(
        fakeResult({ output: "x".repeat(5000), completionTokens: 10 }),
      );
      expect(d.savingsTokens).toBe(0);
      expect(d.compressionRatio).toBeGreaterThan(1);
    });

    it("defaults compressionRatio to 1 when completionTokens is 0", () => {
      const d = computeSpawnDistillation(fakeResult({ output: "x", completionTokens: 0 }));
      expect(d.compressionRatio).toBe(1);
    });
  });

  describe("summarizeSubagentSession", () => {
    it("returns a sane zero shape on empty input", () => {
      const s = summarizeSubagentSession([]);
      expect(s.spawnCount).toBe(0);
      expect(s.successRate).toBe(0);
      expect(s.aggregateCompressionRatio).toBe(1);
      expect(s.totalSavingsTokens).toBe(0);
    });

    it("aggregates per-spawn distillations into a session summary", () => {
      const spawns: SpawnDistillation[] = [
        mkSpawn({ completion: 1000, output: 50, useful: true }),
        mkSpawn({ completion: 800, output: 0, useful: false }),
        mkSpawn({ completion: 600, output: 30, useful: true }),
      ];
      const s = summarizeSubagentSession(spawns);
      expect(s.spawnCount).toBe(3);
      expect(s.usefulSpawnCount).toBe(2);
      expect(s.successRate).toBeCloseTo(2 / 3);
      expect(s.totalCompletionTokens).toBe(2400);
      expect(s.totalOutputTokens).toBe(80);
      expect(s.totalSavingsTokens).toBe(950 + 800 + 570);
      expect(s.aggregateCompressionRatio).toBeCloseTo(80 / 2400);
    });

    it("weights compression by completion tokens, not naive mean", () => {
      // Naive mean of (0.1, 0.9) would be 0.5. Weighted by completion (100, 900)
      // should land near 0.82.
      const spawns: SpawnDistillation[] = [
        mkSpawn({ completion: 100, output: 10, useful: true }),
        mkSpawn({ completion: 900, output: 810, useful: true }),
      ];
      const s = summarizeSubagentSession(spawns);
      expect(s.aggregateCompressionRatio).toBeCloseTo((10 + 810) / 1000);
    });
  });

  describe("countSpawnStorms", () => {
    it("counts turns where spawn count ≥ threshold", () => {
      const turns: SpawnDistillation[][] = [
        [],
        [mkSpawn({ completion: 100, output: 10, useful: true })],
        [
          mkSpawn({ completion: 100, output: 10, useful: true }),
          mkSpawn({ completion: 100, output: 10, useful: true }),
          mkSpawn({ completion: 100, output: 10, useful: true }),
        ],
        [
          mkSpawn({ completion: 100, output: 10, useful: true }),
          mkSpawn({ completion: 100, output: 10, useful: true }),
          mkSpawn({ completion: 100, output: 10, useful: true }),
          mkSpawn({ completion: 100, output: 10, useful: true }),
        ],
      ];
      expect(countSpawnStorms(turns)).toBe(2);
      expect(countSpawnStorms(turns, 4)).toBe(1);
      expect(countSpawnStorms([])).toBe(0);
    });

    it("uses DEFAULT_SPAWN_STORM_THRESHOLD = 3", () => {
      expect(DEFAULT_SPAWN_STORM_THRESHOLD).toBe(3);
    });
  });

  describe("SubagentTelemetry", () => {
    it("starts empty and reports a zero summary", () => {
      const t = new SubagentTelemetry();
      expect(t.spawns).toHaveLength(0);
      expect(t.summary.spawnCount).toBe(0);
      expect(t.stormCount()).toBe(0);
    });

    it("record() captures one distillation per call and returns it", () => {
      const t = new SubagentTelemetry();
      const d = t.record(fakeResult({ output: "ok", completionTokens: 100 }));
      expect(d.completionTokens).toBe(100);
      expect(d.hasOutput).toBe(true);
      expect(t.spawns).toHaveLength(1);
      expect(t.summary.totalCompletionTokens).toBe(100);
    });

    it("groups spawns into turn buckets via startTurn(), enabling storm counting", () => {
      const t = new SubagentTelemetry();
      t.record(fakeResult({ output: "a", completionTokens: 50 }));
      t.startTurn(1);
      t.record(fakeResult({ output: "b", completionTokens: 60 }));
      t.record(fakeResult({ output: "c", completionTokens: 70 }));
      t.record(fakeResult({ output: "d", completionTokens: 80 }));
      expect(t.spawnsByTurn).toHaveLength(2);
      expect(t.spawnsByTurn[0]).toHaveLength(1);
      expect(t.spawnsByTurn[1]).toHaveLength(3);
      expect(t.stormCount()).toBe(1);
      expect(t.stormCount(4)).toBe(0);
    });

    it("record is bound so it can be passed as a callback without losing `this`", () => {
      const t = new SubagentTelemetry();
      const handler = t.record;
      handler(fakeResult({ output: "x", completionTokens: 10 }));
      expect(t.spawns).toHaveLength(1);
    });

    it("summary reflects updates after each record", () => {
      const t = new SubagentTelemetry();
      t.record(fakeResult({ output: "first", completionTokens: 200 }));
      expect(t.summary.spawnCount).toBe(1);
      t.record(fakeResult({ output: "", completionTokens: 300 }));
      expect(t.summary.spawnCount).toBe(2);
      expect(t.summary.usefulSpawnCount).toBe(1);
      expect(t.summary.totalCompletionTokens).toBe(500);
    });
  });

  function mkSpawn(opts: {
    completion: number;
    output: number;
    useful: boolean;
  }): SpawnDistillation {
    return {
      completionTokens: opts.completion,
      outputTokens: opts.output,
      savingsTokens: Math.max(0, opts.completion - opts.output),
      compressionRatio: opts.completion > 0 ? opts.output / opts.completion : 1,
      hasOutput: opts.useful,
    };
  }
});

describe("regex-runner", () => {
  describe("RegexRunner — worker-isolated regex evaluation", () => {
    it("returns line indices for matches against a literal pattern", async () => {
      const runner = new RegexRunner();
      try {
        const text = "alpha\nbeta\nalpha-two\ngamma";
        const hits = await runner.testLines(text, "alpha", "i");
        expect(hits).toEqual([0, 2]);
      } finally {
        await runner.shutdown();
      }
    });

    it("propagates a regex syntax error from the worker", async () => {
      const runner = new RegexRunner();
      try {
        await expect(runner.testLines("anything", "[unterminated", "i")).rejects.toThrow();
      } finally {
        await runner.shutdown();
      }
    });

    it("kills the worker on catastrophic backtracking + reports a timeout (issue #1236)", async () => {
      // (a+)+! on a 30-char run of 'a' is exponential — would take tens of
      // seconds inside re.test. With a 300 ms timeout the worker is terminated
      // and the call rejects fast.
      const runner = new RegexRunner({ defaultTimeoutMs: 300 });
      try {
        const evilLine = "a".repeat(30);
        const start = Date.now();
        await expect(runner.testLines(evilLine, "(a+)+!", "")).rejects.toThrow(/exceeded/);
        expect(Date.now() - start).toBeLessThan(2000);
      } finally {
        await runner.shutdown();
      }
    });

    it("the worker is respawned after a timeout — next call still works", async () => {
      const runner = new RegexRunner({ defaultTimeoutMs: 300 });
      try {
        await expect(runner.testLines("a".repeat(30), "(a+)+!", "")).rejects.toThrow(/exceeded/);
        // Next call uses a fresh worker.
        const hits = await runner.testLines("hello\nworld", "world", "", { timeoutMs: 5_000 });
        expect(hits).toEqual([1]);
      } finally {
        await runner.shutdown();
      }
    });

    it("an aborted signal rejects immediately and tears down the worker", async () => {
      const runner = new RegexRunner({ defaultTimeoutMs: 60_000 });
      try {
        const ctrl = new AbortController();
        const pending = runner.testLines("a".repeat(30), "(a+)+!", "", { signal: ctrl.signal });
        setTimeout(() => ctrl.abort(), 50);
        const start = Date.now();
        await expect(pending).rejects.toThrow(/aborted/);
        expect(Date.now() - start).toBeLessThan(2000);
      } finally {
        await runner.shutdown();
      }
    });
  });
});
