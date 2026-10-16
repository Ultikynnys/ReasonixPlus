import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";

/** px from the bottom within which the view still counts as "pinned". */
export const DEFAULT_PIN_THRESHOLD = 80;

/** ms of scroll quiescence before the pin is re-decided from the settled position. */
export const PIN_SETTLE_MS = 140;

export interface StickyBottomOptions {
  /** px from the bottom that still counts as pinned. */
  threshold?: number;
  /** Fired whenever the pinned state flips (via a user gesture or {@link StickyBottom.pin}). */
  onPinChange?: (pinned: boolean) => void;
  /** Jump to the bottom; `smooth` requests an animated scroll (otherwise instant). */
  scrollToBottom: (smooth: boolean) => void;
}

export interface StickyBottom {
  /** Whether the view is currently following the bottom. */
  isPinned: () => boolean;
  /** Whether the viewport sits within the pin threshold of the bottom. */
  isAtBottom: () => boolean;
  /** Re-pin and jump to the bottom now. */
  pin: (smooth?: boolean) => void;
  /** Un-pin (the user left the bottom). */
  unpin: () => void;
  /** Scroll to the bottom while pinned and not drag-scrolling; returns whether it scrolled. */
  follow: () => boolean;
}

/**
 * Sticky-bottom auto-scroll for a scroll container.
 *
 * Shared by the transcript and the thinking / shell cards. A manual scroll UP
 * (wheel deltaY < 0, touch drag down, PageUp/ArrowUp/Home/Shift+Space, or
 * dragging the scrollbar up) un-pins immediately so a concurrent resize cannot
 * snap the viewport back. Re-pinning is debounced: once scrolling settles (see
 * `PIN_SETTLE_MS`) the pin is re-decided from the settled position, and a
 * down-scroll pins the instant the viewport is already at the bottom — so a
 * mid-scroll reading, or a momentary gap while streamed content is still
 * catching up, can never drop a pin the user did not mean to drop. While the
 * user drags the scrollbar, {@link
 * StickyBottom.follow} is suppressed so the thumb never rubber-bands.
 */
export function useStickyBottom(
  containerRef: RefObject<HTMLElement | null>,
  options: StickyBottomOptions,
): StickyBottom {
  const isPinnedRef = useRef(true);
  const draggingRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  // Read callbacks/threshold fresh without re-binding the listener effect.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const setPinned = useCallback((pinned: boolean) => {
    if (isPinnedRef.current === pinned) return;
    isPinnedRef.current = pinned;
    optionsRef.current.onPinChange?.(pinned);
  }, []);

  const isAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return (
      el.scrollTop + el.clientHeight >=
      el.scrollHeight - (optionsRef.current.threshold ?? DEFAULT_PIN_THRESHOLD)
    );
  }, [containerRef]);

  const pin = useCallback(
    (smooth = false) => {
      setPinned(true);
      if (containerRef.current) optionsRef.current.scrollToBottom(smooth);
    },
    [containerRef, setPinned],
  );

  const unpin = useCallback(() => setPinned(false), [setPinned]);

  const follow = useCallback(() => {
    if (!containerRef.current) return false;
    if (isPinnedRef.current && !draggingRef.current) {
      optionsRef.current.scrollToBottom(false);
      return true;
    }
    return false;
  }, [containerRef]);

  // User-scroll listeners. Direction decides the pin: any scroll toward the bottom
  // (or an at-bottom reading) re-pins and is never undone by a mid-scroll reading,
  // while only an explicit up-scroll — a gesture, or a scroll back past the
  // threshold — releases. Release is one-way until the user returns to the bottom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let settleTimer = 0;
    const clearSettle = () => {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
    };

    // Pin the instant the viewport is already at the bottom, without releasing.
    const pinIfAtBottom = () => {
      if (isAtBottom()) setPinned(true);
    };

    // Re-check the pin once scrolling settles, read from the settled position and
    // PIN-ONLY: a down-scroll can never release the pin, only an explicit up-scroll
    // (or a scroll back past the threshold) can. The debounce is the catch-all for
    // every scroll source (wheel, trackpad momentum, scrollbar drag / click-track,
    // keyboard, smooth scroll), and for a just-re-pinned view it stops a mid-scroll
    // reading from bouncing it straight back into manual mode.
    const settle = () => {
      clearSettle();
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        if (isAtBottom()) setPinned(true);
      }, PIN_SETTLE_MS);
    };

    // An up-scroll un-pins at once so streaming tokens stop yanking the viewport.
    const unpinNow = () => {
      clearSettle();
      setPinned(false);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) unpinNow();
      else if (e.deltaY > 0) {
        pinIfAtBottom();
        settle();
      }
    };

    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0]?.clientY ?? 0;
      const deltaY = touchStartY - currentY;
      touchStartY = currentY;
      if (deltaY < 0) unpinNow();
      else if (deltaY > 0) {
        pinIfAtBottom();
        settle();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "PageUp" ||
        e.key === "ArrowUp" ||
        e.key === "Home" ||
        (e.key === " " && e.shiftKey)
      ) {
        unpinNow();
      } else if (
        e.key === "PageDown" ||
        e.key === "ArrowDown" ||
        e.key === "End" ||
        (e.key === " " && !e.shiftKey)
      ) {
        pinIfAtBottom();
        settle();
      }
    };

    // Every scroll is classified by direction so a re-pin can't be bounced back: a
    // scroll toward the bottom re-pins (immediately when it is already at the
    // bottom, plus the debounced settle), while an upward scroll releases only once
    // it has clearly left the bottom. The threshold dead-zone means a 1px jitter, or
    // a shrink while following, cannot un-pin a view the user just returned to.
    const onScroll = () => {
      const current = el.scrollTop;
      const delta = current - lastScrollTopRef.current;
      lastScrollTopRef.current = current;
      if (delta < 0) {
        if (!isAtBottom()) unpinNow();
      } else if (delta > 0) {
        pinIfAtBottom();
      }
      settle();
    };
    const onPointerDown = () => {
      if (draggingRef.current) return;
      draggingRef.current = true;
      lastScrollTopRef.current = el.scrollTop;
    };
    const endDrag = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      pinIfAtBottom();
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    return () => {
      clearSettle();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [containerRef, isAtBottom, setPinned]);

  return useMemo(
    () => ({ isPinned: () => isPinnedRef.current, isAtBottom, pin, unpin, follow }),
    [isAtBottom, pin, unpin, follow],
  );
}
