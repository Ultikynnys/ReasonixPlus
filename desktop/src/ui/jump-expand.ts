import { useCallback, useEffect, useState } from "react";
import { EXPAND_EVENT } from "./transcript-jump";

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
    const onRequest = (event: Event) => {
      setForced((event as CustomEvent<string | null>).detail === anchor);
    };
    document.addEventListener(EXPAND_EVENT, onRequest);
    return () => document.removeEventListener(EXPAND_EVENT, onRequest);
  }, [anchor]);

  const expanded = open || forced;
  const toggle = useCallback(() => {
    setForced(false);
    setOpen(!expanded);
  }, [expanded]);

  return { open: expanded, toggle };
}
