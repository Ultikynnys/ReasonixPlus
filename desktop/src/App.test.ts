import { describe, expect, it, vi } from "vitest";

vi.mock("./Markdown", () => ({
  WorkspaceProvider: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("./theme", () => ({
  FONT_FAMILY: "sans-serif",
  FONT_FAMILY_STACK: "sans-serif",
  FONT_SCALE: 1,
  FONT_SCALE_ZOOM: 1,
  THEME: "dark",
  THEME_STYLE: {
    GRAPHITE: "graphite",
    SANDSTONE: "sandstone",
    PORCELAIN: "porcelain",
    MIDNIGHT: "midnight",
  },
  defaultStyleForTheme: vi.fn(() => ({
    bg: "#000",
    surface: "#111",
    border: "#222",
    text: "#fff",
    muted: "#888",
    accent: "#0af",
    danger: "#f00",
    warn: "#fa0",
    success: "#0f0",
    brand: "#0af",
  })),
  isFontFamily: vi.fn(() => true),
  isFontScale: vi.fn(() => true),
  isTheme: vi.fn(() => true),
  isThemeStyle: vi.fn(() => true),
  themeForStyle: vi.fn(() => "dark"),
}));

import { baseAppState } from "../../tests/support/app-state.js";
import { interfaceFields } from "../../tests/support/protocol.js";
import {
  activePlanForMessage,
  cueIdForEvent,
  groupTabsByWorkspace,
  hasPendingIntervention,
  mapLoadedMessages,
  parseSessionTimestamp,
  reduce,
  runningSessionNames,
  sanitizeSettingsPatch,
  sessionCreationTime,
  sessionMutationLabel,
  sessionRecency,
  settingsValueEqual,
  sortSessionsByCreationDescending,
  sortSessionsDescending,
  turnEngaged,
  workspaceTabRepresentatives,
  writeStamp,
} from "./App";
import type { IncomingEvent, ModelTurnStartedEvent, PlanHistoryItem } from "./protocol";
import { getThreadMaxWidth } from "./ui/thread-layout";

/** One workspace plan-history row, as a $plan_history projection carries it. */
function planHistoryRow(id: string, overrides: Partial<PlanHistoryItem> = {}): PlanHistoryItem {
  return {
    id,
    status: "active",
    createdAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    totalSteps: 1,
    completedSteps: 1,
    ...overrides,
  };
}

function initialState(): Parameters<typeof reduce>[0] {
  return baseAppState({ ready: false, model: undefined, currentSession: undefined });
}

function makeShellPrompt(command: string): import("@reasonix/core-utils").ApprovalPrompt {
  return {
    id: 1,
    kind: "shell",
    tone: "warn",
    title: "Run command",
    subtitle: command,
    preview: command,
    meta: {},
    actions: [
      { id: "run_once", label: "Run once", kind: "allow_once" },
      { id: "always_allow", label: "Always allow", kind: "allow_always" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: command.split(" ")[0] ?? "" },
  };
}

function makePathPrompt(
  path: string,
  intent: "read" | "write",
): import("@reasonix/core-utils").ApprovalPrompt {
  return {
    id: 2,
    kind: "path",
    tone: "warn",
    title: `Access path — ${intent}`,
    subtitle: path,
    preview: `tool → ${path}`,
    meta: { sandboxRoot: "/workspace" },
    actions: [
      {
        id: "run_once",
        label: intent === "write" ? "Allow write" : "Allow read",
        kind: "allow_once",
      },
      { id: "always_allow", label: "Always allow", kind: "allow_always" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: "/workspace", intent },
  };
}

describe("Desktop App reducer — usage", () => {
  it("records explicit workspace initialization monotonically", () => {
    const initialized = reduce(initialState(), {
      t: "incoming",
      event: { type: "$workspace_initialized", revision: 2 },
    });
    const stale = reduce(initialized, {
      t: "incoming",
      event: { type: "$workspace_initialized", revision: 1 },
    });

    expect(initialized.workspaceInitializationRevision).toBe(2);
    expect(stale.workspaceInitializationRevision).toBe(2);
  });

  it("falls back prompt tokens to cache miss tokens when cache fields are absent", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "model.final",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "ok",
        toolCalls: [],
        usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
      },
    });

    expect(next.usage.totalPromptTokens).toBe(1234);
    expect(next.usage.cacheHitTokens).toBe(0);
    expect(next.usage.cacheMissTokens).toBe(1234);
    expect(next.usage.lastCallCacheMiss).toBe(1234);
  });

  it("surfaces OpenCode Zen cache hits carried by the normalized model.final event", () => {
    // eventize emits prompt_cache_hit_tokens/miss from the client's normalized
    // Usage; Zen reports cache under prompt_tokens_details.cached_tokens, which
    // Usage.fromApi maps into that field. The statusbar chip reads these totals.
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "model.final",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "ok",
        toolCalls: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          total_tokens: 1020,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200,
        },
      },
    });

    expect(next.usage.totalPromptTokens).toBe(1000);
    expect(next.usage.cacheHitTokens).toBe(800);
    expect(next.usage.cacheMissTokens).toBe(200);
    expect(next.usage.lastCallCacheHit).toBe(800);
    expect(next.usage.lastCallCacheMiss).toBe(200);
  });

  it("settles the pending assistant message on an error but keeps the daemon-owned turn (#1660)", () => {
    const base = initialState();
    const state = {
      ...base,
      busy: true,
      messages: [
        ...base.messages,
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "reasoning" as const, text: "thinking…" }],
          pending: true,
        },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        message: "SSE body read failed: terminated",
        recoverable: false,
      },
    });

    // $error is not terminal: mid-turn hook failures arrive while the loop
    // keeps running. Only $turn_complete / $tab_status release the turn.
    expect(next.busy).toBe(true);
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(assistant?.pending).toBe(false);
    const error = next.messages.find((m) => m.kind === "notice" && m.severity === "error");
    expect(error).toMatchObject({
      kind: "notice",
      text: "SSE body read failed: terminated",
      severity: "error",
    });
  });

  it("busy parity: an optimistic send spins as awaitingAck without owning the turn", () => {
    const next = reduce(initialState(), { t: "send_user", text: "hello", clientId: "c-1" });
    expect(next.awaitingAck).toBe(true);
    expect(next.busy).toBe(false);
  });

  it("busy parity: $turn_started is the authoritative ON signal", () => {
    let state = reduce(initialState(), { t: "send_user", text: "hello", clientId: "c-1" });
    expect(state.busy).toBe(false);
    state = reduce(state, {
      t: "incoming",
      event: { type: "$turn_started", turn: 1, clientId: "c-1" },
    });
    expect(state.busy).toBe(true);
    expect(state.awaitingAck).toBe(false);
  });

  it("busy parity: a rejected send settles through $turn_complete without $turn_started", () => {
    let state = reduce(initialState(), { t: "send_user", text: "hello", clientId: "c-1" });
    state = reduce(state, {
      t: "incoming",
      event: { type: "$turn_complete", outcome: "stopped", reason: "No API key configured" },
    });
    expect(state.busy).toBe(false);
    expect(state.awaitingAck).toBe(false);
  });

  it("busy parity: a mid-turn $error does not release the turn", () => {
    let state = reduce(initialState(), { t: "send_user", text: "hello", clientId: "c-1" });
    state = reduce(state, { t: "incoming", event: { type: "$turn_started", turn: 1 } });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        message: "hook outcome failed",
        recoverable: false,
      },
    });
    expect(state.busy).toBe(true);
    const error = state.messages.find((m) => m.kind === "notice" && m.severity === "error");
    expect(error).toBeDefined();
  });

  it("busy parity: $tab_status reconciles a lost terminal event to idle with a notice", () => {
    let state = reduce(initialState(), { t: "send_user", text: "hello", clientId: "c-1" });
    state = reduce(state, { t: "incoming", event: { type: "$turn_started", turn: 1 } });
    state = reduce(state, {
      t: "incoming",
      event: { type: "$tab_status", busy: false, queued: 0, compacting: false, switching: false },
    });
    expect(state.busy).toBe(false);
    expect(state.awaitingAck).toBe(false);
    const resync = state.messages.find((m) => m.kind === "notice" && m.text.includes("Resynced"));
    expect(resync).toBeDefined();
  });

  it("busy parity: turnEngaged is the one predicate every idle check shares", () => {
    // The composer, the queue drain, the watchdog and the transcript guard all read
    // idleness through this function, so none of them can disagree about it.
    expect(turnEngaged({ busy: false, awaitingAck: false, compacting: false })).toBe(false);
    expect(turnEngaged({ busy: true, awaitingAck: false, compacting: false })).toBe(true);
    expect(turnEngaged({ busy: false, awaitingAck: true, compacting: false })).toBe(true);
    expect(turnEngaged({ busy: false, awaitingAck: false, compacting: true })).toBe(true);
  });

  it("busy parity: $tab_status adopts daemon busy when the UI missed the start", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$tab_status",
        busy: true,
        turn: 2,
        queued: 0,
        compacting: false,
        switching: false,
      },
    });
    expect(next.busy).toBe(true);
    expect(next.awaitingAck).toBe(false);
  });

  it("busy parity: $tab_status treats a compacting daemon as engaged, never idle", () => {
    // A fold leaves turn-busy false while the daemon still works — releasing a
    // held turn here would strand the send the user typed during compaction.
    let state = reduce(initialState(), { t: "send_user", text: "hi", clientId: "c-1" });
    state = reduce(state, { t: "incoming", event: { type: "$turn_started", turn: 1 } });
    state = reduce(state, {
      t: "incoming",
      event: { type: "$tab_status", busy: false, queued: 0, compacting: true, switching: false },
    });
    expect(state.busy).toBe(true);
    expect(state.awaitingAck).toBe(false);
    expect(state.messages.some((m) => m.kind === "notice" && m.text.includes("Resynced"))).toBe(
      false,
    );
  });

  it("compacting clears from the daemon even while a card still spins", () => {
    // Regression: the queue is gated by the daemon's authoritative flag, not by
    // the presence of a compaction card — a stuck card must never wedge sends.
    const stuck = baseAppState({
      compacting: true,
      messages: [
        {
          kind: "notice",
          id: "n1",
          text: "Compacting context…",
          severity: "info",
          running: true,
          trigger: "auto",
        },
      ],
    });
    const next = reduce(stuck, {
      t: "incoming",
      event: { type: "$tab_status", busy: false, queued: 0, compacting: false, switching: false },
    });
    expect(next.compacting).toBe(false);
  });

  it("compacting toggles from the daemon without a spurious resync", () => {
    // The daemon announces the fold while turn-busy stays false; the flag alone
    // gates the queue, and clearing it must not look like a lost terminal.
    let state = reduce(initialState(), {
      t: "incoming",
      event: { type: "$tab_status", busy: false, queued: 0, compacting: true, switching: false },
    });
    expect(state.compacting).toBe(true);
    expect(state.busy).toBe(false);
    state = reduce(state, {
      t: "incoming",
      event: { type: "$tab_status", busy: false, queued: 0, compacting: false, switching: false },
    });
    expect(state.compacting).toBe(false);
    expect(state.messages.some((m) => m.kind === "notice" && m.text.includes("Resynced"))).toBe(
      false,
    );
  });

  // The ghost-card class: a session that reads as idle while cards keep landing in
  // its transcript. Agent output is turn output, and a turn that streams is never
  // idle — so an idle transcript is closed to new cards, and output that proves a
  // turn is running adopts the turn instead of painting under an idle composer.
  describe("ghost cards — an idle chat never grows a card", () => {
    const contentDelta = (turn: number, text: string) => ({
      type: "model.delta" as const,
      id: turn * 100,
      ts: "2026-05-27T00:00:00.000Z",
      turn,
      channel: "content" as const,
      text,
    });

    /** One whole turn driven through the same events the daemon sends, left
     *  settled and idle: the state a ghost card would appear in. */
    function settledTurn(turn = 1) {
      let state = reduce(initialState(), {
        t: "send_user",
        text: "hello",
        clientId: `c-${turn}`,
      });
      state = reduce(state, { t: "incoming", event: { type: "$turn_started", turn } });
      state = reduce(state, { t: "incoming", event: contentDelta(turn, "answer") });
      return reduce(state, {
        t: "incoming",
        event: { type: "$turn_complete", outcome: "success", turn },
      });
    }

    it("drops late output for a settled turn instead of opening a card", () => {
      const idle = settledTurn();
      expect(idle.busy).toBe(false);

      const late = reduce(idle, { t: "incoming", event: contentDelta(1, " still typing") });

      expect(late).toBe(idle);
      expect(late.messages.filter((m) => m.kind === "assistant")).toHaveLength(1);
      expect(late.busy).toBe(false);
    });

    it("drops a tool card for a settled turn instead of opening one", () => {
      const idle = settledTurn();
      const cards = idle.messages.length;

      const late = reduce(idle, {
        t: "incoming",
        event: {
          type: "tool.preparing",
          id: 2,
          ts: "2026-05-27T00:00:00.000Z",
          turn: 1,
          callId: "tc-late",
          name: "shell",
        },
      });

      expect(late.messages).toHaveLength(cards);
      expect(late.busy).toBe(false);
    });

    it("drops a batched frame for a settled turn instead of opening a card", () => {
      // The live stream reaches the reducer as coalesced frames, not one event per
      // token, so the batched path has to honour the same rule.
      const idle = settledTurn();

      const late = reduce(idle, {
        t: "batch_delta",
        items: [{ turn: 1, channel: "content", text: " still typing" }],
      });

      expect(late).toBe(idle);
      expect(late.messages.filter((m) => m.kind === "assistant")).toHaveLength(1);
    });

    it("still clears a fold card left spinning when the frame is refused", () => {
      // Refusing output must not skip the cleanup that used to ride along with it:
      // a stuck compaction throbber goes even though no card is opened.
      const idle = settledTurn();
      const stuck = {
        ...idle,
        messages: [
          ...idle.messages,
          {
            kind: "notice" as const,
            id: "fold-1",
            text: "Compacting context…",
            severity: "info" as const,
            running: true,
            trigger: "auto" as const,
          },
        ],
      };

      const late = reduce(stuck, { t: "incoming", event: contentDelta(1, " still typing") });

      expect(late.messages).toEqual(idle.messages);
      expect(late.busy).toBe(false);
    });

    it("adopts a batched frame for a live turn it never saw start", () => {
      const idle = settledTurn(1);

      const next = reduce(idle, {
        t: "batch_delta",
        items: [{ turn: 2, channel: "content", text: "second answer" }],
      });

      expect(next.busy).toBe(true);
      expect(next.messages.at(-1)).toMatchObject({
        kind: "assistant",
        turn: 2,
        pending: true,
      });
    });

    it("cannot open a card for a late warning on an already-settled turn", () => {
      const idle = settledTurn();
      const cards = idle.messages.length;

      const late = reduce(idle, {
        t: "incoming",
        event: {
          type: "warning",
          id: 9,
          ts: "2026-05-27T00:00:00.000Z",
          turn: 1,
          text: "late warning from a turn that already ended",
          severity: "high",
        },
      });

      expect(late.messages).toHaveLength(cards);
      expect(late.busy).toBe(false);
    });

    it("adopts a turn whose start it never saw instead of painting into an idle chat", () => {
      const idle = settledTurn(1);

      const next = reduce(idle, { t: "incoming", event: contentDelta(2, "second answer") });

      expect(next.busy).toBe(true);
      expect(next.awaitingAck).toBe(false);
      expect(next.messages.at(-1)).toMatchObject({
        kind: "assistant",
        turn: 2,
        pending: true,
        segments: [{ kind: "text", text: "second answer" }],
      });
    });

    it("still delivers a diagnostic notice to an idle chat", () => {
      // Only turn output is gated: a notice (or an error) is a diagnostic and has
      // to reach the user whenever it happens.
      const idle = settledTurn();

      const next = reduce(idle, {
        t: "incoming",
        event: { type: "$notice", text: "Sessions deleted", severity: "info" },
      });

      expect(next.messages.at(-1)).toMatchObject({ kind: "notice", text: "Sessions deleted" });
    });

    it("adopts output for a turn the transcript only ever knew as history", () => {
      // History read from disk is CLOSED but never SETTLED — this chat has seen no
      // terminal event for it — so the daemon may still be streaming that turn, and
      // dropping its output would lose the answer the user is waiting for.
      let state = reduce(initialState(), {
        t: "incoming",
        event: {
          type: "$session_loaded",
          name: "sess-1",
          resync: false,
          messages: [
            { kind: "user", text: "q1" },
            {
              kind: "assistant",
              turn: 1,
              segments: [{ kind: "text", text: "logged answer" }],
              pending: false,
            },
          ],
          carryover: { cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 },
        },
      });

      state = reduce(state, { t: "incoming", event: contentDelta(1, "live tail") });

      expect(state.busy).toBe(true);
      expect(state.messages.at(-1)).toMatchObject({ kind: "assistant", pending: true });
    });
  });

  it("appends a late kernel error at the tail in creation order, not re-anchored to its turn", () => {
    const base = initialState();
    const state = {
      ...base,
      messages: [
        { kind: "user" as const, text: "first", clientId: "c-1", turn: 1 },
        { kind: "assistant" as const, turn: 1, segments: [], pending: false },
        { kind: "user" as const, text: "second", clientId: "c-2", turn: 2 },
        { kind: "assistant" as const, turn: 2, segments: [], pending: false },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        message: "Late failure from turn one",
        recoverable: false,
      },
    });

    expect(
      next.messages.map((m) => (m.kind === "notice" ? `notice-${m.turn}` : `${m.kind}-${m.turn}`)),
    ).toEqual(["user-1", "assistant-1", "user-2", "assistant-2", "notice-1"]);
  });

  it("appends error cards in creation order, never inverting a later error above an earlier one", () => {
    const base = initialState();
    const state = {
      ...base,
      messages: [
        { kind: "user" as const, text: "go", clientId: "c-1", turn: 1 },
        { kind: "assistant" as const, turn: 1, segments: [], pending: false },
      ],
    };
    // Created back-to-back: a turn-2 error first, then a late turn-1 error.
    // Placement follows creation (turn-2 card stays above), not turn number.
    let next = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 10,
        ts: "t",
        turn: 2,
        message: "created first",
        recoverable: false,
      },
    });
    next = reduce(next, {
      t: "incoming",
      event: {
        type: "error",
        id: 11,
        ts: "t",
        turn: 1,
        message: "created second",
        recoverable: false,
      },
    });
    expect(next.messages.flatMap((m) => (m.kind === "notice" ? [m.text] : []))).toEqual([
      "created first",
      "created second",
    ]);
  });

  it("recovers model and tool cards when turn-start is missing after a model switch", () => {
    let state = reduce(initialState(), {
      t: "send_user",
      text: "continue after switching models",
      clientId: "c-1",
    });

    state = reduce(state, {
      t: "incoming",
      event: {
        type: "tool.intent",
        id: 1,
        ts: "t",
        turn: 1,
        callId: "tc-1",
        name: "read_file",
        args: '{"path":"src/App.tsx"}',
      },
    });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 2,
        ts: "t",
        turn: 1,
        callId: "tc-1",
        ok: true,
        output: "file contents",
      },
    });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 3,
        ts: "t",
        turn: 1,
        channel: "content",
        text: "Done.",
      },
    });

    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({
      kind: "assistant",
      turn: 1,
      pending: true,
      segments: [
        {
          kind: "tool",
          callId: "tc-1",
          name: "read_file",
          result: "file contents",
          ok: true,
        },
        { kind: "text", text: "Done." },
      ],
    });
  });

  it("releases a busy turn when the marked model switch lands", () => {
    const base: Parameters<typeof reduce>[0] = {
      ...initialState(),
      busy: true,
      turnStatus: "waiting_model",
      turnStatusTool: "read_file",
      settings: {
        reasoningEffort: "high",
        editMode: "follow",
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        version: "0.50.1",
      },
      queuedSends: [{ text: "queued while the turn was wedged" }],
    };

    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "glm-5.3-flash",
        turnReleased: true,
        version: "0.50.1",
      },
    });

    // The daemon aborts the running turn on a model switch; the FE must
    // unblock too, or the queued sends stay stuck behind the dead turn.
    expect(next.busy).toBe(false);
    expect(next.turnStatus).toBeNull();
    expect(next.turnStatusTool).toBeNull();
    expect(next.queuedSends).toHaveLength(1);
  });

  it("keeps a running turn when a failover repaints the model", () => {
    const base: Parameters<typeof reduce>[0] = {
      ...initialState(),
      busy: true,
      awaitingAck: false,
      turnStatus: "waiting_model",
      turnStatusTool: "spawn_subagent",
      settings: {
        reasoningEffort: "high",
        editMode: "follow",
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        subagentModel: "gpt-5.6-sol",
        version: "0.50.1",
      },
      queuedSends: [{ text: "typed while the subagent ran" }],
    };

    // A provider ran dry mid-turn: the tab (and the subagent pin with it) moved
    // to a backup, but the turn never ended. Settling here marked the task
    // complete over a live subagent and drained the queue into that turn.
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "glm-5.3-flash",
        subagentModel: "glm-5.3-flash",
        providerCatalogs: {},
        version: "0.50.1",
      },
    });

    expect(next.busy).toBe(true);
    expect(next.turnStatus).toBe("waiting_model");
    expect(next.turnStatusTool).toBe("spawn_subagent");
    expect(next.queuedSends).toHaveLength(1);
    expect(next.settings?.model).toBe("glm-5.3-flash");
  });

  it("takes the parked-send count as the ack for a send that arrived mid-turn", () => {
    const parked: Parameters<typeof reduce>[0] = {
      ...initialState(),
      busy: false,
      awaitingAck: true,
      settings: {
        reasoningEffort: "high",
        editMode: "follow",
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        version: "0.50.1",
      },
      queuedSends: [{ text: "next" }],
    };

    // The daemon holds the send behind a turn that is still unwinding. Without
    // this ack the stale-send watchdog releases it after 10 s with the "never
    // acknowledged" warning and discards the queue behind it.
    const next = reduce(parked, {
      t: "incoming",
      event: { type: "$tab_status", busy: true, queued: 1, compacting: false, switching: false },
    });

    expect(next.awaitingAck).toBe(false);
    expect(next.busy).toBe(true);
    expect(next.queuedSends).toHaveLength(1);
  });

  it("keeps a fold engaged when it parks the send instead of claiming a turn", () => {
    const folding: Parameters<typeof reduce>[0] = {
      ...initialState(),
      busy: false,
      awaitingAck: true,
      settings: {
        reasoningEffort: "high",
        editMode: "follow",
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        version: "0.50.1",
      },
    };

    const next = reduce(folding, {
      t: "incoming",
      event: { type: "$tab_status", busy: false, queued: 1, compacting: true, switching: false },
    });

    // The ack lands, but the fold keeps the chat engaged through `compacting`:
    // claiming busy here would leave the next probe reporting a lost turn.
    expect(next.awaitingAck).toBe(false);
    expect(next.busy).toBe(false);
    expect(next.compacting).toBe(true);
  });

  it("keeps a running turn when $settings refreshes without a model change", () => {
    const base: Parameters<typeof reduce>[0] = {
      ...initialState(),
      busy: true,
      turnStatus: "waiting_model",
      settings: {
        reasoningEffort: "high",
        editMode: "follow",
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        version: "0.50.1",
      },
    };

    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "low",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        version: "0.50.1",
      },
    });

    expect(next.busy).toBe(true);
    expect(next.turnStatus).toBe("waiting_model");
  });

  it("releases busy when $settings arrives after optimistic settings_patch model switch", () => {
    let state: Parameters<typeof reduce>[0] = {
      ...initialState(),
      busy: true,
      turnStatus: "waiting_model",
      turnStatusTool: "read_file",
      settings: {
        reasoningEffort: "high",
        editMode: "follow",
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        version: "0.50.1",
      },
      queuedSends: [{ text: "Proceed" }],
    };

    state = reduce(state, {
      t: "settings_patch",
      patch: { model: "glm-5.3-flash" },
    });

    state = reduce(state, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "glm-5.3-flash",
        version: "0.50.1",
      },
    });

    expect(state.busy).toBe(false);
    expect(state.turnStatus).toBeNull();
    expect(state.turnStatusTool).toBeNull();
  });

  it("applies batch_delta to the card model.turn.started created (no synthesis)", () => {
    let state = reduce(initialState(), {
      t: "send_user",
      text: "first turn",
      clientId: "c-1",
    });

    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.turn.started",
        id: 1,
        ts: "t",
        turn: 1,
        model: "m",
        reasoningEffort: "medium",
        prefixHash: "h",
      },
    });

    state = reduce(state, {
      t: "batch_delta",
      items: [{ turn: 1, channel: "content", text: "executing task" }],
    });

    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({
      kind: "assistant",
      turn: 1,
      pending: true,
      segments: [{ kind: "text", text: "executing task" }],
    });
  });

  it("reconciles the optimistic user bubble with the daemon turn echo", () => {
    // Simulate a post-truncation post-model-switch session: the daemon's
    // monotonic counter sits far above the FE's optimistic guess.
    let state: Parameters<typeof reduce>[0] = {
      ...initialState(),
      messages: [
        { kind: "user", text: "old", clientId: "c-old", turn: 41 },
        { kind: "assistant", turn: 41, segments: [], pending: false },
      ],
    };

    state = reduce(state, {
      t: "send_user",
      text: "continue",
      clientId: "c-42",
    });
    // Optimistic guess.
    expect(state.messages.at(-1)).toMatchObject({ kind: "user", turn: 42, clientId: "c-42" });

    state = reduce(state, {
      t: "incoming",
      event: {
        type: "user.message",
        id: 7,
        ts: "t",
        turn: 4096,
        text: "continue",
        clientId: "c-42",
      },
    });

    // The bubble is renumbered in place — no duplicate appended.
    const users = state.messages.filter((m) => m.kind === "user");
    expect(users).toHaveLength(2);
    expect(users.at(-1)).toMatchObject({ turn: 4096, clientId: "c-42" });
  });

  it("always creates an assistant card for a model.turn.started with an unseen turn", () => {
    // Post-truncation regression guard (the old skip-branch swallowed the
    // whole turn when the ordinal collided with an ancient card): an unseen
    // ordinal must always produce a fresh pending card.
    let state: Parameters<typeof reduce>[0] = {
      ...initialState(),
      messages: [
        { kind: "user", text: "old", clientId: "c-old", turn: 4095 },
        { kind: "assistant", turn: 4095, segments: [], pending: false },
      ],
    };

    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.turn.started",
        id: 1,
        ts: "t",
        turn: 4096,
        model: "m",
        reasoningEffort: "medium",
        prefixHash: "h",
      },
    });

    expect(state.messages.at(-1)).toMatchObject({ kind: "assistant", turn: 4096, pending: true });
  });

  it("recovers the turn card from any entry event when turn-start is missing", () => {
    const base = initialState();
    const incoming = (event: Record<string, unknown>) =>
      reduce(base, { t: "incoming", event } as unknown as Parameters<typeof reduce>[1]);

    // Streamed text arrives first (no turn-start): the card still appears.
    expect(
      incoming({ type: "model.delta", id: 1, ts: "t", turn: 2, channel: "content", text: "hi" })
        .messages,
    ).toMatchObject([
      { kind: "assistant", turn: 2, pending: true, segments: [{ kind: "text", text: "hi" }] },
    ]);

    // A tool call announced first (no turn-start): the running tool appears.
    expect(
      incoming({ type: "tool.preparing", id: 2, ts: "t", turn: 3, callId: "tc-9", name: "shell" })
        .messages[0],
    ).toMatchObject({
      kind: "assistant",
      turn: 3,
      pending: true,
      segments: [{ kind: "tool", callId: "tc-9", name: "shell" }],
    });
  });

  it("does not fabricate a card for events that only patch an existing one", () => {
    const base = initialState();
    // tool.result only patches an existing tool segment, so alone it must not
    // spawn an empty assistant bubble.
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 1,
        ts: "t",
        turn: 4,
        callId: "tc-1",
        ok: true,
        output: "orphaned result",
      },
    } as unknown as Parameters<typeof reduce>[1]);
    expect(next.messages).toEqual([]);
  });

  it("settles a tool result on its own turn when a rebuilt runtime repeats the callId", () => {
    const inc = (state: ReturnType<typeof initialState>, event: Record<string, unknown>) =>
      reduce(state, { t: "incoming", event } as unknown as Parameters<typeof reduce>[1]);
    const tool = (state: ReturnType<typeof initialState>, turn: number) => {
      const card = state.messages.find((m) => m.kind === "assistant" && m.turn === turn);
      return card?.kind === "assistant"
        ? card.segments.find((seg) => seg.kind === "tool")
        : undefined;
    };

    // Turn 1 announces a call that never settles (the tab is rebuilt mid-flight).
    let s = inc(initialState(), {
      type: "tool.preparing",
      id: 1,
      ts: "t",
      turn: 1,
      callId: "tc-1",
      name: "search_content",
    });
    // The rebuilt runtime restarts wire ids, so turn 2 opens ANOTHER tc-1 card —
    // a web search, whose output carries the engine header.
    s = inc(s, {
      type: "tool.preparing",
      id: 2,
      ts: "t",
      turn: 2,
      callId: "tc-1",
      name: "web_search",
    });
    s = inc(s, {
      type: "tool.result",
      id: 3,
      ts: "t",
      turn: 2,
      callId: "tc-1",
      ok: true,
      output: "engine: playwright-webkit\n\nquery: x",
    });

    // The engine header belongs to the web_search card it was produced for; the
    // stale search_content card keeps its own name and waits for the turn settle.
    expect(tool(s, 1)).toMatchObject({ name: "search_content" });
    expect((tool(s, 1) as { result?: string } | undefined)?.result).toBeUndefined();
    expect(tool(s, 2)).toMatchObject({
      name: "web_search",
      result: "engine: playwright-webkit\n\nquery: x",
    });
  });

  it("keeps older streaming cards before newly created notices", () => {
    let s = initialState();
    const act = (action: Parameters<typeof reduce>[1]) => {
      s = reduce(s, action);
    };
    const inc = (event: { type: string } & Record<string, unknown>) => {
      s = reduce(s, { t: "incoming", event } as unknown as Parameters<typeof reduce>[1]);
    };
    const labels = (msgs: typeof s.messages) =>
      msgs.map((m) => {
        if (m.kind === "notice") return `${m.severity}-${m.turn}`;
        if (m.kind === "user") return `user-${m.turn}`;
        return `assistant-${m.turn}${m.pending ? "(pending)" : ""}`;
      });

    // Turn 1 completes cleanly.
    act({ t: "send_user", text: "first", clientId: "c-1" });
    inc({
      type: "model.turn.started",
      id: 1,
      ts: "t",
      turn: 1,
      model: "m",
      reasoningEffort: "medium",
      prefixHash: "h",
    });
    inc({ type: "model.delta", id: 2, ts: "t", turn: 1, channel: "content", text: "hello" });
    inc({ type: "model.final", id: 3, ts: "t", turn: 1, content: "hello", usage: null });
    inc({ type: "$turn_complete", ts: "t" });

    // Turn 2 starts streaming (assistant-2 is the active/pending card).
    act({ t: "send_user", text: "second", clientId: "c-2" });
    inc({
      type: "model.turn.started",
      id: 4,
      ts: "t",
      turn: 2,
      model: "m",
      reasoningEffort: "medium",
      prefixHash: "h",
    });
    inc({ type: "model.delta", id: 5, ts: "t", turn: 2, channel: "content", text: "streaming" });
    expect(labels(s.messages)).toEqual(["user-1", "assistant-1", "user-2", "assistant-2(pending)"]);

    act({ t: "push_notice", text: "Model → deepseek-v4-flash", severity: "info" });
    // A mid-turn notice seals the in-flight card, so later output opens a NEW
    // card below it; the notice itself still lands in creation order (last).
    expect(labels(s.messages)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
      "info-2",
    ]);

    inc({ type: "error", id: 6, ts: "t", turn: 2, message: "429 rate limit", recoverable: false });
    expect(labels(s.messages)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
      "info-2",
      "error-2",
    ]);
  });

  it("places a new status notice after the already created response", () => {
    let s = initialState();
    const act = (action: Parameters<typeof reduce>[1]) => {
      s = reduce(s, action);
    };
    const inc = (event: { type: string } & Record<string, unknown>) => {
      s = reduce(s, { t: "incoming", event } as unknown as Parameters<typeof reduce>[1]);
    };
    const labels = (msgs: typeof s.messages) =>
      msgs.map((m) => {
        if (m.kind === "notice") return `${m.severity}-${m.turn}`;
        if (m.kind === "user") return `user-${m.turn}`;
        return `assistant-${m.turn}${m.pending ? "(pending)" : ""}`;
      });

    // Turn 1 completes cleanly (its assistant card is the newest entry).
    act({ t: "send_user", text: "first", clientId: "c-1" });
    inc({
      type: "model.turn.started",
      id: 1,
      ts: "t",
      turn: 1,
      model: "m",
      reasoningEffort: "medium",
      prefixHash: "h",
    });
    inc({ type: "model.final", id: 2, ts: "t", turn: 1, content: "hello", usage: null });
    inc({ type: "$turn_complete", ts: "t" });
    expect(labels(s.messages)).toEqual(["user-1", "assistant-1"]);

    act({ t: "push_notice", text: "Mode: AUTO", severity: "info" });
    expect(labels(s.messages)).toEqual(["user-1", "assistant-1", "info-1"]);
  });

  it("keeps error cards below their own turn's user message when numbering is unified", () => {
    // Turn contract pinned stack-wide: the kernel's turn number equals the FE
    // user-message position. A resumed session whose earlier turn failed (user
    // message logged, no assistant reply) must NOT renumber — with the old
    // assistant-count resume baseline the kernel lagged one turn behind and the
    // error card jumped ABOVE the very "proceed" that started its turn.
    let s = initialState();
    const act = (action: Parameters<typeof reduce>[1]) => {
      s = reduce(s, action);
    };
    const inc = (event: { type: string } & Record<string, unknown>) => {
      s = reduce(s, { t: "incoming", event } as unknown as Parameters<typeof reduce>[1]);
    };
    const labels = (msgs: typeof s.messages) =>
      msgs.map((m) => {
        if (m.kind === "notice") return `${m.severity}-${m.turn}`;
        if (m.kind === "user") return `user-${m.turn}`;
        return `assistant-${m.turn}${m.pending ? "(pending)" : ""}`;
      });

    // Turn 1 completes; turn 2 fails before any model reply (no assistant card).
    act({ t: "send_user", text: "first", clientId: "c-1" });
    inc({
      type: "model.turn.started",
      id: 1,
      ts: "t",
      turn: 1,
      model: "m",
      reasoningEffort: "medium",
      prefixHash: "h",
    });
    inc({ type: "model.final", id: 2, ts: "t", turn: 1, content: "hello", usage: null });
    inc({ type: "$turn_complete", ts: "t" });
    act({ t: "send_user", text: "second", clientId: "c-2" });
    inc({
      type: "error",
      id: 3,
      ts: "t",
      turn: 2,
      message: "404 model not found",
      recoverable: false,
    });

    // Unified numbering: the retry ("proceed") is turn 3 for BOTH sides — the
    // error for turn 3 lands below user-3, never above it.
    act({ t: "send_user", text: "proceed", clientId: "c-3" });
    inc({
      type: "model.turn.started",
      id: 4,
      ts: "t",
      turn: 3,
      model: "m",
      reasoningEffort: "medium",
      prefixHash: "h",
    });
    inc({
      type: "error",
      id: 5,
      ts: "t",
      turn: 3,
      message: "404 model not found",
      recoverable: false,
    });
    expect(labels(s.messages)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "error-2",
      "user-3",
      "assistant-3",
      "error-3",
    ]);
  });

  it("settles every unresolved tool card when the conversation stops", () => {
    const base = initialState();
    const state = {
      ...base,
      busy: true,
      messages: [
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [
            {
              kind: "tool" as const,
              callId: "shell-1",
              name: "run_command",
              args: JSON.stringify({ command: "long task" }),
              startedAt: 100,
            },
            {
              kind: "tool" as const,
              callId: "review-1",
              name: "spawn_subagent",
              args: JSON.stringify({ task: "review changes" }),
              startedAt: 200,
            },
            {
              kind: "tool" as const,
              callId: "done-1",
              name: "read_file",
              args: JSON.stringify({ path: "README.md" }),
              startedAt: 300,
              result: "done",
              ok: true,
            },
          ],
          pending: true,
        },
      ],
    };

    const next = reduce(state, { t: "incoming", event: { type: "$turn_complete" } });

    expect(next.busy).toBe(false);
    const assistant = next.messages[0];
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected assistant message");
    expect(assistant.segments[0]).toMatchObject({
      callId: "shell-1",
      result: "Tool call cancelled because the conversation stopped. No result was produced.",
      ok: false,
    });
    expect(assistant.segments[1]).toMatchObject({
      callId: "review-1",
      result: "Tool call cancelled because the conversation stopped. No result was produced.",
      ok: false,
    });
    expect(assistant.segments[2]).toMatchObject({
      callId: "done-1",
      result: "done",
      ok: true,
    });

    const afterLateResult = reduce(next, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 99,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        callId: "shell-1",
        output: "late success",
        ok: true,
      },
    });
    const afterAssistant = afterLateResult.messages[0];
    expect(afterAssistant?.kind).toBe("assistant");
    if (afterAssistant?.kind !== "assistant") throw new Error("expected assistant message");
    expect(afterAssistant.segments[0]).toMatchObject({
      result: "Tool call cancelled because the conversation stopped. No result was produced.",
      ok: false,
    });
  });

  it("closes a subagent run its settled turn left running", () => {
    const state: Parameters<typeof reduce>[0] = {
      ...initialState(),
      busy: true,
      messages: [
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [
            {
              kind: "tool" as const,
              callId: "review-1",
              name: "spawn_subagent",
              args: JSON.stringify({ task: "review changes" }),
              startedAt: 200,
              subagentRuns: [
                { runId: "run-a", task: "review changes", status: "running" as const, tools: [] },
                { runId: "run-b", task: "read the diff", status: "done" as const, tools: [] },
              ],
            },
          ],
          pending: true,
        },
      ],
    };

    const next = reduce(state, { t: "incoming", event: { type: "$turn_complete" } });
    const assistant = next.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant message");
    const segment = assistant.segments[0];
    if (segment?.kind !== "tool") throw new Error("expected tool segment");

    // The child's progress stream ends with the turn, so a run left running would
    // keep a spinner on a card the daemon already declared idle.
    expect(segment.subagentRuns?.map((run) => run.status)).toEqual(["failed", "done"]);
  });

  it("does not reopen a spinner for a run that arrives after its turn settled", () => {
    const settled = reduce(
      {
        ...initialState(),
        messages: [
          {
            kind: "assistant" as const,
            turn: 1,
            pending: true,
            segments: [
              {
                kind: "tool" as const,
                callId: "review-1",
                name: "spawn_subagent",
                args: JSON.stringify({ task: "review changes" }),
                startedAt: 200,
              },
            ],
          },
        ],
      },
      { t: "incoming", event: { type: "$turn_complete" } },
    );

    const next = reduce(settled, {
      t: "incoming",
      event: {
        type: "subagent.progress",
        id: 9,
        ts: "2026-06-01T00:00:00.000Z",
        turn: 1,
        runId: "run-late",
        parentCallId: "review-1",
        task: "review changes",
        action: "start",
      },
    });
    const assistant = next.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant message");
    const segment = assistant.segments[0];
    if (segment?.kind !== "tool") throw new Error("expected tool segment");

    expect(segment.subagentRuns?.map((run) => run.status)).toEqual(["failed"]);
  });

  it("adds a terminal stop card when a turn ends without an answer", () => {
    const started = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "model.turn.started",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        model: "m",
        reasoningEffort: "medium",
        prefixHash: "h",
      },
    });
    const next = reduce(started, {
      t: "incoming",
      event: {
        type: "$turn_complete",
        outcome: "stopped",
        turn: 1,
        reason: "The model refused to continue.",
      },
    });
    expect(next.lastTurnOutcome).toBe("stopped");
    const notices = next.messages.filter((m) => m.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind === "notice" ? notices[0].text : "").toBe(
      "The model refused to continue.",
    );
  });

  it("does not add a second stop card when the loop already explained the stop", () => {
    const started = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "model.turn.started",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        model: "m",
        reasoningEffort: "medium",
        prefixHash: "h",
      },
    });
    const warned = reduce(started, {
      t: "incoming",
      event: {
        type: "warning",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        text: "The model returned an empty response twice in a row.",
        severity: "high",
      },
    });
    const next = reduce(warned, {
      t: "incoming",
      event: {
        type: "$turn_complete",
        outcome: "stopped",
        turn: 1,
        reason: "The model returned an empty response twice in a row.",
      },
    });
    expect(next.messages.filter((m) => m.kind === "notice")).toHaveLength(0);
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(
      assistant?.kind === "assistant" && assistant.segments.some((s) => s.kind === "warning"),
    ).toBe(true);
  });

  it("keeps cumulative usage when live context breakdown refreshes", () => {
    const base = initialState();
    const next = reduce(
      {
        ...base,
        usage: {
          ...base.usage,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          totalPromptTokens: 100,
        },
      },
      {
        t: "incoming",
        event: { type: "$ctx_breakdown", reservedTokens: 10, logTokens: 42 },
      },
    );

    expect(next.usage.cacheHitTokens).toBe(80);
    expect(next.usage.cacheMissTokens).toBe(20);
    expect(next.usage.liveLogTokens).toBe(42);
  });

  it("$mcp_setup records the session-start picker and $ready clears it", () => {
    const withSetup = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$mcp_setup",
        servers: [
          { name: "playwright", enabled: true, builtin: true },
          { name: "github", enabled: false, builtin: false },
        ],
        plugins: [{ name: "notfair", displayName: "NotFair", enabled: true }],
        skills: [{ name: "churn-analysis", description: "Predicts churn.", enabled: false }],
        subagents: true,
      },
    });
    expect(withSetup.mcpSetup).toEqual({
      servers: [
        { name: "playwright", enabled: true, builtin: true },
        { name: "github", enabled: false, builtin: false },
      ],
      plugins: [{ name: "notfair", displayName: "NotFair", enabled: true }],
      skills: [{ name: "churn-analysis", description: "Predicts churn.", enabled: false }],
      subagents: true,
    });

    const unlocked = reduce(withSetup, { t: "incoming", event: { type: "$ready" } });
    expect(unlocked.ready).toBe(true);
    expect(unlocked.mcpSetup).toBeNull();
  });

  it("$mcp_setup bumps the picker revision, so a re-armed gate remounts the dialog", () => {
    const gated = reduce(initialState(), {
      t: "incoming",
      event: { type: "$mcp_setup", servers: [], plugins: [], skills: [], subagents: false },
    });
    expect(gated.mcpSetupRevision).toBe(initialState().mcpSetupRevision + 1);

    // A failed confirm re-emits the same payload; the bump is what lets the picker
    // leave its own "starting" state and become answerable again.
    const rearmed = reduce(gated, {
      t: "incoming",
      event: { type: "$mcp_setup", servers: [], plugins: [], skills: [], subagents: false },
    });
    expect(rearmed.mcpSetupRevision).toBe(gated.mcpSetupRevision + 1);
  });

  it("$skills replaces the standalone inventory", () => {
    const listed = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$skills",
        skills: [
          {
            id: "churn-analysis",
            name: "churn-analysis",
            description: "Predicts churn.",
            path: "/skills/churn-analysis/SKILL.md",
            active: true,
          },
        ],
      },
    });
    expect(listed.skills).toEqual([
      {
        id: "churn-analysis",
        name: "churn-analysis",
        description: "Predicts churn.",
        path: "/skills/churn-analysis/SKILL.md",
        active: true,
      },
    ]);

    const cleared = reduce(listed, { t: "incoming", event: { type: "$skills", skills: [] } });
    expect(cleared.skills).toEqual([]);
  });

  it("$needs_setup also resolves the picker, so an uncredentialed chat is never stuck on it", () => {    const gated = reduce(initialState(), {
      t: "incoming",
      event: { type: "$mcp_setup", servers: [], plugins: [], skills: [], subagents: false },
    });
    expect(gated.mcpSetup).toEqual({ servers: [], plugins: [], skills: [], subagents: false });

    const resolved = reduce(gated, {
      t: "incoming",
      event: { type: "$needs_setup", reason: "no_api_key" },
    });
    expect(resolved.mcpSetup).toBeNull();
    expect(resolved.needsSetup).toBe(true);
  });

  const SETUP_MESSAGE = "Not configured yet — add an OpenRouter API key in Settings → Models.";

  it("$needs_setup keeps the daemon's model-specific reason for the setup screen", () => {
    const gated = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$needs_setup",
        reason: "no_api_key",
        message: SETUP_MESSAGE,
      },
    });
    expect(gated.setupMessage).toBe(SETUP_MESSAGE);
    // A later credential clears it: the setup screen must not keep explaining a gap
    // that no longer exists.
    expect(reduce(gated, { t: "incoming", event: { type: "$ready" } }).setupMessage).toBeNull();
  });

  it("$needs_setup releases a send parked behind the credential gate and says why", () => {
    const parked = reduce(
      reduce(baseAppState(), {
        t: "incoming",
        event: { type: "$ready" },
      }),
      { t: "send_user", text: "start the conversation", clientId: "c-1" },
    );
    expect(parked.awaitingAck).toBe(true);

    const gated = reduce(parked, {
      t: "incoming",
      event: { type: "$needs_setup", reason: "no_api_key", message: SETUP_MESSAGE },
    });
    // The composer would otherwise spin on an ack the gated daemon never sends.
    expect(gated.awaitingAck).toBe(false);
    const notice = gated.messages.at(-1);
    expect(notice?.kind).toBe("notice");
    expect(notice?.kind === "notice" ? notice.text : "").toContain("OpenRouter");
  });

  it("stores shell-output filtering totals from the context breakdown event", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$ctx_breakdown",
        reservedTokens: 10,
        shellOutputRawTokens: 50_000,
        shellOutputShownTokens: 31_000,
      },
    });

    expect(next.usage.shellOutputRawTokens).toBe(50_000);
    expect(next.usage.shellOutputShownTokens).toBe(31_000);
  });

  it("keeps prior shell-output totals when a breakdown event omits them", () => {
    const seeded = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$ctx_breakdown",
        reservedTokens: 10,
        shellOutputRawTokens: 50_000,
        shellOutputShownTokens: 31_000,
      },
    });
    const next = reduce(seeded, {
      t: "incoming",
      event: { type: "$ctx_breakdown", reservedTokens: 12 },
    });

    expect(next.usage.shellOutputRawTokens).toBe(50_000);
    expect(next.usage.shellOutputShownTokens).toBe(31_000);
  });

  it("resets shell-output totals on session load — the chip is per-session", () => {
    const seeded = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$ctx_breakdown",
        reservedTokens: 10,
        shellOutputRawTokens: 50_000,
        shellOutputShownTokens: 31_000,
      },
    });
    const next = reduce(seeded, {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "sess-2",
        messages: [],
        carryover: {
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });

    // Undefined, not 0: the chip hides until the new session emits fresh totals.
    expect(next.usage.shellOutputRawTokens).toBeUndefined();
    expect(next.usage.shellOutputShownTokens).toBeUndefined();
  });

  it("carries shell-output totals through a model.final usage rebuild", () => {
    const seeded = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$ctx_breakdown",
        reservedTokens: 10,
        shellOutputRawTokens: 50_000,
        shellOutputShownTokens: 31_000,
      },
    });
    const next = reduce(seeded, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "ok",
        toolCalls: [],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      },
    });

    expect(next.usage.shellOutputRawTokens).toBe(50_000);
    expect(next.usage.shellOutputShownTokens).toBe(31_000);
  });

  it("keeps the context cap through a model.final usage rebuild", () => {
    const seeded = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$ctx_breakdown",
        reservedTokens: 10,
        logTokens: 100,
        ctxMax: 736_000,
      },
    });
    const next = reduce(seeded, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "ok",
        toolCalls: [],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      },
    });

    // Without this the context meter reverts to its 300K fallback mid-session.
    expect(next.usage.ctxMax).toBe(736_000);
  });
});

