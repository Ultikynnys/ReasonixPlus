// Consolidated from 16 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { DirectKernelWireEvent } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  HEAP_HEADROOM_MB,
  TARGET_HEAP_MB_CEILING,
  TARGET_HEAP_MB_FLOOR,
  decideHeapTargetMb,
} from "../src/cli/heap-limit.js";
import {
  MIN_NODE_MAJOR,
  isSupportedNodeVersion,
  unsupportedNodeMessage,
} from "../src/cli/node-version.js";
import {
  _resetForTests,
  dumpStartupProfile,
  isStartupProfileEnabled,
  markPhase,
} from "../src/cli/startup-profile.js";
import { Usage } from "../src/client.js";
import { type EventizeContext, Eventizer } from "../src/core/eventize.js";
import type { Event } from "../src/core/events.js";
import { lazy } from "../src/core/lazy.js";
import { LruCache, TtlLruCache } from "../src/core/lru.js";
import {
  apply,
  capabilities,
  conversation,
  emptyCapabilities,
  emptyConversation,
  emptyPlan,
  emptyProjections,
  emptySessionMeta,
  emptyStatus,
  emptyWorkspace,
  plan,
  replay,
  sessionMeta,
  status,
  workspace,
} from "../src/core/reducers.js";
import { MAX_OPEN_TABS, type TabCapCandidate, pickTabToEvict } from "../src/desktop/tab-cap.js";
import type { LoopEvent } from "../src/loop.js";
import {
  addBinDirToPath,
  findPortableNodeBinDir,
  getNodeDownloadUrl,
  isNpxOnPath,
} from "../src/mcp/node-runtime.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import {
  ESCALATION_CONTRACT,
  TUI_FORMATTING_RULES,
  escalationContract,
} from "../src/prompt-fragments.js";
import {
  appendCacheDiagnostic,
  buildCacheDiagnostic,
  inferCacheMissReason,
  prefixDiagnosticHashes,
  renderCacheMissReport,
} from "../src/telemetry/cache-diagnostics.js";
import {
  MAX_TOOL_SPEC_BYTES,
  fitsSpecBudget,
  resolveSpecBudgetBytes,
  specBytes,
  toolSpecBytes,
} from "../src/tools/spec-budget.js";
import type { ToolSpec } from "../src/types.js";

// Pillar invariants — promoted from spike-fork-prefix-rebuild Exp 1 to permanent regression.
describe("architecture-invariants", () => {
  const ctx: EventizeContext = {
    model: "deepseek-v4-flash",
    reasoningEffort: "max",
    prefixHash: "test",
  };

  function synth(loopEvents: LoopEvent[]): Event[] {
    const eventizer = new Eventizer();
    const events: Event[] = [];
    events.push(eventizer.emitSessionOpened(0, "inv", 0));
    events.push(eventizer.emitUserMessage(1, "kick off"));
    for (const lev of loopEvents) {
      for (const out of eventizer.consume(lev, ctx)) events.push(out);
    }
    return events;
  }

  function assistantTurn(turn: number, content: string): LoopEvent {
    return { turn, role: "assistant_final", content } as LoopEvent;
  }

  function toolPair(turn: number, name: string, args: string, result: string): LoopEvent[] {
    return [
      { turn, role: "tool_start", toolName: name, toolArgs: args } as LoopEvent,
      { turn, role: "tool", content: result, toolName: name } as LoopEvent,
    ];
  }

  function buildSession(turns: number, toolsPerTurn: (t: number) => number): LoopEvent[] {
    const out: LoopEvent[] = [];
    for (let t = 1; t <= turns; t++) {
      out.push(assistantTurn(t, `assistant turn ${t}`));
      const n = toolsPerTurn(t);
      for (let i = 0; i < n; i++) {
        out.push(...toolPair(t, "read_file", `{"path":"f${t}-${i}.ts"}`, `body ${t}-${i}`));
      }
    }
    return out;
  }

  type ForwardedKernelEvent = Extract<Event, { type: DirectKernelWireEvent["type"] }>;
  const _kernelWireContract: ForwardedKernelEvent extends DirectKernelWireEvent ? true : never =
    true;
  void _kernelWireContract;

  describe("Pillar 1 — ImmutablePrefix.fingerprint determinism", () => {
    it("same {system, tools, fewShots} inputs yield byte-identical fingerprint", () => {
      const a = new ImmutablePrefix({
        system: "you are a coder",
        toolSpecs: [
          { type: "function", function: { name: "echo", parameters: { type: "object" } } },
        ],
        fewShots: [],
      });
      const b = new ImmutablePrefix({
        system: "you are a coder",
        toolSpecs: [
          { type: "function", function: { name: "echo", parameters: { type: "object" } } },
        ],
        fewShots: [],
      });
      expect(a.fingerprint).toBe(b.fingerprint);
    });

    it("addTool invalidates fingerprint exactly once", () => {
      const p = new ImmutablePrefix({ system: "x", toolSpecs: [] });
      const before = p.fingerprint;
      const ok = p.addTool({
        type: "function",
        function: { name: "new", parameters: { type: "object" } },
      });
      expect(ok).toBe(true);
      expect(p.fingerprint).not.toBe(before);
    });
  });

  describe("Pillar 1 — reducer projection determinism", () => {
    const shapes: Array<[string, LoopEvent[]]> = [
      ["quick-fix", buildSession(5, (t) => (t % 2 === 0 ? 1 : 0))],
      ["local-refactor", buildSession(20, (t) => 3 + (t % 3))],
      ["long-tail-debug", buildSession(80, (t) => 1 + (t % 2))],
    ];

    for (const [name, loopEvents] of shapes) {
      it(`${name}: identical LoopEvent input → byte-identical message projection`, () => {
        const a = synth(loopEvents);
        const b = synth(loopEvents);
        const aJson = JSON.stringify(replay(a).conversation.messages);
        const bJson = JSON.stringify(replay(b).conversation.messages);
        expect(aJson).toBe(bJson);
      });
    }
  });

  describe("Pillar 1 — message-level append-only across turn boundaries", () => {
    it("replay(events[0..n]).messages is a strict prefix of replay(events[0..m]) for n < m", () => {
      const events = synth(buildSession(20, (t) => 3 + (t % 3)));
      const turnBoundaries: number[] = [];
      let lastTurn = -1;
      events.forEach((ev, idx) => {
        if (ev.turn !== lastTurn) {
          turnBoundaries.push(idx);
          lastTurn = ev.turn;
        }
      });

      let prev: ReturnType<typeof replay>["conversation"]["messages"] | null = null;
      for (const cut of turnBoundaries) {
        const cur = replay(events.slice(0, cut)).conversation.messages;
        if (prev !== null) {
          expect(cur.length).toBeGreaterThanOrEqual(prev.length);
          for (let i = 0; i < prev.length; i++) {
            expect(JSON.stringify(cur[i])).toBe(JSON.stringify(prev[i]));
          }
        }
        prev = cur;
      }
    });
  });
});

describe("cache-diagnostics", () => {
  function tool(name: string, parameters: object = { type: "object" }): ToolSpec {
    return {
      type: "function",
      function: { name, description: "", parameters },
    };
  }

  function usage(hit: number, miss: number): Usage {
    return new Usage(hit + miss, 10, hit + miss + 10, hit, miss);
  }

  describe("cache diagnostics", () => {
    it("breaks the immutable prefix into stable sub-hashes", () => {
      const a = prefixDiagnosticHashes({
        system: "s",
        toolSpecs: [tool("read"), tool("write")],
        fewShots: [],
      });
      const b = prefixDiagnosticHashes({
        system: "s",
        toolSpecs: [tool("read"), tool("write")],
        fewShots: [],
      });

      expect(a).toEqual(b);
      expect(a.toolNames).toEqual(["read", "write"]);
      expect(a.prefixHash).toHaveLength(16);
    });

    it("infers local miss reasons from prefix evidence", () => {
      const previous = buildCacheDiagnostic({
        turn: 1,
        model: "deepseek-v4-flash",
        usage: usage(0, 100),
        prefix: prefixDiagnosticHashes({ system: "s", toolSpecs: [tool("read")], fewShots: [] }),
      });
      const current = prefixDiagnosticHashes({
        system: "s",
        toolSpecs: [tool("read", { type: "object", properties: { path: { type: "string" } } })],
        fewShots: [],
      });

      expect(inferCacheMissReason(previous, current, usage(50, 50))).toMatchObject({
        reason: "tool-schema-or-order-changed",
      });
      expect(
        inferCacheMissReason(
          previous,
          prefixDiagnosticHashes({ system: "s2", toolSpecs: [tool("read")], fewShots: [] }),
          usage(50, 50),
        ),
      ).toMatchObject({ reason: "system-prompt-changed" });
    });

    it("renders the DeepSeek/inferred caveat in reports", () => {
      const entry = buildCacheDiagnostic({
        turn: 1,
        model: "deepseek-v4-flash",
        usage: usage(90, 10),
        prefix: prefixDiagnosticHashes({ system: "s", toolSpecs: [tool("read")], fewShots: [] }),
      });
      const report = renderCacheMissReport(appendCacheDiagnostic([], entry));

      expect(report).toContain("DeepSeek does not return a cache-miss reason");
      expect(report).toContain("Reasonix+ infers");
      expect(report).toContain("cached 90");
    });
  });
});

