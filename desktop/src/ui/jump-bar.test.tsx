// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JumpBar, SETTLE_MS, projectMarks } from "./jump-bar";

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

function stubRect(el: HTMLElement, top: number): void {
  el.getBoundingClientRect = () =>
    ({
      top,
      left: 0,
      right: 100,
      bottom: top + 10,
      width: 100,
      height: 10,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

interface FakeThread {
  el: HTMLElement;
  /** Scroll geometry, mutated by the test to simulate layout changes. */
  geom: { scrollTop: number; scrollHeight: number; clientHeight: number };
  /** Re-derive each turn's rect from its content offset at the current scroll. */
  sync(): void;
}

function makeThread(): FakeThread {
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
  stubRect(el, 0);
  sync();
  return { el, geom, sync };
}

const userTurn = (turn: number, text: string) => ({ kind: "user", text, turn });

const messages = [userTurn(1, "first question"), userTurn(2, "second question")];

function dotTops(): number[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".jump-dot")).map((dot) =>
    Number.parseFloat(dot.style.top),
  );
}

function fireResize(): void {
  const ro = FakeResizeObserver.instances.at(-1);
  if (!ro) throw new Error("no ResizeObserver was installed");
  act(() => {
    ro.fire();
  });
}

function settle(): void {
  act(() => {
    vi.advanceTimersByTime(SETTLE_MS);
  });
}

const anchors = [
  { turn: 1, text: "a", offset: 0 },
  { turn: 2, text: "b", offset: 500 },
];

describe("projectMarks", () => {
  it("places a turn where its content offset falls on the track", () => {
    expect(projectMarks(anchors, 400, 1000).map((m) => m.top)).toEqual([0, 200]);
  });

  it("clamps an offset past the content end onto the track bottom", () => {
    expect(projectMarks([{ turn: 1, text: "a", offset: 9000 }], 400, 1000)[0]!.top).toBe(400);
  });

  it("gives a non-overflowing transcript evenly spaced slots", () => {
    expect(projectMarks(anchors, 400, 400).map((m) => m.top)).toEqual([100, 300]);
  });

  it("rounds to whole pixels so sub-pixel wobble cannot invent a position", () => {
    const a = projectMarks([{ turn: 1, text: "a", offset: 1 }], 400, 1000)[0]!.top;
    const b = projectMarks([{ turn: 1, text: "a", offset: 1.2 }], 400, 1000)[0]!.top;
    expect(a).toBe(b);
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

  it("places one dot per turn at its proportional spot", () => {
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(document.querySelectorAll(".jump-dot")).toHaveLength(2);
    expect(dotTops()).toEqual([0, 200]);
  });

  it("renders nothing while the transcript holds a single turn", () => {
    render(<JumpBar messages={[userTurn(1, "only")]} threadEl={thread.el} />);
    expect(document.querySelectorAll(".jump-dot")).toHaveLength(0);
  });

  it("de-duplicates a replayed turn so its dot cannot swap places", () => {
    render(
      <JumpBar
        messages={[userTurn(1, "first"), userTurn(1, "replayed"), userTurn(2, "second")]}
        threadEl={thread.el}
      />,
    );
    expect(document.querySelectorAll(".jump-dot")).toHaveLength(2);
  });

  it("spaces the turns evenly while the transcript is too short to scroll", () => {
    thread.geom.scrollHeight = thread.geom.clientHeight;
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([100, 300]);
  });

  it("drops the dot of a turn that is not mounted in the transcript", () => {
    thread.el.querySelector('[data-turn="2"]')?.remove();
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0]);
  });

  it("places the dots at once when an unmeasurable transcript becomes visible", () => {
    thread.geom.clientHeight = 0;
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(document.querySelectorAll(".jump-dot")).toHaveLength(0);
    // No settle delay once there is a box to draw into again.
    thread.geom.clientHeight = 400;
    fireResize();
    expect(dotTops()).toEqual([0, 200]);
  });

  it("holds the dots still while the content grows, then re-projects once it settles", () => {
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0, 200]);
    // The transcript grows below the second turn, as a streamed reply would.
    thread.geom.scrollHeight = 2000;
    fireResize();
    expect(dotTops()).toEqual([0, 200]);
    settle();
    expect(dotTops()).toEqual([0, 100]);
  });

  it("never moves the dots when the transcript is scrolled", () => {
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0, 200]);
    // Scrolling shifts every rect, but not the turn's offset in the content.
    thread.geom.scrollTop = 250;
    thread.sync();
    fireResize();
    settle();
    expect(dotTops()).toEqual([0, 200]);
  });
});