describe("Desktop App reducer — ApprovalPrompt integration", () => {
  it("stores shell confirm with prompt on $confirm_required", () => {
    const state = initialState();
    const prompt = makeShellPrompt("git status");
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$confirm_required",
        id: 7,
        kind: "run_command",
        command: "git status",
        prompt,
      },
    });
    expect(next.pendingConfirms).toHaveLength(1);
    expect(next.pendingConfirms[0]).toMatchObject({
      id: 7,
      kind: "run_command",
      command: "git status",
    });
    expect(next.pendingConfirms[0].prompt).toEqual(prompt);
  });

  it("stores path access with prompt on $path_access_required", () => {
    const state = initialState();
    const prompt = makePathPrompt("/etc/passwd", "read");
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$path_access_required",
        id: 8,
        path: "/etc/passwd",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/workspace",
        allowPrefix: "/workspace",
        prompt,
      },
    });
    expect(next.pendingPathAccess).toHaveLength(1);
    expect(next.pendingPathAccess[0]).toMatchObject({
      id: 8,
      path: "/etc/passwd",
      intent: "read",
    });
    expect(next.pendingPathAccess[0].prompt).toEqual(prompt);
  });

  it("removes confirm on resolve_confirm", () => {
    const prompt = makeShellPrompt("ls");
    const state = {
      ...initialState(),
      pendingConfirms: [
        { id: 1, kind: "run_command" as const, command: "ls", prompt },
        {
          id: 2,
          kind: "run_command" as const,
          command: "pwd",
          prompt: { ...prompt, id: 2, subtitle: "pwd" },
        },
      ],
    };
    const next = reduce(state, { t: "resolve_confirm", id: 1 });
    expect(next.pendingConfirms).toHaveLength(1);
    expect(next.pendingConfirms[0].id).toBe(2);
  });

  it("removes path access on resolve_path_access", () => {
    const prompt = makePathPrompt("/tmp", "write");
    const state = {
      ...initialState(),
      pendingPathAccess: [
        {
          id: 3,
          path: "/tmp",
          intent: "write" as const,
          toolName: "write_file",
          sandboxRoot: "/workspace",
          allowPrefix: "/workspace",
          prompt,
        },
      ],
    };
    const next = reduce(state, { t: "resolve_path_access", id: 3 });
    expect(next.pendingPathAccess).toHaveLength(0);
  });

  it("clears all pending on clear action", () => {
    const shellPrompt = makeShellPrompt("echo hi");
    const pathPrompt = makePathPrompt("/x", "read");
    const state = {
      ...initialState(),
      pendingConfirms: [
        { id: 1, kind: "run_command" as const, command: "echo hi", prompt: shellPrompt },
      ],
      pendingPathAccess: [
        {
          id: 2,
          path: "/x",
          intent: "read" as const,
          toolName: "read_file",
          sandboxRoot: "/ws",
          allowPrefix: "/ws",
          prompt: pathPrompt,
        },
      ],
    };
    const next = reduce(state, { t: "detach_session" });
    expect(next.pendingConfirms).toHaveLength(0);
    expect(next.pendingPathAccess).toHaveLength(0);
  });

  it("patches settings optimistically for desktop setting commands", () => {
    const state: Parameters<typeof reduce>[0] = {
      ...initialState(),
      settings: {
        reasoningEffort: "medium",
        editMode: "follow",
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    };

    const next = reduce(state, {
      t: "settings_patch",
      patch: { reasoningEffort: "low", editMode: "follow" },
    });

    expect(next.settings?.reasoningEffort).toBe("low");
    expect(next.settings?.editMode).toBe("follow");
  });

  it("stores the auto-compaction settings from $settings", () => {
    const state = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        autoCompact: false,
        autoCompactTrigger: 0.6,
        version: "0.50.1",
      },
    });
    expect(state.settings?.autoCompact).toBe(false);
    expect(state.settings?.autoCompactTrigger).toBe(0.6);

    // Absent fields fall back to the daemon defaults (on, 80%).
    const defaults = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        version: "0.50.1",
      },
    });
    expect(defaults.settings?.autoCompact).toBe(true);
    expect(defaults.settings?.autoCompactTrigger).toBeNull();
  });

  it("stores the per-pack audio settings from $settings", () => {
    const audio = {
      halo: {
        inputRequired: { enabled: true, volume: 0.25 },
        guardTriggered: { enabled: false, volume: 0.8 },
      },
    };
    const state = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        feedbackAudio: audio,
        version: "0.50.1",
      },
    });
    expect(state.settings?.feedbackAudio).toEqual(audio);

    // Absent fields fall back to no pack settings: every pack silent.
    const defaults = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        version: "0.50.1",
      },
    });
    expect(defaults.settings?.feedbackAudio).toEqual({});
  });

  it("carries a picked sound pack from the UI patch to the settings_save body", () => {
    const withSettings = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        version: "0.50.1",
      },
    });
    const patch = { soundPackId: "halo" };

    // One object is both the optimistic state and the `settings_save` body, so the pack
    // the user sees marked Active is the pack the daemon is told to store.
    expect(sanitizeSettingsPatch(patch)).toEqual(patch);
    const next = reduce(withSettings, { t: "settings_patch", patch });
    expect(next.settings?.soundPackId).toBe("halo");
  });

  it("carries the pack, bounds, duplicate controls and prefill rows from $settings", () => {
    // The daemon owns every one of these values, so its echo has to reach state: the pack
    // the Sound page marks active, the slider range it allows, the Duplicate controls it
    // seeds, and the capability rows the start-of-chat picker offers.
    const bounds = { min: 32_000, max: 128_000 };
    const echo = {
      type: "$settings" as const,
      reasoningEffort: "high" as const,
      editMode: "follow" as const,
      quickSendId: "proceed",
      quickSends: [],
      workspaceDir: "/workspace",
      recentWorkspaces: [],
      model: "deepseek-v4-pro",
      soundPackId: "halo",
      contextTokensBounds: bounds,
      duplicateSessionTokens: 24_000,
      duplicateSessionAutoProceed: false,
      pluginPrefill: [{ name: "seo-agent", displayName: "SEO Agent", enabled: true }],
      skillPrefill: [{ name: "churn-analysis", description: "Predicts churn.", enabled: false }],
      version: "0.50.1",
    };
    const state = reduce(initialState(), { t: "incoming", event: echo });
    // Every field the echo carries reaches state; the wire controls are the only exclusions
    // and the UI defaults the only additions, so a field the reducer forgets to name fails
    // here instead of reverting its control in the app.
    for (const [key] of Object.entries(echo)) {
      if (key === "type" || key === "turnReleased") continue;
      expect(state.settings, key).toHaveProperty(key);
    }
    expect(state.settings?.soundPackId).toBe("halo");
    expect(state.settings?.contextTokensBounds).toEqual(bounds);
    expect(state.settings?.duplicateSessionTokens).toBe(24_000);
    expect(state.settings?.duplicateSessionAutoProceed).toBe(false);
    expect(state.settings?.pluginPrefill).toEqual([
      { name: "seo-agent", displayName: "SEO Agent", enabled: true },
    ]);
    expect(state.settings?.skillPrefill).toEqual([
      { name: "churn-analysis", description: "Predicts churn.", enabled: false },
    ]);

    // A cleared selection reaches the UI the same way, instead of being left behind.
    const cleared = reduce(state, { t: "incoming", event: { ...echo, soundPackId: undefined } });
    expect(cleared.settings?.soundPackId).toBeUndefined();
  });

  it("carries every field the settings contract declares", () => {
    // The mirror of the settings_save parity net: that one keeps a patch field reaching the
    // daemon, this one keeps an echo field reaching state. Both read the contract instead
    // of listing fields, which is how a field nobody named stays wired.
    const fields = interfaceFields("SettingsEvent").filter(
      (field) => field !== "type" && field !== "turnReleased",
    );
    expect(fields.length).toBeGreaterThan(40);

    const sentinel = (field: string): string => `<${field}>`;
    const echo = Object.fromEntries(fields.map((field) => [field, sentinel(field)]));
    const state = reduce(initialState(), {
      t: "incoming",
      event: { type: "$settings", ...echo } as unknown as IncomingEvent,
    });

    const settings = (state.settings ?? {}) as Record<string, unknown>;
    expect(fields.filter((field) => settings[field] !== sentinel(field))).toEqual([]);
  });

  it("appends a $notice event below the turn as a notice card", () => {
    const base = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "test?", clientId: "1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "hello" }],
          pending: false,
        },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "$notice",
        text: "Nothing to compact; the context is already small.",
        severity: "info",
      },
    });
    // Creation-ordered: below the assistant card, not anchored at turn start.
    expect(next.messages.findIndex((m) => m.kind === "notice")).toBe(2);
    expect(next.messages.at(-1)).toMatchObject({
      kind: "notice",
      severity: "info",
      text: "Nothing to compact; the context is already small.",
    });
  });

  it("shows a $toast as a popover and never touches the transcript", () => {
    const base = {
      ...initialState(),
      messages: [{ kind: "user" as const, text: "test?", clientId: "1", turn: 1 }],
    };
    const next = reduce(base, {
      t: "incoming",
      event: { type: "$toast", text: "skills_install: no SKILL.md in /tmp/x", severity: "error" },
    });
    expect(next.messages).toEqual(base.messages);
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0]).toMatchObject({
      text: "skills_install: no SKILL.md in /tmp/x",
      severity: "error",
    });
    expect(reduce(next, { t: "dismiss_toast", id: next.toasts[0]?.id ?? 0 }).toasts).toEqual([]);
  });

  it("keeps the state object for a $toast that carries nothing", () => {
    const base = initialState();
    expect(reduce(base, { t: "incoming", event: { type: "$toast", text: "  ", severity: "info" } })).toBe(
      base,
    );
    expect(reduce(base, { t: "dismiss_toast", id: 404 })).toBe(base);
  });

  it("stores the per-tab subagent model from $settings and settings_patch", () => {
    // Each tab has its own reducer state — this locks in that the subagent
    // model is a per-tab field (not global), so different tabs can hold
    // different main/subagent model combinations.
    const fromEvent = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        subagentModel: "deepseek-v4-flash",
        version: "0.50.1",
      },
    });
    expect(fromEvent.settings?.model).toBe("deepseek-v4-pro");
    expect(fromEvent.settings?.subagentModel).toBe("deepseek-v4-flash");
    // The custom quick-send list must survive the $settings round-trip, or the
    // composer's quick-send dropdown loses the user's actions (regression: the
    // quick-send list was dropped from the reducer).
    expect(fromEvent.settings?.quickSends).toEqual([]);

    // An explicit chat-menu pick patches the tab's own subagent model.
    const base: Parameters<typeof reduce>[0] = {
      ...initialState(),
      settings: {
        reasoningEffort: "high",
        editMode: "follow",
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    };
    const patched = reduce(base, {
      t: "settings_patch",
      patch: { subagentModel: "gpt-5.6-sol" },
    });
    expect(patched.settings?.subagentModel).toBe("gpt-5.6-sol");

    // Absent subagentModel = subagents follow the main model.
    const noOverride = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        version: "0.50.1",
      },
    });
    expect(noOverride.settings?.subagentModel).toBeUndefined();
  });

  it("carries the capability rows the Duplicate popover offers from $settings", () => {
    // The popover renders state.settings.capabilityPrefill; a $settings frame that
    // drops it makes a chat with servers configured read as having none.
    const rows = [
      { name: "playwright", enabled: true, builtin: true },
      { name: "ghidra", enabled: false, builtin: false },
    ];
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        capabilityPrefill: rows,
        version: "0.50.1",
      },
    });
    expect(next.settings?.capabilityPrefill).toEqual(rows);
  });

  it("stores the session's frozen subagent capability from $settings", () => {
    // The composer's subagent model picker keys off this, and the capability is
    // frozen at chat creation.
    const settingsEvent = (subagents?: boolean) => ({
      type: "$settings" as const,
      reasoningEffort: "high" as const,
      editMode: "follow" as const,
      quickSendId: "proceed",
      quickSends: [],
      workspaceDir: "/workspace",
      recentWorkspaces: [],
      model: "deepseek-v4-pro",
      subagents,
      version: "0.50.1",
    });
    const capabilityOf = (subagents?: boolean) =>
      reduce(initialState(), { t: "incoming", event: settingsEvent(subagents) }).settings
        ?.subagents;

    expect(capabilityOf(true)).toBe(true);
    expect(capabilityOf(false)).toBe(false);
    // Absence reads as off: a missing field must never grant the capability.
    expect(capabilityOf()).toBe(false);
  });

  it("removes workspace from recentWorkspaces on workspace_recent_removed action", () => {
    const base: Parameters<typeof reduce>[0] = {
      ...initialState(),
      settings: {
        reasoningEffort: "high",
        editMode: "follow",
        workspaceDir: "/workspace",
        recentWorkspaces: ["/repo/alpha", "/repo/beta", "/repo/gamma"],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    };

    const next = reduce(base, {
      t: "workspace_recent_removed",
      path: "/repo/beta",
    });

    expect(next.settings?.recentWorkspaces).toEqual(["/repo/alpha", "/repo/gamma"]);
  });
});

