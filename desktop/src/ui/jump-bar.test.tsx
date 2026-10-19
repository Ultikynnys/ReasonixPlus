// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JumpBar,
  MIN_DOT_GAP,
  type ConversationSpan,
  activeTurnFor,
  conversationSpans,
  jumpTargetFor,
  markTopFor,
  projectMarks,
  separateTops,
} from "./jump-bar";

/** Minimal ResizeObserver the test fires by hand: jsdom has none, and the
 *  component's own scheduling is what is under test. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(): void {
    this.callback();
  }
}

const rectOf = (top: number, bottom: number): DOMRect =>
  ({
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/** A rect with an explicit vertical extent: the bar measures the chevrons' inner
 *  edges, so a fixed 10px box is not always enough. */
function stubSpan(el: HTMLElement, top: number, bottom: number): void {
  el.getBoundingClientRect = () => rectOf(top, bottom);
}

function stubRect(el: HTMLElement, top: number): void {
  stubSpan(el, top, top + 10);
}

interface FakeThread {
  el: HTMLElement;
  /** Scroll geometry, mutated by the test to simulate layout changes. */
  geom: { scrollTop: number; scrollHeight: number; clientHeight: number };
  /** Re-derive each turn's rect from its content offset at the current scroll. */
  sync(): void;
}

interface ThreadOptions {
  /** Inner edges of the chevrons, in the scroller's viewport coordinates: the top
   *  button's bottom edge and the bottom button's top edge. */
  chevrons?: { topEnd: number; bottomStart: number };
}

function makeThread({ chevrons }: ThreadOptions = {}): FakeThread {
  const wrap = document.createElement("div");
  const el = document.createElement("div");
  const inner = document.createElement("div");
  el.appendChild(inner);
  const turns = [1, 2].map((turn) => {
    const node = document.createElement("div");
    node.setAttribute("data-turn", String(turn));
    inner.appendChild(node);
    return node;
  });
  const offsets = [0, 500];
  const geom = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
  const sync = () => {
    turns.forEach((node, i) => stubRect(node, offsets[i]! - geom.scrollTop));
  };
  Object.defineProperty(el, "scrollTop", {
    get: () => geom.scrollTop,
    set: (value: number) => {
      geom.scrollTop = value;
    },
  });
  Object.defineProperty(el, "scrollHeight", { get: () => geom.scrollHeight });
  Object.defineProperty(el, "clientHeight", { get: () => geom.clientHeight });
  // The scroller's rect follows its live height, as the real box does.
  el.getBoundingClientRect = () => rectOf(0, geom.clientHeight);
  wrap.appendChild(el);
  if (chevrons) {
    const rail = (buttonTop: number) => {
      const row = document.createElement("div");
      const button = document.createElement("button");
      button.className = "thread-scroll-btn";
      stubSpan(button, buttonTop, buttonTop + 18);
      row.appendChild(button);
      return row;
    };
    wrap.insertBefore(rail(chevrons.topEnd - 18), el);
    wrap.appendChild(rail(chevrons.bottomStart));
  }
  sync();
  return { el, geom, sync };
}

const userTurn = (turn: number, text: string, ts?: number) => ({
  kind: "user",
  text,
  turn,
  ...(ts === undefined ? {} : { ts }),
});

/** Two turns with their answers: turn 1 written at 1000, turn 2 at 2000, and the
 *  conversation ends at 3000. */
const messages = [
  userTurn(1, "first question", 1_000),
  { kind: "assistant", turn: 1, ts: 1_500 },
  userTurn(2, "second question", 2_000),
  { kind: "assistant", turn: 2, ts: 3_000 },
];

function dotTops(): number[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".jump-dot")).map((dot) =>
    Number.parseFloat(dot.style.top),
  );
}

/** Notify every observer, as a real resize does: the bar keeps one for the track
 *  box and one for the marker's anchors. */
