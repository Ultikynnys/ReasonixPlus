import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

interface JumpBarProps {
  messages: { kind: string; text?: string; turn?: number }[];
  threadEl: HTMLElement | null;
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
}

interface TurnAnchor extends JumpTurn {
  /** Vertical offset (px) of the turn within the scroll content. */
  offset: number;
}

/** Content must stay quiet this long before the dots are re-projected, so a
 *  streaming turn, or an image that lands after a jump, cannot drag them. */
export const SETTLE_MS = 150;
/** Cap on that deferral: a continuously growing transcript is still refreshed. */
const MAX_DEFER_MS = 1200;
/** Below this many turns there is nothing to navigate between. */
const MIN_TURNS = 2;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** The `[data-turn]` wrapper for a turn, or null while it is not mounted. */
function findTurn(threadEl: HTMLElement, turn: number): HTMLElement | null {
  return threadEl.querySelector<HTMLElement>(`[data-turn="${turn}"]`);
}

/** Project each turn onto the scrollbar track: a dot marks the spot the thumb
 *  reaches when that turn is scrolled to. Rounded to whole pixels so sub-pixel
 *  wobble cannot invent a new position; pure, so it is testable without a DOM. */
export function projectMarks(
  anchors: readonly TurnAnchor[],
  trackHeight: number,
  scrollHeight: number,
): JumpMark[] {
  if (trackHeight <= 0 || scrollHeight <= 0) return [];
  // A transcript that does not overflow has no scroll range to be proportional
  // to, so its turns fall back to evenly spaced slots.
  const spaced = scrollHeight <= trackHeight + 1;
  const place = (anchor: TurnAnchor, i: number): number =>
    spaced
      ? (trackHeight * (i + 0.5)) / anchors.length
      : clamp((anchor.offset / scrollHeight) * trackHeight, 0, trackHeight);
  return anchors.map((anchor, i) => ({
    turn: anchor.turn,
    text: anchor.text,
    top: Math.round(place(anchor, i)),
  }));
}

/** True when a re-projection would leave every dot exactly where it already is. */
function sameLayout(prev: JumpLayout | null, next: JumpLayout): boolean {
  if (!prev) return false;
  if (
    prev.track.top !== next.track.top ||
    prev.track.right !== next.track.right ||
    prev.track.height !== next.track.height ||
    prev.marks.length !== next.marks.length
  ) {
    return false;
  }
  return prev.marks.every((mark, i) => {
    const other = next.marks[i]!;
    return mark.turn === other.turn && mark.top === other.top;
  });
}

/** Measure the transcript and turn each user turn into a dot position. Split
 *  from the render path so the component stays a plain layout-to-markup map. */
function useJumpLayout(
  threadEl: HTMLElement | null,
  barRef: RefObject<HTMLDivElement | null>,
  items: readonly JumpTurn[],
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
  // Re-projection waits for the content to settle, because growth (a streamed
  // turn, an image that lands after a jump) would otherwise drag every dot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: turn set change; list via itemsRef
  useLayoutEffect(() => {
    if (!threadEl) {
      setLayout(null);
      return;
    }
    let frame = 0;
    let framePending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deferredSince = 0;
    let drawn = false;

    const measure = () => {
      const trackHeight = threadEl.clientHeight;
      const scrollHeight = threadEl.scrollHeight;
      const turns = itemsRef.current;
      if (turns.length < MIN_TURNS || trackHeight <= 0 || scrollHeight <= 0) {
        drawn = false;
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
          height: Math.round(trackHeight),
        },
        marks: projectMarks(anchors, trackHeight, scrollHeight),
      };
      drawn = true;
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    };

    const measureNextFrame = () => {
      if (framePending) return;
      framePending = true;
      frame = requestAnimationFrame(() => {
        framePending = false;
        frame = 0;
        measure();
      });
    };

    /** Coalesce layout noise into one measure, taken once the content settles. */
    const measureWhenSettled = () => {
      if (!drawn) {
        measureNextFrame();
        return;
      }
      const now = performance.now();
      if (deferredSince === 0) deferredSince = now;
      if (timer !== undefined) clearTimeout(timer);
      if (now - deferredSince >= MAX_DEFER_MS) {
        deferredSince = 0;
        measureNextFrame();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        deferredSince = 0;
        measureNextFrame();
      }, SETTLE_MS);
    };

    // The turn set changed (or the overlay just appeared), so the dots on screen
    // no longer describe this transcript: place them without waiting.
    measureNextFrame();

    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measureWhenSettled) : null;
    if (ro) {
      // Watch every child: growth can land in any of them, not just the first.
      ro.observe(threadEl);
      for (const child of threadEl.children) ro.observe(child);
    }
    window.addEventListener("resize", measureWhenSettled);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      ro?.disconnect();
      window.removeEventListener("resize", measureWhenSettled);
    };
  }, [threadEl, turnsKey]);

  return layout;
}

/** One dot per user turn, overlaid on the transcript's native scrollbar. A dot
 *  sits where the thumb reaches when its turn is scrolled to, and is only
 *  re-projected once the layout settles: never on scroll, so jumps stay put. */
export function JumpBar({ messages, threadEl }: JumpBarProps) {
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
  const lastTurn = items.length > 0 ? items[items.length - 1]!.turn : null;
  const layout = useJumpLayout(threadEl, barRef, items);

  // The newest turn is the "you are here" marker.
  useEffect(() => {
    if (lastTurn !== null) setActive(lastTurn);
  }, [lastTurn]);

  if (items.length < MIN_TURNS) return null;

  const track = layout?.track ?? null;
  const marks = layout?.marks ?? [];

  const scrollTo = (turn: number) => {
    setActive(turn);
    if (!threadEl) return;
    findTurn(threadEl, turn)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