describe("Desktop App reducer — yolo interactive countdown", () => {
  it("stores countdownMs on pending choices when $choice_required carries it", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$choice_required",
        id: 8,
        question: "Which approach?",
        options: [
          { id: "option-1", title: "First" },
          { id: "option-2", title: "Second" },
        ],
        allowCustom: true,
        countdownMs: 10_000,
      },
    });
    expect(next.pendingChoices).toHaveLength(1);
    expect(next.pendingChoices[0]).toMatchObject({
      id: 8,
      countdownMs: 10_000,
    });
  });

  it("stores countdownMs on pending plans when $plan_required carries it", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$plan_required",
        id: 9,
        plan: "Step 1\nStep 2",
        steps: [{ id: "s1", title: "one", action: "edit" }],
        summary: "do it",
        countdownMs: 10_000,
      },
    });
    expect(next.pendingPlans).toHaveLength(1);
    expect(next.pendingPlans[0]).toMatchObject({
      id: 9,
      countdownMs: 10_000,
    });
  });

  it("leaves countdownMs undefined when $plan_required has none (review mode)", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: { type: "$plan_required", id: 10, plan: "Step 1" },
    });
    expect(next.pendingPlans[0]?.countdownMs).toBeUndefined();
  });

  it("stores countdownMs on pending revisions when $revision_required carries it", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$revision_required",
        id: 11,
        reason: "scope changed",
        remainingSteps: [{ id: "s2", title: "two", action: "run" }],
        summary: "rev",
        countdownMs: 10_000,
      },
    });
    expect(next.pendingRevisions).toHaveLength(1);
    expect(next.pendingRevisions[0]).toMatchObject({
      id: 11,
      countdownMs: 10_000,
    });
  });

  it("transitions turnStatus to waiting_user and updates hasPendingIntervention on $choice_required", () => {
    const s0 = { ...initialState(), busy: true, turnStatus: "calling_tool" as const };
    const next = reduce(s0, {
      t: "incoming",
      event: {
        type: "$choice_required",
        id: 12,
        question: "A or B?",
        options: [
          { id: "A", title: "Option A" },
          { id: "B", title: "Option B" },
        ],
        allowCustom: true,
      },
    });
    expect(next.turnStatus).toBe("waiting_user");
    expect(hasPendingIntervention(next)).toBe(true);

    const resolved = reduce(next, {
      t: "resolve_choice",
      id: 12,
      verdict: { type: "pick", optionId: "A" },
    });
    expect(hasPendingIntervention(resolved)).toBe(false);
    expect(resolved.turnStatus).toBe("calling_tool");
    // The Events tab keeps what was picked, not just that the gate closed.
    expect(resolved.sessionEvents).toEqual([
      expect.objectContaining({ type: "choice", outcome: "pick", label: "Option A" }),
    ]);
  });
});

