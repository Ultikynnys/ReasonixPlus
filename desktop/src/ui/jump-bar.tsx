import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

interface JumpBarProps {
  messages: { kind: string; text?: string; turn?: number }[];
  threadEl: HTMLElement | null;
}

interface JumpMark {
  turn: number;
  text: string;
  /** Vertical offset (px) of the dot within the transcript's scrollbar track. */
  top: number;
}

/** The `[data-turn]` wrapper for a turn, or null while it is not mounted. */
function findTurn(threadEl: HTMLElement, turn: number): HTMLElement | null {
  return threadEl.querySelector<HTMLElement>(`[data-turn="${turn}"]`);
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** One dot per user turn, overlaid on the transcript's native scrollbar. Each
 *  dot's position is the turn's offset within the scroll content as a fraction
 *  of the full scroll height, i.e. where the thumb sits when scrolled to it. */
export function JumpBar({ messages, threadEl }: JumpBarProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [track, setTrack] = useState<{ top: number; right: number; height: number } | null>(null);
  const [marks, setMarks] = useState<JumpMark[]>([]);
  const barRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () =>
      messages
        .filter(
          (m): m is { kind: "user"; text: string; turn: number } =>
            m.kind === "user" && typeof m.text === "string" && typeof m.turn === "number",
        )
        .map((m) => ({ turn: m.turn, text: m.text.slice(0, 80) })),
    [messages],
  );
  // Turns are append-only, so this identifies the turn SET. The measure effect
  // keys on it rather than `items`, whose array identity changes on every
  // streamed token even though the user turns are unchanged.
  const turnsKey = items.map((m) => m.turn).join(",");
  const lastTurn = items.length > 0 ? items[items.length - 1]!.turn : null;

  // The newest turn is the "you are here" marker.
  useEffect(() => {
    if (lastTurn !== null) setActive(lastTurn);
  }, [lastTurn]);

  // Place the overlay over the `.thread` scroll container and read each turn's
  // offset from its `[data-turn]` element. The box is resolved against the
  // overlay's offsetParent, so it stays glued to the scrollbar even if an
  // intermediate ancestor becomes positioned. Content growth is caught by the
  // ResizeObserver; both paths coalesce into one measure per animation frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reading items fresh each measure; content growth is handled by the ResizeObserver
  useLayoutEffect(() => {
    if (!threadEl || items.length < 2) {
      setTrack(null);
      setMarks([]);
      return;
    }
    let raf = 0;
    const measure = () => {
      const rect = threadEl.getBoundingClientRect();
      const clientHeight = threadEl.clientHeight;
      const scrollHeight = threadEl.scrollHeight;
      if (clientHeight <= 0 || scrollHeight <= 0) {
        setTrack(null);
        setMarks([]);
        return;
      }
      const parentRect = barRef.current?.offsetParent?.getBoundingClientRect();
      setTrack({
        top: parentRect ? rect.top - parentRect.top : threadEl.offsetTop,
        right: parentRect ? parentRect.right - rect.right : 0,
        height: clientHeight,
      });
      setMarks(
        items.flatMap((item) => {
          const el = findTurn(threadEl, item.turn);
          if (!el) return [];
          const offset = el.getBoundingClientRect().top - rect.top + threadEl.scrollTop;
          const top = clamp((offset / scrollHeight) * clientHeight, 0, clientHeight);
          return [{ turn: item.turn, text: item.text, top }];
        }),
      );
    };
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    schedule();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (ro) {
      ro.observe(threadEl);
      const inner = threadEl.firstElementChild;
      if (inner) ro.observe(inner);
    }
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [threadEl, turnsKey]);

  if (items.length < 2) return null;

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
