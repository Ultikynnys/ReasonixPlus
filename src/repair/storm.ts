import type { ToolCall } from "../types.js";

/** Mutating calls clear prior read-only entries so a post-edit re-read isn't flagged as repeat. */
export type IsMutating = (call: ToolCall) => boolean;
export type IsStormExempt = (call: ToolCall) => boolean;

/** Consecutive failures of ONE tool before the breaker steers the model to
 *  another tool. Keyed on name only, so five errors with different args still
 *  trip — the case that would otherwise re-try a broken call until the turn ends. */
export const DEFAULT_FAILURE_LIMIT = 5;

interface RecentEntry {
  name: string;
  args: string;
  readOnly: boolean;
}

/** Tracks (name, args) repeats; mutating calls clear read-only entries. Exempt tools are counted separately so a long identical-args repeat still reads as a stuck loop without disturbing non-exempt detection. */
export class StormBreaker {
  private readonly windowSize: number;
  private readonly threshold: number;
  /** Identical exempt-call repeats before that tool trips the storm (defaults to
   *  the window — a window's worth of the same inspection call is a loop). */
  private readonly exemptLimit: number;
  private readonly isMutating: IsMutating | undefined;
  private readonly isStormExempt: IsStormExempt | undefined;
  private readonly failureLimit: number;
  private readonly recent: RecentEntry[] = [];
  /** Key of the previous exempt call and its consecutive repeat count — a
   *  different call resets the run so sparse re-reads never falsely trip. */
  private exemptRunKey: string | null = null;
  private exemptRunCount = 0;
  /** Name of the tool and length of its current unbroken failure run. A success
   *  by that tool, or a different tool taking over, resets the run. */
  private failureName: string | null = null;
  private failureCount = 0;

  constructor(
    windowSize = 6,
    threshold = 3,
    isMutating?: IsMutating,
    isStormExempt?: IsStormExempt,
    failureLimit = DEFAULT_FAILURE_LIMIT,
  ) {
    this.windowSize = windowSize;
    this.threshold = threshold;
    this.exemptLimit = windowSize;
    this.isMutating = isMutating;
    this.isStormExempt = isStormExempt;
    this.failureLimit = failureLimit;
  }

  inspect(call: ToolCall): { suppress: boolean; reason?: string; kind?: "repeat" | "failure" } {
    const name = call.function?.name;
    if (!name) return { suppress: false };
    // Failure-aware trip first: a tool that keeps erroring is stuck just as
    // surely as a byte-identical repeat, and this is the case that otherwise
    // re-tries the same broken call until the whole turn is spent.
    if (this.failureName === name && this.failureCount >= this.failureLimit) {
      return {
        suppress: true,
        kind: "failure",
        reason: `${name} failed ${this.failureCount} times in a row — try a different tool or approach`,
      };
    }
    const exempt = this.isStormExempt?.(call) ?? false;
    const args = call.function?.arguments ?? "";
    const mutating = this.isMutating ? this.isMutating(call) : false;
    const readOnly = !mutating;

    if (mutating) {
      // Drop prior read-only entries — the file/shell state just changed, so a
      // verify-read after this should start with a clean slate. Keep mutator
      // entries: 3 identical edits in a row is still a storm (model in a loop).
      for (let i = this.recent.length - 1; i >= 0; i--) {
        if (this.recent[i]!.readOnly) this.recent.splice(i, 1);
      }
      // Same for the exempt counter — a re-read after a write is a fresh
      // verify, not the continuation of a stuck loop.
      this.exemptRunKey = null;
      this.exemptRunCount = 0;
    }

    if (exempt) {
      // Exempt inspection tools live in their own counter — they don't consume
      // shared-window slots, but a CONSECUTIVE identical-args repeat that fills
      // the whole window still reads as a stuck loop. A different call (or a
      // mutating call above) resets the run, so sparse re-reads never falsely
      // trip.
      const key = `${name}::${args}`;
      const count = key === this.exemptRunKey ? this.exemptRunCount + 1 : 1;
      if (count >= this.exemptLimit) {
        return {
          suppress: true,
          kind: "repeat",
          reason: `${name} called with identical args ${count} times — repeat-loop guard tripped`,
        };
      }
      this.exemptRunKey = key;
      this.exemptRunCount = count;
      return { suppress: false };
    }

    const count = this.recent.reduce((n, e) => (e.name === name && e.args === args ? n + 1 : n), 0);
    if (count >= this.threshold - 1) {
      return {
        suppress: true,
        kind: "repeat",
        reason: `${name} called with identical args ${count + 1} times — repeat-loop guard tripped`,
      };
    }
    this.recent.push({ name, args, readOnly });
    while (this.recent.length > this.windowSize) this.recent.shift();
    return { suppress: false };
  }

  /** Records a settled tool result so consecutive failures of one tool
   *  accumulate. A success by that tool, or any call to a different tool,
   *  resets the run — only an unbroken streak trips the guard. */
  noteResult(name: string | undefined, failed: boolean): void {
    if (!name) return;
    if (this.failureName !== name) {
      this.failureName = failed ? name : null;
      this.failureCount = failed ? 1 : 0;
      return;
    }
    if (failed) {
      this.failureCount++;
    } else {
      this.failureName = null;
      this.failureCount = 0;
    }
  }

  reset(): void {
    this.recent.length = 0;
    this.exemptRunKey = null;
    this.exemptRunCount = 0;
    this.failureName = null;
    this.failureCount = 0;
  }
}