describe("desktop thread layout", () => {
  it("recomputes the thread cap from the latest viewport width", () => {
    const side = 244;
    const ctx = 320;

    expect(getThreadMaxWidth({ viewportWidth: 1000, visibleSide: side, visibleCtx: ctx })).toBe(
      580,
    );
    expect(getThreadMaxWidth({ viewportWidth: 1400, visibleSide: side, visibleCtx: ctx })).toBe(
      756,
    );
    expect(getThreadMaxWidth({ viewportWidth: 1800, visibleSide: side, visibleCtx: ctx })).toBe(
      1120,
    );
  });
});

describe("Desktop App reducer — compaction card lifecycle", () => {
  const startedEvent = (id: number, trigger: "manual" | "auto" | "overflow" = "manual") =>
    ({
      type: "compaction.started",
      id,
      ts: "2026-05-27T00:00:00.000Z",
      turn: 1,
      trigger,
    }) as const;

  it("inserts the running compaction card on compaction.started", () => {
    const next = reduce(initialState(), { t: "incoming", event: startedEvent(90) });
    const card = next.messages.find((m) => m.kind === "notice");
    expect(card).toMatchObject({ kind: "notice", running: true });
  });

  it("keeps a single running card when compaction.started repeats", () => {
    const once = reduce(initialState(), { t: "incoming", event: startedEvent(90) });
    const twice = reduce(once, { t: "incoming", event: startedEvent(91) });
    expect(twice.messages.filter((m) => m.kind === "notice")).toHaveLength(1);
  });

  it("flips the running card in place on the manual $notice result", () => {
    const beforeState = reduce(initialState(), { t: "incoming", event: startedEvent(90) });
    const next = reduce(beforeState, {
      t: "incoming",
      event: {
        type: "$notice",
        text: "Context compacted (summary): 9 tokens -> 3 tokens.",
        severity: "success",
      },
    });
    const before = beforeState.messages.find((m) => m.kind === "notice");
    const after = next.messages.find((m) => m.kind === "notice");
    if (before?.kind !== "notice" || after?.kind !== "notice") throw new Error("missing notice");
    expect(after.id).toBe(before.id);
    expect(next.messages).toHaveLength(beforeState.messages.length);
    expect(after).toMatchObject({
      running: false,
      severity: "success",
      text: "Context compacted (summary): 9 tokens -> 3 tokens.",
    });
  });

  it("flips the running card on the auto-path compaction warning", () => {
    const beforeState = reduce(initialState(), { t: "incoming", event: startedEvent(90, "auto") });
    const next = reduce(beforeState, {
      t: "incoming",
      event: {
        type: "warning",
        id: 91,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        text: "Context compacted (summary): 1,000 tokens -> 400 tokens.",
        severity: "high",
      },
    });
    const card = next.messages.find((m) => m.kind === "notice");
    expect(card).toMatchObject({
      running: false,
      severity: "success",
      text: "Context compacted (summary): 1,000 tokens -> 400 tokens.",
    });
    // The warning is the card's done text now — no assistant segment too.
    expect(next.messages.some((m) => m.kind === "assistant")).toBe(false);
  });

  it("appends the compaction summary carried on the auto-path warning", () => {
    const beforeState = reduce(initialState(), { t: "incoming", event: startedEvent(90, "auto") });
    const next = reduce(beforeState, {
      t: "incoming",
      event: {
        type: "warning",
        id: 91,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        text: "Context compacted (summary): 1,000 tokens -> 400 tokens.",
        severity: "high",
        compactionSummary: "Goal: ship X.\nNext: run tests.",
      },
    });
    const card = next.messages.find((m) => m.kind === "notice");
    expect(card).toMatchObject({
      running: false,
      severity: "success",
      text: "Context compacted (summary): 1,000 tokens -> 400 tokens.\n\nGoal: ship X.\nNext: run tests.",
    });
  });

  it("keeps the running card through a session.retracted rebuild", () => {
    const beforeState = reduce(initialState(), { t: "incoming", event: startedEvent(90) });
    const next = reduce(beforeState, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 91,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        kind: "compact",
        beforeMessages: 4,
        afterMessages: 2,
        replacementMessages: [{ kind: "user", text: "kept" }],
      },
    });
    expect(next.messages[0]).toMatchObject({ kind: "user", text: "kept" });
    const card = next.messages.find((m) => m.kind === "notice");
    expect(card).toMatchObject({ running: true });
  });

  it("drops a stale auto card on the next primary model event", () => {
    const beforeState = reduce(initialState(), { t: "incoming", event: startedEvent(90, "auto") });
    const next = reduce(beforeState, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 91,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        channel: "content",
        text: "answer",
      },
    });
    expect(next.messages.some((m) => m.kind === "notice")).toBe(false);
  });

  it("keeps a manual throbber through concurrent model deltas", () => {
    const beforeState = reduce(initialState(), { t: "incoming", event: startedEvent(90) });
    const next = reduce(beforeState, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 91,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        channel: "content",
        text: "answer",
      },
    });
    const card = next.messages.find((m) => m.kind === "notice");
    expect(card).toMatchObject({ running: true, trigger: "manual" });
  });

  it("keeps the in-flight assistant card through a mid-turn compaction rebuild", () => {
    const base = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "go", clientId: "1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "streaming answer" }],
          pending: true,
        },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 90,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        kind: "compact",
        beforeMessages: 4,
        afterMessages: 2,
        replacementMessages: [
          { kind: "user", text: "go" },
          {
            kind: "assistant",
            turn: 1,
            segments: [
              {
                kind: "tool",
                callId: "tc-1",
                name: "read_file",
                args: '{"path":"a.ts"}',
                ok: true,
                result: "body",
              },
            ],
            pending: false,
          },
        ],
      },
    });
    const assistants = next.messages.filter((m) => m.kind === "assistant");
    // The live streaming card wins over the loaded copy of its turn.
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      turn: 1,
      pending: true,
      segments: [{ kind: "text", text: "streaming answer" }],
    });
  });

  it("settles the running card on $error", () => {
    const beforeState = reduce(initialState(), { t: "incoming", event: startedEvent(90) });
    const next = reduce(beforeState, {
      t: "incoming",
      event: { type: "$error", message: "compact failed: boom" },
    });
    const card = next.messages.find((m) => m.kind === "notice");
    expect(card).toMatchObject({
      running: false,
      severity: "error",
      text: "compact failed: boom",
    });
    // No second notice card beside it.
    expect(next.messages.filter((m) => m.kind === "notice")).toHaveLength(1);
  });
});

describe("Desktop App reducer — Events tab recordings", () => {
  const compactionStarted = (trigger: "manual" | "auto" | "overflow" = "auto") =>
    ({
      type: "compaction.started",
      id: 90,
      ts: "2026-05-27T00:00:00.000Z",
      turn: 1,
      trigger,
    }) as const;

  it("records which fold ran, once, with the trigger it started with", () => {
    const state = reduce(initialState(), { t: "incoming", event: compactionStarted("overflow") });
    expect(state.sessionEvents).toEqual([
      expect.objectContaining({ type: "compaction", outcome: "overflow" }),
    ]);
    expect(state.sessionEvents[0]?.ts).toBeGreaterThan(0);
  });

  it("refines that one row with the fold's result when its card settles", () => {
    const started = reduce(initialState(), { t: "incoming", event: compactionStarted("auto") });
    const settled = reduce(started, {
      t: "incoming",
      event: {
        type: "warning",
        id: 91,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        text: "Context compacted: 9 tokens -> 3 tokens.",
        severity: "high",
      },
    });
    expect(settled.sessionEvents).toHaveLength(1);
    expect(settled.sessionEvents[0]).toMatchObject({
      type: "compaction",
      outcome: "auto",
      label: "Context compacted: 9 tokens -> 3 tokens.",
    });
  });

  it("anchors the fold's row to its card, and keeps it when the card settles", () => {
    const started = reduce(initialState(), { t: "incoming", event: compactionStarted("auto") });
    const card = started.messages.find((message) => message.kind === "notice");
    expect(started.sessionEvents[0]?.anchor).toBe(`notice:${card?.id}`);
    const settled = reduce(started, {
      t: "incoming",
      event: {
        type: "warning",
        id: 91,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        text: "Context compacted: 9 tokens -> 3 tokens.",
        severity: "high",
      },
    });
    expect(settled.sessionEvents[0]?.anchor).toBe(`notice:${card?.id}`);
  });

  it("records a plan verdict with the plan it was about", () => {
    const staged = reduce(
      {
        ...initialState(),
        pendingPlans: [
          {
            id: 4,
            plan: "## QuickSend polish\n\nCloses four gaps.",
            summary: "Ship the tab",
            steps: [
              { id: "step-1", title: "Route strings through i18n", action: "Do it" },
              { id: "step-2", title: "Collision-proof ids", action: "Do it" },
            ],
          },
        ],
      },
      { t: "resolve_plan", id: 4, verdict: { type: "approve" } },
    );
    expect(staged.sessionEvents).toEqual([
      expect.objectContaining({
        type: "plan",
        outcome: "approve",
        label: "Ship the tab",
        // The plan itself and its checklist, not just the summary line.
        body: "## QuickSend polish\n\nCloses four gaps.",
        steps: ["Route strings through i18n", "Collision-proof ids"],
      }),
    ]);
  });

  it("does not store a plan body separate from a label that already is it", () => {
    const staged = reduce(
      {
        ...initialState(),
        pendingPlans: [{ id: 5, plan: "Only the body", steps: [] }],
      },
      { t: "resolve_plan", id: 5, verdict: { type: "approve" } },
    );
    expect(staged.sessionEvents[0]).toMatchObject({ label: "Only the body" });
    expect(staged.sessionEvents[0]?.body).toBeUndefined();
  });

  it("anchors a plan verdict to the card that asked, not to the turn", () => {
    const staged = reduce(
      {
        ...initialState(),
        pendingPlans: [{ id: 6, plan: "P", callId: "call-7" }],
      },
      { t: "resolve_plan", id: 6, verdict: { type: "approve" } },
    );
    expect(staged.sessionEvents[0]).toMatchObject({ anchor: "call:call-7" });
  });

  it("records the live transcript's own id alongside the gate's", () => {
    // A running transcript names a tool call the way the wire does (`tc-…`), while
    // the plan gate carries the loop's id (`call_…`). A row that kept only the
    // gate's id never matched the rendered card, so the jump landed on the prompt
    // bubble of the turn instead. The card already carries its result here: a
    // never-ask countdown can settle the call before the verdict reaches the UI.
    const staged = reduce(
      {
        ...initialState(),
        pendingPlans: [{ id: 6, plan: "P", callId: "call-loop-7" }],
        messages: [
          {
            kind: "assistant",
            turn: 1,
            pending: false,
            segments: [
              {
                kind: "tool",
                callId: "tc-3",
                name: "submit_plan",
                args: "{}",
                startedAt: 1,
                result: "plan approved",
                ok: true,
              },
            ],
          },
        ],
      },
      { t: "resolve_plan", id: 6, verdict: { type: "approve" } },
    );
    expect(staged.sessionEvents[0]).toMatchObject({
      anchor: "call:call-loop-7",
      anchorAlias: "call:tc-3",
    });
  });

  it("does not borrow an older plan's card for its alias", () => {
    // The gate blocks the turn that submitted it, so a plan card from an earlier
    // turn belongs to a different plan: anchoring to it would send the jump there.
    const staged = reduce(
      {
        ...initialState(),
        pendingPlans: [{ id: 6, plan: "P", callId: "call-loop-9" }],
        messages: [
          { kind: "user", turn: 1, text: "first", clientId: "c-1" },
          {
            kind: "assistant",
            turn: 1,
            pending: false,
            closed: true,
            segments: [
              {
                kind: "tool",
                callId: "tc-1",
                name: "submit_plan",
                args: "{}",
                startedAt: 1,
                result: "plan approved",
                ok: true,
              },
            ],
          },
          { kind: "user", turn: 2, text: "second", clientId: "c-2" },
        ],
      },
      { t: "resolve_plan", id: 6, verdict: { type: "approve" } },
    );
    expect(staged.sessionEvents[0]).toMatchObject({ turn: 2, anchor: "call:call-loop-9" });
    expect(staged.sessionEvents[0]?.anchorAlias).toBeUndefined();
  });

  it("keeps the live id alone when no gate id reached the record", () => {
    const staged = reduce(
      {
        ...initialState(),
        messages: [
          {
            kind: "assistant",
            turn: 2,
            pending: false,
            segments: [
              { kind: "tool", callId: "tc-8", name: "submit_plan", args: "{}", startedAt: 1 },
            ],
          },
        ],
      },
      { t: "resolve_plan", id: 99, verdict: { type: "approve" } },
    );
    expect(staged.sessionEvents[0]).toMatchObject({ anchor: "call:tc-8" });
    expect(staged.sessionEvents[0]?.anchorAlias).toBeUndefined();
  });

  it("anchors a choice verdict to the card that asked it", () => {
    // A choice reaches the app without a call id, so the asking card is found
    // where it is rendered: the gate's still-pending tool segment.
    const staged = reduce(
      {
        ...initialState(),
        messages: [
          {
            kind: "assistant",
            turn: 1,
            pending: true,
            segments: [
              { kind: "tool", callId: "call-9", name: "ask_choice", args: "{}", startedAt: 1 },
            ],
          },
        ],
        pendingChoices: [
          { id: 7, question: "Which?", options: [{ id: "a", title: "A" }], allowCustom: false },
        ],
      },
      { t: "resolve_choice", id: 7, verdict: { type: "pick", optionId: "a" } },
    );
    expect(staged.sessionEvents[0]).toMatchObject({ anchor: "call:call-9" });
  });

  it("leaves a choice unanchored when no asking call is open any more", () => {
    const staged = reduce(
      {
        ...initialState(),
        messages: [
          {
            kind: "assistant",
            turn: 1,
            pending: false,
            segments: [
              {
                kind: "tool",
                callId: "call-9",
                name: "ask_choice",
                args: "{}",
                startedAt: 1,
                result: "picked",
              },
            ],
          },
        ],
        pendingChoices: [
          { id: 7, question: "Which?", options: [{ id: "a", title: "A" }], allowCustom: false },
        ],
      },
      { t: "resolve_choice", id: 7, verdict: { type: "pick", optionId: "a" } },
    );
    expect(staged.sessionEvents[0]?.anchor).toBeUndefined();
  });
  it("records the wording the user chose, not just the option id", () => {
    const staged = reduce(
      {
        ...initialState(),
        pendingChoices: [
          {
            id: 2,
            question: "Which parser?",
            options: [
              { id: "a", title: "Rewrite the parser" },
              { id: "b", title: "Patch the parser" },
            ],
            allowCustom: true,
          },
        ],
      },
      { t: "resolve_choice", id: 2, verdict: { type: "pick", optionId: "b" } },
    );
    expect(staged.sessionEvents[0]).toMatchObject({
      type: "choice",
      outcome: "pick",
      label: "Patch the parser",
      detail: "Which parser?",
      // The pick alone is useless later: keep what it was chosen from.
      options: ["Rewrite the parser", "Patch the parser"],
    });
  });

  it("keeps a typed answer the same way", () => {
    const staged = reduce(
      {
        ...initialState(),
        pendingChoices: [{ id: 3, question: "Which parser?", options: [], allowCustom: true }],
      },
      { t: "resolve_choice", id: 3, verdict: { type: "text", text: "neither" } },
    );
    expect(staged.sessionEvents[0]).toMatchObject({ outcome: "text", label: "neither" });
  });

  it("drops verdicts for turns a rewind removed, and keeps the rest", () => {
    const base = {
      ...initialState(),
      sessionEvents: [
        { id: "plan-1", type: "plan" as const, ts: 10, turn: 1, outcome: "approve" },
        { id: "plan-2", type: "plan" as const, ts: 20, turn: 2, outcome: "approve" },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 10,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 2,
        kind: "rewind",
        beforeMessages: 6,
        afterMessages: 2,
        replacementMessages: [
          { kind: "user", text: "ask1" },
          { kind: "assistant", turn: 1, segments: [], pending: false },
        ],
      },
    });
    // Turn 2 is gone from the transcript, so its verdict cannot land anywhere.
    expect(next.sessionEvents.map((event) => event.id)).toEqual(["plan-1"]);
  });

  it("records a subagent spawn as an event of its own, with the task it was given", () => {
    const task = "Survey every Events-tab consumer and report what each one renders.";
    const state = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "tool.intent",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 2,
        callId: "tc-7",
        name: "spawn_subagent",
        args: JSON.stringify({ task }),
      },
    });
    expect(state.sessionEvents).toEqual([
      expect.objectContaining({
        id: "subagent-tc-7",
        type: "subagent",
        outcome: "started",
        label: "spawn_subagent",
        // The instruction, whole: the row and the card are the only record of
        // what the child was asked to do.
        detail: task,
        anchor: "call:tc-7",
        turn: 2,
      }),
    ]);
  });

  it("keeps one subagent row when the same spawn is re-announced", () => {
    const intent = {
      type: "tool.intent",
      id: 1,
      ts: "2026-05-27T00:00:00.000Z",
      turn: 1,
      callId: "tc-1",
      name: "spawn_subagent",
      args: JSON.stringify({ task: "review the diff" }),
    } as const;
    const once = reduce(initialState(), { t: "incoming", event: intent });
    const twice = reduce(once, { t: "incoming", event: { ...intent, id: 2 } });
    expect(twice.sessionEvents).toHaveLength(1);
  });

  it("settles the subagent row with the verdict its card carries", () => {
    const spawned = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "tool.intent",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        callId: "tc-3",
        name: "spawn_subagent",
        args: JSON.stringify({ task: "find the callers" }),
      },
    });
    const started = spawned.sessionEvents[0]?.ts;
    const settled = reduce(spawned, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 2,
        ts: "2026-05-27T00:00:01.000Z",
        turn: 1,
        callId: "tc-3",
        ok: false,
        output: "ERROR: gave up",
      },
    });
    expect(settled.sessionEvents).toHaveLength(1);
    expect(settled.sessionEvents[0]).toMatchObject({ type: "subagent", outcome: "failed" });
    // The row keeps the stamp of the spawn: it did not happen a second time.
    expect(settled.sessionEvents[0]?.ts).toBe(started);
    // A result that is not the subagent envelope is the answer as it came.
    expect(settled.sessionEvents[0]?.result).toBe("ERROR: gave up");
  });

  it("settles the subagent row with the answer the child came back with", () => {
    const spawned = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "tool.intent",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        callId: "tc-4",
        name: "spawn_subagent",
        args: JSON.stringify({ task: "find the callers" }),
      },
    });
    const settled = reduce(spawned, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 2,
        ts: "2026-05-27T00:00:01.000Z",
        turn: 1,
        callId: "tc-4",
        ok: true,
        output: JSON.stringify({
          success: true,
          output: "The callers are in src/loop.ts and src/tools.",
          turns: 2,
        }),
      },
    });
    // The row says what the child found, not just that it finished: the card that
    // carried the answer scrolls away, the row does not.
    expect(settled.sessionEvents[0]).toMatchObject({
      type: "subagent",
      outcome: "done",
      result: "The callers are in src/loop.ts and src/tools.",
    });
  });

  it("keeps a partial child's note beside the answer it did produce", () => {
    const spawned = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "tool.intent",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        callId: "tc-5",
        name: "spawn_subagent",
        args: JSON.stringify({ task: "audit the loop" }),
      },
    });
    const settled = reduce(spawned, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 2,
        ts: "2026-05-27T00:00:01.000Z",
        turn: 1,
        callId: "tc-5",
        ok: true,
        output: JSON.stringify({
          success: true,
          partial: true,
          output: "Halfway through the reducer chain.",
          note: "budget exhausted",
        }),
      },
    });
    expect(settled.sessionEvents[0]?.result).toBe(
      "Halfway through the reducer chain.\n\nbudget exhausted",
    );
  });

  it("records no event for a tool call that is not a subagent", () => {
    const state = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "tool.intent",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        callId: "tc-9",
        name: "read_file",
        args: '{"path":"src/App.tsx"}',
      },
    });
    expect(state.sessionEvents).toEqual([]);
  });

  it("adopts the loaded session's own events, and starts clean when cleared", () => {
    const loaded = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "older",
        messages: [],
        events: [
          { id: "plan-1", type: "plan", ts: 1_000, turn: 1, outcome: "refine", label: "Rework" },
        ],
        carryover: {
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });
    expect(loaded.sessionEvents.map((e) => e.id)).toEqual(["plan-1"]);
    expect(reduce(loaded, { t: "detach_session" }).sessionEvents).toEqual([]);
  });
});

