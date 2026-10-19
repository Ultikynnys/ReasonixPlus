/** Scrolling the transcript to a recorded event's location. Kept separate from
 *  the Events tab so the geometry (and its tests) do not depend on any panel
 *  rendering. */

/** Past this many viewports a smooth scroll takes seconds and any arriving token
 *  can interrupt it, so the jump lands at once instead. */
const JUMP_SMOOTH_MAX_VIEWPORTS = 3;

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

/** The scrollTop that brings an element's top edge to the viewport top. */
export function jumpTargetFor(offset: number, scrollHeight: number, clientHeight: number): number {
  return clamp(offset, 0, Math.max(0, scrollHeight - clientHeight));
}

/** Scroll the transcript so `target` sits at the viewport top: the anchored card
 *  first, its turn's prompt bubble only when that card is gone. Returns false
 *  when nothing could be located, so the caller can decline to mark it current.
 */
export function jumpToAnchor(threadEl: HTMLElement | null, target: JumpTarget): boolean {
  if (!threadEl) return false;
  const anchored = target.anchor ? findAnchorElement(threadEl, target.anchor) : null;
  const element =
    (anchored && hasLayout(anchored) ? anchored : null) ??
    (Number.isFinite(target.turn) && target.turn > 0
      ? findTurnElement(threadEl, target.turn)
      : null);
  if (!element) return false;
  // Read the element's offset at jump time: a streamed answer below it moves the
  // scroll range, not the element.
  const offset = element.getBoundingClientRect().top - threadEl.getBoundingClientRect().top;
  const targetScrollTop = jumpTargetFor(
    offset + threadEl.scrollTop,
    threadEl.scrollHeight,
    threadEl.clientHeight,
  );
  const far =
    Math.abs(targetScrollTop - threadEl.scrollTop) > threadEl.clientHeight * JUMP_SMOOTH_MAX_VIEWPORTS;
  threadEl.scrollTo({ top: targetScrollTop, behavior: far ? "instant" : "smooth" });
  return true;
}
