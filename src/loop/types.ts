import type { CompactionFoldPayload } from "@reasonix/core-utils";
import type { RepairReport } from "../repair/index.js";
import type { CacheDiagnosticEntry } from "../telemetry/cache-diagnostics.js";
import type { TurnStats } from "../telemetry/stats.js";
import type { ChatMessage } from "../types.js";

export type EventRole =
  | "assistant_delta"
  | "assistant_final"
  /** Only liveness signal during a large-args tool call (no content/reasoning bytes). */
  | "tool_call_delta"
  /** Pre-dispatch ping so the TUI can show a spinner during long tool awaits. */
  | "tool_start"
  | "tool"
  | "done"
  | "error"
  | "warning"
  /** Transient indicator for silent phases; UI clears on next primary event. */
  | "status"
  /** Mid-turn steer injected as queued user guidance without aborting the current turn. */
  | "steer"
  /** Compaction card lifecycle — mirrors tool_start/tool so UIs can render a
   *  compaction card in the same queue as tool cards. Start carries the reason,
   *  end carries the FoldResult. Never emitted without a matching end. */
  | "compaction_start"
  | "compaction_end"
  /** Session edit (abort-discard) truncated the log mid-turn — carries the
   *  post-truncation log so the eventizer can emit session.retracted and the
   *  kernel conversation view stays replayable. */
  | "session_retracted";

/** "low" = chatty / self-correcting / counter — Desktop+Dashboard filter these out by default.
 *  Undefined / "high" = real event the user should see (compaction, abort, budget, rate-limit, etc.).
 *  TUI ignores this and renders every warning. */
export type EventSeverity = "low" | "high";

/** compaction_end fold fields — names and docs live on CompactionFoldPayload
 *  (core-utils). foldError/foldWarn keep their prefixed names in LoopEvent
 *  (flat per-role bag) and map to payload `error`/`warn` in the eventizer. */
export type CompactionEndFoldFields = Partial<
  Pick<
    CompactionFoldPayload,
    | "folded"
    | "beforeMessages"
    | "afterMessages"
    | "summaryChars"
    | "summary"
    | "prunedFiles"
    | "prunedTokens"
    | "droppedFiles"
  >
>;

export interface LoopEvent extends CompactionEndFoldFields {
  turn: number;
  role: EventRole;
  content: string;
  /** Model-generated image (assistant image output) — data URL + mime. */
  image?: { dataUrl: string; mimeType: string };
  severity?: EventSeverity;
  reasoningDelta?: string;
  /** Complete reasoning snapshot, present on finals that replace streamed output. */
  reasoningContent?: string;
  /** Final content/reasoning supersedes deltas already rendered for this turn. */
  replaceStreamedOutput?: boolean;
  toolName?: string;
  /** Raw args JSON — needed by `reasonix diff` to explain why a tool was called. */
  toolArgs?: string;
  /** Cumulative arguments-string length for `role === "tool_call_delta"`. */
  toolCallArgsChars?: number;
  /** Zero-based index of the tool call this delta belongs to (multi-tool progress). */
  toolCallIndex?: number;
  /** Count of tool calls whose args have parsed as valid JSON (UI progress, not dispatch gate). */
  toolCallReadyCount?: number;
  /** Stable id for tool_start / tool pairs — also the inflight-set key. UI uses this as the card id so it can derive `running` from `loop.inflight.has(callId)` instead of trusting end-event delivery. */
  callId?: string;
  stats?: TurnStats;
  /** Per-turn local cache evidence — prefix hashes + inferred miss reason. Surfaced
   *  on assistant_final; DeepSeek reports token counts, Reasonix+ infers reasons. */
  cacheDiagnostic?: CacheDiagnosticEntry;
  repair?: RepairReport;
  error?: string;
  errorDetail?: {
    name: string;
    message: string;
    code?: string;
    phase?: string;
    retryable: boolean;
    recoverable: boolean;
  };
  /** Display-only — code-mode applier MUST skip SEARCH/REPLACE in forced-summary text. */
  forcedSummary?: boolean;
  /** Stable id pairing compaction_start with its compaction_end — the UI keys the card by it. */
  compactionId?: string;
  /** Why the fold runs — "user" = a user-triggered compaction, "auto-context-pressure" = loop-internal fold. */
  compactionReason?: "user" | "auto-context-pressure";
  /** What kind of compaction runs — "fold" (head folded into a summary message) vs
   *  "force-summary" (log trimmed + summarized in place under the context guard).
   *  Carried on both compaction_start and compaction_end. */
  compactionKind?: "fold" | "force-summary";
  /** compaction_end with folded=true: the post-fold message log — lets the eventizer
   *  emit session.compacted so the kernel conversation view stays replayable after
   *  the log replacement. */
  replacementMessages?: ReadonlyArray<ChatMessage>;
  /** True when the fold is in the 70-85% aggressive band — user-facing messaging. */
  aggressive?: boolean;
  /** session_retracted: which session edit truncated the log. */
  sessionRetractedKind?: "retry" | "rewind" | "abort-discard";
  /** compaction_end: why the fold didn't happen (payload `error`), when the summarizer failed. */
  foldError?: string;
  /** compaction_end: advisory warning on a successful fold (payload `warn`) — e.g. file triage failed, nothing dropped. */
  foldWarn?: string;
}