describe("Desktop App reducer — card ordering", () => {
  const turnStarted = (turn: number) =>
    ({
      type: "model.turn.started",
      id: turn,
      ts: "2026-05-27T00:00:00.000Z",
      turn,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "pfx",
    }) as const;
  const reasoningDelta = (turn: number, text: string) =>
    ({
      type: "model.delta",
      id: turn * 100,
      ts: "2026-05-27T00:00:00.000Z",
      turn,
      channel: "reasoning",
      text,
    }) as const;
  const compactionStarted = (turn: number) =>
    ({
      type: "compaction.started",
      id: turn * 1000,
      ts: "2026-05-27T00:00:00.000Z",
      turn,
      trigger: "auto",
    }) as const;
  const compactionDone = (turn: number) =>
    ({
      type: "warning",
      id: turn * 1000 + 1,
      ts: "2026-05-27T00:00:00.000Z",
      turn,
      text: "Context compacted (summary): 1,000 tokens -> 400 tokens.",
      severity: "high",
    }) as const;

  it("keeps a mid-turn compaction card above the post-compaction assistant output", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted(1) });
    state = reduce(state, {
      t: "incoming",
      event: reasoningDelta(1, "thinking before compaction"),
    });
    state = reduce(state, { t: "incoming", event: compactionStarted(1) });
    state = reduce(state, { t: "incoming", event: compactionDone(1) });
    state = reduce(state, { t: "incoming", event: reasoningDelta(1, "thinking after compaction") });

    expect(state.messages.map((m) => m.kind)).toEqual(["assistant", "notice", "assistant"]);
    const [before, notice, after] = state.messages;
    expect(before).toMatchObject({ kind: "assistant", turn: 1, pending: false });
    expect(notice).toMatchObject({ kind: "notice", severity: "success", running: false });
    expect(after).toMatchObject({ kind: "assistant", turn: 1, pending: true });
    if (before?.kind !== "assistant" || after?.kind !== "assistant") {
      throw new Error("expected two assistant cards");
    }
    expect(before.segments.at(-1)).toMatchObject({
      kind: "reasoning",
      text: "thinking before compaction",
    });
    expect(after.segments.at(-1)).toMatchObject({
      kind: "reasoning",
      text: "thinking after compaction",
    });
  });

  it("renders multiple assistant cards for one turn across a compaction boundary", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted(1) });
    state = reduce(state, { t: "incoming", event: reasoningDelta(1, "before") });
    state = reduce(state, { t: "incoming", event: compactionStarted(1) });
    state = reduce(state, { t: "incoming", event: compactionDone(1) });
    state = reduce(state, { t: "incoming", event: reasoningDelta(1, "after") });

    const assistantIdxs = state.messages.flatMap((m, i) => (m.kind === "assistant" ? [i] : []));
    expect(assistantIdxs).toHaveLength(2);
    expect(
      state.messages
        .filter((m) => m.kind === "assistant")
        .every((m) => m.kind === "assistant" && m.turn === 1),
    ).toBe(true);
    const noticeIdx = state.messages.findIndex((m) => m.kind === "notice");
    expect(assistantIdxs[0]!).toBeLessThan(noticeIdx);
    expect(noticeIdx).toBeLessThan(assistantIdxs[1]!);
  });

  it("keeps the card above output that arrives as batched deltas (the runtime path)", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted(1) });
    state = reduce(state, {
      t: "batch_delta",
      items: [{ turn: 1, channel: "reasoning", text: "before" }],
    });
    state = reduce(state, { t: "incoming", event: compactionStarted(1) });
    state = reduce(state, { t: "incoming", event: compactionDone(1) });
    state = reduce(state, {
      t: "batch_delta",
      items: [{ turn: 1, channel: "reasoning", text: "after" }],
    });

    expect(state.messages.map((m) => m.kind)).toEqual(["assistant", "notice", "assistant"]);
    const assistants = state.messages.filter((m) => m.kind === "assistant");
    // The batched frame did NOT fan out to the pre-compaction card.
    expect(assistants[0]).toMatchObject({ turn: 1, pending: false });
    expect(assistants[1]).toMatchObject({ turn: 1, pending: true });
  });

  it("opens a card below the boundary when the retraction carries no in-flight card", () => {
    // The compaction card can be settled BEFORE the log swap lands (an $error, a
    // stale-frame sweep, a slow fold). The retraction then finds no pending card
    // and no running notice, so it keeps the folded log's cards as-is — and those
    // are "open". Output after the boundary must still open a NEW card below the
    // compaction card instead of growing a folded card above it, which is what
    // made everything after a compaction invisible.
    let state = reduce(initialState(), { t: "incoming", event: turnStarted(1) });
    state = reduce(state, {
      t: "incoming",
      event: reasoningDelta(1, "thinking before compaction"),
    });
    state = reduce(state, { t: "incoming", event: compactionStarted(1) });
    state = reduce(state, { t: "incoming", event: compactionDone(1) });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 7,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        kind: "compact",
        beforeMessages: 2,
        afterMessages: 2,
        replacementMessages: [
          { kind: "user", text: "the ask" },
          {
            kind: "assistant",
            turn: 1,
            segments: [{ kind: "reasoning", text: "before" }],
            pending: false,
          },
        ],
      },
    });
    state = reduce(state, {
      t: "incoming",
      event: reasoningDelta(1, "thinking after compaction"),
    });

    // The compaction card stays where the boundary put it; the turn's later
    // output opens a NEW card below it.
    expect(state.messages.map((m) => m.kind)).toEqual(["user", "assistant", "notice", "assistant"]);
    const noticeIdx = state.messages.findIndex((m) => m.kind === "notice");
    const after = state.messages[state.messages.length - 1];
    if (after?.kind !== "assistant") throw new Error("expected a post-boundary card");
    expect(after.segments.at(-1)).toMatchObject({
      kind: "reasoning",
      text: "thinking after compaction",
    });
    expect(state.messages.length - 1).toBeGreaterThan(noticeIdx);
  });

  it("settles the sealed card when output opens its successor", () => {
    // A card left unclosed above a boundary (the shape a late notice for an
    // earlier turn leaves behind) must stop rendering as live the moment the
    // next card opens, so one turn never shows two live cards at once.
    const sealed = {
      kind: "assistant" as const,
      turn: 1,
      segments: [{ kind: "reasoning" as const, text: "orphan", startedAt: Date.now() }],
      pending: true,
    };
    const base = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "ask", clientId: "c-1", turn: 1 },
        sealed,
        {
          kind: "notice" as const,
          id: "notice-1",
          text: "Context compacted.",
          severity: "success" as const,
          turn: 1,
          running: false,
        },
      ],
    };
    const next = reduce(base, { t: "incoming", event: reasoningDelta(1, "after") });

    expect(next.messages.map((m) => m.kind)).toEqual(["user", "assistant", "notice", "assistant"]);
    expect(next.messages[1]).toMatchObject({ pending: false, closed: true });
    expect(next.messages.at(-1)).toMatchObject({
      pending: true,
      segments: [{ kind: "reasoning" }],
    });
    expect(next.messages.at(-1)).not.toHaveProperty("closed", true);
  });

  it("keeps late output at the tail when a newer user bubble already follows the card", () => {
    // Same invariant, no notice involved: content may never be written into a
    // card that something else already follows.
    const base = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "first", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "reasoning" as const, text: "run" }],
          pending: true,
        },
      ],
    };
    const withNewAsk = reduce(base, {
      t: "incoming",
      event: {
        type: "user.message",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 2,
        text: "second",
      },
    });
    const next = reduce(withNewAsk, { t: "incoming", event: reasoningDelta(1, "late") });

    expect(next.messages.map((m) => m.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(next.messages[1]).toMatchObject({ turn: 1, segments: [{ kind: "reasoning" }] });
    expect(next.messages.at(-1)).toMatchObject({ turn: 1, pending: true });
  });

  it("keeps streaming into a live card that sits below the boundary", () => {
    // The retraction carried the in-flight card past a settled boundary, so the
    // boundary is mid-transcript: output belongs in that live card, not in a
    // needless third card.
    const base = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "ask", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "before" }],
          pending: false,
          closed: true,
        },
        {
          kind: "notice" as const,
          id: "notice-1",
          text: "Context compacted.",
          severity: "success" as const,
          turn: 1,
          running: false,
        },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "reasoning" as const, text: "thinking" }],
          pending: true,
        },
      ],
    };
    const next = reduce(base, { t: "incoming", event: reasoningDelta(1, "more") });

    expect(next.messages.map((m) => m.kind)).toEqual(["user", "assistant", "notice", "assistant"]);
    const tail = next.messages.at(-1);
    if (tail?.kind !== "assistant") throw new Error("expected the live card");
    // Appended to the live card's open reasoning run, not to a new card.
    expect(tail.segments).toHaveLength(1);
    expect(tail.segments.at(-1)).toMatchObject({ kind: "reasoning", text: "thinkingmore" });
  });

  it("never streams into the tail card of a reloaded transcript", () => {
    // A load puts history at the tail. Its ordinals are renumbered from the log,
    // so the next delta of the same ordinal would land in history — visibly
    // above whatever card the user is watching. It must open a new card.
    let state = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "sess-1",
        resync: false,
        messages: [
          { kind: "user", text: "q1" },
          {
            kind: "assistant",
            turn: 1,
            segments: [{ kind: "text", text: "logged answer" }],
            pending: false,
          },
        ],
        carryover: {
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });
    state = reduce(state, { t: "incoming", event: reasoningDelta(1, "live tail") });

    expect(state.messages.map((m) => m.kind)).toEqual(["user", "assistant", "assistant"]);
    const history = state.messages[1];
    if (history?.kind !== "assistant") throw new Error("expected the history card");
    expect(history.segments.some((s) => s.kind === "text" && s.text === "logged answer")).toBe(
      true,
    );
    expect(history.segments.some((s) => s.kind === "reasoning")).toBe(false);
    expect(state.messages.at(-1)).toMatchObject({ kind: "assistant", pending: true });
  });

  it("keeps later output below a mid-turn btw card", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted(1) });
    state = reduce(state, { t: "incoming", event: reasoningDelta(1, "before btw") });
    state = reduce(state, {
      t: "incoming",
      event: { type: "$btw_result", question: "why?", answer: "because" },
    });
    state = reduce(state, { t: "incoming", event: reasoningDelta(1, "after btw") });

    expect(state.messages.map((m) => m.kind)).toEqual(["assistant", "notice", "assistant"]);
    const tail = state.messages.at(-1);
    if (tail?.kind !== "assistant") throw new Error("expected a post-btw card");
    expect(tail.segments.at(-1)).toMatchObject({ kind: "reasoning", text: "after btw" });
  });

  it("carries the in-flight turn's cards through a compaction retraction, in order", () => {
    const base = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "old ask", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "old answer" }],
          pending: false,
        },
        { kind: "user" as const, text: "new ask", clientId: "c-2", turn: 2 },
        {
          kind: "assistant" as const,
          turn: 2,
          segments: [{ kind: "reasoning" as const, text: "streaming" }],
          pending: true,
        },
        {
          kind: "notice" as const,
          id: "notice-1",
          text: "Compacting context…",
          severity: "info" as const,
          turn: 2,
          running: true,
          trigger: "auto" as const,
        },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 5,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 2,
        kind: "compact",
        beforeMessages: 4,
        afterMessages: 2,
        replacementMessages: [
          { kind: "user", text: "old ask" },
          {
            kind: "assistant",
            turn: 1,
            segments: [{ kind: "text", text: "old answer" }],
            pending: false,
          },
        ],
      },
    });
    expect(
      next.messages.map((m) => (m.kind === "notice" ? "notice" : `${m.kind}-${m.turn}`)),
    ).toEqual(["user-1", "assistant-1", "user-2", "assistant-2", "notice"]);
  });

  it("survives a pre-turn compaction retraction with the optimistic user bubble intact", () => {
    const base = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "brand new ask", clientId: "c-9", turn: 1 },
        {
          kind: "notice" as const,
          id: "notice-1",
          text: "Compacting context…",
          severity: "info" as const,
          turn: 1,
          running: true,
          trigger: "auto" as const,
        },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 6,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        kind: "compact",
        beforeMessages: 0,
        afterMessages: 0,
        replacementMessages: [],
      },
    });
    expect(
      next.messages.map((m) => (m.kind === "notice" ? "notice" : `${m.kind}-${m.turn}`)),
    ).toEqual(["user-1", "notice"]);
  });

  it("carries an earlier-turn notice through a compaction retraction, beside its turn", () => {
    const base = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "ask1", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "ans1" }],
          pending: false,
          closed: true,
        },
        {
          kind: "notice" as const,
          id: "elog-1",
          text: "Mode: AUTO",
          severity: "warning" as const,
          turn: 1,
        },
        { kind: "user" as const, text: "ask2", clientId: "c-2", turn: 2 },
        {
          kind: "assistant" as const,
          turn: 2,
          segments: [{ kind: "reasoning" as const, text: "live" }],
          pending: true,
        },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 9,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 2,
        kind: "compact",
        beforeMessages: 5,
        afterMessages: 3,
        replacementMessages: [
          { kind: "user", text: "ask1" },
          {
            kind: "assistant",
            turn: 1,
            segments: [{ kind: "text", text: "ans1" }],
            pending: false,
          },
        ],
      },
    });
    // The older-turn notice is NOT dropped; it lands at the end of its own turn's
    // group (after assistant-1, before the in-flight turn's cards).
    expect(
      next.messages.map((m) => (m.kind === "notice" ? `notice-${m.turn}` : `${m.kind}-${m.turn}`)),
    ).toEqual(["user-1", "assistant-1", "notice-1", "user-2", "assistant-2"]);
  });

  it("keeps a surviving-turn notice but drops one whose turn a rewind removed", () => {
    const base = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "ask1", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [],
          pending: false,
          closed: true,
        },
        {
          kind: "notice" as const,
          id: "elog-1",
          text: "kept",
          severity: "info" as const,
          turn: 1,
        },
        { kind: "user" as const, text: "ask2", clientId: "c-2", turn: 2 },
        {
          kind: "assistant" as const,
          turn: 2,
          segments: [],
          pending: false,
          closed: true,
        },
        {
          kind: "notice" as const,
          id: "elog-2",
          text: "rewound away",
          severity: "warning" as const,
          turn: 2,
        },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 10,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 2,
        kind: "rewind",
        beforeMessages: 6,
        afterMessages: 2,
        replacementMessages: [
          { kind: "user", text: "ask1" },
          { kind: "assistant", turn: 1, segments: [], pending: false },
        ],
      },
    });
    const notices = next.messages.filter((m) => m.kind === "notice");
    expect(notices.map((m) => (m.kind === "notice" ? m.text : ""))).toEqual(["kept"]);
    expect(
      next.messages.map((m) => (m.kind === "notice" ? `notice-${m.turn}` : `${m.kind}-${m.turn}`)),
    ).toEqual(["user-1", "assistant-1", "notice-1"]);
  });
});

describe("Desktop App reducer — session.retracted file derivation", () => {
  it("session.retracted replaces the transcript and re-derives files", () => {
    const base = {
      ...initialState(),
      messages: [{ kind: "user" as const, text: "stale", clientId: "1", turn: 1 }],
      sessionFiles: [{ path: "src/stale.ts", status: "c" as const }],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 2,
        kind: "retry",
        beforeMessages: 4,
        afterMessages: 2,
        replacementMessages: [
          { kind: "user", text: "kept" },
          {
            kind: "assistant",
            turn: 1,
            segments: [
              {
                kind: "tool",
                callId: "c1",
                name: "read_file",
                args: JSON.stringify({ path: "src/keep.ts" }),
              },
            ],
            pending: false,
          },
        ],
      },
    });

    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]).toMatchObject({ kind: "user", text: "kept", turn: 1 });
    expect(next.sessionFiles).toEqual([{ path: "src/keep.ts", status: "c" }]);
  });

  it("session.retracted with a context-edit kind swaps the transcript live", () => {
    const base = {
      ...initialState(),
      messages: [{ kind: "user" as const, text: "before edit", clientId: "1", turn: 1 }],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "session.retracted",
        id: 4,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 2,
        kind: "context-edit",
        beforeMessages: 3,
        afterMessages: 1,
        replacementMessages: [{ kind: "user", text: "edited" }],
      },
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({ kind: "user", text: "edited" });
  });
});

