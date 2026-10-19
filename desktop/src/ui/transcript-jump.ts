/** Scrolling the transcript to a recorded event's location. Kept separate from
 *  the Events tab so the geometry (and its tests) do not depend on any panel
 *  rendering. */

/** How long a jump keeps re-pinning its target after it lands. A recorded event's
 *  card can mount a commit later (a segment still being appended, a gate being
 *  swapped for its answered form or for the live task card), a card above it can
 *  open, and an image can decode; each of those moves the target. Long enough to
 *  ride all of them out, short enough that a jump the reader has moved on from
 *  lets go on its own. */
const JUMP_HOLD_MS = 1_000;

/** How far the target may sit from the top before the hold re-pins it: less than
 *  this is sub-pixel layout noise, more is the target having moved. */
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

/** Ask the collapsible cards to open the one carrying `anchor` (and to release
 *  any card an earlier jump forced open). The state change lands on React's next
 *  commit, which the hold below re-pins after. */
export function requestAnchorExpansion(anchor: string | null): void {
  document.dispatchEvent(new CustomEvent(EXPAND_EVENT, { detail: anchor }));
}

/** What a target points at right now: the anchored card once it is laid out, else
 *  its turn's prompt bubble. Re-asked on every frame of a hold, because the card a
 *  record names can be missing when the jump starts and appear a commit later. */
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

/** Where the transcript has to scroll so the element's top edge sits at the top
 *  of the viewport. */
function landingScrollTop(threadEl: HTMLElement, element: HTMLElement): number {
  return jumpTargetFor(
    contentOffset(threadEl, element),
    threadEl.scrollHeight,
    threadEl.clientHeight,
  );
}

/** The one live hold: a fresh jump must not fight the previous one. */
let stopHold: (() => void) | null = null;

/** Let go of the transcript so the reader has it back (a new jump does this
 *  first, so a jump can never be pulled around by the one before it). */
export function endJumpAlignment(): void {
  stopHold?.();
  stopHold = null;
}

/**
 * Re-pin the target to the top of the viewport until the layout goes quiet.
 *
 * A jump cannot be a single measurement: the card it names can mount a commit
 * after the click, a card above it can open, an image can decode, and the browser
 * can clamp the offset when the tail shrinks (`overflow-anchor: none` on `.thread`
 * means nothing compensates). So each frame asks where the target is *now* and
 * corrects, which also covers a scroll the app makes behind us. It lets go on the
 * first reader gesture, when the transcript goes away, or when the window is up.
 */
function holdOnTarget(threadEl: HTMLElement, target: JumpTarget): void {
  endJumpAlignment();
  const deadline = performance.now() + JUMP_HOLD_MS;
  let stopped = false;
  let frame = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchstart", stop);
    window.removeEventListener("keydown", stop);
    window.removeEventListener("pointerdown", stop);
    if (stopHold === stop) stopHold = null;
  };

  const tick = (now: number) => {
    frame = 0;
    if (stopped) return;
    if (!threadEl.isConnected || now >= deadline) {
      stop();
      return;
    }
    const element = findTarget(threadEl, target);
    if (element) {
      const desired = landingScrollTop(threadEl, element);
      if (Math.abs(desired - threadEl.scrollTop) >= ALIGN_EPSILON) threadEl.scrollTop = desired;
    }
    frame = requestAnimationFrame(tick);
  };

  window.addEventListener("wheel", stop, { passive: true });
  window.addEventListener("touchstart", stop, { passive: true });
  window.addEventListener("keydown", stop);
  window.addEventListener("pointerdown", stop);
  stopHold = stop;
  frame = requestAnimationFrame(tick);
}

/** Scroll the transcript so `target` sits at the viewport top and hold it there
 *  while the layout settles. Lands on the event's own card, its turn's prompt
 *  bubble only while that card is missing. Returns false when nothing could be
 *  located, so the caller can decline to mark it current.
 *
 *  The landing itself is instant, never animated: a smooth scroll is one more
 *  thing that a later layout change can cancel or outrun, and one click has to be
 *  enough. */
export function jumpToAnchor(threadEl: HTMLElement | null, target: JumpTarget): boolean {
  if (!threadEl) return false;
  const element = findTarget(threadEl, target);
  if (!element) return false;
  // Not conditioned on the card looking collapsed: a jump is the reader asking to
  // see the event, and `useJumpOpen` ignores the ask for a card already open.
  requestAnchorExpansion(target.anchor ?? null);
  threadEl.scrollTo({ top: landingScrollTop(threadEl, element), behavior: "instant" });
  holdOnTarget(threadEl, target);
  return true;
}
