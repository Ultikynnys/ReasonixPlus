/** Keyboard handlers shared by click-to-activate / click-to-close targets —
 *  the keyboard twins of their onClick actions (a11y useKeyWithClickEvents). */
import { type KeyboardEvent, useEffect } from "react";

/** Enter and Space run the action (Space prevented so the page doesn't
 *  scroll). For non-button click targets; pair with tabIndex={0}. */
export function activationHandler(action: (e: KeyboardEvent) => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      action(e);
    }
  };
}

/** Escape closes — the keyboard equivalent of a click-outside mask. */
export function escapeHandler(action: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Escape") action();
  };
}

/** Window-level close-on-Escape listener — the keyboard twin of a click-outside
 *  mask. Pass `enabled=false` for a popover that stays mounted while closed. */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}