describe("Desktop App reducer — $session_loaded resync echo", () => {
  function loaded(session: string, resync: boolean): Parameters<typeof reduce>[1] {
    return {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: session,
        resync,
        messages: [
          { kind: "user", text: "q1" },
          {
            kind: "assistant",
            turn: 1,
            segments: [{ kind: "text", text: "a1" }],
            pending: false,
          },
        ],
        carryover: {
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    };
  }

  it("skips a resync echo of the already-loaded session, even when idle", () => {
    const base = {
      ...initialState(),
      busy: false,
      currentSession: "sess-1",
      messages: [{ kind: "user" as const, text: "live", clientId: "c", turn: 1 }],
    };
    // Cold-start double-emit: bootstrap $session_loaded already applied, then
    // desktop_resync echoes the same session. Must NOT wipe the transcript.
    const next = reduce(base, loaded("sess-1", true));
    expect(next.messages).toEqual([{ kind: "user", text: "live", clientId: "c", turn: 1 }]);
    expect(next.currentSession).toBe("sess-1");
  });

  it("applies a resync echo when the session differs (genuine reload)", () => {
    const base = { ...initialState(), currentSession: "sess-1" };
    const next = reduce(base, loaded("sess-2", true));
    expect(next.currentSession).toBe("sess-2");
    expect(next.messages).toHaveLength(2);
  });

  it("applies a non-resync session load (user-initiated switch)", () => {
    const base = { ...initialState(), currentSession: "sess-1" };
    const next = reduce(base, loaded("sess-2", false));
    expect(next.currentSession).toBe("sess-2");
    expect(next.messages).toHaveLength(2);
  });
});

describe("Desktop App reducer — $session_bound (the neutral state)", () => {
  const bound = (name: string): Parameters<typeof reduce>[1] => ({
    t: "incoming",
    event: { type: "$session_bound", name },
  });

  it("drops the deleted conversation when the channel is bound to nothing", () => {
    const base = {
      ...initialState(),
      currentSession: "doomed",
      messages: [{ kind: "user" as const, text: "typed into it", clientId: "c", turn: 1 }],
    };
    const next = reduce(base, bound(""));
    expect(next.currentSession).toBeUndefined();
    expect(next.messages).toEqual([]);
  });

  it("clears the per-session plan, queue and files that belonged to the deleted session", () => {
    const base = {
      ...initialState(),
      currentSession: "doomed",
      activePlan: {
        plan: "# Body",
        steps: [{ id: "step-1", title: "t", action: "a" }],
        completedStepIds: [],
        stepResults: {},
        status: "active" as const,
      },
      queuedSends: [{ text: "queued before the delete" }],
      sessionFiles: [{ path: "src/App.tsx", status: "m" as const }],
    };
    const next = reduce(base, bound(""));
    expect(next.activePlan).toBeNull();
    expect(next.queuedSends).toEqual([]);
    expect(next.sessionFiles).toEqual([]);
  });

  it("adopts the session created for the message typed while neutral, keeping that message", () => {
    // The daemon binds the session on the first send, so the optimistic echo the
    // user is looking at must survive: only the name changes.
    const echoing = reduce(
      { ...initialState(), currentSession: undefined },
      { t: "send_user", text: "hello", clientId: "c-9" },
    );
    const next = reduce(echoing, bound("desktop-20260101120000-3"));
    expect(next.currentSession).toBe("desktop-20260101120000-3");
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({ kind: "user", text: "hello" });
  });

  it("keeps the state untouched when the channel is already bound to that session", () => {
    const base = { ...initialState(), currentSession: "sess-1" };
    expect(reduce(base, bound("sess-1"))).toBe(base);
  });

  it("drops a transcript it can no longer vouch for when the bind swaps sessions", () => {
    // A rebind between two sessions is not a load: the rows on screen belong to the
    // other conversation, so they must not be shown — or synced — under this name.
    const base = {
      ...initialState(),
      currentSession: "old",
      messages: [{ kind: "user" as const, text: "old question", clientId: "c", turn: 1 }],
    };
    const next = reduce(base, bound("new"));
    expect(next.currentSession).toBe("new");
    expect(next.messages).toEqual([]);
  });
});

describe("runningSessionNames — sidebar dot is running-agents only", () => {
  const WS = "C:\\repo";
  const tab = (
    over: Partial<{ id: string; workspaceDir: string; session: string; busy: boolean }>,
  ) => ({
    id: "t1",
    workspaceDir: WS,
    busy: false,
    ...over,
  });

  it("dots only sessions with a busy agent — open idle channels get no dot", () => {
    const tabs = [
      tab({ id: "t1", session: "busy-chat", busy: true }),
      tab({ id: "t2", session: "idle-chat", busy: false }),
      tab({ id: "t3", session: "idle-chat-2", busy: false }),
    ];
    const running = runningSessionNames(tabs, WS);
    expect(running.has("busy-chat")).toBe(true);
    expect(running.has("idle-chat")).toBe(false);
    expect(running.has("idle-chat-2")).toBe(false);
    expect(running.size).toBe(1);
  });

  it("only counts tabs on the SAME workspace as the sidebar's tab", () => {
    const tabs = [
      tab({ id: "t1", workspaceDir: WS, session: "here", busy: true }),
      tab({ id: "t2", workspaceDir: "D:\\other", session: "elsewhere", busy: true }),
    ];
    const running = runningSessionNames(tabs, WS);
    expect(running.has("here")).toBe(true);
    expect(running.has("elsewhere")).toBe(false);
  });

  it("a busy tab with no session bound yet contributes nothing", () => {
    const running = runningSessionNames([tab({ id: "t1", session: undefined, busy: true })], WS);
    expect(running.size).toBe(0);
  });
});

describe("Desktop App session sorting", () => {
  it("parseSessionTimestamp extracts millisecond timestamp and sessionRecency computes max", () => {
    expect(parseSessionTimestamp("desktop-20260905120000-1")).toBe(Date.UTC(2026, 8, 5, 12, 0, 0));
    expect(parseSessionTimestamp("plain-session")).toBe(0);

    const recency = sessionRecency({
      name: "desktop-20260905120000-1",
      mtime: new Date(Date.UTC(2026, 8, 5, 10, 0, 0)).toISOString(),
    });
    expect(recency).toBe(Date.UTC(2026, 8, 5, 12, 0, 0));
  });

  it("sortSessionsDescending prioritizes newest sessions by recency and tie-breaks by name", () => {
    const list = [
      { name: "desktop-20260901100000-1", messageCount: 2, mtime: new Date(1000).toISOString() },
      { name: "desktop-20260905120000-1", messageCount: 0, mtime: new Date(1000).toISOString() },
      { name: "desktop-20260903110000-1", messageCount: 5, mtime: new Date(1000).toISOString() },
    ];
    const sorted = [...list].sort(sortSessionsDescending);
    expect(sorted.map((s) => s.name)).toEqual([
      "desktop-20260905120000-1",
      "desktop-20260903110000-1",
      "desktop-20260901100000-1",
    ]);
  });

  it("sessionCreationTime prefers the meta stamp, then the name timestamp, then mtime", () => {
    const name = "desktop-20260905120000-1";
    const nameTs = Date.UTC(2026, 8, 5, 12, 0, 0);
    const mtime = new Date(Date.UTC(2020, 0, 1)).toISOString();

    expect(sessionCreationTime({ name, mtime })).toBe(nameTs);
    expect(
      sessionCreationTime({ name: "plain-session", mtime, createdAt: Date.UTC(2024, 5, 1) }),
    ).toBe(Date.UTC(2024, 5, 1));
    expect(sessionCreationTime({ name: "plain-session", mtime })).toBe(Date.UTC(2020, 0, 1));
  });

  it("sortSessionsByCreationDescending orders by creation date, not last activity", () => {
    // old but recently active (name timestamp from Sep 1, meta stamp from Sep 6)
    const oldButActive = {
      name: "desktop-20260901100000-1",
      messageCount: 9,
      mtime: new Date(9000).toISOString(),
      createdAt: Date.UTC(2026, 8, 1, 10, 0, 0),
    };
    // new and created Sep 5
    const newest = {
      name: "desktop-20260905120000-1",
      messageCount: 0,
      mtime: new Date(1000).toISOString(),
      createdAt: Date.UTC(2026, 8, 5, 12, 0, 0),
    };
    // legacy session with no meta stamp — creation falls back to the name timestamp
    const legacy = {
      name: "desktop-20260903110000-1",
      messageCount: 5,
      mtime: new Date(1000).toISOString(),
    };

    const sorted = [...[legacy, oldButActive, newest]].sort(sortSessionsByCreationDescending);
    expect(sorted.map((s) => s.name)).toEqual([newest.name, legacy.name, oldButActive.name]);
  });

  it("maps each in-flight session mutation to one wording", () => {
    expect(sessionMutationLabel({ kind: "create" }, 0)).toBe("Creating session…");
    expect(sessionMutationLabel({ kind: "delete" }, 0)).toBe("Deleting session…");
    expect(sessionMutationLabel({ kind: "clear" }, 3)).toBe("Deleting 3 sessions…");
  });
});

describe("Desktop App reducer — reasoning duration", () => {
  const turnStarted: ModelTurnStartedEvent = {
    type: "model.turn.started",
    id: 1,
    ts: "2026-05-27T00:00:00.000Z",
    turn: 1,
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    prefixHash: "h",
  };

  const reasoningSeg = (state: Parameters<typeof reduce>[0]) => {
    const assistant = state.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant card");
    return assistant.segments.find((s) => s.kind === "reasoning");
  };

  it("stamps a reasoning run's wall-clock duration once content follows", () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1000);
      let state = reduce(initialState(), { t: "incoming", event: turnStarted });
      state = reduce(state, {
        t: "incoming",
        event: {
          type: "model.delta",
          id: 2,
          ts: "t",
          turn: 1,
          channel: "reasoning",
          text: "step one",
        },
      });
      now.mockReturnValue(2500);
      state = reduce(state, {
        t: "incoming",
        event: {
          type: "model.delta",
          id: 3,
          ts: "t",
          turn: 1,
          channel: "reasoning",
          text: " step two",
        },
      });
      now.mockReturnValue(3250);
      state = reduce(state, {
        t: "incoming",
        event: {
          type: "model.delta",
          id: 4,
          ts: "t",
          turn: 1,
          channel: "content",
          text: "the answer",
        },
      });

      expect(reasoningSeg(state)).toMatchObject({
        kind: "reasoning",
        text: "step one step two",
        startedAt: 1000,
        durationMs: 2250,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("stamps each reasoning run with the model that produced it", () => {
    const delta = (id: number, channel: "reasoning" | "content", text: string) =>
      ({ type: "model.delta", id, ts: "t", turn: 1, channel, text }) as const;

    let state = reduce(initialState(), { t: "incoming", event: turnStarted });
    state = reduce(state, { t: "incoming", event: delta(2, "reasoning", "primary") });
    // Content closes the first run; the fallback model then owns the second.
    state = reduce(state, { t: "incoming", event: delta(3, "content", "answer") });
    state = reduce(state, {
      t: "incoming",
      event: { ...turnStarted, id: 4, model: "deepseek-v4-pro" },
    });
    state = reduce(state, { t: "incoming", event: delta(5, "reasoning", "retry") });

    const assistant = state.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant card");
    expect(assistant.segments.filter((s) => s.kind === "reasoning")).toMatchObject([
      { text: "primary", model: "deepseek-v4-flash" },
      { text: "retry", model: "deepseek-v4-pro" },
    ]);
  });

  it("closes an open reasoning run at model.final when nothing else streamed", () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(500);
      let state = reduce(initialState(), { t: "incoming", event: turnStarted });
      state = reduce(state, {
        t: "incoming",
        event: {
          type: "model.delta",
          id: 2,
          ts: "t",
          turn: 1,
          channel: "reasoning",
          text: "thinking",
        },
      });
      now.mockReturnValue(1500);
      state = reduce(state, {
        t: "incoming",
        event: {
          type: "model.final",
          id: 3,
          ts: "t",
          turn: 1,
          content: "",
          toolCalls: [],
          usage: {},
        },
      });

      expect(reasoningSeg(state)).toMatchObject({ kind: "reasoning", durationMs: 1000 });
    } finally {
      now.mockRestore();
    }
  });

  it("closes an open reasoning run when a tool call starts", () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(200);
      let state = reduce(initialState(), { t: "incoming", event: turnStarted });
      state = reduce(state, {
        t: "incoming",
        event: {
          type: "model.delta",
          id: 2,
          ts: "t",
          turn: 1,
          channel: "reasoning",
          text: "reason",
        },
      });
      now.mockReturnValue(1200);
      state = reduce(state, {
        t: "incoming",
        event: {
          type: "tool.preparing",
          id: 3,
          ts: "t",
          turn: 1,
          callId: "tc-1",
          name: "read_file",
        },
      });

      expect(reasoningSeg(state)).toMatchObject({ kind: "reasoning", durationMs: 1000 });
    } finally {
      now.mockRestore();
    }
  });
});

describe("Desktop App reducer — model.final content", () => {
  const turnStarted: ModelTurnStartedEvent = {
    type: "model.turn.started",
    id: 1,
    ts: "2026-05-27T00:00:00.000Z",
    turn: 1,
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    prefixHash: "h",
  };

  it("renders abort content when nothing streamed (no silent empty bubble)", () => {
    const state = reduce(initialState(), { t: "incoming", event: turnStarted });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "[aborted by user — no response produced.]",
        toolCalls: [],
        usage: {},
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind !== "assistant") return;
    expect(assistant.pending).toBe(false);
    expect(assistant.segments).toHaveLength(1);
    expect(assistant.segments[0]).toMatchObject({
      kind: "text",
      text: "[aborted by user — no response produced.]",
    });
  });

  it("appends an image segment when model.final carries an image", () => {
    const state = reduce(initialState(), { t: "incoming", event: turnStarted });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "",
        toolCalls: [],
        usage: {},
        image: { dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" },
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind !== "assistant") return;
    expect(assistant.segments.at(-1)).toMatchObject({
      kind: "image",
      dataUrl: "data:image/jpeg;base64,AAAA",
      mimeType: "image/jpeg",
    });
  });

  it("re-marks the card pending when a later tool iteration streams after a mid-turn final", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted });
    state = reduce(state, {
      t: "batch_delta",
      items: [{ turn: 1, channel: "reasoning", text: "first pass" }],
    });
    // Mid-turn final (iteration 1 done): the card settles so its reasoning run
    // closes and the spinner gives way to the completion checkmark.
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 2,
        ts: "t",
        turn: 1,
        content: "",
        toolCalls: [],
        usage: {},
      },
    });
    let assistant = state.messages.find((m) => m.kind === "assistant");
    expect(assistant?.pending).toBe(false);

    // Iteration 2 streams more output for the SAME turn (after a tool call): the
    // card must read as still-streaming again so the reasoning spinner shows
    // instead of a premature green checkmark.
    state = reduce(state, {
      t: "batch_delta",
      items: [{ turn: 1, channel: "reasoning", text: "second pass" }],
    });
    assistant = state.messages.find((m) => m.kind === "assistant");
    expect(assistant?.pending).toBe(true);
  });

  it("does not duplicate content already streamed as deltas", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        channel: "content",
        text: "partial answer",
      },
    });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "partial answer",
        toolCalls: [],
        usage: {},
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant message");
    expect(assistant.segments).toHaveLength(1);
    expect(assistant.segments[0]).toMatchObject({ kind: "text", text: "partial answer" });
  });

  it("replaces streamed degeneration with the authoritative trimmed final", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        channel: "content",
        text: "Safe prefix wrightwrightwright",
      },
    });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "Safe prefix ",
        reasoningContent: "Checked files.",
        replaceStreamedOutput: true,
        toolCalls: [],
        usage: {},
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant message");
    expect(assistant.pending).toBe(false);
    expect(assistant.segments).toEqual([
      { kind: "reasoning", text: "Checked files.", model: "deepseek-v4-flash" },
      { kind: "text", text: "Safe prefix " },
    ]);
  });

  it("attaches degeneration warnings as a warning card segment on the active assistant message", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "Useful text before loop.",
        toolCalls: [],
        usage: {},
      },
    });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "warning",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        text: "Stopped a degenerating model stream after detecting 1024 repeated characters (period 6) in content output.",
        severity: "high",
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant message");
    expect(assistant.segments).toEqual([
      { kind: "text", text: "Useful text before loop." },
      {
        kind: "warning",
        id: "w-3",
        text: "Stopped a degenerating model stream after detecting 1024 repeated characters (period 6) in content output.",
        severity: "high",
      },
    ]);
  });

  it("anchors a late warning to its assistant turn instead of the latest assistant", () => {
    const base = initialState();
    const state = {
      ...base,
      messages: [
        { kind: "user" as const, text: "first", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "first answer" }],
          pending: false,
        },
        { kind: "user" as const, text: "second", clientId: "c-2", turn: 2 },
        {
          kind: "assistant" as const,
          turn: 2,
          segments: [{ kind: "text" as const, text: "second answer" }],
          pending: false,
        },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "warning",
        id: 4,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        text: "Late warning from turn one",
        severity: "high",
      },
    });
    const assistants = next.messages.filter((m) => m.kind === "assistant");

    expect(assistants[0]?.segments.at(-1)).toMatchObject({
      kind: "warning",
      id: "w-4",
      text: "Late warning from turn one",
    });
    expect(assistants[1]?.segments).toEqual([{ kind: "text", text: "second answer" }]);
  });

  it("skips forcedSummary finals — the placeholder is not rendered as content", () => {
    const state = reduce(initialState(), { t: "incoming", event: turnStarted });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "[aborted by user (Esc) — interrupted turn discarded. Ask again when ready.]",
        toolCalls: [],
        usage: {},
        forcedSummary: true,
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant message");
    expect(assistant.segments).toHaveLength(0);
    expect(assistant.pending).toBe(false);
  });
});

describe("Desktop App reducer — OpenAI OAuth flow state", () => {
  it("oauth_begin_result sets oauthWaiting", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: { type: "oauth_begin_result", url: "https://auth.example/authorize?x=1" },
    });
    expect(next.oauthWaiting).toBe(true);
  });

  it("$error with an OAuth message clears oauthWaiting", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: { type: "$error", message: "OAuth sign-in failed: access_denied" },
    });
    expect(next.oauthWaiting).toBe(false);
    expect(next.messages.at(-1)).toMatchObject({ kind: "notice", severity: "error" });
  });

  it("unrelated $error keeps oauthWaiting", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: { type: "$error", message: "settings_save failed: boom" },
    });
    expect(next.oauthWaiting).toBe(true);
  });

  it("$settings with signed-in OAuth clears oauthWaiting", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "medium",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        openaiOAuth: { signedIn: true, account: "u@example.com" },
        version: "0.50.1",
      },
    });
    expect(next.oauthWaiting).toBe(false);
    expect(next.settings?.openaiOAuth).toEqual({ signedIn: true, account: "u@example.com" });
  });

  it("$settings maps modelEndpoint and OAuth flowError into settings (#1529)", () => {
    const state = initialState();
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "medium",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        modelEndpoint: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          openaiAuth: "oauth",
          oauthAccount: "u@example.com",
        },
        openaiOAuth: {
          signedIn: true,
          account: "u@example.com",
          flowError: "OAuth token exchange failed: invalid_client",
        },
        version: "0.50.1",
      },
    });
    expect(next.settings?.modelEndpoint).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      openaiAuth: "oauth",
      oauthAccount: "u@example.com",
    });
    expect(next.settings?.openaiOAuth).toEqual({
      signedIn: true,
      account: "u@example.com",
      flowError: "OAuth token exchange failed: invalid_client",
    });
  });

  it("$settings carries workspace and global rules into settings", () => {
    const state = initialState();
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "medium",
        editMode: "never-ask",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-flash",
        shellAllowedWorkspace: ["npm test"],
        pathAllowedWorkspace: ["/opt/tools"],
        shellAllowedGlobal: ["git"],
        pathAllowedGlobal: ["/etc"],
        version: "0.50.1",
      },
    });
    expect(next.settings?.shellAllowedWorkspace).toEqual(["npm test"]);
    expect(next.settings?.pathAllowedWorkspace).toEqual(["/opt/tools"]);
    expect(next.settings?.shellAllowedGlobal).toEqual(["git"]);
    expect(next.settings?.pathAllowedGlobal).toEqual(["/etc"]);
  });

  it("$settings without signed-in OAuth keeps oauthWaiting", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "medium",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    });
    expect(next.oauthWaiting).toBe(true);
  });

  it("oauth_waiting action sets the flag directly (cancel button)", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, { t: "oauth_waiting", waiting: false });
    expect(next.oauthWaiting).toBe(false);
  });
});

