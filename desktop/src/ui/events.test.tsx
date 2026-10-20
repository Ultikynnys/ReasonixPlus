// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEventRecord } from "../protocol";
import { EventsPanel, sessionEvents, turnEvents } from "./events";

afterEach(cleanup);

const userTurn = (turn: number, text: string, ts?: number) => ({
  kind: "user",
  text,
  turn,
  ...(ts === undefined ? {} : { ts }),
});

/** Turn 1 written at 1000, answered at 1500, turn 2 at 2000. */
const messages = [
  userTurn(1, "first question", 1_000),
  { kind: "assistant", turn: 1, ts: 1_500 },
  userTurn(2, "second question", 2_000),
];

const planEvent = (over: Partial<SessionEventRecord> = {}): SessionEventRecord => ({
  id: "plan-1",
  type: "plan",
  ts: 1_200,
  turn: 1,
  outcome: "approve",
  label: "Ship the parser",
  ...over,
});

describe("turnEvents", () => {
  it("keeps one row per user turn, stamped with when it was written", () => {
    const rows = turnEvents(messages);
    expect(rows.map((row) => row.turn)).toEqual([1, 2]);
    expect(rows.map((row) => row.ts)).toEqual([1_000, 2_000]);
    expect(rows[0]?.label).toBe("first question");
  });

  it("drops a replayed turn so one question cannot show twice", () => {
    const rows = turnEvents([userTurn(1, "first", 10), userTurn(1, "replayed", 20)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("first");
  });

  it("gives a pre-stamp record the stamp before it instead of no time", () => {
    const rows = turnEvents([userTurn(1, "one", 1_000), userTurn(2, "two")]);
    expect(rows.map((row) => row.ts)).toEqual([1_000, 1_000]);
  });

  it("collapses a headline to one line", () => {
    const rows = turnEvents([userTurn(1, `line one\n\n   line two${"x".repeat(400)}`, 5)]);
    expect(rows[0]?.label).not.toContain("\n");
    expect(rows[0]?.label.length).toBeLessThanOrEqual(160);
  });

  it("skips a machine-written record so tool feedback is not a prompt row", () => {
    const rows = turnEvents([
      userTurn(1, "real question", 1_000),
      { ...userTurn(2, "Screen capture (monitor 0 [0, 0] to [1920, 1080])", 2_000), injected: true },
      userTurn(3, "next question", 3_000),
    ]);

    expect(rows.map((row) => row.turn)).toEqual([1, 3]);
    expect(rows.map((row) => row.label)).toEqual(["real question", "next question"]);
  });
});

describe("sessionEvents", () => {
  it("orders turns and recorded verdicts by when they happened", () => {
    const rows = sessionEvents(messages, [
      planEvent(),
      { id: "compaction-7", type: "compaction", ts: 1_600, turn: 1, outcome: "auto", label: "folded 12" },
    ]);
    expect(rows.map((row) => `${row.kind}:${row.ts}`)).toEqual([
      "turn:1000",
      "plan:1200",
      "compaction:1600",
      "turn:2000",
    ]);
  });

  it("keeps the verdict and the wording the record carried", () => {
    const [plan] = sessionEvents([], [planEvent({ detail: "because" })]);
    expect(plan).toMatchObject({ kind: "plan", outcome: "approve", label: "Ship the parser" });
    expect(plan?.detail).toBe("because");
  });

  it("carries the options a choice was picked from", () => {
    const [choice] = sessionEvents([], [
      {
        id: "choice-1",
        type: "choice",
        ts: 10,
        turn: 1,
        outcome: "pick",
        label: "B",
        options: ["A", "B"],
      },
    ]);
    expect(choice?.options).toEqual(["A", "B"]);
  });

  it("carries a plan's body and checklist", () => {
    const [plan] = sessionEvents([], [
      planEvent({ body: "## Plan\n\nDo the thing.", steps: ["First", "Second"] }),
    ]);
    expect(plan?.body).toBe("## Plan\n\nDo the thing.");
    expect(plan?.steps).toEqual(["First", "Second"]);
  });

  it("skips a record with no usable stamp", () => {
    expect(sessionEvents([], [planEvent({ ts: Number.NaN })])).toEqual([]);
  });

  it("carries a subagent spawn with the instruction it was given", () => {
    const [spawn] = sessionEvents([], [
      {
        id: "subagent-tc-7",
        type: "subagent",
        ts: 10,
        turn: 1,
        outcome: "started",
        label: "explore",
        detail: "Survey the Events tab consumers.",
        anchor: "call:tc-7",
      },
    ]);
    expect(spawn).toMatchObject({
      kind: "subagent",
      outcome: "started",
      label: "explore",
      detail: "Survey the Events tab consumers.",
      anchor: "call:tc-7",
    });
  });
});

describe("EventsPanel", () => {
  const recorded: SessionEventRecord[] = [
    planEvent(),
    { id: "choice-2", type: "choice", ts: 1_800, turn: 2, outcome: "pick", label: "Option B" },
  ];

  const renderPanel = (onJump = vi.fn()) => {
    render(<EventsPanel messages={messages} events={recorded} onJump={onJump} />);
    return onJump;
  };

  it("shows every type in one timeline", () => {
    renderPanel();
    const rows = Array.from(document.querySelectorAll(".ctx-evt"));
    expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual([
      "turn",
      "plan",
      "choice",
      "turn",
    ]);
  });

  it("jumps to the row's turn when its body is clicked", () => {
    const onJump = renderPanel();
    const turnRow = document.querySelector('.ctx-evt[data-kind="turn"]');
    fireEvent.click(within(turnRow as HTMLElement).getByRole("button", { name: "Jump to turn 1" }));
    expect(onJump).toHaveBeenCalledWith({ turn: 1 });
    expect(turnRow?.getAttribute("data-active")).toBe("true");
  });

  it("jumps to the event's own card when the record carries an anchor", () => {
    // A plan/choice/fold row must land on its card, not on the prompt bubble of
    // the turn that happened to be open when it fired.
    const onJump = vi.fn();
    render(
      <EventsPanel
        messages={messages}
        events={[planEvent({ anchor: "call:p1" })]}
        onJump={onJump}
      />,
    );
    const planRow = document.querySelector('.ctx-evt[data-kind="plan"]');
    fireEvent.click(within(planRow as HTMLElement).getByRole("button", { name: "Jump to this event" }));
    expect(onJump).toHaveBeenCalledWith({ turn: 1, anchor: "call:p1" });
  });

  it("keeps an anchored row clickable when it has no turn", () => {
    const onJump = vi.fn();
    render(
      <EventsPanel
        messages={[]}
        events={[planEvent({ turn: 0, anchor: "call:p1" })]}
        onJump={onJump}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Jump to this event" }));
    expect(onJump).toHaveBeenCalledWith({ turn: 0, anchor: "call:p1" });
  });

  it("leaves the row unmarked when the chat could not go there", () => {
    // A rewound session still lists its verdicts; a turn that is gone must not
    // leave a row claiming to be the reader's place.
    render(<EventsPanel messages={messages} events={[]} onJump={() => false} />);
    const turnRow = document.querySelector('.ctx-evt[data-kind="turn"]');
    fireEvent.click(within(turnRow as HTMLElement).getByRole("button", { name: "Jump to turn 1" }));
    expect(turnRow?.getAttribute("data-active")).toBe("false");
  });

  it("expands a row's details from its chevron, not from the row", () => {
    const onJump = renderPanel();
    const [chevron] = screen.getAllByRole("button", { name: "Show event details" });
    expect(chevron?.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".ctx-evt-body")).toBeNull();
    fireEvent.click(chevron!);
    expect(chevron?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".ctx-evt-body")).not.toBeNull();
    // Expanding is not a jump: the chevron never scrolls the chat.
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.click(chevron!);
    expect(document.querySelector(".ctx-evt-body")).toBeNull();
  });

  it("lists the options a choice was picked from, marking the winner", () => {
    render(
      <EventsPanel
        messages={[]}
        events={[
          {
            id: "choice-9",
            type: "choice",
            ts: 1_000,
            turn: 1,
            outcome: "pick",
            label: "Verify the Events tab myself",
            detail: "What should I do next?",
            options: ["Stop here", "Verify the Events tab myself"],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show event details" }));
    const rows = Array.from(document.querySelectorAll(".ctx-evt-options li"));
    expect(rows.map((row) => row.textContent)).toEqual([
      "Stop here",
      "Verify the Events tab myself",
    ]);
    expect(rows.map((row) => row.getAttribute("data-picked"))).toEqual(["false", "true"]);
    // The pick is marked in the list; repeating it below would duplicate it.
    const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
      (el) => el.textContent,
    );
    expect(details).toEqual(["What should I do next?"]);
  });

  it("still shows a typed answer, which no offered option covers", () => {
    render(
      <EventsPanel
        messages={[]}
        events={[
          {
            id: "choice-10",
            type: "choice",
            ts: 1_000,
            turn: 1,
            outcome: "text",
            label: "Neither, do Z instead",
            options: ["Do X", "Do Y"],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show event details" }));
    expect(document.querySelectorAll(".ctx-evt-options li[data-picked]")).toHaveLength(2);
    const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
      (el) => el.textContent,
    );
    expect(details).toContain("Neither, do Z instead");
  });

  it("shows a plan's body and checklist when expanded", () => {
    render(
      <EventsPanel
        messages={[]}
        events={[
          {
            id: "plan-9",
            type: "plan",
            ts: 1_000,
            turn: 1,
            outcome: "approve",
            label: "QuickSend polish",
            body: "## QuickSend polish\n\nCloses four gaps.",
            steps: ["Route strings through i18n", "Collision-proof ids"],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show event details" }));
    const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
      (el) => el.textContent,
    );
    expect(details).toContain("## QuickSend polish\n\nCloses four gaps.");
    expect(details).toContain("QuickSend polish");
    const steps = Array.from(document.querySelectorAll(".ctx-evt-steps li")).map(
      (el) => el.textContent,
    );
    expect(steps).toEqual(["Route strings through i18n", "Collision-proof ids"]);
  });

  it("does not repeat a label that a body already carries", () => {
    // A row written by another build can hold both; the panel must not print the
    // plan twice just because the record does.
    render(
      <EventsPanel
        messages={[]}
        events={[
          {
            id: "plan-11",
            type: "plan",
            ts: 1_000,
            turn: 1,
            outcome: "approve",
            label: "Only the body",
            body: "Only the body",
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show event details" }));
    const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
      (el) => el.textContent,
    );
    expect(details).toEqual(["Only the body"]);
  });

  it("leaves a row without a turn unclickable", () => {
    render(<EventsPanel messages={[]} events={[planEvent({ turn: 0 })]} onJump={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Jump to/ })).toBeNull();
    expect(document.querySelector(".ctx-evt-body")).toBeNull();
    expect(document.querySelector(".ctx-evt-main")).toBeTruthy();
  });

  it("labels every row with its own event type", () => {
    renderPanel();
    const labels = Array.from(document.querySelectorAll(".ctx-evt")).map((row) =>
      row.querySelector(".ctx-evt-kind")?.textContent,
    );
    // No count/filter bar: the type is each row's own tag.
    expect(labels).toEqual(["User", "Plan", "Choice", "User"]);
    expect(document.querySelector(".ctx-evt-types")).toBeNull();
  });

  it("shows a subagent spawn as its own row, tagged and jumpable", () => {
    const onJump = vi.fn();
    render(
      <EventsPanel
        messages={[]}
        events={[
          {
            id: "subagent-tc-7",
            type: "subagent",
            ts: 1_000,
            turn: 1,
            outcome: "started",
            label: "explore",
            detail: "Survey the Events tab consumers.",
            anchor: "call:tc-7",
          },
        ]}
        onJump={onJump}
      />,
    );
    const row = document.querySelector('.ctx-evt[data-kind="subagent"]') as HTMLElement;
    expect(row.querySelector(".ctx-evt-kind")?.textContent).toBe("Subagent");
    expect(row.querySelector(".ctx-evt-label")?.textContent).toBe("started · explore");
    fireEvent.click(within(row).getByRole("button", { name: "Jump to this event" }));
    expect(onJump).toHaveBeenCalledWith({ turn: 1, anchor: "call:tc-7" });
    // The instruction is the row's body: a spawn's task is the point of the row.
    fireEvent.click(within(row).getByRole("button", { name: "Show event details" }));
    const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
      (el) => el.textContent,
    );
    expect(details).toContain("Survey the Events tab consumers.");
  });

  it("says so when a session has nothing recorded yet", () => {
    render(<EventsPanel messages={[]} events={[]} />);
    expect(document.querySelectorAll(".ctx-evt")).toHaveLength(0);
    expect(document.querySelector(".ctx-empty")?.textContent).toBe(
      "No events in this session yet.",
    );
  });
});
