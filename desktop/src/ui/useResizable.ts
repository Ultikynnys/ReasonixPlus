import { useCallback, useEffect, useRef, useState } from "react";
import { getThreadMaxWidth } from "./thread-layout";

const MIN_WIDTH = 160;
const MAX_WIDTH_PCT = 0.4;
const CSS_VAR = { side: "--side-width", ctx: "--ctx-width" } as const;
const PERSIST_KEY_SIDE = "reasonix.sideWidth";
const PERSIST_KEY_CTX = "reasonix.ctxWidth";

// Every tab renders its own `.app` shell and they all share the same column
// widths, so a resize has to touch all of them.
function appElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".app"));
}

// Writes the dragged column width plus the derived thread/composer max-widths
// straight to the DOM. Kept off the React render path on purpose: a setState on
// every mousemove re-renders the whole tab tree and makes the drag crawl.
function applyColumnWidths(
  els: HTMLElement[],
  cssVar: string,
  otherVar: string,
  side: "side" | "ctx",
  width: number,
): void {
  if (els.length === 0) return;
  const otherW = Number.parseFloat(els[0].style.getPropertyValue(otherVar)) || 0;
  const tMax = getThreadMaxWidth({
    viewportWidth: window.innerWidth,
    visibleSide: side === "side" ? width : otherW,
    visibleCtx: side === "ctx" ? width : otherW,
  });
  for (const el of els) {
    el.style.setProperty(cssVar, `${width}px`);
    el.style.setProperty("--thread-max-width", `${tMax}px`);
    el.style.setProperty("--composer-max-width", `${tMax}px`);
  }
}

export function useResizable(
  side: "side" | "ctx",
  collapsed: boolean,
): {
  width: number;
  onMouseDown: (e: React.MouseEvent) => void;
} {
  const persistKey = side === "side" ? PERSIST_KEY_SIDE : PERSIST_KEY_CTX;
  const defaultWidth = side === "side" ? 244 : 320;

  const [width, setWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(persistKey);
      if (saved) {
        const n = Number(saved);
        if (Number.isFinite(n) && n >= MIN_WIDTH) return n;
      }
    } catch {
      /* localStorage not available */
    }
    return defaultWidth;
  });

  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const widthRef = useRef(width);
  widthRef.current = width;
  const cssVar = CSS_VAR[side];
  const otherVar = side === "side" ? "--ctx-width" : "--side-width";

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = widthRef.current;
    // All tab shells share the widths, so flag them all to disable the grid
    // transition on whichever one is visible.
    for (const el of appElements()) el.dataset.dragging = "true";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    if (collapsed) return;

    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;

      const delta = e.clientX - startXRef.current;
      let next: number;
      if (side === "side") {
        next = startWidthRef.current + delta;
      } else {
        next = startWidthRef.current - delta;
      }
      const maxW = Math.floor(window.innerWidth * MAX_WIDTH_PCT);
      next = Math.max(MIN_WIDTH, Math.min(next, maxW));
      widthRef.current = next;

      // Write straight to the DOM instead of React state: React only rewrites
      // the style keys whose prop value changed, so these imperative writes
      // survive unrelated re-renders mid-drag and are re-synced on mouseup.
      applyColumnWidths(appElements(), cssVar, otherVar, side, next);
    };

    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      for (const el of appElements()) delete el.dataset.dragging;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(persistKey, String(widthRef.current));
      } catch {
        /* localStorage not available */
      }
      // Commit the final width once so React state matches what was dragged.
      setWidth(widthRef.current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [collapsed, side, persistKey, cssVar, otherVar]);

  return { width, onMouseDown };
}