describe("Desktop App reducer — OpenCode OAuth flow state", () => {
  it("opencode_oauth_begin_result sets opencodeOAuthWaiting", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "opencode_oauth_begin_result",
        url: "https://opencode.ai/console/device?user_code=ABCD-EFGH",
        userCode: "ABCD-EFGH",
      },
    });
    expect(next.opencodeOAuthWaiting).toBe(true);
  });

  it("$error with an OpenCode message clears opencodeOAuthWaiting", () => {
    const state = { ...initialState(), opencodeOAuthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: { type: "$error", message: "OpenCode sign-in failed: access_denied" },
    });
    expect(next.opencodeOAuthWaiting).toBe(false);
  });

  it("unrelated $error keeps opencodeOAuthWaiting", () => {
    const state = { ...initialState(), opencodeOAuthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: { type: "$error", message: "settings_save failed: boom" },
    });
    expect(next.opencodeOAuthWaiting).toBe(true);
  });

  it("$settings with signed-in OpenCode OAuth clears opencodeOAuthWaiting", () => {
    const state = { ...initialState(), opencodeOAuthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "medium",
        editMode: "follow",
        quickSendId: "proceed",
        quickSends: [],
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "mimo-v2.6-pro",
        opencodeOAuth: { signedIn: true, account: "u@example.com", orgName: "Acme" },
        version: "0.50.1",
      },
    });
    expect(next.opencodeOAuthWaiting).toBe(false);
    expect(next.settings?.opencodeOAuth).toEqual({
      signedIn: true,
      account: "u@example.com",
      orgName: "Acme",
    });
  });

  it("opencode_oauth_waiting action sets the flag directly (cancel button)", () => {
    const state = { ...initialState(), opencodeOAuthWaiting: true };
    const next = reduce(state, { t: "opencode_oauth_waiting", waiting: false });
    expect(next.opencodeOAuthWaiting).toBe(false);
  });
});

describe("Desktop App reducer — image attachments", () => {
  it("send_user with images attaches them to the optimistic user message", () => {
    const next = reduce(initialState(), {
      t: "send_user",
      text: "what does this show?",
      clientId: "c-img-1",
      images: ["data:image/png;base64,AAAA"],
    });
    const user = next.messages.find((m) => m.kind === "user");
    expect(user).toMatchObject({
      kind: "user",
      text: "what does this show?",
      clientId: "c-img-1",
      images: ["data:image/png;base64,AAAA"],
    });
  });

  it("send_user without images omits the images field", () => {
    const next = reduce(initialState(), { t: "send_user", text: "hi", clientId: "c-2" });
    const user = next.messages.find((m) => m.kind === "user");
    expect(user).toMatchObject({ kind: "user", text: "hi" });
    expect(user).not.toHaveProperty("images");
  });

  it("$session_loaded maps user images through to the thread", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "sess-img",
        messages: [
          {
            kind: "user",
            text: "what does this show?",
            images: ["data:image/png;base64,AAAA"],
          },
          {
            kind: "assistant",
            turn: 1,
            segments: [{ kind: "text", text: "a chart" }],
            pending: false,
          },
        ],
        carryover: {
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });
    const user = next.messages.find((m) => m.kind === "user");
    expect(user).toMatchObject({
      kind: "user",
      text: "what does this show?",
      images: ["data:image/png;base64,AAAA"],
    });
  });
});

describe("Desktop App reducer — subagent progress", () => {
  it("associates parallel runs with their parent tool call ids", () => {
    const state = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 1,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "parent-a",
              name: "spawn_subagent",
              args: "{}",
              startedAt: 1,
            },
            {
              kind: "tool" as const,
              callId: "parent-b",
              name: "spawn_subagent",
              args: "{}",
              startedAt: 1,
            },
          ],
        },
      ],
    };
    const eventBase = {
      type: "subagent.progress" as const,
      id: 1,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 1,
      action: "start" as const,
      task: "review",
    };
    const afterA = reduce(state, {
      t: "incoming",
      event: { ...eventBase, runId: "run-a", parentCallId: "parent-a" },
    });
    const afterB = reduce(afterA, {
      t: "incoming",
      event: { ...eventBase, id: 2, runId: "run-b", parentCallId: "parent-b" },
    });
    const assistant = afterB.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.segments[0]).toMatchObject({
      callId: "parent-a",
      subagentRuns: [{ runId: "run-a" }],
    });
    expect(assistant.segments[1]).toMatchObject({
      callId: "parent-b",
      subagentRuns: [{ runId: "run-b" }],
    });
  });

  it("keeps each run on its own card when the turn has one card per spawn", () => {
    // A turn that spawns twice produces a separate assistant card per spawn. The
    // host used to be resolved per message, so an event whose parentCallId
    // matched nothing in a message fell through to "this message's only subagent
    // segment" and attached the OTHER run there: both cards then rendered both
    // runs, duplicating the reasoning/output counters across every card.
    const card = (callId: string) => ({
      kind: "assistant" as const,
      turn: 3,
      pending: false,
      closed: true,
      segments: [
        {
          kind: "tool" as const,
          callId,
          name: "spawn_subagent",
          args: '{"task":"look"}',
          startedAt: 1,
        },
      ],
    });
    const start = {
      type: "subagent.progress" as const,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 3,
      task: "look",
      action: "start" as const,
    };
    const stream = { ...start, action: "stream" as const };

    let state: Parameters<typeof reduce>[0] = {
      ...initialState(),
      messages: [card("tc-1"), card("tc-2")],
    };
    state = reduce(state, {
      t: "incoming",
      event: { ...start, id: 1, runId: "sub-a", parentCallId: "tc-1" },
    });
    state = reduce(state, {
      t: "incoming",
      event: { ...start, id: 2, runId: "sub-b", parentCallId: "tc-2" },
    });
    state = reduce(state, {
      t: "incoming",
      event: {
        ...stream,
        id: 3,
        runId: "sub-a",
        parentCallId: "tc-1",
        reasoningChars: 1_000,
        outputChars: 10,
      },
    });
    state = reduce(state, {
      t: "incoming",
      event: {
        ...stream,
        id: 4,
        runId: "sub-b",
        parentCallId: "tc-2",
        reasoningChars: 5_000,
        outputChars: 50,
      },
    });

    const cards = state.messages.map((m) =>
      m.kind === "assistant"
        ? m.segments.map(
            (s) =>
              (s as { subagentRuns?: Array<Record<string, unknown>> }).subagentRuns?.map((r) => ({
                runId: r.runId,
                reasoningChars: r.reasoningChars,
                outputChars: r.outputChars,
              })) ?? [],
          )
        : [],
    );
    expect(cards[0]?.[0]).toEqual([{ runId: "sub-a", reasoningChars: 1_000, outputChars: 10 }]);
    expect(cards[1]?.[0]).toEqual([{ runId: "sub-b", reasoningChars: 5_000, outputChars: 50 }]);
  });

  it("pairs child tool activity and settles a failed run", () => {
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 2,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "parent",
              name: "spawn_subagent",
              args: "{}",
              startedAt: 1,
            },
          ],
        },
      ],
    };
    const send = (
      state: Parameters<typeof reduce>[0],
      event: import("./protocol").SubagentProgressEvent,
    ) => reduce(state, { t: "incoming", event });
    const common = {
      type: "subagent.progress" as const,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 2,
      runId: "run",
      parentCallId: "parent",
      task: "explore",
    };
    let state = send(base, { ...common, id: 1, action: "start" });
    state = send(state, {
      ...common,
      id: 2,
      action: "tool-start",
      childCallId: "child",
      toolName: "read_file",
    });
    state = send(state, {
      ...common,
      id: 3,
      action: "tool-end",
      childCallId: "child",
      toolOk: true,
    });
    state = send(state, { ...common, id: 4, action: "end", error: "failed" });
    const assistant = state.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.segments[0]).toMatchObject({
      subagentRuns: [
        {
          runId: "run",
          status: "failed",
          error: "failed",
          tools: [{ callId: "child", name: "read_file", status: "done" }],
        },
      ],
    });
  });

  it("falls back to running subagent candidate when parentCallId does not match segment callId", () => {
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 5,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "tc-1",
              name: "spawn_subagent",
              args: "{}",
              startedAt: 1,
            },
          ],
        },
      ],
    };
    const send = (
      state: Parameters<typeof reduce>[0],
      event: import("./protocol").SubagentProgressEvent,
    ) => reduce(state, { t: "incoming", event });
    const event = {
      type: "subagent.progress" as const,
      id: 1,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 5,
      runId: "run-mismatched",
      parentCallId: "loop-internal-call-id",
      action: "start" as const,
      task: "investigate quick send",
    };

    const next = send(base, event);
    const assistant = next.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.segments[0]).toMatchObject({
      callId: "tc-1",
      subagentRuns: [{ runId: "run-mismatched", task: "investigate quick send" }],
    });
  });

  it("accumulates thinking and process rows into recentRows on subagent.progress", () => {
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 3,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "parent-sub",
              name: "spawn_subagent",
              args: "{}",
              startedAt: 1,
            },
          ],
        },
      ],
    };
    const send = (
      state: Parameters<typeof reduce>[0],
      event: import("./protocol").SubagentProgressEvent,
    ) => reduce(state, { t: "incoming", event });
    const common = {
      type: "subagent.progress" as const,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 3,
      runId: "run-act",
      parentCallId: "parent-sub",
      task: "explore codebase",
    };

    let state = send(base, { ...common, id: 1, action: "start" });
    state = send(state, {
      ...common,
      id: 2,
      action: "stream",
      thought: "Analyzing the architecture...",
    });
    state = send(state, {
      ...common,
      id: 3,
      action: "tool-start",
      toolName: "read_file",
      toolArgs: "src/index.ts",
    });

    const assistant = state.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    const run = (assistant.segments[0] as { subagentRuns?: Array<{ recentRows?: unknown[] }> })
      ?.subagentRuns?.[0];

    expect(run?.recentRows).toHaveLength(3);
    expect(run?.recentRows?.[0]).toMatchObject({
      kind: "process",
      text: "Starting subagent...",
      status: "running",
    });
    expect(run?.recentRows?.[1]).toMatchObject({
      kind: "thinking",
      text: "Analyzing the architecture...",
    });
    expect(run?.recentRows?.[2]).toMatchObject({
      kind: "process",
      text: "↳ read_file src/index.ts",
      status: "running",
    });
  });

  it("keeps the latest three streamed lines as live activity rows", () => {
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 4,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "parent-live",
              name: "spawn_subagent",
              args: "{}",
              startedAt: 1,
            },
          ],
        },
      ],
    };
    const common = {
      type: "subagent.progress" as const,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 4,
      runId: "run-live",
      parentCallId: "parent-live",
      task: "research docs",
      skillName: "research",
    };

    let state = reduce(base, { t: "incoming", event: { ...common, id: 1, action: "start" } });
    state = reduce(state, {
      t: "incoming",
      event: {
        ...common,
        id: 2,
        action: "stream",
        reasoningChars: 30,
        thought: "First line\nSecond line\nThird line\nFourth line",
      },
    });
    state = reduce(state, {
      t: "incoming",
      event: {
        ...common,
        id: 3,
        action: "stream",
        reasoningChars: 40,
        thought: "Second line\nThird line\nFourth line updated",
      },
    });

    const assistant = state.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    const run = (
      assistant.segments[0] as {
        subagentRuns?: Array<{ recentRows?: Array<{ kind: string; text: string }> }>;
      }
    ).subagentRuns?.[0];

    expect(run?.recentRows?.slice(-3)).toEqual([
      expect.objectContaining({ kind: "thinking", text: "Second line" }),
      expect.objectContaining({ kind: "thinking", text: "Third line" }),
      expect.objectContaining({ kind: "thinking", text: "Fourth line updated" }),
    ]);
  });
  it("keeps the instruction a spawn started with when later events carry a preview", () => {
    // The start event carries the child's whole instruction; every later
    // progress event repeats only its head, which must not replace it.
    const instruction =
      "Diagnose a Unicorn emulation crash in this repo and prescribe the exact fix, working from the project root and running the differential harness first.";
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 1,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "tc-1",
              name: "spawn_subagent",
              args: JSON.stringify({ task: instruction }),
              startedAt: 1,
            },
          ],
        },
      ],
    };
    const common = {
      type: "subagent.progress" as const,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 1,
      runId: "run-task",
      parentCallId: "tc-1",
    };
    let state = reduce(base, {
      t: "incoming",
      event: { ...common, id: 1, action: "start", task: instruction },
    });
    state = reduce(state, {
      t: "incoming",
      event: {
        ...common,
        id: 2,
        action: "stream",
        task: `${instruction.slice(0, 30)}…`,
        outputChars: 10,
      },
    });

    const assistant = state.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    const run = (assistant.segments[0] as { subagentRuns?: Array<{ task: string }> })
      .subagentRuns?.[0];
    expect(run?.task).toBe(instruction);
  });
});

describe("Desktop App reducer — tool.output live shell output", () => {
  function stateWithShellCall(turn = 1, callId = "tc-1") {
    return {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId,
              name: "run_command",
              args: JSON.stringify({ command: "npm test" }),
              startedAt: 1,
            },
          ],
        },
      ],
    };
  }

  function outputEvent(
    text: string,
    overrides: Partial<import("./protocol").ToolOutputEvent> = {},
  ) {
    return {
      type: "tool.output" as const,
      id: 1,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 1,
      callId: "tc-1",
      name: "run_command",
      text,
      ...overrides,
    };
  }

  it("accumulates streamed output onto the matching running shell segment", () => {
    const afterFirst = reduce(stateWithShellCall(), {
      t: "incoming",
      event: outputEvent("pass 1\n"),
    });
    const assistant = afterFirst.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.segments[0]).toMatchObject({ liveOutput: "pass 1\n" });

    const afterSecond = reduce(afterFirst, {
      t: "incoming",
      event: outputEvent("pass 2\n", { id: 2 }),
    });
    const settled = afterSecond.messages[0];
    if (settled?.kind !== "assistant") throw new Error("expected assistant");
    expect(settled.segments[0]).toMatchObject({ liveOutput: "pass 1\npass 2\n" });
  });

  it("ignores output that arrives after the tool result settled the segment", () => {
    const state = stateWithShellCall();
    const withResult = reduce(state, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 5,
        ts: "2026-06-01T00:00:00.000Z",
        turn: 1,
        callId: "tc-1",
        ok: true,
        output: "pass 1\npass 2\n",
      },
    });
    const afterLate = reduce(withResult, {
      t: "incoming",
      event: outputEvent("stray\n", { id: 6 }),
    });
    const assistant = afterLate.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    const seg = assistant.segments[0];
    if (!seg || seg.kind !== "tool") throw new Error("expected tool segment");
    expect(seg.result).toBe("pass 1\npass 2\n");
    expect(seg.liveOutput).toBeUndefined();
  });

  it("does not attach output to segments on other turns or call ids", () => {
    const state = {
      ...stateWithShellCall(2, "tc-9"),
      messages: [
        ...stateWithShellCall(1, "tc-1").messages,
        ...stateWithShellCall(2, "tc-9").messages,
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: outputEvent("mine\n", { turn: 1, callId: "tc-1" }),
    });
    const first = next.messages[0];
    const second = next.messages[1];
    if (first?.kind !== "assistant" || second?.kind !== "assistant") {
      throw new Error("expected assistant");
    }
    expect(first.segments[0]).toMatchObject({ liveOutput: "mine\n" });
    const other = second.segments[0];
    if (!other || other.kind !== "tool") throw new Error("expected tool segment");
    expect(other.liveOutput).toBeUndefined();
  });
});

describe("Desktop App reducer — plan timeline anchor", () => {
  it("selects the active plan only for its original submit_plan message", () => {
    const plan = {
      plan: "Implement the timeline",
      steps: [],
      completedStepIds: [],
      stepResults: {},
      callId: "plan-call-42",
    };
    const before = {
      kind: "assistant" as const,
      turn: 1,
      pending: false,
      segments: [{ kind: "text" as const, text: "before" }],
    };
    const anchored = {
      kind: "assistant" as const,
      turn: 2,
      pending: false,
      segments: [
        {
          kind: "tool" as const,
          callId: "plan-call-42",
          name: "submit_plan",
          args: "{}",
          startedAt: 1,
        },
      ],
    };
    const after = {
      kind: "assistant" as const,
      turn: 3,
      pending: false,
      segments: [{ kind: "text" as const, text: "after" }],
    };

    expect(activePlanForMessage(before, plan)).toBeUndefined();
    expect(activePlanForMessage(anchored, plan)).toBe(plan);
    expect(activePlanForMessage(after, plan)).toBeUndefined();
  });

  it("preserves the submit_plan call id when an approved plan becomes active", () => {
    let state = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$plan_required",
        id: 7,
        plan: "Implement the timeline",
        summary: "Chronological plan",
        callId: "plan-call-42",
        steps: [
          {
            id: "step-1",
            title: "Anchor the card",
            action: "Render it at the submit_plan segment.",
          },
        ],
      },
    });

    state = reduce(state, {
      t: "resolve_plan",
      id: 7,
      verdict: { type: "approve" },
    });

    expect(state.activePlan).toMatchObject({
      callId: "plan-call-42",
      plan: "Implement the timeline",
      completedStepIds: [],
    });
  });
});

describe("Desktop App reducer — plan restore", () => {
  it("$plan_restored hydrates the active plan with steps, progress and results", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$plan_restored",
        planId: "plan-body",
        plan: "# Body",
        summary: "Resume me",
        steps: [
          { id: "step-1", title: "extract", action: "split tokens" },
          { id: "step-2", title: "rewire", action: "wire middleware" },
        ],
        completedStepIds: ["step-1"],
        stepResults: { "step-1": "done" },
      },
    });
    expect(next.activePlan).toMatchObject({
      plan: "# Body",
      summary: "Resume me",
      completedStepIds: ["step-1"],
      stepResults: { "step-1": "done" },
      status: "active",
    });
    expect(next.activePlan?.steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
  });

  it("$session_loaded clears the plan; a following $plan_restored re-hydrates it", () => {
    const seeded = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$plan_restored",
        planId: "plan-b",
        plan: "b",
        steps: [{ id: "step-1", title: "t", action: "a" }],
        completedStepIds: [],
      },
    });
    expect(seeded.activePlan).not.toBeNull();

    const loaded = reduce(seeded, {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "other",
        messages: [],
        carryover: {
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });
    expect(loaded.activePlan).toBeNull();
  });
});

