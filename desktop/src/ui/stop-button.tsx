import { useCallback, useEffect, useState } from "react";
import { I } from "../icons";

/** Tracks a cancel that is in flight: `start()` flips it on, and it clears the
 *  moment `done` turns true — or after a safety timeout, so a stop that never
 *  lands can't strand a throbber forever. */
export function usePendingStop(done: boolean, timeoutMs = 15_000): [boolean, () => void] {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return;
    if (done) {
      setPending(false);
      return;
    }
    const id = window.setTimeout(() => setPending(false), timeoutMs);
    return () => window.clearTimeout(id);
  }, [pending, done, timeoutMs]);
  const start = useCallback(() => setPending(true), []);
  return [pending, start];
}

/** The shared cancel button. While its stop is in flight (`busy`) it swaps its
 *  icon for a throbber and locks out re-clicks, so every cancel action reads as
 *  "working" instead of appearing to do nothing. */
export function StopButton({
  onClick,
  title,
  busy = false,
  className = "btn stop",
  iconSize,
  label,
}: {
  onClick: () => void;
  title: string;
  busy?: boolean;
  className?: string;
  /** Icon size; omit for a text-only button (the throbber still shows). */
  iconSize?: number;
  /** Omit for an icon-only button. */
  label?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      title={title}
      disabled={busy}
      aria-busy={busy}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {busy ? (
        <span className="spin stop-throbber" role="status" aria-label={title} />
      ) : iconSize !== undefined ? (
        <I.stop size={iconSize} />
      ) : null}
      {label}
    </button>
  );
}
