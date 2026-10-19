import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

interface JumpBarProps {
  messages: { kind: string; text?: string; turn?: number }[];
  threadEl: HTMLElement | null;
  /** True while this tab is streaming a turn: the dots then re-measure every frame
   *  by construction, instead of waiting for a layout observer to settle. */
  busy?: boolean;
  /** Called just before a jump so a sticky-bottom follow cannot snap the viewport
   *  back to the bottom while the jump is in flight. */
  onJump?: () => void;
}

interface JumpTurn {
  turn: number;
  text: string;
}

interface JumpMark extends JumpTurn {
  /** Vertical offset (px) of the dot within the transcript's scrollbar track. */
  top: number;
}

interface JumpLayout {
  /** Box overlaid on the `.thread` scrollbar track. */
  track: { top: number; right: number; height: number };
  marks: JumpMark[];
  /** Turn offsets in content space, ascending with turn order: what the scroll
   *  position is compared against to decide the reader's position. */
  anchors: TurnAnchor[];
}

interface TurnAnchor extends JumpTurn {
  /** Vertical offset (px) of the turn within the scroll content. */
  offset: number;
}

/** Frames without growth before the sampler parks. Long enough to ride out a
 *  streamed token's pause, short enough to stop forcing layout once idle. */
const IDLE_FRAMES = 12;
/** Below this many turns there is nothing to navigate between. */
const MIN_TURNS = 2;
/** Chromium and WebKit clamp the native thumb to a platform minimum length that
 *  JS cannot read; assume it so a dot still lands under the thumb once a long
 *  transcript drives `clientHeight / scrollHeight * trackHeight` below it. */
export const MIN_THUMB_PX = 20;
/** Minimum gap between dots. One dot's invisible hit pad is 15px tall, so a
 *  tighter stack lets the top-most dot swallow its neighbours' clicks. */
export const MIN_DOT_GAP = 16;
/** Past this many viewports a smooth scroll takes seconds and any arriving token
 *  can interrupt it, so the jump lands at once instead. */
const JUMP_SMOOTH_MAX_VIEWPORTS = 3;
/** How long a jump holds the marker on the clicked turn while a smooth scroll
 *  passes over the turns in between. */
const JUMP_MARKER_LOCK_MS = 600;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** The `[data-turn]` wrapper for a turn, or null while it is not mounted. */
function findTurn(threadEl: HTMLElement, turn: number): HTMLElement | null {
  return threadEl.querySelector<HTMLElement>(`[data-turn="${turn}"]`);
}

/** Scroll geometry the dots are projected onto. The track box spans the
 *  scroller's padding box, so `trackHeight` and `clientHeight` hold the same
 *  number here; both are carried because the thumb length follows the viewport
 *  while the travel range follows the track. */
export interface TrackMetrics {
  /** Track length in px. */
  trackHeight: number;
  /** Scroll content height. */
  scrollHeight: number;
  /** Viewport height of the scroller. */
  clientHeight: number;
}

/** Read the track metrics from the live scroller: the single place the geometry
 *  is sampled, so the dots, the click target and the tests cannot drift apart. */
export function trackMetrics(el: HTMLElement): TrackMetrics {
  return {
    trackHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  };
}

