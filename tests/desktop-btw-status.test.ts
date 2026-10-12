import { beforeAll, describe, expect, it, vi } from "vitest";
import { baseAppState } from "./support/app-state.js";

// Tauri APIs/plugins resolve to tests/mocks/*.ts via vitest.config.ts aliases.
const componentMocks = await import("./support/desktop-component-mocks.js");
vi.mock("../desktop/src/Markdown", () => componentMocks.markdown);
vi.mock("../desktop/src/ui/thread", () => componentMocks.thread);

type AppModule = Awaited<typeof import("../desktop/src/App")>;
type ReduceFn = AppModule["reduce"];
type AppState = Parameters<ReduceFn>[0];

let reduce: ReduceFn;
let mapLoadedMessages: AppModule["mapLoadedMessages"];
let collectPersistedNotices: AppModule["collectPersistedNotices"];

beforeAll(async () => {
  ({ reduce, mapLoadedMessages, collectPersistedNotices } = await import("../desktop/src/App"));
});

const makeState = () => baseAppState({ ready: true });

describe("desktop timeline notices", () => {
  it("appends notice cards in dispatch order without shifting unrelated state", () => {
    const state = makeState();
    let next = reduce(state, { t: "push_notice", text: "Model switched" });
    next = reduce(next, {
      t: "push_notice",
      text: "Vision is unavailable",
      severity: "warning",
    });
    next = reduce(next, { t: "push_notice", text: "Export failed", severity: "error" });

    expect(next.messages).toMatchObject([
      { kind: "notice", text: "Model switched", severity: "info" },
      { kind: "notice", text: "Vision is unavailable", severity: "warning" },
      { kind: "notice", text: "Export failed", severity: "error" },
    ]);
    expect(new Set(next.messages.map((message) => message.kind))).toEqual(new Set(["notice"]));
    expect(next.busy).toBe(state.busy);
    expect(next.ready).toBe(state.ready);
  });

  it("appends a new notice after older completed cards", () => {
    const state: AppState = {
      ...makeState(),
      messages: [
        { kind: "user", text: "hi", clientId: "c1", turn: 1 },
        { kind: "assistant", turn: 1, segments: [], pending: false },
        { kind: "user", text: "again", clientId: "c2", turn: 2 },
        { kind: "assistant", turn: 2, segments: [], pending: false },
      ],
    };
    const next = reduce(state, { t: "push_notice", text: "Export failed", severity: "error" });
    expect(next.messages.slice(0, -1)).toEqual(state.messages);
    expect(next.messages.at(-1)).toMatchObject({ kind: "notice", turn: 2 });
  });

  it("appends a mid-turn notice after all previously created cards", () => {
    const state: AppState = {
      ...makeState(),
      messages: [
        { kind: "user", text: "hi", clientId: "c1", turn: 1 },
        { kind: "assistant", turn: 1, segments: [], pending: false },
        { kind: "user", text: "again", clientId: "c2", turn: 2 },
        { kind: "assistant", turn: 2, segments: [], pending: true },
        { kind: "user", text: "queued", clientId: "c3", turn: 3 },
      ],
    };
    const next = reduce(state, {
      t: "push_notice",
      text: "Image attach failed",
      severity: "error",
    });
    expect(next.messages.slice(0, -1)).toEqual(state.messages);
    expect(next.messages.at(-1)).toMatchObject({ kind: "notice", turn: 2 });
  });
});

describe("manual compaction card chronology", () => {
  it("appends below a pending assistant and settles without moving", () => {
    const state: AppState = {
      ...makeState(),
      messages: [
        { kind: "user", text: "hi", clientId: "c1", turn: 1 },
        { kind: "assistant", turn: 1, segments: [], pending: true },
      ],
    };
    const started = reduce(state, {
      t: "incoming",
      event: {
        type: "compaction.started",
        id: 1,
        ts: "2026-06-01T00:00:00Z",
        turn: 1,
        trigger: "manual",
      },
    });
    expect(started.messages.slice(0, -1)).toEqual(state.messages);
    expect(started.messages.at(-1)).toMatchObject({ kind: "notice", running: true });
    const finished = reduce(started, {
      t: "incoming",
      event: { type: "$notice", text: "Compacted", severity: "success" },
    });
    expect(finished.messages.slice(0, -1)).toEqual(state.messages);
    expect(finished.messages.at(-1)).toMatchObject({
      kind: "notice",
      running: false,
      text: "Compacted",
    });
  });
});