describe("Desktop App reducer — a deleted plan leaves no rail behind", () => {
  const restored = {
    type: "$plan_restored" as const,
    planId: "plan-a",
    plan: "body",
    summary: "Cover the largest unsuited bodies with fixtures",
    steps: [{ id: "step-1", title: "fixtures", action: "write them" }],
    completedStepIds: ["step-1"],
  };

  function railWithPendingGates() {
    const hydrated = reduce(initialState(), { t: "incoming", event: restored });
    return reduce(hydrated, {
      t: "incoming",
      event: {
        type: "$checkpoint_required",
        id: 1,
        stepId: "step-1",
        result: "done",
        completed: 1,
        total: 1,
      },
    });
  }

  it("drops the rail and its pending gates when the workspace has no plan left", () => {
    // Delete-all empties the store, so the projection lists nothing. Nothing can keep
    // showing a plan that no longer exists anywhere.
    const cleared = reduce(railWithPendingGates(), {
      t: "incoming",
      event: { type: "$plan_history", sessionName: "mine", items: [] },
    });
    expect(cleared.activePlan).toBeNull();
    expect(cleared.pendingCheckpoints).toEqual([]);
  });

  it("drops a sealed rail showing a finished plan", () => {
    // A finished plan is sealed, not removed, so it stays on screen with every step ticked.
    // Once the plan is deleted that sealed rail is an orphan like any other.
    const sealed = reduce(railWithPendingGates(), {
      t: "incoming",
      event: { type: "$plan_cleared" },
    });
    expect(sealed.activePlan?.status).toBe("finished");
    const cleared = reduce(sealed, {
      t: "incoming",
      event: { type: "$plan_history", sessionName: "mine", items: [] },
    });
    expect(cleared.activePlan).toBeNull();
  });

  it("drops the rail when the projection no longer lists its plan", () => {
    // Another session's delete, in a workspace that still holds other plans: this tab's
    // rail showed the deleted one, so it goes with it.
    const cleared = reduce(railWithPendingGates(), {
      t: "incoming",
      event: { type: "$plan_history", sessionName: "other", items: [planHistoryRow("plan-z")] },
    });
    expect(cleared.activePlan).toBeNull();
  });

  it("keeps the rail while the projection still lists its plan", () => {
    const rail = railWithPendingGates();
    const kept = reduce(rail, {
      t: "incoming",
      event: { type: "$plan_history", sessionName: "mine", items: [planHistoryRow("plan-a")] },
    });
    expect(kept.activePlan).toBe(rail.activePlan);
    expect(kept.pendingCheckpoints).toHaveLength(1);
  });

  it("keeps an unhydrated rail until the workspace is empty, then drops it", () => {
    // A rail built from the approval carries no id until the daemon hydrates it, so the
    // only proof it is gone is a workspace with nothing left to show.
    const pending = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$plan_required",
        id: 7,
        plan: "Implement the timeline",
        summary: "Chronological plan",
        callId: "plan-call-42",
        steps: [{ id: "step-1", title: "Anchor the card", action: "Render it." }],
      },
    });
    const approved = reduce(pending, { t: "resolve_plan", id: 7, verdict: { type: "approve" } });
    expect(approved.activePlan?.planId).toBeUndefined();

    const stillThere = reduce(approved, {
      t: "incoming",
      event: { type: "$plan_history", sessionName: "mine", items: [planHistoryRow("plan-z")] },
    });
    expect(stillThere.activePlan).toBe(approved.activePlan);

    const cleared = reduce(approved, {
      t: "incoming",
      event: { type: "$plan_history", sessionName: "mine", items: [] },
    });
    expect(cleared.activePlan).toBeNull();
  });
});

describe("Desktop App reducer — plan labels are workspace-scoped", () => {
  const items = [
    planHistoryRow("plan-1", {
      status: "active",
      totalSteps: 2,
      completedSteps: 0,
      ownerSession: "background",
      summary: "Ship it",
    }),
  ];

  /** The tab is showing `foreground`; the plan belongs to another session. */
  function viewingForeground() {
    return { ...initialState(), currentSession: "foreground" };
  }

  it("applies a $plan_history stamped with a session this tab is not viewing", () => {
    // The plan store is workspace-wide, so the projection describes every session in
    // it. Dropping it because the name did not match left a background session's row
    // labelled "No plan" until the user switched to it.
    const next = reduce(viewingForeground(), {
      t: "incoming",
      event: { type: "$plan_history", sessionName: "background", items },
    });
    expect(next.planHistory).toHaveLength(1);
    expect(next.planHistory?.[0]?.ownerSession).toBe("background");
  });

  it("keeps the plan map when $session_loaded switches the visible session", () => {
    // A switch is not evidence that the workspace's plans changed.
    const seeded = reduce(viewingForeground(), {
      t: "incoming",
      event: { type: "$plan_history", sessionName: "background", items },
    });
    const loaded = reduce(seeded, {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "foreground",
        messages: [],
        carryover: {
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });
    expect(loaded.currentSession).toBe("foreground");
    expect(loaded.planHistory).toHaveLength(1);
    // The in-flight plan itself is per-session and still clears.
    expect(loaded.activePlan).toBeNull();
  });
});

describe("Desktop App reducer — plan usage", () => {
  it("$usage stores the normalized windows and clears the refresh flag", () => {
    const state = { ...initialState(), planUsageRefreshing: true };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$usage",
        usage: {
          probe: "ollama-balance",
          plan: "free",
          windows: [
            { label: "5h", remainingPct: 99.7, resetsAt: null },
            { label: "wk", remainingPct: 99.9, resetsAt: null },
          ],
        },
      },
    });
    expect(next.planUsage).toMatchObject({
      plan: "free",
      windows: [
        { label: "5h", remainingPct: 99.7 },
        { label: "wk", remainingPct: 99.9 },
      ],
    });
    expect(next.planUsageRefreshing).toBe(false);
    expect(next.planUsageReason).toBeNull();
    expect(next.planUsageNeedsSetup).toBe(false);
  });

  it("$usage with a null payload carries the reason and its setup flag", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: { type: "$usage", usage: null, reason: "http-429", needsSetup: true },
    });
    expect(next.planUsage).toBeNull();
    expect(next.planUsageReason).toBe("http-429");
    expect(next.planUsageNeedsSetup).toBe(true);
    expect(next.planUsageRefreshing).toBe(false);
  });
});

describe("sanitizeSettingsPatch — secrets never enter the settings view state", () => {
  it("drops the provider settings map and engine keys but keeps non-secret fields", () => {
    // Map keys come from declarations, so this typechecks with none declared as
    // well as with the shipped set — the sanitizer drops each map wholesale.
    const sanitized = sanitizeSettingsPatch({
      providerSettings: {},
      searchSettings: {},
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    });
    expect(sanitized).not.toHaveProperty("providerSettings");
    expect(sanitized).not.toHaveProperty("searchSettings");
    expect(sanitized.model).toBe("deepseek-v4-flash");
    expect(sanitized.reasoningEffort).toBe("high");
  });
});

describe("groupTabsByWorkspace — one ribbon tab per workspace", () => {
  it("groups independent session channels by normalized workspace, not group id", () => {
    const groups = groupTabsByWorkspace([
      { id: "t1", workspaceDir: "C:\\Work\\Alpha", group: "g1" },
      { id: "t2", workspaceDir: "c:/work/alpha/", group: "legacy-duplicate" },
      { id: "t3", workspaceDir: "C:\\Work\\Beta", group: "g1" },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.items.map((tab) => tab.id)).toEqual(["t1", "t2"]);
    expect(groups[1]!.items.map((tab) => tab.id)).toEqual(["t3"]);
  });

  it("preserves case-sensitive POSIX workspace identity", () => {
    const groups = groupTabsByWorkspace([
      { id: "t1", workspaceDir: "/work/Alpha" },
      { id: "t2", workspaceDir: "/work/alpha" },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("keeps pending channels separate unless their backend group matches", () => {
    const groups = groupTabsByWorkspace([
      { id: "t1", group: "g1" },
      { id: "t2", group: "g1" },
      { id: "t3", group: "g2" },
    ]);

    expect(groups.map((group) => group.items.map((tab) => tab.id))).toEqual([["t1", "t2"], ["t3"]]);
  });

  it("uses the active session channel as its workspace's representative", () => {
    const tabs = [
      { id: "a1", workspaceDir: "/proj/a" },
      { id: "b1", workspaceDir: "/proj/b" },
      { id: "a2", workspaceDir: "/proj/a" },
    ];

    expect(workspaceTabRepresentatives(tabs, "a2").map((tab) => tab.id)).toEqual(["a2", "b1"]);
  });
});

describe("cueIdForEvent — wire events to feedback cue ids", () => {
  it("maps every user-intervention event to inputRequired", () => {
    const events = [
      { type: "$confirm_required", id: 1, kind: "run_command", command: "ls" },
      {
        type: "$path_access_required",
        id: 2,
        path: "/tmp/x",
        intent: "write",
        toolName: "write_file",
        sandboxRoot: "/",
        allowPrefix: "/",
      },
      {
        type: "$edit_required",
        id: 3,
        path: "/a",
        toolName: "edit_file",
        sandboxRoot: "/",
        allowPrefix: "/",
      },
      { type: "$choice_required", id: 4, question: "q", options: [], allowCustom: true },
      { type: "$plan_required", id: 5, plan: "body" },
      { type: "$checkpoint_required", id: 6, stepId: "s", result: "r", completed: 1, total: 2 },
      { type: "$revision_required", id: 7, reason: "why", remainingSteps: [] },
    ] as const;
    for (const ev of events) {
      expect(cueIdForEvent(ev as never)).toBe("inputRequired");
    }
  });

  it("maps repetition-guard warnings to guardTriggered and leaves other warnings uncued", () => {
    expect(
      cueIdForEvent({
        id: 1,
        ts: "t",
        turn: 1,
        type: "warning",
        text: "x",
        severity: "high",
        cause: "repetition-guard",
      }),
    ).toBe("guardTriggered");
    expect(
      cueIdForEvent({ id: 2, ts: "t", turn: 1, type: "warning", text: "x", severity: "high" }),
    ).toBeNull();
  });

  it("returns null for events with no cue", () => {
    expect(cueIdForEvent({ type: "status", id: 1, ts: "t", turn: 1, text: "" })).toBeNull();
    expect(cueIdForEvent({ type: "$turn_complete", outcome: "success" })).toBeNull();
  });
});

describe("settingsValueEqual — echo reconciliation", () => {
  it("matches primitives, arrays, and nested objects by structure", () => {
    expect(settingsValueEqual(1, 1)).toBe(true);
    expect(settingsValueEqual("a", "b")).toBe(false);
    expect(settingsValueEqual([1, 2], [1, 2])).toBe(true);
    expect(settingsValueEqual([1, 2], [2, 1])).toBe(false);
    expect(
      settingsValueEqual(
        { inputRequired: { enabled: true, volume: 0.5, notify: false } },
        { inputRequired: { enabled: true, volume: 0.5, notify: false } },
      ),
    ).toBe(true);
    // Key order must not matter (JSON round-trips can reorder).
    expect(settingsValueEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(
      settingsValueEqual(
        { planComplete: { enabled: true, volume: 0.5, notify: false } },
        { planComplete: { enabled: false, volume: 0.5, notify: false } },
      ),
    ).toBe(false);
  });

  it("treats a missing field and null/undefined distinctly from a value", () => {
    expect(settingsValueEqual(undefined, null)).toBe(false);
    expect(settingsValueEqual(null, null)).toBe(true);
    expect(settingsValueEqual(undefined, {})).toBe(false);
  });
});

describe("mapLoadedMessages write stamps", () => {
  it("carries each record's write time onto the transcript entry", () => {
    const messages = mapLoadedMessages([
      { kind: "user", text: "first", ts: 1_700_000_000_000 },
      { kind: "assistant", turn: 1, segments: [], pending: false, ts: 1_700_000_004_000 },
      { kind: "notice", id: "n1", text: "compacted", severity: "info", ts: 1_700_000_006_000 },
      { kind: "user", text: "second", ts: 1_700_000_010_000 },
    ]);
    expect(messages.map((m) => m.ts)).toEqual([
      1_700_000_000_000, 1_700_000_004_000, 1_700_000_006_000, 1_700_000_010_000,
    ]);
  });

  it("leaves the stamp absent for a record written before stamps existed", () => {
    const [user] = mapLoadedMessages([{ kind: "user", text: "old" }]);
    expect(user?.ts).toBeUndefined();
  });
});

describe("writeStamp", () => {
  it("orders two records written in the same millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const first = writeStamp();
    const second = writeStamp();
    vi.useRealTimers();
    expect(first).toBeGreaterThanOrEqual(1_700_000_000_000);
    expect(second).toBeGreaterThan(first);
  });
});

describe("Desktop App reducer — turn phase vs daemon status", () => {
  const statusEvent = (fields: {
    code?: "tool-upload" | "model-retry" | "rate-limit";
    attempt?: number;
    waitMs?: number;
  }): Parameters<typeof reduce>[1] =>
    ({
      t: "incoming",
      event: {
        type: "status",
        id: 5,
        ts: "2026-06-01T00:00:00.000Z",
        turn: 1,
        text: "daemon copy the row does not print",
        ...fields,
      },
    }) as Parameters<typeof reduce>[1];

  it("stops claiming the tool result is outstanding once the result lands", () => {
    const next = reduce({ ...initialState(), busy: true, turnLastEventMs: 1 }, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 1,
        ts: "t",
        turn: 1,
        callId: "tc-1",
        ok: true,
        output: "[exit 0]",
      },
    } as unknown as Parameters<typeof reduce>[1]);

    expect(next.turnStatus).toBe("waiting_model");
    expect(next.turnStatusWait).toBeNull();
  });

  it("takes the phase and the wait from a tagged status event", () => {
    const next = reduce(
      { ...initialState(), busy: true, turnStatus: "calling_tool", turnStatusWait: null },
      statusEvent({ code: "model-retry", attempt: 2, waitMs: 3000 }),
    );

    expect(next.turnStatus).toBe("waiting_model");
    expect(next.turnStatusWait).toEqual({ code: "model-retry", attempt: 2, waitMs: 3000 });
    expect(next.turnLastEventMs).toBeGreaterThan(0);
  });

  it("clears a previous wait when the next request uploads the tool result", () => {
    const retrying = reduce(
      { ...initialState(), busy: true, turnStatus: "waiting_model" },
      statusEvent({ code: "model-retry", attempt: 1, waitMs: 500 }),
    );
    const uploading = reduce(retrying, statusEvent({ code: "tool-upload" }));

    expect(uploading.turnStatus).toBe("waiting_model");
    expect(uploading.turnStatusWait).toBeNull();
  });

  it("treats an untagged status as liveness only, never as a phase change", () => {
    const next = reduce(
      { ...initialState(), busy: true, turnStatus: "responding", turnLastEventMs: 1 },
      statusEvent({}),
    );

    expect(next.turnStatus).toBe("responding");
    expect(next.turnStatusWait).toBeNull();
    expect(next.turnLastEventMs).toBeGreaterThan(1);
  });
});

describe("Desktop App reducer — queued sends", () => {
  function queued(...texts: string[]): Parameters<typeof reduce>[0] {
    return { ...initialState(), queuedSends: texts.map((text) => ({ text })) };
  }

  it("promotes the clicked message to the head, keeping the rest in order", () => {
    const next = reduce(queued("first", "second", "third"), {
      t: "promote_queued_send",
      index: 2,
    });

    expect(next.queuedSends.map((item) => item.text)).toEqual(["third", "first", "second"]);
  });

  it("leaves the queue object alone when the message is already the head", () => {
    const state = queued("first", "second");
    expect(reduce(state, { t: "promote_queued_send", index: 0 })).toBe(state);
  });

  it("ignores a promote for an index the queue no longer holds", () => {
    const state = queued("first", "second");
    expect(reduce(state, { t: "promote_queued_send", index: 5 })).toBe(state);
  });

  it("dequeue keeps working by index after a promote", () => {
    const promoted = reduce(queued("first", "second", "third"), {
      t: "promote_queued_send",
      index: 2,
    });
    const dequeued = reduce(promoted, { t: "dequeue_send", index: 0 });

    expect(dequeued.queuedSends.map((item) => item.text)).toEqual(["first", "second"]);
  });

  it("drops the whole queue on stop instead of draining it into a new turn", () => {
    const stopped = reduce(
      { ...queued("first", "second"), busy: true },
      {
        t: "clear_queued_sends",
      },
    );

    expect(stopped.queuedSends).toEqual([]);
    // Nothing is announced yet: the turn still holds the card the notice belongs below.
    expect(stopped.messages).toEqual([]);
  });

  it("announces the drop at once when no turn card is streaming", () => {
    // A fold is engaged without a turn: there is no card to seal, so nothing to defer.
    const stopped = reduce(
      { ...queued("typed mid-fold"), compacting: true },
      {
        t: "clear_queued_sends",
      },
    );

    expect(stopped.queuedSends).toEqual([]);
    expect(stopped.queueDiscardCount).toBe(0);
    expect(stopped.messages.at(-1)).toMatchObject({
      kind: "notice",
      severity: "warning",
      text: "Stopped: 1 queued message was discarded.",
    });
  });

  it("announces the discarded queue once the stopped turn settles, below its card", () => {
    const stopped = reduce(
      { ...queued("first", "second"), busy: true },
      {
        t: "clear_queued_sends",
      },
    );
    const settled = reduce(stopped, {
      t: "incoming",
      event: { type: "$turn_complete", outcome: "aborted" },
    });

    expect(settled.messages.at(-1)).toMatchObject({
      kind: "notice",
      severity: "warning",
      text: "Stopped: 2 queued messages were discarded.",
    });
    // Announced once: the next settle has nothing left to report.
    const next = reduce(
      { ...settled, busy: true },
      { t: "incoming", event: { type: "$turn_complete", outcome: "success" } },
    );
    expect(next.messages.filter((m) => m.kind === "notice")).toHaveLength(1);
  });

  it("announces a parked discard when the lost terminal is resynced from $tab_status", () => {
    const stopped = reduce({ ...queued("first"), busy: true }, { t: "clear_queued_sends" });
    const resynced = reduce(stopped, {
      t: "incoming",
      event: { type: "$tab_status", busy: false, queued: 0, compacting: false, switching: false },
    });

    expect(resynced.queueDiscardCount).toBe(0);
    expect(resynced.messages.filter((m) => m.kind === "notice")).toHaveLength(2);
    expect(resynced.messages.at(-1)).toMatchObject({
      text: "Stopped: 1 queued message was discarded.",
    });
  });

  it("announces a parked discard when the unacknowledged send is released", () => {
    const stopped = reduce(
      { ...queued("first"), busy: true, awaitingAck: true },
      {
        t: "clear_queued_sends",
      },
    );
    const released = reduce(stopped, { t: "release_stale_send" });

    expect(released.queueDiscardCount).toBe(0);
    expect(released.messages.at(-1)).toMatchObject({
      text: "Stopped: 1 queued message was discarded.",
    });
  });

  it("adds no discard notice when nothing was queued", () => {
    const state = queued();

    expect(reduce(state, { t: "clear_queued_sends" })).toBe(state);
  });

  it("holds an unacknowledged send through an idle probe instead of releasing the turn", () => {
    // The daemon answers $tab_status before it has picked the user_input up (an
    // image mention or the MCP bridge parks the turn). Treating that quiet probe
    // as a lost terminal cleared awaitingAck, and the drain then pushed the next
    // queued message into a turn that was only just starting.
    const sending = {
      ...queued("next"),
      busy: false,
      awaitingAck: true,
      messages: [{ kind: "user" as const, text: "first", clientId: "c-1", turn: 1, ts: 1 }],
    };

    const probed = reduce(sending, {
      t: "incoming",
      event: { type: "$tab_status", busy: false, queued: 0, compacting: false, switching: false },
    });

    expect(probed.awaitingAck).toBe(true);
    expect(probed.queuedSends).toHaveLength(1);
    expect(probed.messages.some((m) => m.kind === "notice")).toBe(false);
  });

  it("refuses a blank item that would otherwise wedge the head of the queue", () => {
    const state = queued("first");

    expect(reduce(state, { t: "enqueue_send", send: { text: "   " } })).toBe(state);
    // An attachments-only send has no text but is still a real message.
    expect(
      reduce(state, {
        t: "enqueue_send",
        send: { text: " ", images: [{ id: "i1", thumbnail: "data:," }] },
      }).queuedSends,
    ).toHaveLength(2);
  });
});
