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
  /** Mount a card carrying a jump anchor at a content offset. `open` renders the
   *  collapsible box a `Card` wraps its body in (either state), and `laidOut:
   *  false` reports the zero rect of a card inside a hidden subtree. */
  const placeCard = (
    anchor: string,
    offset: number,
    options: { open?: boolean; laidOut?: boolean } = {},
  ) => {
    let at = offset;
    const laidOut = options.laidOut ?? true;
    const mount = () => {
      const wrap = document.createElement("div");
      wrap.setAttribute("data-anchor", anchor);
      if (options.open !== undefined) {
        const box = document.createElement("div");
        box.setAttribute("data-open", String(options.open));
        wrap.appendChild(box);
      }
      wrap.getBoundingClientRect = () =>
        laidOut
          ? rectOf(at - geom.scrollTop)
          : ({ ...rectOf(0), width: 0, height: 0 } as DOMRect);
      el.appendChild(wrap);
      return wrap;
    };
    let node = mount();
    return {
      /** The card opens (or its body finishes loading): it moves to `next`. */
      openAt: (next: number) => {
        at = next;
        node.querySelector("[data-open]")?.setAttribute("data-open", "true");
      },
      /** A re-render swaps the card for a fresh element sitting at `next`. */
      rerenderAt: (next: number) => {
        node.remove();
        at = next;
        node = mount();
      },
    };
  };
  return { el, place, placeCard, scrollTo, geom };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Capture the callback the alignment watcher registers, so a test can report a
 *  relayout the way a browser would and jsdom never does. */
function stubResizeObserver() {
  const callbacks: ResizeObserverCallback[] = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(cb: ResizeObserverCallback) {
      callbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return {
    trigger: () => {
      for (const cb of callbacks) cb([], {} as ResizeObserver);
    },
    restore: () => {
      globalThis.ResizeObserver = original;
    },
  };
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
    const { el, place, placeCard, scrollTo, geom } = fakeThread();
    place(1, 100);
    placeCard("call:c1", 900);
    expect(jumpToAnchor(el, { turn: 1, anchor: "call:c1" })).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "smooth" });
    expect(geom.scrollTop).toBe(900);
  });

  it("falls back to the turn when the anchored card is gone", () => {
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

describe("anchor formats", () => {
  it("addresses a gate card by its tool call, and a fold by its notice", () => {
    expect(callAnchor("call-7")).toEqual({ anchor: "call:call-7" });
    expect(callAnchor(undefined)).toEqual({});
    expect(noticeAnchor("n-1")).toBe("notice:n-1");
  });
});

describe("jumpToAnchor — collapsed cards and late layout shifts", () => {
  afterEach(() => {
    endJumpAlignment();
    document.body.replaceChildren();
  });

  /** A transcript mounted like the real one: the alignment watcher only re-aligns
   *  a target that is still in the document. */
  const mountedThread = () => {
    const thread = fakeThread();
    document.body.append(thread.el);
    return thread;
  };

  it("opens a collapsed card first and measures after it opened", async () => {
    // A collapsed card is a header now and its whole body a commit later, so an
    // offset read before that commit lands high by exactly the body height.
    const { el, placeCard, scrollTo } = mountedThread();
    const card = placeCard("call:c1", 300, { open: false });
    const requested: (string | null)[] = [];
    const onExpand = (event: Event) => requested.push((event as CustomEvent<string | null>).detail);
    document.addEventListener(EXPAND_EVENT, onExpand);

    expect(jumpToAnchor(el, { turn: 1, anchor: "call:c1" })).toBe(true);
    expect(requested).toContain("call:c1");
    expect(scrollTo).not.toHaveBeenCalled();

    card.openAt(900);
    await nextFrame();
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "smooth" });
    document.removeEventListener(EXPAND_EVENT, onExpand);
  });

  it("re-resolves the card when a re-render replaces it before the frame lands", async () => {
    const { el, placeCard, geom } = mountedThread();
    const card = placeCard("call:c1", 300, { open: false });

    jumpToAnchor(el, { turn: 1, anchor: "call:c1" });
    // A gate resolving swaps the collapsed card for an expanded one further down.
    card.rerenderAt(950);
    await nextFrame();
    expect(geom.scrollTop).toBe(950);
  });

  it("leaves an expanded card's jump immediate", () => {
    const { el, placeCard, scrollTo } = mountedThread();
    placeCard("call:c1", 400, { open: true });

    expect(jumpToAnchor(el, { turn: 1, anchor: "call:c1" })).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 400, behavior: "smooth" });
  });

  it("reads the collapsed state off an approval card's own element", () => {
    // An `ApprovalCard` carries the anchor and `data-open` on the same node, a
    // `Card` on a wrapper around it. Both must be recognised as collapsed.
    const { el, scrollTo } = mountedThread();
    const card = document.createElement("div");
    card.setAttribute("data-anchor", "call:p1");
    card.setAttribute("data-open", "false");
    card.getBoundingClientRect = () => rectOf(300);
    el.appendChild(card);

    expect(jumpToAnchor(el, { turn: 1, anchor: "call:p1" })).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("re-aligns the target when a card above it opens after the jump", async () => {
    // `.thread` disables overflow anchoring, so nothing compensates on its own:
    // the target slides down by the growing card's height and stays there.
    const observer = stubResizeObserver();
    try {
      const { el, place, geom } = mountedThread();
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });
      expect(geom.scrollTop).toBe(600);

      place(2, 850);
      observer.trigger();
      await nextFrame();
      expect(geom.scrollTop).toBe(850);
    } finally {
      observer.restore();
    }
  });

  it("accumulates sub-pixel drift instead of dismissing each shift as noise", async () => {
    // Two relayouts under the epsilon must still land the target: the check is
    // against where the target belongs now, never against a remembered offset.
    const observer = stubResizeObserver();
    try {
      const { el, place, geom } = mountedThread();
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });

      place(2, 600.6);
      observer.trigger();
      await nextFrame();
      expect(geom.scrollTop).toBe(600);

      place(2, 601.2);
      observer.trigger();
      await nextFrame();
      expect(geom.scrollTop).toBeCloseTo(601.2, 5);
    } finally {
      observer.restore();
    }
  });

  it("leaves the viewport alone when only content below the target changed", async () => {
    const observer = stubResizeObserver();
    try {
      const { el, place, geom } = mountedThread();
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });

      // The tail grew or shrank: the target's own place in the content did not.
      observer.trigger();
      await nextFrame();
      expect(geom.scrollTop).toBe(600);
    } finally {
      observer.restore();
    }
  });

  it("stops re-aligning as soon as the reader takes over", async () => {
    const observer = stubResizeObserver();
    try {
      const { el, place, geom } = mountedThread();
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });

      window.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      place(2, 850);
      observer.trigger();
      await nextFrame();
      expect(geom.scrollTop).toBe(600);
    } finally {
      observer.restore();
    }
  });

  it("stops re-aligning when the target goes away", async () => {
    const observer = stubResizeObserver();
    try {
      const { el, place, geom } = mountedThread();
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });

      el.querySelector('[data-turn="2"]')?.remove();
      observer.trigger();
      await nextFrame();
      expect(geom.scrollTop).toBe(600);
    } finally {
      observer.restore();
    }
  });
});