import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/** What the jump map is allowed to read: the written conversation and when each
 *  record was written. No layout, no viewport, no scroll position. */
export interface JumpMessage {
  kind: string;
  text?: string;
  turn?: number;
  /** When this record was written (epoch ms). Messages without one fall back to
   *  their position in the conversation. */
  ts?: number;
}

interface JumpBarProps {
  messages: JumpMessage[];
  threadEl: HTMLElement | null;
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

/** A turn plus its place on the conversation's timeline. */
export interface TurnSpan extends JumpTurn {
  /** Stamp of the turn's record, or its index when records carry no stamps. */
  at: number;
}

/** The conversation's timeline: one span per user turn, plus the stamps the track
 *  is stretched between. */
export interface ConversationSpan {
  turns: TurnSpan[];
  /** Stamp of the first written record (index 0 when unstamped). */
  start: number;
  /** Stamp of the last written record (last index when unstamped). */
  end: number;
}

/** Box overlaid on the `.thread` scrollbar track, plus the band the dots may use:
 *  the chevrons sit at the track's ends, so a dot there would land on a button. */
interface TrackBox {
  top: number;
  right: number;
  height: number;
  /** Reserved at the top and bottom, measured to the chevrons' inner edges. */
  insetTop: number;
  insetBottom: number;
}

interface TurnAnchor extends JumpTurn {
  /** Vertical offset (px) of the turn within the scroll content. */
  offset: number;
}

/** Below this many turns there is nothing to navigate between. */
const MIN_TURNS = 2;
/** Minimum gap between dots. One dot's invisible hit pad is 15px tall, so a
 *  tighter stack lets the top-most dot swallow its neighbours' clicks. */
export const MIN_DOT_GAP = 16;
/** Half a dot plus a hair: a dot is centred on its y, so the end dots must start
 *  this far inside the band to stay clear of the chevrons. */
const DOT_CLEARANCE = 3;
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

/** The record's stamp, or null when it has none (a pre-upgrade transcript). */
function stampOf(message: JumpMessage): number | null {
  const { ts } = message;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

/** Build the conversation's timeline. Stamped records are placed by when they
 *  were written; a transcript with any unstamped record is placed by position
 *  instead, so old logs stay ordered and stable rather than half-mapped. */
export function conversationSpans(messages: readonly JumpMessage[]): ConversationSpan {
  const stamped = messages.length > 0 && messages.every((m) => stampOf(m) !== null);
  const seen = new Set<number>();
  const turns: TurnSpan[] = [];
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  messages.forEach((message, index) => {
    const stamp = stampOf(message);
    // One unit per transcript: a log where ANY record is unstamped is placed by
    // position, so stamps and indices never mix inside one span.
    const at = stamped && stamp !== null ? stamp : index;
    earliest = Math.min(earliest, at);
    latest = Math.max(latest, at);
    const { kind, text, turn } = message;
    if (kind !== "user" || typeof text !== "string" || typeof turn !== "number") return;
    // A replayed or regenerated turn can arrive twice; duplicate keys would let
    // two dots swap places under each other.
    if (seen.has(turn)) return;
    seen.add(turn);
    turns.push({ turn, text: text.slice(0, 80), at });
  });
  // The first turn anchors the top of the track, not the first record: a session can
  // open with a notice or a card, and the first dot must still sit at 0. Both ends
  // come from every record, so a reordered log cannot clamp a dot onto an edge.
  const firstTurn = turns.reduce((low, turn) => Math.min(low, turn.at), Number.POSITIVE_INFINITY);
  const start = Number.isFinite(firstTurn) ? firstTurn : earliest;
  const end = Math.max(latest, start);
  return {
    turns,
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : 0,
  };
}
/** A dot's y: the turn's place on the timeline, from the start of the conversation
 *  (0, the top of the track) to its end (trackHeight, the bottom). */
export function markTopFor(at: number, start: number, end: number, trackHeight: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (trackHeight <= 0 || end <= start) return 0;
  return ((clamp(at, start, end) - start) / (end - start)) * trackHeight;
}

/** Enforce the clickability floor without discarding the stamps' own spacing: a dot
 *  holds its timestamp position unless a neighbour would sit closer than `minGap`,
 *  in which case the later one gives way. Only when the floor cannot fit at all is
 *  it shrunk to the largest gap the track holds, never traded for a uniform ladder. */
export function separateTops(
  tops: readonly number[],
  trackHeight: number,
  minGap: number,
): number[] {
  if (tops.length === 0) return [];
  // A collapsed track has nowhere to separate dots; pin them all rather than emit
  // negative positions the caller would have to sanitise.
  if (trackHeight <= 0) return tops.map(() => 0);
  // n dots leave n-1 gaps: a floor taller than that is physically unreachable.
  const gap = Math.min(minGap, trackHeight / Math.max(1, tops.length - 1));
  const out = tops.map((top) => (Number.isFinite(top) ? clamp(top, 0, trackHeight) : 0));
  // Forward: a later dot is nudged down to clear its predecessor; an earlier dot
  // never moves above what its stamp says.
  for (let i = 1; i < out.length; i += 1) {
    out[i] = Math.max(out[i]!, out[i - 1]! + gap);
  }
  // Backward: the overflow is paid by pulling the packed tail up, so the first dot
  // stays on the top edge and the gaps keep their order.
  if (out[out.length - 1]! > trackHeight) {
    out[out.length - 1] = trackHeight;
    for (let i = out.length - 2; i >= 0; i -= 1) {
      out[i] = Math.min(out[i]!, out[i + 1]! - gap);
    }
  }
  return out;
}

/** The turn the reader is currently at: the last one whose top has passed the
 *  viewport top, falling back to the first turn above it. */
export function activeTurnFor(scrollTop: number, anchors: readonly TurnAnchor[]): number | null {
  let active: number | null = null;
  for (const anchor of anchors) {
    if (anchor.offset > scrollTop + 1) break;
    active = anchor.turn;
  }
  return active ?? anchors[0]?.turn ?? null;
}

/** Project the timeline onto the track: one dot per user turn at its place in the
 *  conversation, then the clickability gap. Rounded to whole pixels so sub-pixel
 *  wobble cannot invent a position; pure, so it is testable without a DOM. */
export function projectMarks(span: ConversationSpan, trackHeight: number): JumpMark[] {
  const { turns, start, end } = span;
  if (turns.length === 0 || trackHeight <= 0) return [];
  // A timeline with no room between its ends (one record, or a whole burst in the
  // same millisecond) cannot be distinguished by stamp, so share the track evenly.
  const spread = (index: number): number => (index / Math.max(1, turns.length - 1)) * trackHeight;
  const tops = separateTops(
    turns.map((turn, index) =>
      end > start ? markTopFor(turn.at, start, end, trackHeight) : spread(index),
    ),
    trackHeight,
    MIN_DOT_GAP,
  );
  return turns.map((turn, index) => ({
    turn: turn.turn,
    text: turn.text,
    top: Math.round(tops[index]!),
  }));
}

/** The scrollTop that brings a turn's top edge to the viewport top. */
export function jumpTargetFor(offset: number, scrollHeight: number, clientHeight: number): number {
  return clamp(offset, 0, Math.max(0, scrollHeight - clientHeight));
}

/** Content-space offset of each turn: a rect moves with the scroll, so scrollTop
 *  is added back to read the coordinate the active marker is derived from. */
function measureAnchors(threadEl: HTMLElement, turns: readonly JumpTurn[]): TurnAnchor[] {
  const rect = threadEl.getBoundingClientRect();
  return turns.flatMap(({ turn, text }) => {
    const el = findTurn(threadEl, turn);
    if (!el) return [];
    return [{ turn, text, offset: el.getBoundingClientRect().top - rect.top + threadEl.scrollTop }];
  });
}

/** How much of the track's ends belongs to the jump-to-top / jump-to-bottom
 *  chevrons: the dots map between the buttons, never under them. */
function chevronInsets(
  threadEl: HTMLElement,
  rect: DOMRect,
  height: number,
): Pick<TrackBox, "insetTop" | "insetBottom"> {
  const buttons = threadEl.parentElement?.querySelectorAll<HTMLElement>(".thread-scroll-btn");
  const first = buttons?.[0]?.getBoundingClientRect();
  const last = buttons?.[buttons.length - 1]?.getBoundingClientRect();
  // Half the track each, at most: a mis-measured button cannot eat the whole band.
  const cap = Math.max(DOT_CLEARANCE, height / 2);
  return {
    insetTop: first ? clamp(Math.max(0, first.bottom - rect.top) + DOT_CLEARANCE, 0, cap) : 0,
    insetBottom: last ? clamp(Math.max(0, rect.bottom - last.top) + DOT_CLEARANCE, 0, cap) : 0,
  };
}

/** The stretch the dots may occupy: the track minus whatever the chevrons own.
 *  Zero or negative means there is no band to draw into, which the projection
 *  already treats as no dots. */
function bandHeightOf(track: TrackBox): number {
  return track.height - track.insetTop - track.insetBottom;
}

/** Measure the box the bar overlays. Only the container's own size moves it, so
 *  it is read on mount and on resize — never on scroll, never per frame. */
function useTrackBox(
  threadEl: HTMLElement | null,
  barRef: RefObject<HTMLDivElement | null>,
): TrackBox | null {
  const [box, setBox] = useState<TrackBox | null>(null);

  useLayoutEffect(() => {
    if (!threadEl) {
      setBox(null);
      return;
    }
    const measure = () => {
      const rect = threadEl.getBoundingClientRect();
      const parentRect = barRef.current?.offsetParent?.getBoundingClientRect();
      const height = Math.round(threadEl.clientHeight);
      const next: TrackBox = {
        top: Math.round(parentRect ? rect.top - parentRect.top : threadEl.offsetTop),
        right: Math.round(parentRect ? parentRect.right - rect.right : 0),
        height,
        ...chevronInsets(threadEl, rect, height),
      };
      setBox((prev) =>
        prev &&
        prev.top === next.top &&
        prev.right === next.right &&
        prev.height === next.height &&
        prev.insetTop === next.insetTop &&
        prev.insetBottom === next.insetBottom
          ? prev
          : next,
      );
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(threadEl);
    // The chevrons mount and unmount with the scrollability gate inside the wrap.
    const wrap = threadEl.parentElement;
    if (wrap) ro?.observe(wrap);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [threadEl, barRef]);

  return box;
}

/** One dot per user turn, overlaid on the transcript's native scrollbar. A dot
 *  marks when its turn was written, stretched from the first record to the last:
 *  the first turn sits flush with the top of the track and nothing but a written
 *  record can move a dot. Clicking one jumps to that turn. */
export function JumpBar({ messages, threadEl, onJump }: JumpBarProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const span = useMemo(() => conversationSpans(messages), [messages]);
  const track = useTrackBox(threadEl, barRef);
  // Dots map onto the band between the chevrons, then shift down past the top one.
  const bandHeight = track ? bandHeightOf(track) : 0;
  const bandTop = track?.insetTop ?? 0;
  const marks = useMemo(() => projectMarks(span, bandHeight), [span, bandHeight]);

  // Every streamed token rewrites `messages`, so the marker's effect keys on the
  // turn set instead of the array identity.
  const turnsRef = useRef(span.turns);
  turnsRef.current = span.turns;
  const turnsKey = useMemo(() => span.turns.map((t) => t.turn).join(","), [span]);

  // Anchors feed the "you are here" marker only, so they are read when the
  // layout may have moved rather than on every frame.
  const anchorsRef = useRef<TurnAnchor[]>([]);
  const anchorsStaleRef = useRef(true);
  // A jump states the user's intent: hold the marker on the clicked turn while a
  // smooth scroll passes over the turns in between.
  const jumpLockRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: turnsKey is the re-run trigger — turns are read through turnsRef so a streamed token cannot re-anchor the marker
  const deriveActive = useCallback(() => {
    const el = threadEl;
    if (!el || performance.now() < jumpLockRef.current) return;
    if (anchorsStaleRef.current) {
      anchorsRef.current = measureAnchors(el, turnsRef.current);
      anchorsStaleRef.current = false;
    }
    const next = activeTurnFor(el.scrollTop, anchorsRef.current);
    setActive((prev) => (prev === next ? prev : next));
  }, [threadEl, turnsKey]);

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
  useEffect(() => {
    const el = threadEl;
    if (!el) return;
    let frame = 0;
    const invalidate = () => {
      anchorsStaleRef.current = true;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        deriveActive();
      });
    };
    invalidate();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(invalidate) : null;
    ro?.observe(el);
    for (const child of el.children) ro?.observe(child);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(invalidate) : null;
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [threadEl, deriveActive]);

  if (span.turns.length < MIN_TURNS) return null;

  const hoveredMark = hovered !== null ? marks.find((m) => m.turn === hovered) : undefined;

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
    const targetScrollTop = jumpTargetFor(offset, el.scrollHeight, el.clientHeight);
    onJump?.();
    const far =
      Math.abs(targetScrollTop - el.scrollTop) > el.clientHeight * JUMP_SMOOTH_MAX_VIEWPORTS;
    el.scrollTo({ top: targetScrollTop, behavior: far ? "instant" : "smooth" });
  };

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
            style={{ top: bandTop + mark.top }}
            onMouseEnter={() => setHovered(mark.turn)}
            onMouseLeave={() => setHovered((h) => (h === mark.turn ? null : h))}
            onClick={() => scrollTo(mark.turn)}
            aria-label={mark.text}
          />
        );
      })}
      {hoveredMark ? (
        <div className="jump-preview" style={{ top: bandTop + hoveredMark.top }}>
          <span className="jump-text">{hoveredMark.text}</span>
        </div>
      ) : null}
    </div>
  );
}
