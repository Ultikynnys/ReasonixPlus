import { beforeAll, describe, expect, it, vi } from "vitest";
import { baseAppState } from "./support/app-state.js";

// Tauri APIs/plugins resolve to tests/mocks/*.ts via vitest.config.ts aliases.
const componentMocks = await import("./support/desktop-component-mocks.js");
vi.mock("../desktop/src/Markdown", () => componentMocks.markdown);
vi.mock("../desktop/src/ui/thread", () => componentMocks.thread);

type ReduceFn = Awaited<typeof import("../desktop/src/App")>["reduce"];
type AppState = Parameters<ReduceFn>[0];

let reduce: ReduceFn;

beforeAll(async () => {
  ({ reduce } = await import("../desktop/src/App"));
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

  it("anchors a notice to the start of its turn's group, above that turn's reply", () => {
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
    // The notice belongs to turn 2 (the last completed turn), so it slots right
    // after that turn's user message and above its reply, keeping creation order
    // within the turn instead of floating at the transcript tail.
    expect(next.messages.map((m) => m.kind)).toEqual([
      "user",
      "assistant",
      "user",
      "notice",
      "assistant",
    ]);
    expect(next.messages.at(-2)).toMatchObject({ kind: "notice", turn: 2 });
  });

  it("anchors a mid-turn notice to its in-flight turn, above the streaming card", () => {
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
    // The in-flight turn (2) owns the notice: it lands right after that turn's
    // user message, above the still-streaming card — never below the queued user
    // message at the tail. It still records the in-flight turn.
    expect(next.messages.map((m) => m.kind)).toEqual([
      "user",
      "assistant",
      "user",
      "notice",
      "assistant",
      "user",
    ]);
    expect(next.messages.at(-3)).toMatchObject({ kind: "notice", turn: 2 });
  });
});

describe("desktop $btw_result reducer (#1470)", () => {
  it("clears busy and appends the answer as a status message", () => {
    // /btw flips busy=true on send (via send_user echo); the answer must
    // flip it back off or the composer stays disabled (#1470).
    const state: AppState = { ...makeState(), busy: true };
    const next = reduce(state, {
      t: "incoming",
      event: { type: "$btw_result", question: "what year is it?", answer: "2026." },
    });
    expect(next.busy).toBe(false);
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