function fireResize(): void {
  if (FakeResizeObserver.instances.length === 0) {
    throw new Error("no ResizeObserver was installed");
  }
  act(() => {
    for (const ro of FakeResizeObserver.instances) ro.fire();
  });
}

describe("conversationSpans", () => {
  it("places each turn on the timeline by when it was written", () => {
    const span = conversationSpans(messages);
    expect(span.turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(span.turns.map((t) => t.at)).toEqual([1_000, 2_000]);
    expect(span.start).toBe(1_000);
    expect(span.end).toBe(3_000);
  });

  it("anchors the top on the first turn, not on a record written before it", () => {
    const span = conversationSpans([
      { kind: "notice", text: "compacted", ts: 500 },
      userTurn(1, "one", 1_000),
    ]);
    // A notice can sit above turn 1; the first dot still has to be at 0.
    expect(span.start).toBe(1_000);
    expect(span.end).toBe(1_000);
    expect(span.turns.map((t) => t.at)).toEqual([1_000]);
  });

  it("stretches the end over a record written after the last turn", () => {
    const span = conversationSpans([
      userTurn(1, "one", 1_000),
      { kind: "assistant", turn: 1, ts: 3_000 },
    ]);
    expect(span.start).toBe(1_000);
    expect(span.end).toBe(3_000);
    expect(span.turns.map((t) => t.at)).toEqual([1_000]);
  });

  it("keeps one span per turn when a replayed turn arrives twice", () => {
    const span = conversationSpans([
      userTurn(1, "first", 10),
      userTurn(1, "replayed", 20),
      userTurn(2, "second", 30),
    ]);
    expect(span.turns.map((t) => t.turn)).toEqual([1, 2]);
  });

  it("falls back to turn order when any record has no write stamp", () => {
    const span = conversationSpans([
      userTurn(1, "first", 1_000),
      { kind: "assistant", turn: 1 },
      userTurn(2, "second", 2_000),
    ]);
    expect(span.turns.map((t) => t.at)).toEqual([0, 2]);
    expect(span.start).toBe(0);
    expect(span.end).toBe(2);
  });

  it("has an empty timeline without records", () => {
    expect(conversationSpans([])).toEqual({ turns: [], start: 0, end: 0 });
  });

  it("keeps an out-of-order log inside one span", () => {
    // A retracted or re-inserted record must not pull the span behind a turn: the
    // old first-record/last-record rule clamped every such dot onto an edge.
    const span = conversationSpans([userTurn(1, "first", 900), userTurn(2, "second", 300)]);
    expect(span.start).toBe(300);
    expect(span.end).toBe(900);
  });

  it("falls back to turn order when a record's stamp is corrupt", () => {
    const span = conversationSpans([userTurn(1, "a", Number.NaN), userTurn(2, "b", 10)]);
    expect(span.turns.map((t) => t.at)).toEqual([0, 1]);
    expect(span.start).toBe(0);
    expect(span.end).toBe(1);
  });
});

describe("markTopFor", () => {
  it("puts the first thing in the written conversation at the very top", () => {
    expect(markTopFor(1_000, 1_000, 3_000, 564)).toBe(0);
    expect(markTopFor(0, 0, 1, 1200)).toBe(0);
  });

  it("maps the end of the conversation to the bottom of the track", () => {
    expect(markTopFor(3_000, 1_000, 3_000, 564)).toBe(564);
  });

  it("places a turn by its share of the timeline, not of the content", () => {
    expect(markTopFor(2_000, 1_000, 3_000, 400)).toBe(200);
  });

  it("draws nothing without a track or without a timeline", () => {
    expect(markTopFor(2_000, 1_000, 3_000, 0)).toBe(0);
    expect(markTopFor(2_000, 1_000, 1_000, 400)).toBe(0);
  });

  it("clamps a stamp outside the timeline", () => {
    expect(markTopFor(9_999, 1_000, 3_000, 400)).toBe(400);
    expect(markTopFor(0, 1_000, 3_000, 400)).toBe(0);
  });

  it("refuses to place a dot from a non-finite stamp", () => {
    expect(markTopFor(Number.NaN, 0, 10, 400)).toBe(0);
    expect(markTopFor(5, 0, Number.POSITIVE_INFINITY, 400)).toBe(0);
  });
});

describe("projectMarks", () => {
  /** A timeline of turns at the given stamps, spanning them by default. */
  const timeline = (
    stamps: readonly number[],
    start = stamps[0] ?? 0,
    end = stamps[stamps.length - 1] ?? 0,
  ): ConversationSpan => ({
    turns: stamps.map((at, i) => ({ turn: i + 1, text: `t${i + 1}`, at })),
    start,
    end,
  });

  it("marks each turn at its place on the timeline", () => {
    expect(projectMarks(timeline([1_000, 2_000, 3_000]), 400).map((m) => m.top)).toEqual([
      0, 200, 400,
    ]);
  });

  it("keeps the first dot at the top even when every later turn is dense", () => {
    const tops = projectMarks(timeline([1_000, 1_001, 1_002, 1_003], 1_000, 900_000), 600).map(
      (m) => m.top,
    );
    expect(tops[0]).toBe(0);
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]! - tops[i - 1]!).toBeGreaterThanOrEqual(MIN_DOT_GAP - 1);
    }
  });

  it("shares the track evenly when the whole conversation lands in one instant", () => {
    expect(projectMarks(timeline([5_000, 5_000, 5_000]), 400).map((m) => m.top)).toEqual([
      0, 200, 400,
    ]);
  });

  it("keeps the distances between dots proportional to the stamp gaps", () => {
    expect(projectMarks(timeline([0, 1_000, 3_000]), 300).map((m) => m.top)).toEqual([0, 100, 300]);
  });

  it("spreads a burst to the floor without displacing an isolated dot", () => {
    const tops = projectMarks(timeline([0, 10, 20, 3_000]), 300).map((m) => m.top);
    expect(tops.slice(0, 3)).toEqual([0, MIN_DOT_GAP, MIN_DOT_GAP * 2]);
    // The far dot still sits exactly where its stamp puts it.
    expect(tops[3]).toBe(300);
  });

  it("has nothing to draw without a track", () => {
    expect(projectMarks(timeline([0], 0, 10), 0)).toEqual([]);
    expect(projectMarks({ turns: [], start: 0, end: 10 }, 400)).toEqual([]);
  });
});

