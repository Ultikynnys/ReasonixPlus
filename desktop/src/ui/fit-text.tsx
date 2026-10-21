import { useLayoutEffect, useRef } from "react";

/** How many shrink passes a fit may take; enough to converge, bounded so a
 *  pathological measurement can never spin. */
const MAX_PASSES = 8;

/** The font size that fits `natural` px of text into `available` px, never below
 *  `min`. Absent layout (jsdom, a hidden panel) keeps the base size. */
export function fitFontSize(options: {
  available: number;
  natural: number;
  base: number;
  min: number;
}): number {
  const { available, natural, base, min } = options;
  if (!(available > 0) || !(natural > available)) return base;
  return Math.max(min, (base * available) / natural);
}

/** Text that scales down to fit its box instead of truncating. The scaled label
 *  keeps its whole text in `title`, so a shrunk name is still readable on hover. */
export function FitText({
  text,
  className,
  title,
  minSize = 9,
  fallbackSize = 14,
}: {
  text: string;
  className?: string;
  title?: string;
  /** Smallest size a fit may reach; below it the box's own ellipsis takes over. */
  minSize?: number;
  /** Used only when the computed size is unreadable (jsdom, a detached node). */
  fallbackSize?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = (): void => {
      // Clear the inline size first so the stylesheet (a container query, a
      // font-scale preference) still decides the base every time it re-fits.
      el.style.fontSize = "";
      const computed = Number.parseFloat(getComputedStyle(el).fontSize);
      let size = Number.isFinite(computed) && computed > 0 ? computed : fallbackSize;
      el.style.fontSize = `${size}px`;
      // Shrinking the text can shrink the box that holds it, so re-measure until
      // the size stops changing rather than trusting one division.
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const next = fitFontSize({
          available: el.clientWidth,
          natural: el.scrollWidth,
          base: size,
          min: minSize,
        });
        if (next >= size) return;
        size = next;
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    // A collapsing panel or a container-query step changes the parent's width
    // without changing `text`; jsdom has no layout, so it has no observer either.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    if (el.parentElement) observer?.observe(el.parentElement);
    return () => observer?.disconnect();
  }, [text, minSize, fallbackSize]);

  return (
    <span ref={ref} className={className} title={title ?? text}>
      {text}
    </span>
  );
}