describe("desktop $btw_result reducer (#1470)", () => {
  it("appends the answer as a status message without touching turn state", () => {
    // A btw side question never runs a turn — the daemon answers it outside the
    // loop, so no $turn_started/$turn_complete ever frames it. The answer must
    // not release turn state either: a real turn may be running concurrently
    // and only its own terminal event may settle it.
    const state: AppState = { ...makeState(), busy: true };
    const next = reduce(state, {
      t: "incoming",
      event: { type: "$btw_result", question: "what year is it?", answer: "2026." },
    });
    expect(next.busy).toBe(true);
    expect(next.messages.at(-1)).toMatchObject({
      kind: "notice",
      text: "≫ btw\n2026.",
      severity: "info",
    });
  });
});

describe("desktop error notice severity", () => {
  it("renders a recoverable kernel error as a warning notice", () => {
    const state = makeState();
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 99,
        ts: "2026-05-21T00:00:00Z",
        turn: 1,
        message: "repeat-loop guard tripped",
        recoverable: true,
      },
    });
    expect(next.messages.at(-1)).toMatchObject({
      kind: "notice",
      text: "repeat-loop guard tripped",
      severity: "warning",
    });
  });

  it("renders a hard protocol error as an error notice", () => {
    const state = makeState();
    const next = reduce(state, {
      t: "incoming",
      event: { type: "$error", message: "rpc died" },
    });
    expect(next.messages.at(-1)).toMatchObject({
      kind: "notice",
      text: "rpc died",
      severity: "error",
    });
  });
});

describe("desktop $turn_complete reducer (#1456)", () => {
  it("clears orphaned pause-gate modals so an aborted plan card stops haunting the transcript", () => {
    // When the user aborts (e.g. presses the stop button mistaken for send)
    // mid-plan-approval, the loop unwinds and emits $turn_complete. Without
    // this clear, pendingPlans stays populated — the queued user message
    // drains next and renders ABOVE the zombie plan card (#1456).
    const state: AppState = {
      ...makeState(),
      busy: true,
      pendingPlans: [{ id: 7, plan: "## Plan\nstep 1\nstep 2", summary: "do thing" }],
      pendingConfirms: [{ id: 8, kind: "shell", command: "rm -rf /tmp/x", prompt: "?" }],
      pendingPathAccess: [{ id: 9, path: "/secret" }],
      pendingChoices: [{ id: 10, question: "?", options: [], allowCustom: false }],
      pendingCheckpoints: [
        {
          id: 11,
          stepId: "s1",
          title: "step 1",
          result: "ok",
          notes: "",
          completed: 1,
          total: 2,
        },
      ],
      pendingRevisions: [{ id: 12, reason: "blocked", remainingSteps: [] }],
    };
    const next = reduce(state, { t: "incoming", event: { type: "$turn_complete" } });
    expect(next.busy).toBe(false);
    expect(next.pendingPlans).toEqual([]);
    expect(next.pendingConfirms).toEqual([]);
    expect(next.pendingPathAccess).toEqual([]);
    expect(next.pendingChoices).toEqual([]);
    expect(next.pendingCheckpoints).toEqual([]);
    expect(next.pendingRevisions).toEqual([]);
  });
});

describe("desktop session notice persistence round-trip", () => {
  it("maps a persisted notice LoadedMessage back to a notice card, keeping its turn", () => {
    const mapped = mapLoadedMessages([
      { kind: "notice", id: "n1", text: "Mode: AUTO", severity: "warning", turn: 2 },
    ]);
    expect(mapped).toEqual([
      { kind: "notice", id: "n1", text: "Mode: AUTO", severity: "warning", turn: 2 },
    ]);
  });

  it("collects notice cards and assistant warning segments into the persisted shape", () => {
    const collected = collectPersistedNotices([
      { kind: "notice", id: "n1", text: "Mode: AUTO", severity: "info", turn: 2 },
      {
        kind: "assistant",
        turn: 2,
        pending: false,
        segments: [
          { kind: "text", text: "hi" },
          { kind: "warning", id: "w1", text: "degeneration", severity: "high" },
        ],
      },
    ]);
    expect(collected).toEqual([
      { id: "n1", kind: "notice", text: "Mode: AUTO", severity: "info", turn: 2 },
      { id: "w1", kind: "warning", text: "degeneration", severity: "high", turn: 2 },
    ]);
  });
});