describe("separateTops", () => {
  it("leaves stamp spacing untouched where it already clears the floor", () => {
    expect(separateTops([0, 100, 260], 600, MIN_DOT_GAP)).toEqual([0, 100, 260]);
  });

  it("nudges only the dot that would overlap, and only far enough", () => {
    expect(separateTops([0, 4, 200], 600, MIN_DOT_GAP)).toEqual([0, 16, 200]);
  });

  it("never moves a dot above where its stamp put it", () => {
    expect(separateTops([1, 5, 11, 17, 23], 600, MIN_DOT_GAP)).toEqual([1, 17, 33, 49, 65]);
  });

  it("keeps the first dot on the top edge and pays the overflow from the tail", () => {
    expect(separateTops([0, 585, 592, 600], 600, MIN_DOT_GAP)).toEqual([0, 568, 584, 600]);
  });

  it("pins every dot when the track has no height", () => {
    expect(separateTops([0, 10, 20], 0, MIN_DOT_GAP)).toEqual([0, 0, 0]);
  });

  it("shrinks the floor instead of rewriting the layout when the turns cannot fit", () => {
    const stamps = Array.from({ length: 41 }, (_, i) => (i / 40) * 600);
    const tops = separateTops(stamps, 600, MIN_DOT_GAP);
    expect(tops[0]).toBe(0);
    expect(tops[40]).toBe(600);
    // 41 dots leave 40 gaps, so the tallest floor that still fits is 600/40 = 15.
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]! - tops[i - 1]!).toBeCloseTo(15, 9);
    }
    expect(tops[20]).toBeCloseTo(300, 9);
  });
});

