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

interface FitJob {
  el: HTMLElement;
  minSize: number;
  fallbackSize: number;
}

/** Every mounted label waits here. Fitting one element at a time interleaves a
 *  style write with a layout read per label, and each read lays the container out
 *  again: a 468-model provider card (OpenRouter's live catalog) froze for seconds.
 *  Batching every fit of a commit into one queue keeps that to a read pass and a
 *  write pass per shrink round, so the cost stays a couple of layouts. */
const queue = new Set<FitJob>();
let scheduled = false;

function flushQueue(): void {
  scheduled = false;
  const jobs: FitJob[] = [];
  for (const job of queue) if (job.el.isConnected) jobs.push(job);
  queue.clear();
  if (jobs.length === 0) return;
  // Drop every inline size first: the stylesheet base (a container query, a
  // font-scale preference) decides where each fit starts. Writing before reading
  // is what keeps the reads below grouped into a single layout.
  for (const job of jobs) job.el.style.fontSize = "";
  const sizes = jobs.map((job) => {
    const computed = Number.parseFloat(getComputedStyle(job.el).fontSize);
    return Number.isFinite(computed) && computed > 0 ? computed : job.fallbackSize;
  });
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = jobs.map((job, index) =>
      fitFontSize({
        available: job.el.clientWidth,
        natural: job.el.scrollWidth,
        base: sizes[index]!,
        min: job.minSize,
      }),
    );
    let shrank = false;
    for (let index = 0; index < jobs.length; index += 1) {
      const size = next[index]!;
      if (size >= sizes[index]!) continue;
      sizes[index] = size;
      jobs[index]!.el.style.fontSize = `${size}px`;
      shrank = true;
    }
    // Shrinking text can widen the box that holds it, so a converged round is the
    // only safe place to stop.
    if (!shrank) return;
  }
}

function scheduleFit(job: FitJob): void {
  queue.add(job);
  if (scheduled) return;
  scheduled = true;
  // A microtask drains right after the commit that mounted the batch and still
  // before paint, so a shrunken label never flashes at its base size.
  queueMicrotask(flushQueue);
}

/** Text that scales down to fit its box instead of truncating. The scaled label
 *  keeps its whole text in `title`, so a shrunk name is still readable on hover. */
export function FitText({
  text,
  className,
  title,
  minSize = 9,
  fallbackSize = 14,
  deferUntilVisible = false,
}: {
  text: string;
  className?: string;
  title?: string;
  /** Smallest size a fit may reach; below it the box's own ellipsis takes over. */
  minSize?: number;
  /** Used only when the computed size is unreadable (jsdom, a detached node). */
  fallbackSize?: number;
  /** Leave the label unmeasured until it scrolls into view. Measuring a row the
   *  browser is skipping (`content-visibility: auto`) lays that row out, which is
   *  exactly the work the skip avoided, so a long list defers to the observer and
   *  fits each row as it appears. */
  deferUntilVisible?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const job: FitJob = { el, minSize, fallbackSize };
    const fit = (): void => scheduleFit(job);
    let onScreen = !deferUntilVisible;
    const visibility =
      deferUntilVisible && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            for (const entry of entries) {
              onScreen = entry.isIntersecting;
              if (onScreen) fit();
            }
          })
        : null;
    if (visibility) visibility.observe(el);
    else fit();
    // A collapsing panel or a container-query step changes the parent's width
    // without changing `text`; jsdom has no layout, so it has no observer either.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (onScreen) fit();
          });
    if (el.parentElement) observer?.observe(el.parentElement);
    return () => {
      queue.delete(job);
      visibility?.disconnect();
      observer?.disconnect();
    };
  }, [text, minSize, fallbackSize, deferUntilVisible]);

  return (
    <span ref={ref} className={className} title={title ?? text}>
      {text}
    </span>
  );
}
