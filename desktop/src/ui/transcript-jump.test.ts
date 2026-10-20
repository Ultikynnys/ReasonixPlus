// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPAND_EVENT,
  callAnchor,
  endJumpAlignment,
  jumpTargetFor,
  jumpToAnchor,
  noticeAnchor,
} from "./transcript-jump";

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

/** A scroller with two turns, a scrollTo spy and a write counter, so a test can
 *  tell a landing (one write) from a hold that keeps correcting. */
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
  const geom = { scrollTop: 0, writes: 0 };
  Object.defineProperty(el, "scrollTop", {
    get: () => geom.scrollTop,
    set: (value: number) => {
      geom.scrollTop = value;
      geom.writes += 1;
    },
  });
  Object.defineProperty(el, "scrollHeight", { get: () => content });
  Object.defineProperty(el, "clientHeight", { get: () => height });
  el.getBoundingClientRect = () => rectOf(0);
  const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    el.scrollTop = top ?? 0;
  });
  el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  /** Put a turn at a content offset; its viewport rect follows the scroll. */
  const place = (turn: number, offset: number) => {
    const node = turns.get(turn);
    if (!node) throw new Error(`no turn ${turn}`);
    node.getBoundingClientRect = () => rectOf(offset - geom.scrollTop);
  };
  /** Mount a card carrying a jump anchor at a content offset. `laidOut: false`
   *  reports the zero rect of a card inside a hidden subtree. */
  const placeCard = (anchor: string, offset: number, options: { laidOut?: boolean } = {}) => {
    let at = offset;
    const laidOut = options.laidOut ?? true;
    const mount = () => {
      const wrap = document.createElement("div");
      wrap.setAttribute("data-anchor", anchor);
      wrap.getBoundingClientRect = () =>
        laidOut ? rectOf(at - geom.scrollTop) : ({ ...rectOf(0), width: 0, height: 0 } as DOMRect);
      el.appendChild(wrap);
      return wrap;
    };
    let node = mount();
    return {
      /** The card opens (or its body finishes loading): it moves to `next`. */
      openAt: (next: number) => {
        at = next;
      },
      /** A re-render swaps the card for a fresh element sitting at `next`. */
      rerenderAt: (next: number) => {
        node.remove();
        at = next;
        node = mount();
      },
      /** The card goes away entirely (its gate resolved into something else). */
      remove: () => node.remove(),
    };
  };
  return { el, place, placeCard, scrollTo, geom };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** A transcript in the document, which is the only state the hold works in. */
function mountedThread(options: { height?: number; content?: number } = {}) {
  const thread = fakeThread(options);
  document.body.append(thread.el);
  return thread;
}

