import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";

/** px from the bottom within which the view still counts as "pinned". */
export const DEFAULT_PIN_THRESHOLD = 80;

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
 * Shared by the transcript and the reasoning cards. A manual scroll UP (wheel
 * deltaY < 0, touch drag down, PageUp/ArrowUp/Home/Shift+Space, or dragging the
 * scrollbar up) un-pins immediately so a concurrent resize cannot snap the
 * viewport back; scrolling DOWN re-pins only once the viewport reaches the
 * bottom (within `threshold`). While the user drags the scrollbar, {@link
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

  // User-scroll listeners: an up-scroll un-pins immediately (so a concurrent
  // resize cannot snap the viewport back), and the bottom re-pins.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let pendingFrame = 0;
    const unpinNow = () => {
      if (pendingFrame) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = 0;
      }
      setPinned(false);
    };
    const checkPin = () => {
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = 0;
        setPinned(isAtBottom());
      });
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) unpinNow();
      else if (e.deltaY > 0) checkPin();
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
      else if (deltaY > 0) checkPin();
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
        checkPin();
      }
    };

    // Scrollbar drag / selection: while dragging, follow is suppressed (see
    // `follow`) and directional scroll changes decide the pin.
    const onScrollDuringDrag = () => {
      const current = el.scrollTop;
      const delta = current - lastScrollTopRef.current;
      lastScrollTopRef.current = current;
      if (delta < 0) unpinNow();
      else if (delta > 0 && isAtBottom()) setPinned(true);
    };
    const onPointerDown = () => {
      lastScrollTopRef.current = el.scrollTop;
      if (draggingRef.current) return;
      draggingRef.current = true;
      el.addEventListener("scroll", onScrollDuringDrag, { passive: true });
    };
    const endDrag = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      el.removeEventListener("scroll", onScrollDuringDrag);
      setPinned(isAtBottom());
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    return () => {
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("scroll", onScrollDuringDrag);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [containerRef, isAtBottom, setPinned]);

  return useMemo(
    () => ({ isPinned: () => isPinnedRef.current, isAtBottom, pin, unpin, follow }),
    [isAtBottom, pin, unpin, follow],
  );
}
