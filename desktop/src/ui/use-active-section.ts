import { useEffect, useState } from "react";

/** One section's distance from the top of the scrolled content. */
export interface SectionOffset {
  id: string;
  top: number;
}

/**
 * The section the reader is in: the last one whose top has reached the reading line just
 * under the top edge. At the end of the scroll it is the last section, even when that
 * section is too short for its top to reach the line. Pure, so the boundaries can be tested
 * without a layout.
 */
export function activeSectionAt(
  offsets: ReadonlyArray<SectionOffset>,
  scrollTop: number,
  { line = 24, atBottom = false }: { line?: number; atBottom?: boolean } = {},
): string | null {
  const last = offsets[offsets.length - 1];
  if (!last) return null;
  if (atBottom) return last.id;

  let active: string = offsets[0]!.id;
  for (const { id, top } of offsets) {
    if (top - line > scrollTop) break;
    active = id;
  }
  return active;
}

/**
 * True only when the container actually scrolls and the reader is at its end. A page shorter
 * than the viewport has no end to speak of, so it must not claim its last section.
 */
export function isScrollEnd(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollHeight > clientHeight + 2 && scrollTop + clientHeight >= scrollHeight - 2;
}

/**
 * Tracks which of `ids` the reader is looking at inside `el`, re-reading on scroll and on
 * resize. Takes the element rather than a ref: a reopened settings window mounts a new body,
 * and a ref object would keep the detached one. One listener, coalesced per frame, so a fast
 * scroll does not re-render per pixel.
 */
export function useActiveSection(
  el: HTMLElement | null,
  ids: ReadonlyArray<string>,
): string | null {
  const key = ids.join("|");
  const [active, setActive] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    const list = key ? key.split("|") : [];
    if (!el || list.length === 0) {
      setActive(null);
      return;
    }
    const read = () => {
      const box = el.getBoundingClientRect();
      const offsets: SectionOffset[] = [];
      for (const id of list) {
        const target = el.querySelector(`[data-section="${id}"]`);
        // A missing section is skipped rather than ranked at Infinity: the Infinity would
        // stop the walk and leave every section after it unreachable.
        if (!target) continue;
        offsets.push({
          id,
          top: target.getBoundingClientRect().top - box.top + el.scrollTop,
        });
      }
      const atBottom = isScrollEnd(el.scrollTop, el.clientHeight, el.scrollHeight);
      setActive((prev) => {
        const next = activeSectionAt(offsets, el.scrollTop, { atBottom });
        return prev === next ? prev : next;
      });
    };
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        read();
      });
    };
    read();
    el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [el, key]);

  return active;
}

/**
 * Scrolls `container` so the section `id` sits just under its top edge. The jump is instant:
 * a smooth animation is a no-op wherever the engine will not animate, which leaves the index
 * looking dead.
 */
export function scrollToSection(container: HTMLElement | null, id: string, offset = 8): boolean {
  const target = container?.querySelector(`[data-section="${id}"]`);
  if (!container || !target) return false;
  const top =
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop;
  // jsdom has no element scrolling, so the call is optional rather than assumed.
  container.scrollTo?.({ top: Math.max(0, top - offset) });
  return true;
}
