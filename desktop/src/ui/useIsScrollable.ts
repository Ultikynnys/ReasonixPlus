import { useEffect, useState } from "react";

/**
 * True while the scroll container overflows its own height, i.e. exactly when
 * the browser would render a vertical scrollbar. Recomputes on content growth
 * and on container resize, but only commits state when the boolean flips, so it
 * does not re-render the consumer on every streaming frame.
 */
export function useIsScrollable(
  scrollRef: React.RefObject<HTMLElement | null>,
  contentRef: React.RefObject<HTMLElement | null>,
): boolean {
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const next = el.scrollHeight > el.clientHeight + 1;
      setScrollable((prev) => (prev === next ? prev : next));
    };
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (ro) {
      ro.observe(el);
      const content = contentRef.current;
      if (content) ro.observe(content);
    }
    window.addEventListener("resize", update);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [scrollRef, contentRef]);

  return scrollable;
}