afterEach(() => {
  endJumpAlignment();
  document.body.replaceChildren();
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

describe("jumpToAnchor — turn targets", () => {
  it("brings the turn's top edge to the viewport top, at once", () => {
    const { el, place, scrollTo, geom } = fakeThread();
    place(2, 600);
    expect(jumpToAnchor(el, { turn: 2 })).toBe(true);
    // Instant, never animated: an animation is one more thing a later layout
    // change can cancel or outrun, and one click has to be enough.
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "instant" });
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

describe("jumpToAnchor — anchored cards", () => {
  it("lands on the event's own card, not on its turn's prompt", () => {
    // The bug this covers: every recorded event carried only a turn, so a plan,
    // choice or fold row always scrolled to the prompt bubble instead of itself.
    const { el, place, placeCard, scrollTo, geom } = fakeThread();
    place(1, 100);
    placeCard("call:c1", 900);
    expect(jumpToAnchor(el, { turn: 1, anchor: "call:c1" })).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "instant" });
    expect(geom.scrollTop).toBe(900);
  });

  it("lands on the card that answers to the record's other id", () => {
    // A plan row carries two ids: the gate's (what a reloaded transcript renders)
    // and the live wire's `tc-…`. A live session only has the second one mounted.
    const { el, place, placeCard, geom } = fakeThread();
    place(2, 600);
    placeCard("call:tc-7", 900);
    expect(
      jumpToAnchor(el, { turn: 2, anchor: "call:call-loop-7", anchorAlias: "call:tc-7" }),
    ).toBe(true);
    expect(geom.scrollTop).toBe(900);
  });

  it("prefers the primary id when the record's ids both resolve", () => {
    const { el, place, placeCard, geom } = fakeThread();
    place(2, 600);
    placeCard("call:call-loop-7", 900);
    placeCard("call:tc-7", 1_200);
    jumpToAnchor(el, { turn: 2, anchor: "call:call-loop-7", anchorAlias: "call:tc-7" });
    expect(geom.scrollTop).toBe(900);
  });

  it("falls back to the turn while the anchored card is gone", () => {
    const { el, place, placeCard, geom } = fakeThread();
    place(2, 600);
    placeCard("notice:n2", 100);
    expect(jumpToAnchor(el, { turn: 2, anchor: "notice:n1" })).toBe(true);
    expect(geom.scrollTop).toBe(600);
  });

  it("lands an anchored event that has no turn at all", () => {
    const { el, placeCard, geom } = fakeThread();
    placeCard("notice:n9", 300);
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
    const { el, place, placeCard, geom } = fakeThread();
    place(2, 600);
    placeCard("call:hidden", 0, { laidOut: false });
    expect(jumpToAnchor(el, { turn: 2, anchor: "call:hidden" })).toBe(true);
    expect(geom.scrollTop).toBe(600);
  });
});

describe("jumpToAnchor — holding the target", () => {
  const requests = () => {
    const seen: (readonly string[])[] = [];
    const onExpand = (event: Event) =>
      seen.push((event as CustomEvent<readonly string[]>).detail ?? []);
    document.addEventListener(EXPAND_EVENT, onExpand);
    return { seen, done: () => document.removeEventListener(EXPAND_EVENT, onExpand) };
  };

  it("asks the card a record names to open, and releases it on a plain-turn jump", () => {
    const { el, place, placeCard } = mountedThread();
    place(1, 100);
    placeCard("call:c1", 900);
    const expand = requests();

    jumpToAnchor(el, { turn: 1, anchor: "call:c1" });
    jumpToAnchor(el, { turn: 1 });

    expect(expand.seen).toEqual([["call:c1"], []]);
    expand.done();
  });

  it("offers every id a record carries, so the card that mounts answers one of them", () => {
    // The card this transcript renders answers to the alias, and a card that mounts
    // a commit later answers to whichever id its own segment minted: asking for both
    // at once covers either without guessing.
    const { el, place, placeCard } = mountedThread();
    place(2, 600);
    placeCard("call:tc-7", 900);
    const expand = requests();

    jumpToAnchor(el, { turn: 2, anchor: "call:call-loop-7", anchorAlias: "call:tc-7" });

    expect(expand.seen).toEqual([["call:call-loop-7", "call:tc-7"]]);
    expand.done();
  });

  it("re-pins the target when its card opens after the jump", async () => {
    // The card is a header at click time and its whole body a commit later, so a
    // jump that measured once would be high by exactly the body height.
    const { el, place, placeCard, geom } = mountedThread();
    place(1, 100);
    const card = placeCard("call:c1", 300);
    jumpToAnchor(el, { turn: 1, anchor: "call:c1" });
    expect(geom.scrollTop).toBe(300);

    card.openAt(900);
    await nextFrame();
    expect(geom.scrollTop).toBe(900);
  });

  it("switches to the card once it mounts", async () => {
    // A gate renders nothing until its args parse and its segment lands, so the
    // click falls back to the prompt bubble and the card appears a commit later.
    const { el, place, placeCard, geom } = mountedThread();
    place(1, 600);
    jumpToAnchor(el, { turn: 1, anchor: "call:c1" });
    expect(geom.scrollTop).toBe(600);

    placeCard("call:c1", 900);
    await nextFrame();
    expect(geom.scrollTop).toBe(900);
  });

  it("re-pins a target a re-render replaced", async () => {
    const { el, place, placeCard, geom } = mountedThread();
    place(1, 100);
    const card = placeCard("call:c1", 300);
    jumpToAnchor(el, { turn: 1, anchor: "call:c1" });

    card.rerenderAt(950);
    await nextFrame();
    expect(geom.scrollTop).toBe(950);
  });

  it("accumulates sub-pixel drift instead of dismissing each shift as noise", async () => {
    const { el, place, geom } = mountedThread();
    place(2, 600);
    jumpToAnchor(el, { turn: 2 });

    place(2, 600.6);
    await nextFrame();
    expect(geom.scrollTop).toBe(600);

    place(2, 601.2);
    await nextFrame();
    expect(geom.scrollTop).toBeCloseTo(601.2, 5);
  });

  it("leaves the viewport alone when the target has not moved", async () => {
    const { el, place, geom } = mountedThread();
    place(2, 600);
    jumpToAnchor(el, { turn: 2 });
    const landing = geom.writes;

    place(2, 600);
    await nextFrame();
    await nextFrame();
    expect(geom.writes).toBe(landing);
  });

  it("stops as soon as the reader takes over", async () => {
    const { el, place, geom } = mountedThread();
    place(2, 600);
    jumpToAnchor(el, { turn: 2 });

    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    place(2, 850);
    await nextFrame();
    expect(geom.scrollTop).toBe(600);
  });

  it("stops when the transcript goes away", async () => {
    const { el, place, geom } = mountedThread();
    place(2, 600);
    jumpToAnchor(el, { turn: 2 });

    el.remove();
    place(2, 850);
    await nextFrame();
    expect(geom.scrollTop).toBe(600);
  });

  it("gives the transcript to the newest jump", async () => {
    const { el, place, geom } = mountedThread();
    place(1, 100);
    place(2, 600);
    jumpToAnchor(el, { turn: 2 });
    jumpToAnchor(el, { turn: 1 });
    expect(geom.scrollTop).toBe(100);

    place(2, 850);
    await nextFrame();
    expect(geom.scrollTop).toBe(100);
  });
});

describe("anchor formats", () => {
  it("addresses a gate card by its tool call, and a fold by its notice", () => {
    expect(callAnchor("call-7")).toEqual({ anchor: "call:call-7" });
    expect(callAnchor(undefined)).toEqual({});
    expect(noticeAnchor("n-1")).toBe("notice:n-1");
  });
});
