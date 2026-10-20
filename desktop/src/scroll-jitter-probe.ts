import { recordFrontendDiagnostic } from "./diagnostics";

/** Dev-only: sample streaming scrollers each frame and log an episode to the
 *  diagnostics file when scroll position reverses fast enough to read as a bob. */

/** Direction reversals within {@link WINDOW_FRAMES} that flag a jitter episode. */
const REVERSALS_TO_REPORT = 6;
/** Frames retained per scroller (~1.5s at 60fps) and scanned for reversals. */
const WINDOW_FRAMES = 90;
/** Cap on the serialized trace, kept under the diagnostics string truncation. */
const TRACE_CHAR_BUDGET = 1900;
const REPORT_COOLDOWN_MS = 4000;
const MAX_TRACKED = 48;
/** Below this many px a change counts as noise, not movement. */
const MOVE_EPSILON = 0.01;
const TARGET_SELECTOR = ".thread, .reason .stream, .shell .stream";

interface Frame {
  /** Container scrollTop. */
  st: number;
  /** Container scrollHeight. */
  sh: number;
  /** Container clientHeight. */
  ch: number;
  /** Tail (last child) rendered height. */
  th: number;
  /** Container top on screen. */
  ct: number;
}

interface Summary {
  reversals: { scrolled: number; tail: number; shift: number };
  spansPx: { scrolled: number; tail: number; shift: number };
  trace: string;
  traceFrames: number;
}

/** Count scroll deltas that reverse the running direction; a pinned follow is monotonic (0). */
export function countReversals(samples: readonly number[]): number {
  let reversals = 0;
  let direction = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const delta = samples[i] - samples[i - 1];
    if (Math.abs(delta) < MOVE_EPSILON) continue;
    const dir = Math.sign(delta);
    if (direction !== 0 && dir !== direction) reversals += 1;
    direction = dir;
  }
  return reversals;
}

/** Keep the newest parts that fit the char budget, returned oldest to newest. */
export function capTrace(parts: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const cost = parts[i].length + (kept.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    used += cost;
    kept.push(parts[i]);
  }
  return kept.reverse();
}

function classify(el: HTMLElement): string {
  if (el.classList.contains("thread")) return "transcript";
  if (el.closest(".reason")) return "reasonStream";
  if (el.closest(".shell")) return "shellStream";
  return "stream";
}

function span(values: readonly number[]): number {
  return Number((Math.max(...values) - Math.min(...values)).toFixed(2));
}

function summarize(frames: readonly Frame[]): Summary {
  const scrolled = frames.map((f) => f.st);
  const tail = frames.map((f) => f.th);
  const shift = frames.map((f) => f.ct);
  // "scrollTop,scrollHeight,clientHeight,tailHeight,containerTop" per frame.
  const parts = frames.map(
    (f) => `${f.st.toFixed(1)},${f.sh},${f.ch},${f.th.toFixed(1)},${f.ct.toFixed(1)}`,
  );
  const kept = capTrace(parts, TRACE_CHAR_BUDGET);
  return {
    reversals: {
      scrolled: countReversals(scrolled),
      tail: countReversals(tail),
      shift: countReversals(shift),
    },
    spansPx: { scrolled: span(scrolled), tail: span(tail), shift: span(shift) },
    trace: kept.join("|"),
    traceFrames: kept.length,
  };
}

function report(el: HTMLElement, summary: Summary): void {
  const styles = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const details = {
    kind: classify(el),
    className: el.className,
    dpr: window.devicePixelRatio,
    reversals: summary.reversals,
    spansPx: summary.spansPx,
    trace: summary.trace,
    traceFrames: summary.traceFrames,
    styles: {
      overflowAnchor: styles.overflowAnchor,
      overscrollBehavior: styles.overscrollBehavior,
      willChange: styles.willChange,
      transform: styles.transform,
      contain: styles.contain,
      maxHeight: styles.maxHeight,
    },
    rectW: Math.round(rect.width),
    rectH: Math.round(rect.height),
    ua: navigator.userAgent.slice(0, 120),
  };
  recordFrontendDiagnostic("frontend.scroll_jitter", details, "warn");
}

let installed = false;

/** Install the per-frame sampler; returns a stop handle. Idempotent. */
export function installScrollJitterProbe(): () => void {
  if (installed) return () => {};
  installed = true;
  const tracked = new Map<HTMLElement, { frames: Frame[]; lastReportAt: number }>();
  let raf = 0;
  let stopped = false;

  const sampleOnce = (now: number) => {
    let seen = 0;
    for (const el of document.querySelectorAll<HTMLElement>(TARGET_SELECTOR)) {
      if (seen >= MAX_TRACKED) break;
      // Skip empty/inactive tabs and boxes too short to scroll.
      if (el.clientHeight <= 0 || el.scrollHeight <= el.clientHeight + 2) continue;
      seen += 1;
      let entry = tracked.get(el);
      if (!entry) {
        entry = { frames: [], lastReportAt: 0 };
        tracked.set(el, entry);
      }
      const tailEl = el.lastElementChild;
      entry.frames.push({
        st: el.scrollTop,
        sh: el.scrollHeight,
        ch: el.clientHeight,
        th: tailEl ? tailEl.getBoundingClientRect().height : 0,
        ct: el.getBoundingClientRect().top,
      });
      if (entry.frames.length > WINDOW_FRAMES) entry.frames.shift();

      if (entry.frames.length >= WINDOW_FRAMES && now - entry.lastReportAt > REPORT_COOLDOWN_MS) {
        const summary = summarize(entry.frames);
        const peak = Math.max(
          summary.reversals.scrolled,
          summary.reversals.tail,
          summary.reversals.shift,
        );
        if (peak >= REVERSALS_TO_REPORT) {
          entry.lastReportAt = now;
          report(el, summary);
        }
      }
    }
    for (const el of [...tracked.keys()]) {
      if (!el.isConnected) tracked.delete(el);
    }
  };

  const frame = () => {
    if (stopped) return;
    try {
      sampleOnce(performance.now());
    } catch (error) {
      // Never let one bad frame silently kill the sampler.
      recordFrontendDiagnostic("frontend.scroll_jitter_sample_failed", { error }, "warn");
    }
    if (!stopped) raf = requestAnimationFrame(frame);
  };

  raf = requestAnimationFrame(frame);
  return () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    tracked.clear();
  };
}
