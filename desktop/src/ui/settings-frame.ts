import { useEffect, useState } from "react";

/** The frame drops its margins once the window is narrower than this share of the screen. */
export const FULL_BLEED_SCREEN_RATIO = 0.7;

/**
 * True when the window is too narrow for the frame's 92% margins to buy anything, so the
 * settings window takes the whole viewport instead. `screen.width` is the display, not the
 * window, so this compares the window against the screen it sits on.
 */
export function wantsFullBleed(windowWidth: number, screenWidth: number): boolean {
  if (!Number.isFinite(screenWidth) || screenWidth <= 0) return false;
  return windowWidth < screenWidth * FULL_BLEED_SCREEN_RATIO;
}

function readFullBleed(): boolean {
  return wantsFullBleed(window.innerWidth, window.screen?.width ?? 0);
}

/** `wantsFullBleed` for the live window, re-read whenever the window is resized. */
export function useFullBleed(): boolean {
  const [full, setFull] = useState(readFullBleed);

  useEffect(() => {
    const update = () =>
      setFull((prev) => {
        const next = readFullBleed();
        return prev === next ? prev : next;
      });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return full;
}