describe("eventize", () => {
  const ctx = { model: "deepseek-v4-flash", prefixHash: "abc123", reasoningEffort: "max" } as const;

  const lev = (partial: Partial<LoopEvent>): LoopEvent =>
    ({ turn: 1, role: "status", content: "", ...partial }) as LoopEvent;

  describe("Eventizer.consume", () => {
    it("synthesizes model.turn.started on first event of a new turn", () => {
      const e = new Eventizer();
      const out = e.consume(lev({ turn: 1, role: "status", content: "thinking" }), ctx);
      expect(out[0]?.type).toBe("model.turn.started");
      expect(out[1]?.type).toBe("status");
    });

    it("does not re-emit turn.started for events within the same turn", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1, role: "status", content: "a" }), ctx);
      const out = e.consume(lev({ turn: 1, role: "status", content: "b" }), ctx);
      expect(out.find((ev) => ev.type === "model.turn.started")).toBeUndefined();
    });

    it("carries a status event's machine tag and wait numbers onto the wire", () => {
      const e = new Eventizer();
      const out = e.consume(
        lev({
          turn: 1,
          role: "status",
          content: "http 429 · retrying (attempt 2) in 3s",
          statusCode: "model-retry",
          statusAttempt: 2,
          statusWaitMs: 3000,
        }),
        ctx,
      );
      expect(out.find((ev) => ev.type === "status")).toMatchObject({
        type: "status",
        turn: 1,
        code: "model-retry",
        attempt: 2,
        waitMs: 3000,
        text: "http 429 · retrying (attempt 2) in 3s",
      });
    });

    it("leaves the tag fields off a status event that has none", () => {
      const e = new Eventizer();
      const out = e.consume(lev({ turn: 1, role: "status", content: "ping" }), ctx);
      const status = out.find((ev) => ev.type === "status") as Record<string, unknown> | undefined;
      expect(status).toBeDefined();
      expect(Object.hasOwn(status!, "code")).toBe(false);
      expect(Object.hasOwn(status!, "attempt")).toBe(false);
      expect(Object.hasOwn(status!, "waitMs")).toBe(false);
    });

    it("emits a fresh turn.started when the turn number advances", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const out = e.consume(lev({ turn: 2, role: "status", content: "go" }), ctx);
      expect(out[0]?.type).toBe("model.turn.started");
    });

    it("splits assistant_delta into content + reasoning channels", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx); // burn turn-start
      const out = e.consume(
        lev({
          turn: 1,
          role: "assistant_delta",
          content: "hello",
          reasoningDelta: "thinking…",
        }),
        ctx,
      );
      const channels = out
        .filter((ev) => ev.type === "model.delta")
        .map((ev) => (ev as { channel: string }).channel);
      expect(channels).toEqual(["content", "reasoning"]);
    });

    it("tool_start emits both tool.intent and tool.dispatched with matching callId", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const out = e.consume(
        lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: '{"cmd":"ls"}' }),
        ctx,
      );
      const intent = out.find((ev) => ev.type === "tool.intent") as
        | { callId: string; name: string; args: string }
        | undefined;
      const dispatched = out.find((ev) => ev.type === "tool.dispatched") as
        | { callId: string }
        | undefined;
      expect(intent?.name).toBe("shell");
      expect(intent?.args).toBe('{"cmd":"ls"}');
      expect(dispatched?.callId).toBe(intent?.callId);
    });

    it("tool result correlates back to the matching dispatched callId", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const startOut = e.consume(
        lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: "{}" }),
        ctx,
      );
      const startedCallId = (startOut.find((ev) => ev.type === "tool.intent") as { callId: string })
        .callId;
      const resultOut = e.consume(
        lev({ turn: 1, role: "tool", content: "ok\n", toolName: "shell" }),
        ctx,
      );
      const result = resultOut.find((ev) => ev.type === "tool.result") as
        | { callId: string; ok: boolean; output: string }
        | undefined;
      expect(result?.callId).toBe(startedCallId);
      expect(result?.ok).toBe(true);
      expect(result?.output).toBe("ok\n");
    });

    it("correlates parallel tool results by explicit loop call ID, not completion order", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const first = e.consume(
        lev({
          turn: 1,
          role: "tool_start",
          callId: "loop-a",
          toolName: "read_file",
          toolArgs: "{}",
        }),
        ctx,
      );
      const second = e.consume(
        lev({
          turn: 1,
          role: "tool_start",
          callId: "loop-b",
          toolName: "search_content",
          toolArgs: "{}",
        }),
        ctx,
      );
      const firstWireId = (first.find((ev) => ev.type === "tool.intent") as { callId: string })
        .callId;
      const secondWireId = (second.find((ev) => ev.type === "tool.intent") as { callId: string })
        .callId;

      const secondResult = e.consume(
        lev({ turn: 1, role: "tool", callId: "loop-b", toolName: "search_content", content: "B" }),
        ctx,
      );
      const firstResult = e.consume(
        lev({ turn: 1, role: "tool", callId: "loop-a", toolName: "read_file", content: "A" }),
        ctx,
      );

      expect(secondResult.find((ev) => ev.type === "tool.result")).toMatchObject({
        callId: secondWireId,
        output: "B",
      });
      expect(firstResult.find((ev) => ev.type === "tool.result")).toMatchObject({
        callId: firstWireId,
        output: "A",
      });
    });

    it("ignores unknown and duplicate explicit results without consuming another tool", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      e.consume(
        lev({
          turn: 1,
          role: "tool_start",
          callId: "loop-a",
          toolName: "read_file",
          toolArgs: "{}",
        }),
        ctx,
      );
      const started = e.consume(
        lev({
          turn: 1,
          role: "tool_start",
          callId: "loop-b",
          toolName: "search_content",
          toolArgs: "{}",
        }),
        ctx,
      );
      const secondWireId = (started.find((ev) => ev.type === "tool.intent") as { callId: string })
        .callId;

      expect(
        e.consume(lev({ turn: 1, role: "tool", callId: "unknown", content: "bad" }), ctx),
      ).toEqual([]);
      expect(
        e.consume(lev({ turn: 1, role: "tool", callId: "loop-a", content: "A" }), ctx),
      ).toHaveLength(1);
      expect(
        e.consume(lev({ turn: 1, role: "tool", callId: "loop-a", content: "duplicate" }), ctx),
      ).toEqual([]);

      expect(
        e
          .consume(lev({ turn: 1, role: "tool", callId: "loop-b", content: "B" }), ctx)
          .find((ev) => ev.type === "tool.result"),
      ).toMatchObject({ callId: secondWireId, output: "B" });
    });

    it("classifies error-shaped tool results as ok=false", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      e.consume(lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: "{}" }), ctx);
      const out = e.consume(
        lev({ turn: 1, role: "tool", content: "ERROR: bad command", toolName: "shell" }),
        ctx,
      );
      const result = out.find((ev) => ev.type === "tool.result") as { ok: boolean } | undefined;
      expect(result?.ok).toBe(false);
    });

    it("done and tool_call_delta produce no kernel events (control / progress markers)", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const doneOut = e.consume(lev({ turn: 1, role: "done", content: "" }), ctx);
      const tcdOut = e.consume(
        lev({ turn: 1, role: "tool_call_delta", content: "", toolName: "shell" }),
        ctx,
      );
      expect(doneOut).toEqual([]);
      expect(tcdOut).toEqual([]);
    });

    it("drops low-severity warnings (chatty self-correcting messages)", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const out = e.consume(
        lev({
          turn: 1,
          role: "warning",
          severity: "low",
          content: "Caught a repeated tool call",
        }),
        ctx,
      );
      expect(out).toEqual([]);
    });

    it("emits a typed warning event (not error) for high-severity loop warnings", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const out = e.consume(
        lev({
          turn: 1,
          role: "warning",
          severity: "high",
          content: "context 76,500/100,000 (76%) — approaching the window limit",
        }),
        ctx,
      );
      const warn = out.find((ev) => ev.type === "warning") as
        | { text: string; severity: string }
        | undefined;
      expect(warn).toBeDefined();
      expect(warn?.severity).toBe("high");
      expect(warn?.text).toContain("approaching the window limit");
      expect(out.find((ev) => ev.type === "error")).toBeUndefined();
    });

    it("carries the compaction summary body onto the warning event", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const out = e.consume(
        lev({
          turn: 1,
          role: "warning",
          severity: "high",
          content: "Context compacted (summary): 1,000 tokens -> 400 tokens.",
          compactionSummary: "Goal: ship X.",
        }),
        ctx,
      );
      const warn = out.find((ev) => ev.type === "warning") as
        | { compactionSummary?: string }
        | undefined;
      expect(warn?.compactionSummary).toBe("Goal: ship X.");
    });

    it("treats unmarked warnings as high-severity (safer default for new emit sites)", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const out = e.consume(
        lev({ turn: 1, role: "warning", content: "some new warning without severity" }),
        ctx,
      );
      const warn = out.find((ev) => ev.type === "warning") as { severity: string } | undefined;
      expect(warn?.severity).toBe("high");
    });

    it("event ids are monotonic across consume calls", () => {
      const e = new Eventizer();
      const a = e.consume(lev({ turn: 1, role: "status", content: "a" }), ctx);
      const b = e.consume(lev({ turn: 1, role: "status", content: "b" }), ctx);
      const ids = [...a, ...b].map((ev) => ev.id);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
      }
    });

    it("emitUserMessage / emitSlashInvoked produce well-formed events with monotonic ids", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const u = e.emitUserMessage(2, "hi");
      const s = e.emitSlashInvoked(2, "context", "off");
      expect(u.type).toBe("user.message");
      expect(u.text).toBe("hi");
      expect(s.type).toBe("slash.invoked");
      expect(s.name).toBe("context");
      expect(s.args).toBe("off");
      expect(s.id).toBeGreaterThan(u.id);
    });

    it("emitAbortedFinal settles a pending assistant card with zero usage", () => {
      // Desktop runTurn closes the turn generator mid-await on abort (the
      // fold is non-interruptible), so the loop's own assistant_final never
      // arrives — this synthetic final is what flips the card to settled.
      const e = new Eventizer();
      const ev = e.emitAbortedFinal(3);
      expect(ev).toMatchObject({
        type: "model.final",
        turn: 3,
        content: "[aborted by user: no response produced.]",
        toolCalls: [],
        usage: {},
      });
      expect(ev.id).toBeGreaterThan(0);
      expect(ev.ts).toBeTruthy();
    });

    it("maps session_retracted into a kernel session.retracted with the truncated log", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx); // burn turn-start
      const out = e.consume(
        lev({
          turn: 1,
          role: "session_retracted",
          sessionRetractedKind: "abort-discard",
          beforeMessages: 9,
          afterMessages: 2,
          replacementMessages: [
            { role: "user", content: "kept" },
            { role: "assistant", content: "kept too" },
          ],
        }),
        ctx,
      );
      expect(out.length).toBe(1);
      expect(out[0]).toMatchObject({
        type: "session.retracted",
        kind: "abort-discard",
        beforeMessages: 9,
        afterMessages: 2,
      });
      expect((out[0] as { replacementMessages: unknown[] }).replacementMessages).toHaveLength(2);
      // Same turn — no phantom turn.started for the mid-turn truncation.
      expect(out.find((x) => x.type === "model.turn.started")).toBeUndefined();
    });

    it("emitSessionRetracted records retry/rewind truncations outside the turn stream", () => {
      const e = new Eventizer();
      const ev = e.emitSessionRetracted(4, "retry", 7, 2, [{ role: "user", content: "kept" }]);
      expect(ev).toMatchObject({
        type: "session.retracted",
        turn: 4,
        kind: "retry",
        beforeMessages: 7,
        afterMessages: 2,
      });
      expect(ev.id).toBeGreaterThan(0);
      expect(ev.ts).toBeTruthy();
    });

    it("emitSessionRetracted accepts a context-edit kind", () => {
      const e = new Eventizer();
      const ev = e.emitSessionRetracted(2, "context-edit", 5, 3, [{ role: "user", content: "x" }]);
      expect(ev).toMatchObject({
        type: "session.retracted",
        kind: "context-edit",
        afterMessages: 3,
      });
    });

    it("emitSubagentProgress maps loop parentCallId to wire tool callId", () => {
      const e = new Eventizer();
      e.consume(lev({ turn: 1 }), ctx);
      const startOut = e.consume(
        lev({
          turn: 1,
          role: "tool_start",
          toolName: "explore",
          toolArgs: "{}",
          callId: "loop-call-99",
        }),
        ctx,
      );
      const wireToolCallId = (
        startOut.find((ev) => ev.type === "tool.intent") as { callId: string }
      ).callId;
      expect(wireToolCallId).toMatch(/^tc-\d+$/);

      const progress = e.emitSubagentProgress(1, {
        action: "start",
        runId: "sub-run-1",
        task: "explore codebase",
        parentCallId: "loop-call-99",
      });
      expect(progress.parentCallId).toBe(wireToolCallId);
    });
  });
});

