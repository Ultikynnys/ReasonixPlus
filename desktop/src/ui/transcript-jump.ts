/** Scrolling the transcript to a recorded event's location. Kept separate from
 *  the Events tab so the geometry (and its tests) do not depend on any panel
 *  rendering. */

/** Past this many viewports a smooth scroll takes seconds and any arriving token
 *  can interrupt it, so the jump lands at once instead. */
const JUMP_SMOOTH_MAX_VIEWPORTS = 3;

/** How long a landed jump keeps re-aligning against later layout changes: a card
 *  above opening, an image decoding, a Markdown reflow. It only corrects a target
 *  that actually moved, but the window is still bounded so a jump the reader has
 *  moved on from can never keep pulling the viewport. */
const JUMP_ALIGN_MS = 2_000;

/** How far the target may sit from the top before a relayout re-lands it: less
 *  than this is sub-pixel noise, more is a card above it having grown or shrunk. */
const ALIGN_EPSILON = 1;

/** Collapsible cards listen for this to open themselves when a jump lands on
 *  them (see `useJumpOpen`). */
export const EXPAND_EVENT = "reasonix:transcript-expand";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** What an event row points at: its own card when one was recorded, else the
 *  prompt bubble of its turn. */
export interface JumpTarget {
  turn: number;
  /** `call:<id>` for a plan/choice card, `notice:<id>` for a compaction card. */
  anchor?: string;
}