describe("activeTurnFor", () => {
  const positions = [0, 250, 500, 750].map((offset, i) => ({
    turn: i + 1,
    text: `t${i + 1}`,
    offset,
  }));

  it("marks the last turn whose top has passed the viewport top", () => {
    expect(activeTurnFor(480, positions)).toBe(2);
    expect(activeTurnFor(500, positions)).toBe(3);
    expect(activeTurnFor(5000, positions)).toBe(4);
  });

  it("falls back to the first turn while the viewport sits above them all", () => {
    expect(activeTurnFor(0, positions)).toBe(1);
  });

  it("has no marker without anchors", () => {
    expect(activeTurnFor(0, [])).toBeNull();
  });
});

describe("jumpTargetFor", () => {
  it("clamps a jump target to the reachable scroll range", () => {
    expect(jumpTargetFor(9000, 1000, 564)).toBe(436);
    expect(jumpTargetFor(100, 1000, 564)).toBe(100);
  });

  it("targets the top while the transcript cannot scroll", () => {
    expect(jumpTargetFor(500, 400, 400)).toBe(0);
  });
});

describe("JumpBar", () => {
  let thread: FakeThread;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    thread = makeThread();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
  });

  it("puts the first dot at the top and the rest where they were written", () => {
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(document.querySelectorAll(".jump-dot")).toHaveLength(2);
    // Turn 2 was written halfway through a 400px track that spans 1000..3000.
    expect(dotTops()).toEqual([0, 200]);
  });

  it("maps the dots between the chevrons when they overlap the track", () => {
    thread = makeThread({ chevrons: { topEnd: 18, bottomStart: 382 } });
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    // 400px track, an 18px chevron at each end, 3px clearance: a 358px band at y=21.
    expect(dotTops()).toEqual([21, 200]);
  });

  it("only clears the chevrons when they sit outside the track", () => {
    thread = makeThread({ chevrons: { topEnd: 0, bottomStart: 400 } });
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([3, 200]);
  });

  it("renders nothing while the transcript holds a single turn", () => {
    render(<JumpBar messages={[userTurn(1, "only", 1_000)]} threadEl={thread.el} />);
    expect(document.querySelectorAll(".jump-dot")).toHaveLength(0);
  });

  it("de-duplicates a replayed turn so its dot cannot swap places", () => {
    render(
      <JumpBar
        messages={[userTurn(1, "first", 10), userTurn(1, "replayed", 11), userTurn(2, "b", 12)]}
        threadEl={thread.el}
      />,
    );
    expect(document.querySelectorAll(".jump-dot")).toHaveLength(2);
  });

  it("keeps the dots still when the transcript is scrolled", () => {
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0, 200]);
    thread.geom.scrollTop = 250;
    thread.sync();
    fireResize();
    expect(dotTops()).toEqual([0, 200]);
  });

  it("keeps the dots still while an answer streams", () => {
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0, 200]);
    // Growth only moves layout: no record was written, so no dot may move.
    thread.geom.scrollHeight = 40_000;
    fireResize();
    expect(dotTops()).toEqual([0, 200]);
  });

  it("moves a dot only when a message is written", () => {
    const { rerender } = render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0, 200]);
    rerender(
      <JumpBar
        messages={[...messages, { kind: "assistant", turn: 2, ts: 5_000 }]}
        threadEl={thread.el}
      />,
    );
    // The conversation now ends at 5000, so turn 2's place is 1000/4000 of the track.
    expect(dotTops()).toEqual([0, 100]);
  });

  it("falls back to turn order for a transcript written before stamps", () => {
    render(<JumpBar messages={[userTurn(1, "one"), userTurn(2, "two")]} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0, 400]);
  });

  it("draws nothing until the track has a height, then places the dots at once", () => {
    thread.geom.clientHeight = 0;
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(document.querySelectorAll(".jump-dot")).toHaveLength(0);
    thread.geom.clientHeight = 400;
    fireResize();
    expect(dotTops()).toEqual([0, 200]);
  });
});
