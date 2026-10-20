import { useCallback, useEffect, useState } from "react";
import { EXPAND_EVENT } from "./transcript-jump";

/** Which cards a jump could force open, keyed by anchor. ONE document listener
 *  serves every card: a transcript with thousands of tool cards used to install a
 *  listener each, so every expand request walked all of them. */
const forcedSetters = new Map<string, Set<(forced: boolean) => void>>();
let expandListenerAttached = false;

function attachExpandListener(): void {
  if (expandListenerAttached) return;
  expandListenerAttached = true;
  document.addEventListener(EXPAND_EVENT, (event) => {
    const asked = (event as CustomEvent<readonly string[] | null>).detail ?? [];
    // Setters handed an unchanged value are React state no-ops, so only the cards
    // the request actually names re-render.
    for (const [anchor, setters] of forcedSetters) {
      const forced = asked.includes(anchor);
      for (const set of setters) set(forced);
    }
  });
}

/** Open state for a collapsible card that the Events tab can force open.
 *
 *  A jump to a collapsed card would land on a header that grows by its whole body
 *  the moment it opens, so the jump asks for it first and measures after that
 *  commit. The reader always wins: a manual toggle, or a jump anywhere else,
 *  releases the forced state. */
export function useJumpOpen(
  anchor: string | undefined,
  defaultOpen: boolean,
): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(defaultOpen);
  const [forced, setForced] = useState(false);

  useEffect(() => {
    if (anchor === undefined) return;
    attachExpandListener();
    const bucket = forcedSetters.get(anchor) ?? new Set();
    bucket.add(setForced);
    forcedSetters.set(anchor, bucket);
    return () => {
      bucket.delete(setForced);
      if (bucket.size === 0) forcedSetters.delete(anchor);
    };
  }, [anchor]);

  const expanded = open || forced;
  const toggle = useCallback(() => {
    setForced(false);
    setOpen(!expanded);
  }, [expanded]);

  return { open: expanded, toggle };
}
