// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { callAnchor, jumpTargetFor, jumpToAnchor, noticeAnchor } from "./transcript-jump";

const rectOf = (top: number): DOMRect =>
  ({
    top,
    bottom: top + 10,
    left: 0,
    right: 100,
    width: 100,
    height: 10,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/** A scroller with two turns at fixed content offsets and a scrollTo spy. */
function fakeThread(options: { height?: number; content?: number } = {}) {
  const height = options.height ?? 400;
  const content = options.content ?? 2_000;
  const el = document.createElement("div");
  const turns = new Map<number, HTMLElement>();
  for (const turn of [1, 2]) {
    const node = document.createElement("div");
    node.setAttribute("data-turn", String(turn));
    el.appendChild(node);
    turns.set(turn, node);
  }
  const geom = { scrollTop: 0 };
  Object.defineProperty(el, "scrollTop", {
    get: () => geom.scrollTop,
    set: (value: number) => {
      geom.scrollTop = value;
    },
  });
  Object.defineProperty(el, "scrollHeight", { get: () => content });
  Object.defineProperty(el, "clientHeight", { get: () => height });
  el.getBoundingClientRect = () => rectOf(0);
  const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    geom.scrollTop = top ?? 0;
  });
  el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  /** Put a turn at a content offset; its viewport rect follows the scroll. */
  const place = (turn: number, offset: number) => {
    const node = turns.get(turn);
    if (!node) throw new Error(`no turn ${turn}`);
    node.getBoundingClientRect = () => rectOf(offset - geom.scrollTop);
  };
  /** Add a card carrying a jump anchor at a content offset. */
  const placeAnchor = (anchor: string, offset: number, laidOut = true) => {
    const node = document.createElement("div");
    node.setAttribute("data-anchor", anchor);
    node.getBoundingClientRect = () =>
      laidOut ? rectOf(offset - geom.scrollTop) : ({ ...rectOf(0), width: 0, height: 0 } as DOMRect);
    el.appendChild(node);
  };
  return { el, place, placeAnchor, scrollTo, geom };
}

describe("jumpTargetFor", () => {
  it("clamps a jump target to the reachable scroll range", () => {
    expect(jumpTargetFor(9000, 1000, 564)).toBe(436);
    expect(jumpTargetFor(100, 1000, 564)).toBe(100);
  });

  it("targets the top while the transcript cannot scroll", () => {
    expect(jumpTargetFor(500, 400, 400)).toBe(0);
  });
});

describe("jumpToAnchor — turn targets", () => {
  it("brings the turn's top edge to the viewport top", () => {
    const { el, place, scrollTo, geom } = fakeThread();
    place(2, 600);
    expect(jumpToAnchor(el, { turn: 2 })).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "smooth" });
    expect(geom.scrollTop).toBe(600);
  });

  it("reads the turn's offset at jump time, not from a cached layout", () => {
    const { el, place, geom } = fakeThread();
    place(2, 600);
    geom.scrollTop = 200;
    place(2, 600);
    jumpToAnchor(el, { turn: 2 });
    expect(geom.scrollTop).toBe(600);
  });

  it("lands at once when the turn is many viewports away", () => {
    const { el, place, scrollTo } = fakeThread({ content: 10_000 });
    place(2, 9_000);
    jumpToAnchor(el, { turn: 2 });
    // A smooth scroll over thousands of pixels takes seconds and any arriving
    // token interrupts it, so a far jump is instant.
    expect(scrollTo).toHaveBeenCalledWith({ top: 9_000, behavior: "instant" });
  });

  it("clamps a turn near the end to the last reachable scroll position", () => {
    const { el, place, geom } = fakeThread();
    place(2, 1_900);
    jumpToAnchor(el, { turn: 2 });
    expect(geom.scrollTop).toBe(1_600);
  });

  it("reports a missing turn instead of scrolling somewhere else", () => {
    const { el, scrollTo } = fakeThread();
    expect(jumpToAnchor(el, { turn: 9 })).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("reports a missing scroller and a non-turn instead of throwing", () => {
    const { el } = fakeThread();
    expect(jumpToAnchor(null, { turn: 1 })).toBe(false);
    expect(jumpToAnchor(el, { turn: 0 })).toBe(false);
    expect(jumpToAnchor(el, { turn: Number.NaN })).toBe(false);
  });
});

describe("jumpToAnchor", () => {
  it("lands on the event's own card, not on its turn's prompt", () => {
    // The bug this covers: every recorded event carried only a turn, so a plan,
    // choice or fold row always scrolled to the prompt bubble instead of itself.
    const { el, place, placeAnchor, scrollTo, geom } = fakeThread();
    place(1, 100);
    placeAnchor("call:c1", 900);
    expect(jumpToAnchor(el, { turn: 1, anchor: "call:c1" })).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "smooth" });
    expect(geom.scrollTop).toBe(900);
  });

  it("falls back to the turn when the anchored card is gone", () => {
    const { el, place, placeAnchor, geom } = fakeThread();
    place(2, 600);
    placeAnchor("notice:n2", 100);
    expect(jumpToAnchor(el, { turn: 2, anchor: "notice:n1" })).toBe(true);
    expect(geom.scrollTop).toBe(600);
  });

  it("lands an anchored event that has no turn at all", () => {
    const { el, placeAnchor, geom } = fakeThread();
    placeAnchor("notice:n9", 300);
    expect(jumpToAnchor(el, { turn: 0, anchor: "notice:n9" })).toBe(true);
    expect(geom.scrollTop).toBe(300);
  });

  it("reports a target that is nowhere instead of scrolling somewhere else", () => {
    const { el, scrollTo } = fakeThread();
    expect(jumpToAnchor(el, { turn: 0, anchor: "call:gone" })).toBe(false);
    expect(jumpToAnchor(null, { turn: 1 })).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not land on a card that is mounted but not laid out", () => {
    // A card in a hidden subtree reports a zero rect; scrolling to it would land
    // at the transcript top and still report success.
    const { el, place, placeAnchor, geom } = fakeThread();
    place(2, 600);
    placeAnchor("call:hidden", 0, false);
    expect(jumpToAnchor(el, { turn: 2, anchor: "call:hidden" })).toBe(true);
    expect(geom.scrollTop).toBe(600);
  });
});

describe("anchor formats", () => {
  it("addresses a gate card by its tool call, and a fold by its notice", () => {
    expect(callAnchor("call-7")).toEqual({ anchor: "call:call-7" });
    expect(callAnchor(undefined)).toEqual({});
    expect(noticeAnchor("n-1")).toBe("notice:n-1");
  });
});