/** Longest possible scrollTop; 0 when the transcript cannot scroll. */
export function maxScrollTop(metrics: TrackMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

/** Native thumb length, including the browser's minimum-length clamp. */
export function thumbLength(metrics: TrackMetrics): number {
  const proportional = (metrics.clientHeight / metrics.scrollHeight) * metrics.trackHeight;
  return clamp(proportional, MIN_THUMB_PX, metrics.trackHeight);
}

/** Where the thumb's top edge sits for a given scrollTop. */
export function thumbTopForScrollTop(scrollTop: number, metrics: TrackMetrics): number {
  const max = maxScrollTop(metrics);
  if (max <= 0) return 0;
  const travel = Math.max(0, metrics.trackHeight - thumbLength(metrics));
  return (clamp(scrollTop, 0, max) / max) * travel;
}

/** The scrollTop that brings a turn's top edge to the viewport top. */
export function scrollTopForOffset(offset: number, metrics: TrackMetrics): number {
  return clamp(offset, 0, maxScrollTop(metrics));
}

/** A dot's y: exactly where the thumb lands once that turn is jumped to, so the
 *  click moves the thumb onto the dot and it stays there as content grows. */
export function dotTopForOffset(offset: number, metrics: TrackMetrics): number {
  return thumbTopForScrollTop(scrollTopForOffset(offset, metrics), metrics);
}

/** Spread dots into a readable ladder, order preserved: a forward pass drops
 *  each dot `minGap` below its predecessor, a backward pass keeps the tail
 *  inside the track, and a set too dense to fit shares the track evenly (a turn
 *  count that high cannot be told apart at any spacing). */
export function separateTops(
  tops: readonly number[],
  trackHeight: number,
  minGap: number,
): number[] {
  const out = tops.map((top) => clamp(top, 0, trackHeight));
  for (let i = 1; i < out.length; i += 1) {
    out[i] = Math.max(out[i]!, out[i - 1]! + minGap);
  }
  if (out.length > 0 && out[out.length - 1]! > trackHeight) {
    out[out.length - 1] = trackHeight;
    for (let i = out.length - 2; i >= 0; i -= 1) {
      out[i] = Math.min(out[i]!, out[i + 1]! - minGap);
    }
  }
  if (out.some((top) => top < 0)) {
    const step = trackHeight / Math.max(1, out.length - 1);
    for (let i = 0; i < out.length; i += 1) out[i] = i * step;
  }
  return out;
}

/** The turn the reader is currently at: the last one whose top has passed the
 *  viewport top, falling back to the first turn above it. */
export function activeTurnFor(
  scrollTop: number,
  anchors: readonly TurnAnchor[],
): number | null {
  let active: number | null = null;
  for (const anchor of anchors) {
    if (anchor.offset > scrollTop + 1) break;
    active = anchor.turn;
  }
  return active ?? anchors[0]?.turn ?? null;
}

/** Project each turn onto the scrollbar track: a dot marks the spot the thumb
 *  reaches when that turn is scrolled to, then the dots are separated so each
 *  one stays individually reachable. Rounded to whole pixels so sub-pixel wobble
 *  cannot invent a new position; pure, so it is testable without a DOM. */
export function projectMarks(anchors: readonly TurnAnchor[], metrics: TrackMetrics): JumpMark[] {
  if (anchors.length === 0 || metrics.trackHeight <= 0 || metrics.scrollHeight <= 0) return [];
  const tops = separateTops(
    anchors.map((anchor) => dotTopForOffset(anchor.offset, metrics)),
    metrics.trackHeight,
    MIN_DOT_GAP,
  );
  return anchors.map((anchor, i) => ({
    turn: anchor.turn,
    text: anchor.text,
    top: Math.round(tops[i]!),
  }));
}

/** True when a re-projection would leave every dot exactly where it already is. */
function sameLayout(prev: JumpLayout | null, next: JumpLayout): boolean {
  if (!prev) return false;
  if (
    prev.track.top !== next.track.top ||
    prev.track.right !== next.track.right ||
    prev.track.height !== next.track.height ||
    prev.marks.length !== next.marks.length ||
    prev.anchors.length !== next.anchors.length
  ) {
    return false;
  }
  const sameMarks = prev.marks.every((mark, i) => {
    const other = next.marks[i]!;
    return mark.turn === other.turn && mark.top === other.top;
  });
  // Anchors decide the "you are here" marker, so an offset drift the rounded
  // marks hide must still refresh them.
  const sameAnchors = prev.anchors.every((anchor, i) => {
    const other = next.anchors[i]!;
    return anchor.turn === other.turn && anchor.offset === other.offset;
  });
  return sameMarks && sameAnchors;
}

/** Measure the transcript and turn each user turn into a dot position. Split
 *  from the render path so the component stays a plain layout-to-markup map. */
function useJumpLayout(
  threadEl: HTMLElement | null,
  barRef: RefObject<HTMLDivElement | null>,
  items: readonly JumpTurn[],
  busy: boolean,
): JumpLayout | null {
  const [layout, setLayout] = useState<JumpLayout | null>(null);
  // Turns are append-only, so their joined numbers identify the turn SET. The
  // effect keys on this rather than `items`, whose array identity changes on
  // every streamed token even though the user turns are unchanged.
  const turnsKey = useMemo(() => items.map((m) => m.turn).join(","), [items]);
  // A settled re-projection runs a tick later than the render that scheduled it,
  // where the effect's own closure would already hold a stale list.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Overlay the transcript's scrollbar and read each turn's offset from its
  // `[data-turn]` element. Offsets are read in content space (scrollTop added
  // back), so they hold no matter where the transcript happens to be scrolled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: turn set change; list via itemsRef
  useLayoutEffect(() => {
    if (!threadEl) {
      setLayout(null);
      return;
    }
    let frame = 0;
    let lastScrollHeight = -1;
    let stillFrames = 0;
    let running = false;

    const measure = () => {
      const metrics = trackMetrics(threadEl);
      const turns = itemsRef.current;
      if (turns.length < MIN_TURNS || metrics.trackHeight <= 0 || metrics.scrollHeight <= 0) {
        setLayout(null);
        return;
      }
      const rect = threadEl.getBoundingClientRect();
      const parentRect = barRef.current?.offsetParent?.getBoundingClientRect();
      const anchors = turns.flatMap(({ turn, text }) => {
        const el = findTurn(threadEl, turn);
        if (!el) return [];
        // A rect moves with scrollTop; adding it back reads the turn's offset in
        // the content, which is the coordinate the scrollbar maps.
        const offset = el.getBoundingClientRect().top - rect.top + threadEl.scrollTop;
        return [{ turn, text, offset }];
      });
      const next: JumpLayout = {
        track: {
          top: Math.round(parentRect ? rect.top - parentRect.top : threadEl.offsetTop),
          right: Math.round(parentRect ? parentRect.right - rect.right : 0),
          height: Math.round(metrics.trackHeight),
        },
        marks: projectMarks(anchors, metrics),
        anchors,
      };
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    };

    // A live turn re-measures every frame by construction: the deferred
    // re-projection this replaced is what made the dots land in whole-tens-of-pixels
    // steps, and waiting for observer notifications instead would tie the dots to
    // whenever the layout happens to settle. When idle the sampler parks a few
    // frames after growth stops, and the observers below restart it for growth that
    // lands later (an image loading, a late reflow).
    const tick = () => {
      frame = 0;
      const scrollHeight = threadEl.scrollHeight;
      if (busy || scrollHeight !== lastScrollHeight) {
        lastScrollHeight = scrollHeight;
        stillFrames = 0;
        measure();
      } else {
        stillFrames += 1;
        if (stillFrames > IDLE_FRAMES) {
          running = false;
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    let ro: ResizeObserver | null = null;

    // Re-observe on every start: a tab remount replaces `.thread-inner`, and a
    // detached node stops reporting the growth the idle path relies on.
    const observe = () => {
      if (!ro) return;
      // Every child, not just the first: growth can land in any of them.
      ro.observe(threadEl);
      for (const child of threadEl.children) ro.observe(child);
    };

    const startSampling = () => {
      observe();
      if (running) return;
      running = true;
      lastScrollHeight = -1;
      stillFrames = 0;
      frame = requestAnimationFrame(tick);
    };

    ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(startSampling) : null;
    // A structural change (a turn appended, the inner subtree remounted) can leave
    // the observed nodes detached, after which the resize observer never fires again.
    const mo =
      typeof MutationObserver !== "undefined" ? new MutationObserver(startSampling) : null;
    mo?.observe(threadEl, { childList: true });
    startSampling();
    window.addEventListener("resize", startSampling);
    return () => {
      running = false;
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener("resize", startSampling);
    };
  }, [threadEl, turnsKey, busy]);

  return layout;
}

/** One dot per user turn, overlaid on the transcript's native scrollbar. A dot
 *  sits where the thumb reaches when its turn is scrolled to, and is only
 *  re-projected once the layout settles: never on scroll, so jumps stay put. */
export function JumpBar({ messages, threadEl, busy = false, onJump }: JumpBarProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const seen = new Set<number>();
    return messages.flatMap((m) => {
      if (m.kind !== "user" || typeof m.text !== "string" || typeof m.turn !== "number") {
        return [];
      }
      // A replayed or regenerated turn can arrive twice; duplicate keys would let
      // two dots swap places under each other.
      if (seen.has(m.turn)) return [];
      seen.add(m.turn);
      return [{ turn: m.turn, text: m.text.slice(0, 80) }];
    });
  }, [messages]);
  const layout = useJumpLayout(threadEl, barRef, items, busy);
  // The measure closure runs a tick after the render that scheduled it, so its
  // anchors are read through a ref rather than from a stale render value.
  const anchorsRef = useRef<TurnAnchor[]>([]);
  anchorsRef.current = layout?.anchors ?? [];
  // A jump states the user's intent: hold the marker on the clicked turn while a
  // smooth scroll passes over the turns in between.
  const jumpLockRef = useRef(0);

  const deriveActive = useCallback(() => {
    const el = threadEl;
    if (!el || performance.now() < jumpLockRef.current) return;
    const next = activeTurnFor(el.scrollTop, anchorsRef.current);
    setActive((prev) => (prev === next ? prev : next));
  }, [threadEl]);

  // "You are here" is the reader's position, not the newest turn, so a newly
  // streaming turn cannot drag the marker away from what is being read.
  useEffect(() => {
    const el = threadEl;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        deriveActive();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [threadEl, deriveActive]);

  // Growth above the reading position moves every anchor without a scroll event.
  const anchorsKey = anchorsRef.current.map((a) => `${a.turn}:${a.offset}`).join(",");
  useEffect(() => {
    deriveActive();
  }, [deriveActive, anchorsKey]);

  if (items.length < MIN_TURNS) return null;

  const track = layout?.track ?? null;
  const marks = layout?.marks ?? [];

  const scrollTo = (turn: number) => {
    setActive(turn);
    jumpLockRef.current = performance.now() + JUMP_MARKER_LOCK_MS;
    const el = threadEl;
    if (!el) return;
    const target = findTurn(el, turn);
    if (!target) return;
    // Read the turn's content offset at click time: a streamed answer below it
    // moves the scroll range, not the turn.
    const offset =
      target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const targetScrollTop = scrollTopForOffset(offset, trackMetrics(el));
    onJump?.();
    const far =
      Math.abs(targetScrollTop - el.scrollTop) > el.clientHeight * JUMP_SMOOTH_MAX_VIEWPORTS;
    el.scrollTo({ top: targetScrollTop, behavior: far ? "instant" : "smooth" });
  };

  const hoveredMark = hovered !== null ? marks.find((m) => m.turn === hovered) : undefined;

  return (
    <div
      className="jump-bar"
      ref={barRef}
      style={track ? { top: track.top, right: track.right, height: track.height } : undefined}
    >
      {marks.map((mark) => {
        const isHovered = hovered === mark.turn;
        const isActive = active === mark.turn;
        return (
          <button
            type="button"
            key={mark.turn}
            className="jump-dot"
            data-turn={mark.turn}
            data-hover={isHovered ? "" : undefined}
            data-active={isActive ? "" : undefined}
            style={{ top: mark.top }}
            onMouseEnter={() => setHovered(mark.turn)}
            onMouseLeave={() => setHovered((h) => (h === mark.turn ? null : h))}
            onClick={() => scrollTo(mark.turn)}
            aria-label={mark.text}
          />
        );
      })}
      {hoveredMark ? (
        <div className="jump-preview" style={{ top: hoveredMark.top }}>
          <span className="jump-text">{hoveredMark.text}</span>
        </div>
      ) : null}
    </div>
  );
}
