import { useEffect, useRef, useState } from "react";

export function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.floor(s)}s`;
}

/**
 * Renders its children only while a turn has been silent for over `afterSec`.
 * The 1s poll mutates the seconds text node directly and only flips React state
 * on the visible/invisible edge, so a quiet turn costs the parent no re-renders.
 */
export function StuckLabel({
  active,
  sinceMs,
  afterSec = 30,
  render,
}: {
  active: boolean;
  /** Timestamp of the last turn activity. */
  sinceMs: number;
  afterSec?: number;
  /** Builds the label body; called with the elapsed silent seconds on each flip. */
  render: (silentSec: number) => React.ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const tick = () => {
      const silentSec = Math.floor((Date.now() - sinceMs) / 1000);
      const show = silentSec > afterSec;
      if (ref.current) ref.current.textContent = show ? String(silentSec) : "";
      setVisible((prev) => (prev === show ? prev : show));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active, sinceMs, afterSec]);

  return visible ? render(Math.floor((Date.now() - sinceMs) / 1000)) : null;
}

/** A span that displays an auto-updating elapsed-time counter using direct
 *  DOM mutation. This avoids React re-renders on every tick — the timer
 *  update never cascades through the component tree. */
export function TimerSpan({
  active,
  startAt,
  className,
  format,
}: {
  active: boolean;
  startAt?: number;
  className?: string;
  format?: (ms: number) => string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const start = useRef<number | null>(null);
  const fmt = format ?? fmtElapsed;

  useEffect(() => {
    if (!active) {
      if (ref.current) ref.current.textContent = "";
      start.current = null;
      return;
    }
    start.current = startAt ?? performance.now();
    const id = setInterval(() => {
      if (start.current !== null && ref.current) {
        ref.current.textContent = fmt(performance.now() - start.current);
      }
    }, 250);
    return () => clearInterval(id);
  }, [active, startAt, fmt]);

  return <span ref={ref} className={className} />;
}
