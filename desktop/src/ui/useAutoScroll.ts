import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PIN_THRESHOLD, useStickyBottom } from "./useStickyBottom";

/**
 * Auto-scroll to bottom while content grows; un-pin immediately on user scroll-up.
 *
 * Pin/un-pin and the user-gesture listeners live in {@link useStickyBottom};
 * this hook layers the transcript's extra behaviour on top:
 * 1. Turn start re-pins so the user sees the new turn's incoming tokens.
 * 2. Turn end only settles at the bottom if the user remained pinned. If the
 *    user scrolled up to read, turn end does not yank them back to the bottom.
 * 3. Content size changes follow the bottom while pinned (unless dragging the
 *    scrollbar).
 * 4. Boot restore opens the transcript at the saved offset instead of the bottom.
 */
export function useAutoScroll(
  containerRef: React.RefObject<HTMLDivElement | null>,
  contentRef: React.RefObject<HTMLDivElement | null>,
  busy: boolean,
  /** Optional boot-time restore: the offset the transcript should open at. */
  getRestoreScrollTop?: () => number | null,
  /** True when this tab is the visible one. Inactive tabs render no thread
   *  content (see TabRuntime), so the boot restore / pin-to-bottom must be
   *  re-applied the moment a tab becomes active and its content mounts. */
  active?: boolean,
) {
  const [showJumpButton, setShowJumpButton] = useState(false);
  const wasBusyRef = useRef(busy);
  const rafIdRef = useRef<number>(0);

  const scrollToBottomRaw = useCallback(
    (smooth: boolean) => {
      const el = containerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
    },
    [containerRef],
  );

  const onPinChange = useCallback(
    (pinned: boolean) => {
      const el = containerRef.current;
      if (!el) return;
      setShowJumpButton(!pinned && el.scrollHeight > el.clientHeight + DEFAULT_PIN_THRESHOLD);
    },
    [containerRef],
  );

  const sticky = useStickyBottom(containerRef, {
    threshold: DEFAULT_PIN_THRESHOLD,
    onPinChange,
    scrollToBottom: scrollToBottomRaw,
  });

  const refreshJumpButton = useCallback(
    () => onPinChange(sticky.isPinned()),
    [onPinChange, sticky],
  );

  const scrollToBottom = useCallback((smooth = true) => sticky.pin(smooth), [sticky]);

  const scrollToTop = useCallback(
    (smooth = true) => {
      const el = containerRef.current;
      if (!el) return;
      // Un-pin before scrolling so a concurrent follow() cannot snap back.
      sticky.unpin();
      el.scrollTo({ top: 0, behavior: smooth ? "smooth" : "instant" });
    },
    [containerRef, sticky],
  );

  // Turn start: user just sent a message and expects to see the new turn.
  // Turn end: settle on final answer ONLY if the user was already following along.
  // If the user scrolled up, do not yank them away from what they are reading.
  useEffect(() => {
    if (wasBusyRef.current !== busy) {
      if (busy) sticky.pin(true);
      else if (sticky.isPinned()) sticky.pin(true);
    }
    wasBusyRef.current = busy;
  }, [busy, sticky]);

  // Watch content size changes (streaming text, tool results, new messages)
  // and follow the bottom while pinned (unless actively dragging scrollbar).
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const ro = new ResizeObserver(() => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        if (!sticky.follow()) refreshJumpButton();
      });
    });

    ro.observe(content);
    return () => {
      ro.disconnect();
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, [contentRef, sticky, refreshJumpButton]);

  // Initial scroll when the hook mounts or the tab becomes active.
  useEffect(() => {
    if (active === false) return;
    const el = containerRef.current;
    if (!el) return;
    const id = setTimeout(() => {
      const restore = getRestoreScrollTop?.() ?? null;
      if (restore != null && restore > DEFAULT_PIN_THRESHOLD) {
        sticky.unpin();
        el.scrollTop = restore;
        refreshJumpButton();
      } else {
        sticky.pin(false);
      }
    }, 60);
    return () => clearTimeout(id);
  }, [containerRef, getRestoreScrollTop, refreshJumpButton, sticky, active]);

  return { showJumpButton, scrollToBottom, scrollToTop };
}