/** Escape for a quoted attribute value: only `"` and `\` need it. */
const attrValue = (value: string): string => value.replace(/["\\]/g, "\\$&");

/** The jump target of the card a gate's tool call renders; `{}` when the wire
 *  carried no call id, so the record simply has no anchor. */
export function callAnchor(callId: string | undefined): { anchor?: string } {
  return callId ? { anchor: `call:${callId}` } : {};
}

/** The jump target of a compaction card. */
export function noticeAnchor(noticeId: string): string {
  return `notice:${noticeId}`;
}

/** The `[data-turn]` wrapper for a turn, or null while it is not mounted. */
function findTurnElement(threadEl: HTMLElement, turn: number): HTMLElement | null {
  return threadEl.querySelector<HTMLElement>(`[data-turn="${turn}"]`);
}

/** The card carrying an anchor, or null when it is not mounted. */
function findAnchorElement(threadEl: HTMLElement, anchor: string): HTMLElement | null {
  return threadEl.querySelector<HTMLElement>(`[data-anchor="${attrValue(anchor)}"]`);
}

/** Whether an element is actually laid out. A card inside a hidden subtree
 *  reports a zero rect, and scrolling to it would land at the transcript top
 *  while still claiming success. */
function hasLayout(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/** The collapsible box a card wrapper carries: the anchor sits on the wrapper
 *  for a `Card` and on the box itself for an `ApprovalCard`. */
function collapseBox(anchorEl: HTMLElement): HTMLElement | null {
  if (anchorEl.hasAttribute("data-open")) return anchorEl;
  return anchorEl.querySelector<HTMLElement>("[data-open]");
}

/** Whether the anchored card is rendered collapsed. A collapsed card is a header
 *  now and its whole body a commit later, so an offset measured against it lands
 *  high by exactly the body height. */
function isCollapsed(anchorEl: HTMLElement): boolean {
  return collapseBox(anchorEl)?.getAttribute("data-open") === "false";
}

/** Ask the collapsible cards to open the one carrying `anchor` (and to release
 *  any card an earlier jump forced open). The state change lands on React's next
 *  commit, so the caller re-measures a frame later. */
export function requestAnchorExpansion(anchor: string | null): void {
  document.dispatchEvent(new CustomEvent(EXPAND_EVENT, { detail: anchor }));
}

/** What a target points at: the anchored card once it is laid out, else its
 *  turn's prompt bubble. */
function findTarget(threadEl: HTMLElement, target: JumpTarget): HTMLElement | null {
  const anchored = target.anchor ? findAnchorElement(threadEl, target.anchor) : null;
  if (anchored && hasLayout(anchored)) return anchored;
  return Number.isFinite(target.turn) && target.turn > 0
    ? findTurnElement(threadEl, target.turn)
    : null;
}

/** The element's offset inside the scroll content. Read at jump time: a streamed
 *  answer below it moves the scroll range, not the element. */
function contentOffset(threadEl: HTMLElement, element: HTMLElement): number {
  return (
    element.getBoundingClientRect().top - threadEl.getBoundingClientRect().top + threadEl.scrollTop
  );
}

/** The scrollTop that brings an element's top edge to the viewport top. */
export function jumpTargetFor(offset: number, scrollHeight: number, clientHeight: number): number {
  return clamp(offset, 0, Math.max(0, scrollHeight - clientHeight));
}

/** The scrollTop that puts the element's top edge at the viewport top. */
function landingScrollTop(threadEl: HTMLElement, element: HTMLElement): number {
  return jumpTargetFor(
    contentOffset(threadEl, element),
    threadEl.scrollHeight,
    threadEl.clientHeight,
  );
}

/** Scroll so the element's top edge sits at the viewport top. */
function landOn(threadEl: HTMLElement, element: HTMLElement): void {
  const targetScrollTop = landingScrollTop(threadEl, element);
  const smoothRange = threadEl.clientHeight * JUMP_SMOOTH_MAX_VIEWPORTS;
  const far = Math.abs(targetScrollTop - threadEl.scrollTop) > smoothRange;
  threadEl.scrollTo({ top: targetScrollTop, behavior: far ? "instant" : "smooth" });
}

/** The one live alignment watcher: a fresh jump must not fight the previous one. */
let stopAlignment: (() => void) | null = null;

/** Stop re-aligning the transcript (a new jump, or the reader taking over). */
export function endJumpAlignment(): void {
  stopAlignment?.();
  stopAlignment = null;
}

/** Keep a landed jump on its target while the layout settles.
 *
 * `.thread` sets `overflow-anchor: none`, so nothing compensates when a card above
 * the target opens, closes or finishes loading: it slides out by exactly that much.
 * Only a moved target is corrected, so a growing tail below it is left alone, and
 * any reader gesture, a spent budget or a gone target stops the watcher. */
function alignWhileSettling(threadEl: HTMLElement, element: HTMLElement): void {
  endJumpAlignment();
  const content = threadEl.firstElementChild ?? threadEl;
  let frame = 0;
  let stopped = false;
  let budget = 0;
  let resize: ResizeObserver | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    window.clearTimeout(budget);
    resize?.disconnect();
    resize = null;
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchstart", stop);
    window.removeEventListener("keydown", stop);
    window.removeEventListener("pointerdown", stop);
    if (stopAlignment === stop) stopAlignment = null;
  };

  const correct = () => {
    frame = 0;
    if (stopped) return;
    if (!element.isConnected) {
      stop();
      return;
    }
    // Compare with where the target belongs now, not with a remembered offset:
    // sub-pixel drift still corrects once it passes the threshold, and the
    // browser's own clamping can never leave the target parked off the mark.
    const desired = landingScrollTop(threadEl, element);
    if (Math.abs(desired - threadEl.scrollTop) < ALIGN_EPSILON) return;
    threadEl.scrollTop = desired;
  };

  const onLayoutChange = () => {
    if (stopped || frame) return;
    frame = requestAnimationFrame(correct);
  };

  budget = window.setTimeout(stop, JUMP_ALIGN_MS);
  if (typeof ResizeObserver === "function") {
    resize = new ResizeObserver(onLayoutChange);
    resize.observe(content);
  }
  window.addEventListener("wheel", stop, { passive: true });
  window.addEventListener("touchstart", stop, { passive: true });
  window.addEventListener("keydown", stop);
  window.addEventListener("pointerdown", stop);
  stopAlignment = stop;
}

/** Scroll the transcript so `target` sits at the viewport top: the anchored card
 *  first, its turn's prompt bubble only when that card is gone. Returns false
 *  when nothing could be located, so the caller can decline to mark it current.
 *
 *  A collapsed card is opened first and the offset read after that commit, so
 *  the jump is never measured against a height the card is about to lose. */
export function jumpToAnchor(threadEl: HTMLElement | null, target: JumpTarget): boolean {
  if (!threadEl) return false;
  const element = findTarget(threadEl, target);
  if (!element) return false;

  const land = (t: HTMLElement) => {
    landOn(threadEl, t);
    alignWhileSettling(threadEl, t);
  };
  const collapsed = target.anchor !== undefined && isCollapsed(element);
  // Always announced: a jump to a plain turn releases a card an earlier jump
  // forced open, so the reader's own collapses stay theirs.
  requestAnchorExpansion(target.anchor ?? null);

  if (!collapsed) {
    land(element);
    return true;
  }
  // A collapsed card opens on React's next commit. Re-resolve in that frame
  // instead of reusing the node: a gate resolving or a plan swapping in its live
  // card replaces the element, and the stale one is detached by then.
  requestAnimationFrame(() => {
    const settled = findTarget(threadEl, target);
    if (settled) land(settled);
  });
  return true;
}
