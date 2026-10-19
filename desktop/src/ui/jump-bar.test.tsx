// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JumpBar,
  MIN_DOT_GAP,
  MIN_THUMB_PX,
  activeTurnFor,
  dotTopForOffset,
  maxScrollTop,
  projectMarks,
  scrollTopForOffset,
  separateTops,
  thumbLength,
  thumbTopForScrollTop,
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

const anchors = [
  { turn: 1, text: "a", offset: 0 },
  { turn: 2, text: "b", offset: 500 },
];

/** Track geometry; the track box spans the scroller's padding box, so the track
 *  height and the viewport height are the same number. */
const metrics = (trackHeight: number, scrollHeight: number, clientHeight = trackHeight) => ({
  trackHeight,
  scrollHeight,
  clientHeight,
});

describe("projectMarks", () => {
  it("places a turn where its content offset falls on the track", () => {
    expect(projectMarks(anchors, metrics(400, 1000)).map((m) => m.top)).toEqual([0, 200]);
  });

  it("clamps an offset past the content end onto the thumb's lowest position", () => {
    // Not the track bottom: the thumb can only reach trackHeight - thumbLength.
    expect(projectMarks([{ turn: 1, text: "a", offset: 9000 }], metrics(400, 1000))[0]!.top).toBe(
      240,
    );
  });

  it("falls back to an ordered ladder when the transcript cannot scroll", () => {
    expect(projectMarks(anchors, metrics(400, 400)).map((m) => m.top)).toEqual([0, MIN_DOT_GAP]);
  });

  it("rounds to whole pixels so sub-pixel wobble cannot invent a position", () => {
    const a = projectMarks([{ turn: 1, text: "a", offset: 500 }], metrics(400, 1000))[0]!.top;
    const b = projectMarks([{ turn: 1, text: "a", offset: 500.4 }], metrics(400, 1000))[0]!.top;
    expect(a).toBe(b);
  });
});

describe("the dot mapping is the thumb's own map", () => {
  it("puts the thumb exactly on the dot once that turn is jumped to", () => {
    const m = metrics(564, 95085);
    for (const offset of [0, 1200, 45000, 94521]) {
      expect(dotTopForOffset(offset, m)).toBe(
        thumbTopForScrollTop(scrollTopForOffset(offset, m), m),
      );
    }
  });

  it("keeps a turn past the end inside the thumb's reach, not on the track edge", () => {
    // Pre-fix this clamped to trackHeight (564), where the thumb can never sit.
    expect(projectMarks([{ turn: 1, text: "a", offset: 9_000_000 }], metrics(564, 95085))[0]!.top).toBe(
      544,
    );
  });

  it("clamps the thumb to the platform minimum on a very long transcript", () => {
    const m = metrics(564, 95085);
    // The proportional value is ~3.3px; without the floor every dot would sit
    // tens of pixels below the thumb that a click actually lands on.
    expect(thumbLength(m)).toBe(MIN_THUMB_PX);
    expect(maxScrollTop(m)).toBe(95085 - 564);
  });

  it("clamps a jump target to the reachable scroll range", () => {
    const m = metrics(564, 1000);
    expect(scrollTopForOffset(9000, m)).toBe(436);
    expect(scrollTopForOffset(100, m)).toBe(100);
  });

  it("moves a dot smoothly as the content keeps growing", () => {
    const tops = [40_000, 40_100, 40_200, 40_300].map((sh) => dotTopForOffset(2_000, metrics(564, sh)));
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]!).toBeLessThanOrEqual(tops[i - 1]!);
      expect(tops[i - 1]! - tops[i]!).toBeLessThan(1);
    }
  });
});

describe("separateTops", () => {
  it("spaces a stack to the minimum gap, order preserved", () => {
    expect(separateTops([1, 5, 11, 17, 23], 600, MIN_DOT_GAP)).toEqual([1, 17, 33, 49, 65]);
  });

  it("keeps the tail inside the track", () => {
    expect(separateTops([590, 595, 599], 600, MIN_DOT_GAP)).toEqual([568, 584, 600]);
  });

  it("spreads evenly when the turns outnumber the available gaps", () => {
    expect(separateTops([0, 1, 2, 3, 4], 40, MIN_DOT_GAP)).toEqual([0, 10, 20, 30, 40]);
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

describe("projectMarks separation", () => {
  const clustered = [0, 250, 500, 750, 1000].map((offset, i) => ({
    turn: i + 1,
    text: `t${i + 1}`,
    offset,
  }));

  it("spaces the clustered dots of a long transcript instead of stacking them", () => {
    const tops = projectMarks(clustered, metrics(564, 95085)).map((m) => m.top);
    expect(tops).toEqual([0, 16, 32, 48, 64]);
    // Pre-fix this fixture produced [0, 1, 3, 4, 6]: a stack whose 15px hit pads
    // fully overlapped, so only the last turn in the DOM could be clicked.
    expect(tops).not.toEqual([0, 1, 3, 4, 6]);
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]! - tops[i - 1]!).toBeGreaterThanOrEqual(MIN_DOT_GAP - 1);
    }
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

  it("falls back to an ordered ladder while the transcript is too short to scroll", () => {
    thread.geom.scrollHeight = thread.geom.clientHeight;
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0, MIN_DOT_GAP]);
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

  it("follows content growth on the next frame instead of deferring it", () => {
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0, 200]);
    // The transcript grows below the second turn, as a streamed reply would.
    thread.geom.scrollHeight = 2000;
    fireResize();
    expect(dotTops()).toEqual([0, 100]);
  });

  it("never moves the dots when the transcript is scrolled", () => {
    render(<JumpBar messages={messages} threadEl={thread.el} />);
    expect(dotTops()).toEqual([0, 200]);
    // Scrolling shifts every rect, but not the turn's offset in the content.
    thread.geom.scrollTop = 250;
    thread.sync();
    fireResize();
    expect(dotTops()).toEqual([0, 200]);
  });
});
