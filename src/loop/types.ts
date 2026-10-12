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
  /** Compaction is running — emitted before the auto/overflow compactNow so UIs
   *  can show progress for the silent summarization call. */
  | "compaction_start"
  /** Session edit (abort-discard) truncated the log mid-turn — carries the
   *  post-truncation log so the eventizer can emit session.retracted and the
   *  kernel conversation view stays replayable. */
  | "session_retracted";

/** "low" = chatty / self-correcting / counter — Desktop+Dashboard filter these out by default.
 *  Undefined / "high" = real event the user should see (abort, budget, rate-limit, etc.).
 *  TUI ignores this and renders every warning. */
export type EventSeverity = "low" | "high";

/** Stable machine tag for why a high-severity warning fired. Desktops key
 *  feedback cues (sounds/notifications) on this instead of matching text. */
export type WarningCause = "repetition-guard";

export interface LoopEvent {
  turn: number;
  role: EventRole;
  content: string;
  /** Model-generated image (assistant image output) — data URL + mime. */
  image?: { dataUrl: string; mimeType: string };
  severity?: EventSeverity;
  /** Machine-readable trigger tag on warnings, when the trigger is one of WarningCause. */
  cause?: WarningCause;
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
  /** Display-only — code-mode applier MUST skip SEARCH/REPLACE in placeholder text. */
  forcedSummary?: boolean;
  /** session_retracted: the pre-truncation / post-truncation message counts. */
  beforeMessages?: number;
  afterMessages?: number;
  /** session_retracted: the post-truncation log — lets the eventizer emit
   *  session.retracted so the kernel conversation view stays replayable. */
  replacementMessages?: ReadonlyArray<ChatMessage>;
  /** session_retracted: which session edit truncated or compacted the log. */
  sessionRetractedKind?: "retry" | "rewind" | "abort-discard" | "compact";
  /** compaction_start: which compaction path is running. */
  compactionTrigger?: "manual" | "auto" | "overflow";
}