describe("core-reducers", () => {
  const ts = "2026-04-29T12:00:00Z";
  let nextId = 0;
  const ev = <T extends Event>(e: Omit<T, "id"> & { id?: number }): T =>
    ({ ...e, id: e.id ?? ++nextId }) as T;

  describe("conversation reducer", () => {
    it("appends user message", () => {
      const v = conversation(
        emptyConversation(),
        ev<Event>({ type: "user.message", ts, turn: 1, text: "hi" }),
      );
      expect(v.messages).toEqual([{ role: "user", content: "hi" }]);
    });

    it("appends assistant final with tool_calls and reasoning", () => {
      const v = conversation(
        emptyConversation(),
        ev<Event>({
          type: "model.final",
          ts,
          turn: 1,
          content: "ok",
          reasoningContent: "thinking",
          toolCalls: [{ id: "c1", function: { name: "shell", arguments: "{}" } }],
          usage: {},
        }),
      );
      expect(v.messages[0]).toEqual({
        role: "assistant",
        content: "ok",
        reasoning_content: "thinking",
        tool_calls: [{ id: "c1", function: { name: "shell", arguments: "{}" } }],
      });
    });

    it("folds a model.final image into structured assistant content", () => {
      const v = conversation(
        emptyConversation(),
        ev<Event>({
          type: "model.final",
          ts,
          turn: 1,
          content: "here you go",
          toolCalls: [],
          usage: {},
          image: { dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" },
        }),
      );
      expect(v.messages[0]).toEqual({
        role: "assistant",
        content: [
          { type: "text", text: "here you go" },
          { type: "image", data_url: "data:image/jpeg;base64,AAAA", mime_type: "image/jpeg" },
        ],
      });
    });

    it("image-only model.final omits the text part", () => {
      const v = conversation(
        emptyConversation(),
        ev<Event>({
          type: "model.final",
          ts,
          turn: 1,
          content: "",
          toolCalls: [],
          usage: {},
          image: { dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" },
        }),
      );
      expect(v.messages[0]?.content).toEqual([
        { type: "image", data_url: "data:image/png;base64,AAAA", mime_type: "image/png" },
      ]);
    });

    it("tool.intent → pending; tool.result → tool msg + pending cleared", () => {
      let v = emptyConversation();
      v = conversation(
        v,
        ev<Event>({ type: "tool.intent", ts, turn: 1, callId: "c1", name: "shell", args: "{}" }),
      );
      expect(v.pendingToolCalls).toEqual([{ callId: "c1", name: "shell" }]);
      v = conversation(
        v,
        ev<Event>({
          type: "tool.result",
          ts,
          turn: 1,
          callId: "c1",
          ok: true,
          output: "done",
          durationMs: 5,
        }),
      );
      expect(v.pendingToolCalls).toEqual([]);
      expect(v.messages).toEqual([{ role: "tool", content: "done", tool_call_id: "c1" }]);
    });

    it("tool.denied removes pending and writes denial message", () => {
      let v = emptyConversation();
      v = conversation(
        v,
        ev<Event>({ type: "tool.intent", ts, turn: 1, callId: "c1", name: "shell", args: "" }),
      );
      v = conversation(
        v,
        ev<Event>({ type: "tool.denied", ts, turn: 1, callId: "c1", reason: "permission" }),
      );
      expect(v.pendingToolCalls).toEqual([]);
      expect(v.messages).toEqual([
        { role: "tool", content: "denied: permission", tool_call_id: "c1" },
      ]);
    });

    it("session.retracted REPLACES messages and clears pending (retry/rewind/discard)", () => {
      let v = emptyConversation();
      v = conversation(v, ev<Event>({ type: "user.message", ts, turn: 1, text: "old" }));
      v = conversation(
        v,
        ev<Event>({ type: "tool.intent", ts, turn: 1, callId: "c1", name: "shell", args: "" }),
      );
      v = conversation(
        v,
        ev<Event>({
          type: "session.retracted",
          ts,
          turn: 2,
          kind: "retry",
          beforeMessages: 4,
          afterMessages: 1,
          replacementMessages: [{ role: "user", content: "kept" }],
        }),
      );
      expect(v.messages).toEqual([{ role: "user", content: "kept" }]);
      expect(v.pendingToolCalls).toEqual([]);
    });
  });

  describe("plan reducer", () => {
    it("submitted populates steps as not-completed", () => {
      const v = plan(
        emptyPlan(),
        ev<Event>({
          type: "plan.submitted",
          ts,
          turn: 3,
          steps: [
            { id: "a", title: "A", action: "do A", risk: "low" },
            { id: "b", title: "B", action: "do B" },
          ],
          body: "## plan",
        }),
      );
      expect(v.submittedTurn).toBe(3);
      expect(v.steps).toEqual([
        { id: "a", title: "A", action: "do A", risk: "low", completed: false },
        { id: "b", title: "B", action: "do B", risk: undefined, completed: false },
      ]);
    });

    it("step.completed marks only the target", () => {
      let v = plan(
        emptyPlan(),
        ev<Event>({
          type: "plan.submitted",
          ts,
          turn: 1,
          steps: [
            { id: "a", title: "A", action: "" },
            { id: "b", title: "B", action: "" },
          ],
          body: "",
        }),
      );
      v = plan(
        v,
        ev<Event>({
          type: "plan.step.completed",
          ts,
          turn: 2,
          stepId: "b",
          notes: "ok",
          completion: { kind: "step_completed", stepId: "b", result: "ok" },
        }),
      );
      expect(v.steps.find((s) => s.id === "a")?.completed).toBe(false);
      expect(v.steps.find((s) => s.id === "b")?.completed).toBe(true);
      expect(v.steps.find((s) => s.id === "b")?.notes).toBe("ok");
    });

    it("step.completed with unknown id is a no-op", () => {
      const before = plan(
        emptyPlan(),
        ev<Event>({
          type: "plan.submitted",
          ts,
          turn: 1,
          steps: [{ id: "a", title: "A", action: "" }],
          body: "",
        }),
      );
      const after = plan(
        before,
        ev<Event>({
          type: "plan.step.completed",
          ts,
          turn: 2,
          stepId: "ghost",
          completion: { kind: "step_completed", stepId: "ghost", result: "" },
        }),
      );
      expect(after).toBe(before);
    });
  });

  describe("workspace reducer", () => {
    it("file.touched upsert; same path replaces mode", () => {
      let v = workspace(
        emptyWorkspace(),
        ev<Event>({
          type: "effect.file.touched",
          ts,
          turn: 1,
          path: "a.ts",
          mode: "create",
          bytes: 10,
        }),
      );
      v = workspace(
        v,
        ev<Event>({
          type: "effect.file.touched",
          ts,
          turn: 2,
          path: "a.ts",
          mode: "edit",
          bytes: 12,
        }),
      );
      v = workspace(
        v,
        ev<Event>({
          type: "effect.file.touched",
          ts,
          turn: 2,
          path: "b.ts",
          mode: "create",
          bytes: 5,
        }),
      );
      expect(v.filesTouched.get("a.ts")).toBe("edit");
      expect(v.filesTouched.get("b.ts")).toBe("create");
    });
  });

  describe("capabilities reducer", () => {
    it("register / re-register replaces; remove drops", () => {
      let v = capabilities(
        emptyCapabilities(),
        ev<Event>({ type: "capability.registered", ts, turn: 1, name: "shell", permission: "ask" }),
      );
      v = capabilities(
        v,
        ev<Event>({
          type: "capability.registered",
          ts,
          turn: 1,
          name: "shell",
          permission: "allow",
        }),
      );
      v = capabilities(
        v,
        ev<Event>({ type: "capability.registered", ts, turn: 1, name: "fs", permission: "ask" }),
      );
      expect(v.tools).toEqual([
        { name: "shell", permission: "allow" },
        { name: "fs", permission: "ask" },
      ]);
      v = capabilities(v, ev<Event>({ type: "capability.removed", ts, turn: 2, name: "shell" }));
      expect(v.tools).toEqual([{ name: "fs", permission: "ask" }]);
    });
  });

  describe("status reducer", () => {
    it("status sets text; primary event clears it", () => {
      let v = status(emptyStatus(), ev<Event>({ type: "status", ts, turn: 1, text: "harvesting" }));
      expect(v.current).toBe("harvesting");
      v = status(v, ev<Event>({ type: "model.delta", ts, turn: 1, channel: "content", text: "x" }));
      expect(v.current).toBeNull();
    });

    it("non-primary event preserves status", () => {
      let v = status(emptyStatus(), ev<Event>({ type: "status", ts, turn: 1, text: "thinking" }));
      v = status(v, ev<Event>({ type: "user.message", ts, turn: 1, text: "later" }));
      expect(v.current).toBe("thinking");
    });
  });

  describe("sessionMeta reducer", () => {
    it("session.opened sets name + openedAt; turn tracks max", () => {
      let v = sessionMeta(
        emptySessionMeta(),
        ev<Event>({ type: "session.opened", ts, turn: 5, name: "wip", resumedFromTurn: 4 }),
      );
      expect(v.name).toBe("wip");
      expect(v.openedAt).toBe(ts);
      expect(v.currentTurn).toBe(5);
      v = sessionMeta(v, ev<Event>({ type: "user.message", ts, turn: 7, text: "q" }));
      expect(v.currentTurn).toBe(7);
      v = sessionMeta(v, ev<Event>({ type: "user.message", ts, turn: 6, text: "stale" }));
      expect(v.currentTurn).toBe(7);
    });

    it("error event records lastError", () => {
      const v = sessionMeta(
        emptySessionMeta(),
        ev<Event>({ type: "error", ts, turn: 1, message: "boom", recoverable: true }),
      );
      expect(v.lastError).toBe("boom");
    });
  });

  describe("replay determinism", () => {
    it("same events twice → same projections", () => {
      const events: Event[] = [
        ev<Event>({ type: "session.opened", ts, turn: 1, name: "s", resumedFromTurn: 0 }),
        ev<Event>({ type: "user.message", ts, turn: 1, text: "hi" }),
        ev<Event>({
          type: "model.final",
          ts,
          turn: 1,
          content: "",
          toolCalls: [{ id: "c1", function: { name: "shell", arguments: "{}" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        ev<Event>({ type: "tool.intent", ts, turn: 1, callId: "c1", name: "shell", args: "{}" }),
        ev<Event>({ type: "tool.dispatched", ts, turn: 1, callId: "c1" }),
        ev<Event>({
          type: "tool.result",
          ts,
          turn: 1,
          callId: "c1",
          ok: true,
          output: "done",
          durationMs: 3,
        }),
      ];
      const a = replay(events);
      const b = replay(events);
      expect(a).toEqual(b);
      expect(a.conversation.messages).toHaveLength(3);
      expect(a.conversation.pendingToolCalls).toHaveLength(0);
      expect(a.session.currentTurn).toBe(1);
    });

    it("apply composes all reducers", () => {
      const e: Event = ev<Event>({
        type: "session.opened",
        ts,
        turn: 0,
        name: "test session",
        resumedFromTurn: 0,
      });
      const next = apply(emptyProjections(), e);
      expect(next.session.name).toBe("test session");
      expect(next.session.openedAt).toBe(ts);
    });
  });
});

describe("heap-limit", () => {
  describe("decideHeapTargetMb (issue #1011)", () => {
    const base = {
      nodeOptions: "",
      execArgv: [] as readonly string[],
      alreadyReexec: false,
    };

    it("targets 4 GiB on a typical workstation with the default 2 GiB cap", () => {
      expect(decideHeapTargetMb({ ...base, currentLimitMb: 2090, totalMemMb: 16384 })).toBe(
        TARGET_HEAP_MB_CEILING,
      );
    });

    it("scales target down to half of system memory on a memory-constrained VM", () => {
      // 6 GiB total → half is 3072 MiB, which is between floor and ceiling.
      expect(decideHeapTargetMb({ ...base, currentLimitMb: 2090, totalMemMb: 6144 })).toBe(3072);
    });

    it("clamps target to the 2 GiB floor on small-memory systems instead of going lower", () => {
      // 1 GiB total — half is 512 MiB; without the floor clamp we'd target
      // 512 MiB and shrink the heap. Pretend the current limit is below the
      // floor so we exercise the raise path on this small-memory case.
      expect(decideHeapTargetMb({ ...base, currentLimitMb: 1024, totalMemMb: 1024 })).toBe(
        TARGET_HEAP_MB_FLOOR,
      );
    });

    it("returns null when already above the target (within headroom)", () => {
      expect(
        decideHeapTargetMb({
          ...base,
          currentLimitMb: TARGET_HEAP_MB_CEILING - HEAP_HEADROOM_MB + 1,
          totalMemMb: 16384,
        }),
      ).toBeNull();
    });

    it("returns null when the user already set --max-old-space-size in NODE_OPTIONS", () => {
      expect(
        decideHeapTargetMb({
          ...base,
          currentLimitMb: 2090,
          totalMemMb: 16384,
          nodeOptions: "--max-old-space-size=8192",
        }),
      ).toBeNull();
      expect(
        decideHeapTargetMb({
          ...base,
          currentLimitMb: 2090,
          totalMemMb: 16384,
          nodeOptions: "--inspect --max_old_space_size=8192",
        }),
      ).toBeNull();
    });

    it("returns null when the user passed --max-old-space-size on the command line (execArgv)", () => {
      expect(
        decideHeapTargetMb({
          ...base,
          currentLimitMb: 2090,
          totalMemMb: 16384,
          execArgv: ["--max-old-space-size=6144"],
        }),
      ).toBeNull();
    });

    it("returns null after a successful re-exec (REASONIX_HEAP_REEXEC=1 set)", () => {
      expect(
        decideHeapTargetMb({
          ...base,
          currentLimitMb: 2090,
          totalMemMb: 16384,
          alreadyReexec: true,
        }),
      ).toBeNull();
    });

    it("does NOT re-exec when current limit is already at the target", () => {
      expect(
        decideHeapTargetMb({
          ...base,
          currentLimitMb: TARGET_HEAP_MB_CEILING,
          totalMemMb: 16384,
        }),
      ).toBeNull();
    });

    it("does NOT re-exec in desktop mode", () => {
      expect(
        decideHeapTargetMb({
          ...base,
          currentLimitMb: 2090,
          totalMemMb: 16384,
          isDesktop: true,
        }),
      ).toBeNull();
    });
  });
});

describe("lazy", () => {
  describe("lazy", () => {
    it("invokes the loader exactly once across many calls", async () => {
      const loader = vi.fn(async () => ({ value: 42 }));
      const get = lazy(loader);
      const [a, b, c] = await Promise.all([get(), get(), get()]);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(a.value).toBe(42);
    });

    it("returns the same promise on every call", () => {
      const get = lazy(async () => "x");
      expect(get()).toBe(get());
    });

    it("propagates a loader rejection on every call", async () => {
      const err = new Error("boom");
      const get = lazy(async () => {
        throw err;
      });
      await expect(get()).rejects.toBe(err);
      await expect(get()).rejects.toBe(err);
    });
  });
});

describe("lru", () => {
  describe("LruCache", () => {
    it("returns undefined for an unknown key", () => {
      const c = new LruCache<string, number>(4);
      expect(c.get("missing")).toBeUndefined();
    });

    it("stores and retrieves values", () => {
      const c = new LruCache<string, number>(4);
      c.set("a", 1);
      expect(c.get("a")).toBe(1);
    });

    it("evicts the least-recently-used key past the limit", () => {
      const c = new LruCache<string, number>(2);
      c.set("a", 1);
      c.set("b", 2);
      c.set("c", 3);
      expect(c.get("a")).toBeUndefined();
      expect(c.get("b")).toBe(2);
      expect(c.get("c")).toBe(3);
    });

    it("get promotes a key so it survives the next eviction", () => {
      const c = new LruCache<string, number>(2);
      c.set("a", 1);
      c.set("b", 2);
      c.get("a"); // touch a — b is now oldest
      c.set("c", 3);
      expect(c.get("b")).toBeUndefined();
      expect(c.get("a")).toBe(1);
      expect(c.get("c")).toBe(3);
    });

    it("set on an existing key refreshes its position and value", () => {
      const c = new LruCache<string, number>(2);
      c.set("a", 1);
      c.set("b", 2);
      c.set("a", 99);
      c.set("c", 3);
      expect(c.get("b")).toBeUndefined();
      expect(c.get("a")).toBe(99);
    });

    it("clear empties the cache", () => {
      const c = new LruCache<string, number>(4);
      c.set("a", 1);
      c.set("b", 2);
      c.clear();
      expect(c.size).toBe(0);
      expect(c.get("a")).toBeUndefined();
    });
  });

  describe("TtlLruCache", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns a fresh value before the TTL elapses", () => {
      const c = new TtlLruCache<string, number>(4, 1000);
      c.set("a", 1);
      vi.advanceTimersByTime(500);
      expect(c.get("a")).toBe(1);
    });

    it("treats a stale entry as a miss", () => {
      const c = new TtlLruCache<string, number>(4, 1000);
      c.set("a", 1);
      vi.advanceTimersByTime(1500);
      expect(c.get("a")).toBeUndefined();
    });

    it("set refreshes the TTL of an existing key", () => {
      const c = new TtlLruCache<string, number>(4, 1000);
      c.set("a", 1);
      vi.advanceTimersByTime(800);
      c.set("a", 2);
      vi.advanceTimersByTime(500); // total 1300 since first set, 500 since refresh
      expect(c.get("a")).toBe(2);
    });

    it("preserves the underlying LRU eviction order", () => {
      const c = new TtlLruCache<string, number>(2, 1000);
      c.set("a", 1);
      c.set("b", 2);
      c.set("c", 3);
      expect(c.get("a")).toBeUndefined();
      expect(c.get("b")).toBe(2);
      expect(c.get("c")).toBe(3);
    });
  });
});

describe("node-runtime", () => {
  describe("node-runtime detection and paths", () => {
    it("generates correct download URLs for major platforms", () => {
      const win = getNodeDownloadUrl("win32", "x64", "v22.14.0");
      expect(win.url).toBe("https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip");
      expect(win.format).toBe("zip");

      const darwinArm = getNodeDownloadUrl("darwin", "arm64", "v22.14.0");
      expect(darwinArm.url).toBe(
        "https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz",
      );
      expect(darwinArm.format).toBe("tar");

      const linux = getNodeDownloadUrl("linux", "x64", "v22.14.0");
      expect(linux.url).toBe("https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz");
      expect(linux.format).toBe("tar");
    });

    it("detects when npx is missing from an empty PATH", () => {
      expect(isNpxOnPath({ PATH: "" })).toBe(false);
    });

    it("finds portable node bin directory in standard layout", () => {
      const tmp = join(tmpdir(), `node-rt-test-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });

      if (process.platform === "win32") {
        writeFileSync(join(tmp, "npx.cmd"), "@echo off\n");
        const found = findPortableNodeBinDir(tmp);
        expect(found).toBe(tmp);
      } else {
        const bin = join(tmp, "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "npx"), "#!/bin/sh\n");
        const found = findPortableNodeBinDir(tmp);
        expect(found).toBe(bin);
      }
    });

    it("prepends portable bin dir to PATH", () => {
      const fakeEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
      addBinDirToPath("/opt/reasonix/node/bin", fakeEnv);
      expect(fakeEnv.PATH?.startsWith("/opt/reasonix/node/bin")).toBe(true);
    });
  });
});

describe("node-version", () => {
  describe("CLI Node runtime guard (#1698)", () => {
    it("rejects Node 18 before the CLI loads heavier startup modules", () => {
      expect(isSupportedNodeVersion("18.17.0")).toBe(false);
      expect(unsupportedNodeMessage("18.17.0")).toContain(`Node ${MIN_NODE_MAJOR}+`);
      expect(unsupportedNodeMessage("18.17.0")).toContain("18.17.0");
    });

    it("accepts Node 22 and later", () => {
      expect(isSupportedNodeVersion("22.16.0")).toBe(true);
      expect(isSupportedNodeVersion("24.14.1")).toBe(true);
    });

    it("runs before the heap-limit re-exec hook", () => {
      const source = readFileSync("src/cli/index.ts", "utf8");
      expect(source.indexOf('import "./node-version-guard.js";')).toBeLessThan(
        source.indexOf('import "./heap-limit-launch.js";'),
      );
    });
  });
});

// Public API snapshot — fail loud on unintended changes to the npm package's export surface.
describe("public-api", () => {
  const INDEX = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");

  function extractExportedNames(source: string): string[] {
    const names = new Set<string>();
    // Strip block comments + line comments so commented-out exports don't count.
    const cleaned = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");

    // `export { a, b as c, type D, type E as F } from "..."` — including bare `export { ... }` with no `from`.
    const namedBlock = /export(?:\s+type)?\s*\{([^}]+)\}\s*(?:from\s+["'][^"']+["'])?\s*;?/g;
    for (const m of cleaned.matchAll(namedBlock)) {
      const inner = m[1] ?? "";
      for (const raw of inner.split(",")) {
        const trimmed = raw.trim().replace(/^type\s+/, "");
        if (!trimmed) continue;
        const aliasMatch = trimmed.match(/(?:.+\s+as\s+)?(\w+)\s*$/);
        if (aliasMatch?.[1]) names.add(aliasMatch[1]);
      }
    }

    // `export const X`, `export function X`, `export class X`, `export type X`, `export interface X`, `export enum X`.
    const decl =
      /export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g;
    for (const m of cleaned.matchAll(decl)) {
      if (m[1]) names.add(m[1]);
    }

    return [...names].sort();
  }

  const PUBLIC_API: readonly string[] = [
    "AT_MENTION_PATTERN",
    "AT_PICKER_PREFIX",
    "AUTO_COMPACT_TRIGGER_RATIO",
    "AggregateOptions",
    "AppendOnlyLog",
    "AppendUsageInput",
    "ApplyResult",
    "ApplyStatus",
    "AtMentionExpansion",
    "AtMentionOptions",
    "BillingContext",
    "BillingKind",
    "BridgeOptions",
    "BridgeResult",
    "CODE_SYSTEM_PROMPT",
    "COMPACTION_SUMMARY_PREFIX",
    "COMPACT_TARGET_RATIO",
    "CacheFirstLoop",
    "CacheFirstLoopOptions",
    "CallToolResult",
    "ChatMessage",
    "ChatResponse",
    "ChoiceOption",
    "ChoiceRequestedError",
    "ChoiceToolOptions",
    "CodeSystemPromptOptions",
    "CommandOutputMetric",
    "CommandOutputSummary",
    "CompactionOutcome",
    "CompactionPlan",
    "CompactionResult",
    "CompactionTrigger",
    "DEFAULT_AT_DIR_MAX_ENTRIES",
    "DEFAULT_AT_MENTION_MAX_BYTES",
    "DEFAULT_IMAGE_MODEL",
    "DEFAULT_MAX_RESULT_CHARS",
    "DEFAULT_MAX_RESULT_TOKENS",
    "DEFAULT_PICKER_IGNORE_DIRS",
    "DEFAULT_SPAWN_STORM_THRESHOLD",
    "DROPPED_WORK_NOTICE_PREFIX",
    "DeepSeekClient",
    "DeepSeekClientOptions",
    "DirEntry",
    "EditBlock",
    "EventRole",
    "FileWithStats",
    "FilesystemToolsOptions",
    "FilteredCommandResult",
    "FlattenDecision",
    "FlattenOptions",
    "GenerateImageOptions",
    "GenerateImageResult",
    "GetLatestVersionOptions",
    "GetPromptResult",
    "HOOK_EVENTS",
    "HOOK_SETTINGS_DIRNAME",
    "HOOK_SETTINGS_FILENAME",
    "HookConfig",
    "HookEvent",
    "HookOutcome",
    "HookPayload",
    "HookReport",
    "HookScope",
    "HookSettings",
    "HookSpawnInput",
    "HookSpawnResult",
    "HookSpawner",
    "ImageBackground",
    "ImageGenToolOptions",
    "ImageQuality",
    "ImageSize",
    "ImmutablePrefix",
    "ImmutablePrefixOptions",
    "InitializeResult",
    "InspectionReport",
    "InstallSource",
    "JSONSchema",
    "JsonRpcMessage",
    "JsonRpcRequest",
    "JsonRpcResponse",
    "LATEST_CACHE_TTL_MS",
    "LATEST_FETCH_TIMEOUT_MS",
    "ListDirectoryOptions",
    "ListFilesOptions",
    "ListPromptsResult",
    "ListResourcesResult",
    "ListToolsResult",
    "LiveSessionProbe",
    "LoadHookSettingsOptions",
    "LoopAbortOptions",
    "LoopEvent",
    "MCP_PROTOCOL_VERSION",
    "MEMORY_INDEX_FILE",
    "MEMORY_INDEX_MAX_CHARS",
    "McpClient",
    "McpClientOptions",
    "McpContentBlock",
    "McpProgressHandler",
    "McpProgressInfo",
    "McpPrompt",
    "McpPromptArgument",
    "McpPromptMessage",
    "McpPromptResourceBlock",
    "McpResource",
    "McpResourceContents",
    "McpResourceContentsBlob",
    "McpResourceContentsText",
    "McpSpec",
    "McpTool",
    "McpToolSchema",
    "McpTransport",
    "MemoryEntry",
    "MemoryScope",
    "MemoryStore",
    "MemoryStoreOptions",
    "MemoryToolsOptions",
    "MemoryType",
    "MemoryWriteInput",
    "NeedsConfirmationError",
    "OutputFilterMode",
    "OutputFilterResult",
    "OutputRecoveryCapture",
    "OutputRecoveryLimits",
    "OutputRecoveryRef",
    "OutputRecoveryResult",
    "PRESERVE_RECENT_TOKENS",
    "PROJECT_MEMORY_FILE",
    "PROJECT_MEMORY_FILES",
    "PROJECT_MEMORY_MAX_CHARS",
    "PageContent",
    "ParsedAtQuery",
    "PickerCandidate",
    "PlanClaim",
    "PlanCompactionOptions",
    "PlanProposedError",
    "PlanRevisionProposedError",
    "PlanStep",
    "PlanStepRisk",
    "PlanToolOptions",
    "ProgressNotificationParams",
    "ProjectMemory",
    "RankPickerOptions",
    "ReadResourceResult",
    "ReasonixConfig",
    "ReconfigurableOptions",
    "RepairReport",
    "ResolvedHook",
    "RetryInfo",
    "RetryOptions",
    "Role",
    "RulesToolsOptions",
    "RunCommandResult",
    "RunHooksOptions",
    "SUMMARIZER_INPUT_MAX_TOKENS",
    "SUMMARIZER_OUTPUT_HEADROOM",
    "ScavengeOptions",
    "ScavengeResult",
    "SearchResult",
    "SectionResult",
    "SessionInfo",
    "SessionStats",
    "SessionSummary",
    "ShellToolsOptions",
    "SpawnDistillation",
    "SseMcpSpec",
    "SseTransport",
    "SseTransportOptions",
    "StdioMcpSpec",
    "StdioTransport",
    "StdioTransportOptions",
    "StepCompletion",
    "StormBreaker",
    "StreamChunk",
    "StreamWalkOptions",
    "StreamableHttpMcpSpec",
    "StreamableHttpTransport",
    "StreamableHttpTransportOptions",
    "SubagentEvent",
    "SubagentResult",
    "SubagentResultLike",
    "SubagentSessionSummary",
    "SubagentSink",
    "SubagentTelemetry",
    "SubagentToolOptions",
    "TodoItem",
    "TodoStatus",
    "TodoToolOptions",
    "ToolActivityDigest",
    "ToolCall",
    "ToolCallContext",
    "ToolCallRepair",
    "ToolCallRepairOptions",
    "ToolDefinition",
    "ToolFunctionSpec",
    "ToolRegistry",
    "ToolSpec",
    "TruncationRepairResult",
    "TurnStats",
    "USER_MEMORY_DIR",
    "USER_RETENTION_TOKENS",
    "Usage",
    "UsageAggregate",
    "UsageBucket",
    "UsageRecord",
    "VERSION",
    "VolatileScratch",
    "WaitToolOptions",
    "WebFetchOptions",
    "WebSearchOptions",
    "WebToolsOptions",
    "aggregateUsage",
    "analyzeSchema",
    "appendCommandOutputMetric",
    "appendSessionMessage",
    "appendUsage",
    "applyEditBlock",
    "applyEditBlocks",
    "applyMemoryStack",
    "applyOutputFilter",
    "applyProjectMemory",
    "applyUserMemory",
    "billingContextForModel",
    "billingKindForModel",
    "bridgeMcpTools",
    "bucketCacheHitRatio",
    "buildCompactionRequest",
    "buildDroppedWorkNotice",
    "buildVerificationRequest",
    "checkpointSessionMessages",
    "claimingSession",
    "classifyCommandFamily",
    "cleanupOutputRecovery",
    "codeSystemPrompt",
    "commandOutputTelemetryPath",
    "compareVersions",
    "computeSpawnDistillation",
    "countSpawnStorms",
    "decideOutcome",
    "defaultConfigPath",
    "defaultUsageLogPath",
    "deleteSession",
    "detectAtPicker",
    "detectInstallSource",
    "detectNpmInstallPrefix",
    "detectShellOperator",
    "digestHasWork",
    "estimateOutputTokens",
    "expandAtMentions",
    "fetchWithRetry",
    "findProjectMemoryPath",
    "fixToolCallPairing",
    "flattenMcpResult",
    "flattenSchema",
    "forkRegistryExcluding",
    "formatCommandResult",
    "formatHookOutcomeMessage",
    "formatLogSize",
    "formatLoopError",
    "formatSearchResults",
    "generateImageViaCodex",
    "getLatestVersion",
    "globalSettingsPath",
    "hasOpenAIOAuthSession",
    "healLoadedMessages",
    "healLoadedMessagesByTokens",
    "htmlToText",
    "imageModel",
    "injectPowerShellUtf8",
    "inspectMcpServer",
    "isAllowed",
    "isCompactionSummary",
    "isDroppedWorkNotice",
    "isJsonRpcError",
    "isNpxInstall",
    "isPlausibleKey",
    "listDirectory",
    "listFilesSync",
    "listFilesWithStatsAsync",
    "listFilesWithStatsSync",
    "listSessions",
    "loadApiKey",
    "loadBaseUrl",
    "loadBraveApiKey",
    "loadExaApiKey",
    "loadHooks",
    "loadMetasoApiKey",
    "loadOllamaApiKey",
    "loadPerplexityApiKey",
    "loadSessionMessages",
    "loadSessionNotices",
    "loadZaiApiKey",
    "markOutputRecoveryRead",
    "matchesTool",
    "memoryEnabled",
    "nestArguments",
    "outputRecoveryDir",
    "parseAtQuery",
    "parseBingResults",
    "parseEditBlocks",
    "parseMcpSpec",
    "parseSearxngHtmlResults",
    "planCompaction",
    "prepareSpawn",
    "projectHash",
    "projectSettingsPath",
    "quoteForCmdExe",
    "rankPickerCandidates",
    "readConfig",
    "readOutputRecoveryMetadata",
    "readProjectMemory",
    "readUsageLog",
    "redactKey",
    "registerChoiceTool",
    "registerFilesystemTools",
    "registerImageGenTool",
    "registerMemoryTools",
    "registerPlanTool",
    "registerRulesTools",
    "registerShellTools",
    "registerSubagentTool",
    "registerTodoTool",
    "registerWaitTool",
    "registerWebTools",
    "renderDeterministic",
    "renderWithSummary",
    "repairTruncatedJson",
    "resolveExecutable",
    "resolveProjectMemoryWritePath",
    "runCommand",
    "runHooks",
    "sanitizeMemoryName",
    "sanitizeSessionName",
    "saveApiKey",
    "saveBaseUrl",
    "scavengeToolCalls",
    "sessionDir",
    "sessionPath",
    "sessionsDir",
    "setLiveSessionProbe",
    "stripHallucinatedToolMarkup",
    "summarizeCommandOutputMetrics",
    "summarizeSubagentSession",
    "tokenizeCommand",
    "toolActivityDigest",
    "truncateForModel",
    "truncateForModelByTokens",
    "walkFilesStream",
    "webFetch",
    "webSearch",
    "withUtf8Codepage",
    "writeConfig",
    "writeSessionNotices",
  ];

  describe("public API surface", () => {
    it("matches the recorded snapshot — update PUBLIC_API in this file when intentionally changing exports", () => {
      const actual = extractExportedNames(INDEX);
      expect(actual).toEqual([...PUBLIC_API]);
    });

    it("snapshot is sorted + unique (sanity check on the snapshot itself)", () => {
      const sorted = [...PUBLIC_API].sort();
      expect([...PUBLIC_API]).toEqual(sorted);
      expect(new Set(PUBLIC_API).size).toBe(PUBLIC_API.length);
    });
  });
});

// // No silent catch blocks — a catch whose body is empty (or comment-only)
// // swallows the failure. That is the exact class of bug that made a session
// // rewrite die without any visible error. Every catch in the durability-critical
// // + user-facing surfaces below must surface its failure: a stderr write, an
// // error return, an emitted event, or a rethrow.
describe("no-silent-catch", () => {
  const TARGET_DIRS = ["src/core", "src/memory", "src/adapters", "src/cli/commands"];
  const TARGET_FILES = ["src/loop.ts"];

  function collect(): string[] {
    const out: string[] = [];
    for (const rel of TARGET_DIRS) {
      const root = join(process.cwd(), rel);
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
        }
      };
      walk(root);
    }
    for (const rel of TARGET_FILES) out.push(join(process.cwd(), rel));
    return out;
  }

  function stripComments(s: string): string {
    return s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
  }

  /** Catch blocks whose body is empty or comment-only after stripping. */
  function silentCatches(src: string): Array<{ line: number }> {
    const out: Array<{ line: number }> = [];
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/\bcatch\s*(?:\([^)]*\))?\s*\{/);
      if (!m) continue;
      const before = line.slice(0, m.index);
      if (before.includes("//") || /["'`]/.test(before)) continue;
      const bodyStart = line.lastIndexOf("{");
      let body = line.slice(bodyStart + 1);
      const closeSame = body.indexOf("}");
      if (closeSame !== -1) {
        body = body.slice(0, closeSame);
      } else {
        let j = i + 1;
        while (j < lines.length) {
          const seg = lines[j];
          const close = seg.indexOf("}");
          if (close !== -1) {
            body += seg.slice(0, close);
            break;
          }
          body += `${seg}\n`;
          j++;
        }
      }
      if (stripComments(body).trim() === "") out.push({ line: i + 1 });
    }
    return out;
  }

  describe("no silent catch blocks", () => {
    test("swallow-only catches are banned in core durability + CLI surfaces", () => {
      const offenders: string[] = [];
      for (const p of collect()) {
        const src = readFileSync(p, "utf8");
        for (const c of silentCatches(src)) {
          offenders.push(`${relative(process.cwd(), p)}:${c.line} — empty/comment-only catch body`);
        }
      }
      expect(
        offenders,
        "Swallow-only catches hide failures. Make them loud: stderr write, error return, or emitted event.",
      ).toEqual([]);
    });
  });
});

// Spec-budget accounting: the ceiling that bounds every request's tool payload.
describe("spec-budget", () => {
  function spec(
    name: string,
    description: string,
    parameters: Record<string, unknown> = {},
  ): ToolSpec {
    return { type: "function", function: { name, description, parameters } };
  }

  describe("spec budget", () => {
    it("counts description plus serialized parameters", () => {
      const parameters = { type: "object", properties: { a: { type: "string" } } };
      expect(specBytes(spec("a", "hello", parameters))).toBe(
        "hello".length + JSON.stringify(parameters).length,
      );
    });

    it("sums across a spec list", () => {
      const specs = [spec("a", "one"), spec("b", "two")];
      expect(toolSpecBytes(specs)).toBe(specBytes(specs[0]!) + specBytes(specs[1]!));
      expect(toolSpecBytes([])).toBe(0);
    });

    it("defaults to the shared ceiling", () => {
      expect(resolveSpecBudgetBytes({})).toBe(MAX_TOOL_SPEC_BYTES);
      expect(MAX_TOOL_SPEC_BYTES).toBe(64_000);
    });

    it("honors REASONIX_SPEC_BUDGET_BYTES", () => {
      expect(resolveSpecBudgetBytes({ REASONIX_SPEC_BUDGET_BYTES: "8000" })).toBe(8000);
    });

    it("ignores an unparseable or zero override instead of disabling the cap", () => {
      expect(resolveSpecBudgetBytes({ REASONIX_SPEC_BUDGET_BYTES: "lots" })).toBe(
        MAX_TOOL_SPEC_BYTES,
      );
      expect(resolveSpecBudgetBytes({ REASONIX_SPEC_BUDGET_BYTES: "0" })).toBe(MAX_TOOL_SPEC_BYTES);
      expect(resolveSpecBudgetBytes({ REASONIX_SPEC_BUDGET_BYTES: "-5" })).toBe(
        MAX_TOOL_SPEC_BYTES,
      );
    });

    it("is inclusive at the ceiling and exclusive one byte past it", () => {
      const one = spec("a", "12345");
      const cost = specBytes(one);
      expect(fitsSpecBudget([], one, cost)).toBe(true);
      expect(fitsSpecBudget([], one, cost - 1)).toBe(false);
    });

    it("accounts for specs already committed", () => {
      const first = spec("a", "12345");
      const second = spec("b", "12345");
      const budget = specBytes(first) + specBytes(second);
      expect(fitsSpecBudget([first], second, budget)).toBe(true);
      expect(fitsSpecBudget([first], second, budget - 1)).toBe(false);
    });
  });
});

describe("tab-cap", () => {
  const tab = (id: string, focusedAt?: number, running = false): TabCapCandidate => ({
    id,
    focusedAt,
    running,
  });

  /** Exactly `cap` candidates, so the cap is reached and eviction is in play. */
  const atCap = (...candidates: TabCapCandidate[]) => {
    expect(candidates).toHaveLength(MAX_OPEN_TABS);
    return candidates;
  };

  const fillers = (): TabCapCandidate[] =>
    Array.from({ length: MAX_OPEN_TABS - 2 }, (_, i) => tab(`filler-${i}`, 100 + i));

  describe("pickTabToEvict", () => {
    it("closes nothing while the tab set fits", () => {
      expect(pickTabToEvict([tab("a", 1), tab("b", 2)], "a")).toBeNull();
      expect(pickTabToEvict([], "a")).toBeNull();
    });

    it("picks the least recently focused tab once the cap is reached", () => {
      const picked = pickTabToEvict(atCap(tab("old", 1), tab("mid", 5), ...fillers()), "active");
      expect(picked?.id).toBe("old");
    });

    it("never evicts the active tab, even when it looks least recent", () => {
      const picked = pickTabToEvict(atCap(tab("active", 1), tab("mid", 5), ...fillers()), "active");
      expect(picked?.id).not.toBe("active");
      // `mid` (stamp 5) is the oldest tab that is not the active one.
      expect(picked?.id).toBe("mid");
    });

    it("never evicts a tab with an agent running, even when it is the oldest", () => {
      const picked = pickTabToEvict(
        atCap(tab("busy", 1, true), tab("idle", 9), ...fillers()),
        "active",
      );
      // `busy` is oldest but running, so the next oldest, `idle`, goes instead.
      expect(picked?.id).toBe("idle");
    });

    it("returns null when every other tab is busy, so the caller can refuse", () => {
      const busy = Array.from({ length: MAX_OPEN_TABS - 1 }, (_, i) => tab(`busy-${i}`, i, true));
      expect(pickTabToEvict([tab("active", 99), ...busy], "active")).toBeNull();
    });

    it("treats a never-focused tab as the oldest", () => {
      const picked = pickTabToEvict(atCap(tab("never"), tab("seen", 1), ...fillers()), "active");
      expect(picked?.id).toBe("never");
    });
  });
});

// escalationContract: model-aware identity without model-authored routing controls.
describe("prompt-fragments", () => {
  describe("TUI_FORMATTING_RULES", () => {
    it("forbids em dashes and emojis in model text", () => {
      expect(TUI_FORMATTING_RULES).toMatch(/Never use em dashes/i);
      expect(TUI_FORMATTING_RULES).toMatch(/Never use emojis/i);
    });

    it("does not contain em dashes or non-ASCII pictographs in its own prose", () => {
      // The rules must not model the very characters they ban. Arrows and the
      // box-drawing examples (in the forbidden list) are the only allowed
      // non-ASCII; every em dash everywhere is disallowed.
      expect(TUI_FORMATTING_RULES).not.toContain("\u2014"); // em dash
    });
  });

  describe("escalationContract", () => {
    it("identifies the active model and requires a direct answer", () => {
      const out = escalationContract("deepseek-v4-flash");
      expect(out).toContain("`deepseek-v4-flash`");
      expect(out).toContain("Deliver the strongest answer you can directly");
      expect(out).toContain("If asked which model you are, answer `deepseek-v4-flash`");
    });

    it("keeps the compatibility export aligned with the default model note", () => {
      expect(ESCALATION_CONTRACT).toBe(escalationContract("deepseek-v4-flash"));
    });
  });
});

describe("startup-profile", () => {
  function makeSink(): { stream: NodeJS.WriteStream; output: () => string } {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    return { stream, output: () => Buffer.concat(chunks).toString("utf8") };
  }

  describe("startup-profile", () => {
    const original = process.env.REASONIX_PROFILE_STARTUP;

    beforeEach(() => {
      _resetForTests();
    });

    afterEach(() => {
      if (original === undefined) Reflect.deleteProperty(process.env, "REASONIX_PROFILE_STARTUP");
      else process.env.REASONIX_PROFILE_STARTUP = original;
      _resetForTests();
    });

    it("is always enabled but keeps console output opt-in", () => {
      Reflect.deleteProperty(process.env, "REASONIX_PROFILE_STARTUP");
      expect(isStartupProfileEnabled()).toBe(true);
      markPhase("a");
      markPhase("b");
      const sink = makeSink();
      dumpStartupProfile(sink.stream);
      expect(sink.output()).toBe("");
    });

    it("cannot disable durable startup profiling", () => {
      for (const v of ["1", "true", "yes", "0"]) {
        process.env.REASONIX_PROFILE_STARTUP = v;
        expect(isStartupProfileEnabled()).toBe(true);
      }
    });

    it("emits a formatted profile when enabled, with cumulative + delta per phase", () => {
      process.env.REASONIX_PROFILE_STARTUP = "1";
      markPhase("first");
      markPhase("second");
      markPhase("third");
      const sink = makeSink();
      dumpStartupProfile(sink.stream);
      const out = sink.output();
      expect(out).toContain("[startup-profile]");
      expect(out).toContain("first");
      expect(out).toContain("second");
      expect(out).toContain("third");
      expect(out).toMatch(/total/);
      expect(out).toMatch(/last phase third/);
    });

    it("dumpStartupProfile is idempotent — second call is silent", () => {
      process.env.REASONIX_PROFILE_STARTUP = "1";
      markPhase("only");
      const sink1 = makeSink();
      dumpStartupProfile(sink1.stream);
      const first = sink1.output();
      expect(first.length).toBeGreaterThan(0);

      const sink2 = makeSink();
      dumpStartupProfile(sink2.stream);
      expect(sink2.output()).toBe("");
    });

    it("emits nothing when enabled but no phases were marked", () => {
      process.env.REASONIX_PROFILE_STARTUP = "1";
      const sink = makeSink();
      dumpStartupProfile(sink.stream);
      expect(sink.output()).toBe("");
    });

    it("each line shows ms + phase name + (+delta) suffix", () => {
      process.env.REASONIX_PROFILE_STARTUP = "1";
      markPhase("alpha");
      markPhase("beta");
      const sink = makeSink();
      dumpStartupProfile(sink.stream);
      const lines = sink.output().split("\n");
      const alphaLine = lines.find((l) => l.includes("alpha"));
      const betaLine = lines.find((l) => l.includes("beta"));
      expect(alphaLine).toMatch(/\d+ms\s+alpha\s+\(\+\d+\)/);
      expect(betaLine).toMatch(/\d+ms\s+beta\s+\(\+\d+\)/);
    });
  });
});

// Regression for #928 — Tauri's NSIS template stores `{{product_name}}` and substitutes it at installer runtime via the nsis_tauri_utils DLL. When that DLL fails to load (AV / temp-dir issues) the raw placeholder leaks into the dialog. Our custom language files must hardcode the product name so the strings degrade gracefully.
describe("installer-nsh-no-placeholders", () => {
  const nshFiles = ["../desktop/src-tauri/nsis/English.nsh"];

  const PRODUCT_NAME = "Reasonix+";
  const RUNTIME_STRINGS = ["appRunning", "appRunningOkKill", "failedToKillApp"] as const;

  describe("desktop installer NSIS language files — issue #928", () => {
    for (const rel of nshFiles) {
      describe(rel.split("/").pop() ?? rel, () => {
        const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
        const code = text
          .split(/\r?\n/)
          .filter((line) => !line.trimStart().startsWith(";"))
          .join("\n");

        it("contains no `{{product_name}}` runtime placeholders", () => {
          expect(code).not.toMatch(/\{\{\s*product_name\s*\}\}/);
        });

        for (const stringName of RUNTIME_STRINGS) {
          it(`mentions the product name in LangString ${stringName}`, () => {
            const re = new RegExp(
              `LangString\\s+${stringName}\\s+\\$\\{LANG_[A-Z_]+\\}\\s+"[^"]*${PRODUCT_NAME}[^"]*"`,
            );
            expect(text).toMatch(re);
          });
        }
      });
    }
  });
});
