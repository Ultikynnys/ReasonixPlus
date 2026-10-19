import { flattenText, messageOf, sleep } from "@reasonix/core-utils";
import { type DeepSeekClient, Usage } from "./client.js";
import { claimingSession } from "./code/plan-claim.js";
import { type PlanRepository, planRepository } from "./code/plans.js";
import {
  type EditMode,
  type ReasoningEffort,
  clampAutoCompactTrigger,
  providerForModel,
} from "./config.js";
import { tryParseJson } from "./core/parse-json.js";
import type { PauseGate } from "./core/pause-gate.js";
import { pauseGate as defaultPauseGate } from "./core/pause-gate.js";
import { type ResolvedHook, runHooks } from "./hooks.js";
import { DEFAULT_MAX_RESULT_CHARS, DEFAULT_MAX_RESULT_TOKENS } from "./mcp/registry.js";

import { InflightSet } from "./core/inflight.js";
import { t } from "./i18n/index.js";
import {
  AUTO_COMPACT_TRIGGER_RATIO,
  COMPACT_TARGET_RATIO,
  type CompactionPlan,
  type CompactionResult,
  SUMMARIZER_OUTPUT_HEADROOM,
  buildCompactionRequest,
  buildVerificationRequest,
  compactionSummaryBody,
  planCompaction,
  renderDeterministic,
  renderWithSummary,
} from "./loop/compaction.js";
import { contentPartsToString, dispatchToolCallsChunked } from "./loop/dispatch.js";
import {
  errorMeta,
  formatLoopError,
  is4xxError,
  is5xxError,
  isContextOverflowError,
  isDeepSeekHost,
  isNetworkConnectionError,
  isReasoningRoundTripError,
  isUpstreamBareRefusal,
  probeDeepSeekReachable,
  waitForReconnection,
} from "./loop/errors.js";
import {
  fixToolCallPairing,
  healLoadedMessages,
  healLoadedMessagesByTokens,
  stampMissingReasoningForThinkingMode,
} from "./loop/healing.js";
import { hookWarnings, safeParseToolArgs } from "./loop/hook-events.js";
import {
  type ShrinkLevel,
  isPayloadTooLargeError,
  pruneOldImageParts,
  shrinkImagePartsForRetry,
} from "./loop/image-retry.js";
import { buildAssistantMessage, buildSyntheticAssistantMessage } from "./loop/messages.js";
import { looksCutOffMidSentence, looksLikePrematureStop } from "./loop/premature-stop.js";
import { stripDroppableReasoningContent } from "./loop/reasoning-retention.js";
import {
  looksLikeCompleteJson,
  shrinkOversizedToolCallArgsByTokens,
  shrinkOversizedToolResults,
  shrinkOversizedToolResultsByTokens,
} from "./loop/shrink.js";
import { streamModelResponse } from "./loop/streaming.js";
import {
  extractThinkingTags,
  isThinkingModeModel,
  stripHallucinatedToolMarkup,
  thinkingModeForModel,
} from "./loop/thinking.js";
import type { LoopEvent, WarningCause } from "./loop/types.js";
import { AppendOnlyLog, type ImmutablePrefix, VolatileScratch } from "./memory/runtime.js";
import {
  appendSessionMessage,
  archiveSession,
  checkpointSessionMessages,
  loadSessionMessages,
  loadSessionMeta,
  patchSessionMeta,
  rewriteSession,
  stampTranscriptMessage,
} from "./memory/session.js";
import { ToolCallRepair } from "./repair/index.js";
import {
  type PrefixDiagnosticHashes,
  appendCacheDiagnostic,
  buildCacheDiagnostic,
  latestCacheDiagnostic,
} from "./telemetry/cache-diagnostics.js";
import {
  type BillingContext,
  type BillingKind,
  type CacheDiagnostics,
  SessionStats,
  type TurnStats,
  billingContextForModel,
  resolveContextTokens,
} from "./telemetry/stats.js";
import {
  countTokensBounded,
  estimateConversationTokens,
  estimateRequestTokens,
  tokensForMessage,
} from "./tokenizer.js";
import { ToolRegistry, isReadOnlyTool } from "./tools.js";
import { ReadTracker } from "./tools/read-tracker.js";
import { USER_CANCEL_NOTE } from "./tools/shell.js";
import type { ChatMessage, ToolCall, ToolSpec, TurnImage, UserContentPart } from "./types.js";

export const PROVIDER_SERVER_ERROR_RETRY_DELAY_MS = 10_000;
/** Backoff before replaying a request a gateway refused without naming a field. */
export const UPSTREAM_REFUSAL_RETRY_DELAY_MS = 1_500;

/** A refusal-recovery fold aims at this fraction of the refused request size. */
const REFUSAL_FOLD_RATIO = 0.6;
/** A prompt below this is not plausibly the reason, so recovery only replays it. */
const REFUSAL_FOLD_MIN_TOKENS = 20_000;
export const MID_TURN_STEER_WRAPPER =
  "[Mid-turn steer queued by the user. Do not treat this as a new task; use it only as additional guidance for the current task after completing the current step.]";

function formatSteerUserMessage(content: string): string {
  return [MID_TURN_STEER_WRAPPER, content].join("\n");
}

/** Backoff that never turns a user abort into a spurious provider error. */
async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  try {
    await sleep(ms, signal);
  } catch (delayError) {
    if (!signal.aborted) throw delayError;
  }
}

/** finish_reason from a non-streaming chat-completions response body
 *  ("length" = output-token cutoff, like the streaming path's chunk field). */
function chatFinishReason(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const choice = (raw as { choices?: Array<{ finish_reason?: unknown }> }).choices?.[0];
  return typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
}

/** Coerce caller-supplied images (plain data URLs or richer descriptors) into
 *  TurnImage descriptors. */
function toTurnImages(images?: ReadonlyArray<string | TurnImage>): TurnImage[] {
  if (!images) return [];
  return images.map((d) => (typeof d === "string" ? { url: d } : d));
}

/** User content for the log/request: plain text when no images are attached
 *  (prefix-cache stable); content parts when they are — image URLs for the
 *  vision API plus source file paths so the agent can open/modify them. */
function buildUserContent(
  text: string,
  images?: ReadonlyArray<TurnImage>,
): string | UserContentPart[] {
  if (!images || images.length === 0) return text;
  const parts: UserContentPart[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  const paths = images.filter((d) => d.path).map((d) => d.path as string);
  if (paths.length > 0) {
    parts.push({
      type: "text",
      text: `Attached file(s) — you can open and modify these with your file tools:\n${paths.map((p) => `- ${p}`).join("\n")}`,
    });
  }
  for (const d of images) {
    const kind = d.kind ?? "image";
    if (kind === "audio") {
      parts.push({ type: "input_audio", input_audio: { data: d.url } });
    } else if (kind === "video") {
      parts.push({
        type: "video_url",
        video_url: { url: d.url },
        fps: d.fps ?? 2,
        media_resolution: d.mediaResolution ?? "default",
      });
    } else {
      parts.push({ type: "image_url", image_url: { url: d.url, detail: "low" } });
    }
  }
  return parts;
}

/** Turn ordinal for a resumed session: the count of REAL user records. Steer/nudge records
 *  are marked `synthetic` (never a turn start), so the counter matches the desktop's
 *  user-position numbering even with failed turns (no reply) or tool loops (many records). */
export function resumeTurnBaseline(messages: readonly ChatMessage[]): number {
  return messages.reduce((n, m) => (m.role === "user" && !m.synthetic ? n + 1 : n), 0);
}

export {
  fixToolCallPairing,
  formatLoopError,
  healLoadedMessages,
  healLoadedMessagesByTokens,
  isThinkingModeModel,
  looksLikeCompleteJson,
  shrinkOversizedToolCallArgsByTokens,
  shrinkOversizedToolResults,
  shrinkOversizedToolResultsByTokens,
  stampMissingReasoningForThinkingMode,
  stripHallucinatedToolMarkup,
  thinkingModeForModel,
};
export type { EventRole, LoopEvent } from "./loop/types.js";

export interface CacheFirstLoopOptions {
  client: DeepSeekClient;
  prefix: ImmutablePrefix;
  tools?: ToolRegistry;
  model?: string;
  stream?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** Per-turn output token cap passed as `max_tokens`. Undefined = no cap (server default). */
  maxOutputTokens?: number;
  /** Maximum tool-call iterations per turn. Overrides config/env. Default 50. */
  maxIterPerTurn?: number;
  /** Live edit-mode getter, never-ask never pauses on the iteration cap. Thunk
   *  (not a snapshot) so a mid-session Shift+Tab flip takes effect, same
   *  pattern as shell.ts's `allowAll`. */
  getEditMode?: () => EditMode;
  /** Resolves provider and native billing unit from endpoint/config evidence. */
  billingContextFor?: (model: string) => Omit<BillingContext, "at">;
  /** @deprecated Compatibility hook. Prefer billingContextFor. */
  billingKindFor?: (model: string) => BillingKind;
  /** User-configured context-window cap (tokens). Undefined = per-model default.
   *  Hot-applied via configure(). */
  ctxMaxOverride?: number;
  /** Auto-compact the conversation before a turn once the estimated request
   *  reaches the trigger ratio of the context window. Defaults to true. */
  autoCompact?: boolean;
  /** Fraction of the context window at which auto-compaction fires. Defaults
   *  to AUTO_COMPACT_TRIGGER_RATIO; clamped to [0.5, 0.95]. */
  autoCompactTriggerRatio?: number;
  session?: string;
  /** PreToolUse + PostToolUse only — UserPromptSubmit / Stop live at the App boundary. */
  hooks?: ResolvedHook[];
  /** `cwd` reported to hooks; `reasonix code` sets this to the sandbox root, not shell home. */
  hookCwd?: string;
  /** PauseGate bridge — defaults to singleton, injectable for tests. */
  confirmationGate?: PauseGate;
  /** Re-runs the prompt builder (applyMemoryStack / codeSystemPrompt) on a new session so REASONIX.md edits take effect without a restart. Accepting a cache miss is the price. */
  rebuildSystem?: () => string;
  /** When true, the stream repetition / "stuck re-thinking" guard may abort a degenerating stream. Defaults to false (opt-in). */
  repetitionGuardEnabled?: boolean;
  /** In-memory floor for the turn counter across runtime rebuilds. Combined
   *  with session-meta `lastTurn`, ordinals never regress. */
  turnFloor?: number;
}

export interface ReconfigurableOptions {
  model?: string;
  stream?: boolean;
  /** V4 thinking mode only; deepseek-chat ignores. */
  reasoningEffort?: ReasoningEffort;
  /** Per-turn output token cap. Pass null to clear. */
  maxOutputTokens?: number | null;
  /** Context-window cap override (tokens); undefined = per-model default. `null` = clear a set override. */
  ctxMaxOverride?: number | null;
  /** Toggle pre-turn auto-compaction. undefined = keep current. */
  autoCompact?: boolean;
  /** Auto-compaction trigger fraction; `null` = reset to default. undefined = keep current. */
  autoCompactTriggerRatio?: number | null;
  /** Per-turn iteration cap; undefined = keep current, `null` = reset to default (50). */
  maxIterPerTurn?: number | null;
  /** Toggle the stream repetition / "stuck re-thinking" guard. undefined = keep current. */
  repetitionGuardEnabled?: boolean | null;
}

export interface LoopAbortOptions {
  /** Explicit user interrupts can discard the unfinished turn so the next prompt starts clean. */
  discardCurrentTurn?: boolean;
}

export type CompactionTrigger = "auto" | "manual" | "overflow";

/** Notice key for each refusal-recovery step; a union so a typo fails to compile
 *  instead of `t()` quietly rendering the key path. */
export type UpstreamRefusalNoticeKey =
  | "loop.upstreamRefusalRetry"
  | "loop.upstreamRefusalTrimming"
  | "loop.upstreamRefusalCompacting";

export interface CompactionOutcome {
  status: "done" | "noop";
  trigger: CompactionTrigger;
  /** "summary" = LLM rolling summary; "fold" = deterministic dropped-work fold. */
  method?: "summary" | "fold";
  tokensBefore?: number;
  tokensAfter?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  /** On-disk pre-compaction checkpoint, when a session is attached. */
  checkpoint?: string | null;
  /** session_retracted + notice events, for callers to forward to their UI. */
  events: LoopEvent[];
}

interface CacheShapeSnapshot {
  systemHash: string;
  toolsHash: string;
  fewShotsHash: string;
  prefixHash: string;
  logRewriteVersion: number;
  toolSchemaTokens: number;
}

/** Index of the last user prompt — everything above it is the outgoing turn. */
function lastUserIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return i;
  }
  return 0;
}

/** Escalating synthetic prompts for a model that stops right after thinking.
 *  Each stage changes the request rather than replaying one the model already
 *  declined to answer; the last stage hands the model its own reasoning back. */
const THINKING_ONLY_NUDGES = [
  { prompt: "loop.thinkingOnlyNudge", warning: "loop.thinkingOnlyNudgeWarning" },
  { prompt: "loop.thinkingOnlyReasoningNudge", warning: "loop.thinkingOnlyReasoningNudgeWarning" },
] as const;

/** Cap on the reasoning inlined into a recovery nudge — a thinking dump runs to
 *  tens of KB, and pasting it whole can push the retry into context overflow. */
const THINKING_ONLY_REASONING_CHARS = 16_000;

function truncateReasoning(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= THINKING_ONLY_REASONING_CHARS) return trimmed;
  return `${trimmed.slice(0, THINKING_ONLY_REASONING_CHARS)}\n\n[reasoning truncated — answer from what is above]`;
}

function shrinkMessageForRetention(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
  return (
    shrinkOversizedToolCallArgsByTokens([message], DEFAULT_MAX_RESULT_TOKENS).messages[0] ?? message
  );
}

export class CacheFirstLoop {
  readonly client: DeepSeekClient;
  readonly prefix: ImmutablePrefix;
  readonly tools: ToolRegistry;
  readonly log = new AppendOnlyLog();
  readonly scratch = new VolatileScratch();
  readonly stats = new SessionStats();
  readonly repair: ToolCallRepair;
  /** Hard iteration cap per turn — prevents runaway tool-call loops from
   *  burning unlimited API budget. Override via REASONIX_MAX_ITER env var. */
  static readonly DEFAULT_MAX_ITER_PER_TURN = 50;
  /** Output-token-truncation continuations allowed per turn — a model stuck
   *  regenerating a partial answer must not loop forever. */
  static readonly MAX_TRUNCATION_CONTINUATIONS = 3;
  /** Recovery attempts for a gateway refusal that names no offending field
   *  (replay, request-only fold, durable fold) before the error surfaces. */
  static readonly MAX_UPSTREAM_REFUSAL_RECOVERIES = 3;
  /** Reasoner-contract repairs per turn — back-fill `reasoning_content` on the
   *  bare assistant turns a thinking-mode endpoint demands back, then re-send. */
  static readonly MAX_REASONING_REPAIRS = 2;
  /** Escalating recoveries for a thinking-only completion (reasoning, no content,
   *  no tool call): replay the stop, nudge for an answer, then hand the reasoning
   *  back before the turn falls back to showing that reasoning. */
  static readonly MAX_THINKING_ONLY_RECOVERIES = 3;
  /** Consecutive identical-reasoning iterations before the reasoning-loop guard
   *  collapses the turn to a forced summary. */
  static readonly REASONING_LOOP_LIMIT = 3;
  /** Premature-stop nudges per turn — a model that always answers in
   *  fragments can't loop forever. */
  static readonly MAX_PREMATURE_STOP_NUDGES = 2;
  /** Files the model has read this session; gates edit_file / multi_edit so SEARCH text matches on-disk bytes. Cleared on mechanical truncate (the model's byte-level view of the elided history is gone). In-memory only — naturally empty on resume. */
  readonly readTracker = new ReadTracker();

  // Mutable via configure() — slash commands in the TUI / library callers tweak
  // these mid-session so users don't have to restart.
  model: string;
  stream: boolean;
  reasoningEffort: ReasoningEffort;
  /** Per-turn output token cap (max_tokens). Undefined = no cap. */
  maxOutputTokens: number | undefined;
  /** Maximum tool-call iterations per turn. Config > env > default (50). */
  maxIterPerTurn: number;
  /** Context-window cap override (tokens) — mutable via configure(); undefined = per-model default. */
  ctxMaxOverride: number | undefined;
  /** Pre-turn auto-compaction toggle. */
  autoCompact: boolean;
  /** Auto-compaction trigger fraction (clamped to [0.5, 0.95]). */
  autoCompactTriggerRatio: number;
  sessionName: string | null;

  hooks: ResolvedHook[];
  hookCwd: string;

  /** PauseGate bridge — defaults to singleton, injectable for tests. */
  readonly confirmationGate: PauseGate;

  /** Number of messages that were pre-loaded from the session file. */
  readonly resumedMessageCount: number;

  private readonly _rebuildSystem: (() => string) | null;

  /** Provider and native billing resolver. Timestamp is attached at request completion. */
  private readonly _billingContextFor: (model: string) => Omit<BillingContext, "at">;

  private _turn = 0;
  private _streamPreference: boolean;
  /** Threaded through HTTP + every tool dispatch so Esc cancels in-flight work, not after. */
  private _turnAbort: AbortController = new AbortController();
  /** True once the first step() iteration has begun. Distinguishes a carry-worthy
   *  pre-first-step abort (subagent attach race) from a stale post-completion abort
   *  that belonged to an already-finished turn and must be dropped. */
  private _stepStarted = false;
  private _discardAbortRequested = false;
  /** Per-tool-call aborts keyed by inflight id — a TUI Stop click cancels exactly the card's own tool. Cleaned in runOneToolCall's finally. */
  private readonly _toolCancelControllers = new Map<string, AbortController>();
  /** Most-recently-started controller — Ctrl+K / desktop Stop target "the running tool" without a callId. */
  private _lastToolCancelController: AbortController | null = null;
  /** Authoritative running-id set — UI cards consult this instead of trusting end-event delivery. Insert at dispatch entry, delete in finally. */
  private readonly _inflight = new InflightSet();
  /** Dispatched call ids whose results have not been appended. A force-closed
   *  turn (desktop Send now / queue force) abandons these mid-dispatch; they
   *  stay behind so the next step can stub them as cancellations. */
  private readonly _abandonedCalls = new Set<string>();

  /** Typeahead steer messages set by the UI; step() consumes one at each iter boundary. */
  private readonly _steerQueue: string[] = [];

  /** Set true when a steer was consumed this turn; cleared on next step() entry. */
  private _steerConsumed = false;

  /** Turn images — data URLs for the vision API plus source file paths. URLs
   *  reach see_image's ctx; paths are surfaced in the user message so the
   *  agent can open/modify the source files. */
  private _turnImages: readonly TurnImage[] = [];

  /** UI calls this to inject a mid-turn steer message without aborting the current turn.
   *  New text resets steerConsumed because a fresh steer is queued. */
  steer(text: string | null): void {
    if (text === null) {
      this._steerQueue.length = 0;
      return;
    }
    this._steerQueue.push(text);
    this._steerConsumed = false;
  }

  /** True when a steer was consumed this turn (UI gate to avoid double-submit). */
  get steerConsumed(): boolean {
    return this._steerConsumed;
  }

  private _turnSelfCorrected = false;
  /** Failure-driven self-corrects this turn. Capped at 3 so a model that keeps
   *  calling a broken tool can't loop forever, while still outlasting the single
   *  repeat-driven self-correct. */
  private _failureSteers = 0;
  /** Grace-window size granted when the iter cap fires on a productive turn. Set once per turn, at first fire. */
  private _iterGrace = 0;
  /** True once the cap fired and the grace window latched this turn. The hard stop moves to maxIterPerTurn + _iterGrace. */
  private _iterGraceApplied = false;
  /** True once a never-ask turn bypassed the cap, the cap block is skipped for the rest of the turn. */
  private _iterCapBypassed = false;
  /** Live edit-mode getter — hosts that don't pass it keep the default pause. */
  private readonly _getEditMode: (() => EditMode) | undefined;
  /** Latched once per turn — the empty-completion guard retries exactly once. */
  private _emptyResponseRetried = false;
  /** Count of thinking-only recoveries this turn — each stage changes the
   *  request so a model that stops after thinking gets a reason to answer. */
  private _thinkingOnlyRecoveries = 0;
  /** True when a thinking-only retry appended a partial assistant message to the log
   *  that must be replaced by the subsequent answer or discarded on give-up. */
  private _thinkingOnlyPartialAppended = false;
  /** Latched once per turn — replay one provider failure before any output reached the UI. */
  private _providerErrorRetried = false;
  /** Count of network disconnect wait-and-reconnect attempts this turn. */
  private _networkReconnects = 0;
  /** Count of output-token-truncation continuations this turn — caps the resume loop. */
  private _truncationContinuations = 0;
  /** Count of premature-stop nudges this turn — caps the finish-or-continue re-prompt loop. */
  private _prematureStopNudges = 0;
  /** Image-shrink retries after a provider rejected the request body as too
   *  large — caps the shrink-and-retry heal before the error surfaces. */
  private _compactRecoveries = 0;
  private _payloadShrinkAttempts = 0;
  /** Recovery stage for a field-less gateway refusal this turn (0 = none). */
  private _refusalRecoveryStage = 0;
  /** Repairs after a thinking-mode endpoint rejected a bare assistant turn
   *  (`reasoning_content` not passed back) — caps the stamp-and-resend ladder. */
  private _reasoningRepairs = 0;
  /** Latched once the endpoint proves it wants `reasoning_content` on every
   *  assistant turn: stale-reasoning pruning then has to stay off, or the
   *  repair and the prune would undo each other on every send. */
  private _reasoningRoundTripRequired = false;
  /** Request-only fold target (tokens) installed by the refusal ladder. The
   *  log keeps its full history; only the outgoing copy is folded, so a retried
   *  request is smaller while the transcript the user sees stays complete. */
  private _requestFoldTarget: number | null = null;
  /** Mid-turn auto-compactions this turn — bounds the per-iteration recheck so
   *  a fold that still leaves the estimate over the trigger can't compact on
   *  every remaining iteration. */
  private _midTurnCompacts = 0;
  /** Normalized reasoning text from the previous iteration — detects a model
   *  re-thinking the identical thought (a reasoning-only loop) when tool args
   *  drift so the storm breaker can't fire. */
  private _lastReasoningSig: string | null = null;
  /** Consecutive iterations with the same reasoning sig and no content. */
  private _reasoningLoopCount = 0;
  /** Prefix-shape snapshot of the last sent request — next turn's churn is attributed against it. */
  private _lastCacheShape: CacheShapeSnapshot | null = null;
  /** When true, the stream repetition / "stuck re-thinking" guard is active. */
  private _repetitionGuardEnabled: boolean;
  /** Cached log token total for Desktop's context meter — invalidated on any log mutation. */
  private _logTokensCache: { version: number; tokens: number } | null = null;

  /** Subscribe API so UI hooks can derive `running` from finally-guaranteed insertions. */
  get inflight(): InflightSet {
    return this._inflight;
  }

  get currentTurn(): number {
    return this._turn;
  }

  /** When true, the stream repetition / "stuck re-thinking" guard may abort a degenerating stream. */
  get repetitionGuardEnabled(): boolean {
    return this._repetitionGuardEnabled;
  }

  constructor(opts: CacheFirstLoopOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix;
    this.tools = opts.tools ?? new ToolRegistry();
    this.model = opts.model ?? "deepseek-v4-flash";
    this.reasoningEffort = opts.reasoningEffort ?? "high";
    this.maxOutputTokens = opts.maxOutputTokens;
    this.maxIterPerTurn = opts.maxIterPerTurn ?? CacheFirstLoop.DEFAULT_MAX_ITER_PER_TURN;
    this._getEditMode = opts.getEditMode;
    this._repetitionGuardEnabled = Boolean(opts.repetitionGuardEnabled);
    this.ctxMaxOverride = opts.ctxMaxOverride;
    this.autoCompact = opts.autoCompact ?? true;
    this.autoCompactTriggerRatio = clampAutoCompactTrigger(
      opts.autoCompactTriggerRatio ?? AUTO_COMPACT_TRIGGER_RATIO,
    );

    this.hooks = opts.hooks ?? [];
    this.hookCwd = opts.hookCwd ?? process.cwd();
    this.confirmationGate = opts.confirmationGate ?? defaultPauseGate;
    this._rebuildSystem = opts.rebuildSystem ?? null;
    this._billingContextFor =
      opts.billingContextFor ??
      ((model) => {
        const resolved = billingContextForModel(model);
        return opts.billingKindFor
          ? { kind: opts.billingKindFor(model), provider: resolved.provider }
          : resolved;
      });
    this._streamPreference = opts.stream ?? true;
    this.stream = this._streamPreference;

    const allowedNames = new Set([...this.prefix.toolSpecs.map((s) => s.function.name)]);
    // Storm breaker clears its window on mutating calls so read → edit → verify isn't a storm.
    const registry = this.tools;
    const isStormExempt = (call: ToolCall): boolean => {
      const name = call.function?.name;
      if (!name) return false;
      return registry.get(name)?.stormExempt === true;
    };
    this.repair = new ToolCallRepair({
      allowedToolNames: allowedNames,
      isMutating: (call) => this.isMutating(call),
      isStormExempt,
      stormThreshold: parsePositiveIntEnv(process.env.REASONIX_STORM_THRESHOLD),
      stormWindow: parsePositiveIntEnv(process.env.REASONIX_STORM_WINDOW),
    });

    // Heal-on-load: oversized tool results would 400 the next call before the user types.
    this.sessionName = opts.session ?? null;
    // Turn floor applies even session-less: a runtime rebuild of a tab that
    // lost its session must not regress either.
    let metaTurnFloor = 0;
    if (this.sessionName) {
      metaTurnFloor = loadSessionMeta(this.sessionName).lastTurn ?? 0;
    }
    if (metaTurnFloor > 0 || (opts.turnFloor ?? 0) > 0) {
      this._turn = Math.max(this._turn, metaTurnFloor, opts.turnFloor ?? 0);
    }
    if (this.sessionName) {
      const prior = loadSessionMessages(this.sessionName);
      const shrunk = healLoadedMessagesByTokens(prior, DEFAULT_MAX_RESULT_TOKENS);
      const stamped = stampMissingReasoningForThinkingMode(shrunk.messages, this.model);
      const pruned = stripDroppableReasoningContent(stamped.messages);
      const messages = pruned.messages;
      const healedCount = shrunk.healedCount + stamped.stampedCount;
      const tokensSaved = shrunk.tokensSaved;
      for (const msg of messages) this.log.append(msg);
      this.resumedMessageCount = messages.length;
      // Floor on the pre-computed meta/rebuild floors: resumeTurnBaseline
      // counts user records in the current log, which regresses after a log
      // rewrite and let a rebuilt runtime reissue ordinals the desktop
      // already rendered.
      this._turn = Math.max(this._turn, resumeTurnBaseline(messages));
      // Carry forward cumulative cost / turn count so the TUI's session
      // total continues across resumes; otherwise each restart resets to $0.
      if (messages.length > 0) {
        const meta = loadSessionMeta(this.sessionName);
        this.stats.seedCarryover({
          totalCostUsd: meta.totalCostUsd,
          turnCount: meta.turnCount,
          cacheHitTokens: meta.cacheHitTokens,
          cacheMissTokens: meta.cacheMissTokens,
          totalCompletionTokens: meta.totalCompletionTokens,
          lastPromptTokens: meta.lastPromptTokens,
          costByProvider: meta.costByProvider,
        });
      }
      if (healedCount > 0 || pruned.prunedCount > 0) {
        // Persist healed log so the same break isn't re-noticed every restart.
        this.persistLog(messages);
        if (healedCount > 0) {
          process.stderr.write(
            `▸ session "${this.sessionName}": healed ${healedCount} entr${healedCount === 1 ? "y" : "ies"}${tokensSaved > 0 ? ` (shrunk ${tokensSaved.toLocaleString()} tokens of oversized tool output/arguments)` : " (dropped dangling tool_calls tail)"}. Rewrote session file.\n`,
          );
        }
      }
    } else {
      this.resumedMessageCount = 0;
    }
  }

  /** Real-time token count of the current log — forwarded to Desktop for meter refresh.
   *  Cached against the log version so repeated meter polls don't re-tokenize the whole log. */
  getCurrentLogTokens(): number {
    if (this._logTokensCache && this._logTokensCache.version === this.log.version) {
      return this._logTokensCache.tokens;
    }
    let total = 0;
    for (const m of this.log.entries) total += tokensForMessage(m, false);
    this._logTokensCache = { version: this.log.version, tokens: total };
    return total;
  }

  /** Detach every persistence path before an active session is deleted. The
   * in-flight generator may still unwind after abort, but can no longer recreate
   * the removed folder through an append, rewrite, or stats update. */
  detachSessionPersistence(): void {
    this.sessionName = null;
  }

  appendAndPersist(message: ChatMessage): void {
    const retained = stampTranscriptMessage(shrinkMessageForRetention(message));
    this.log.append(retained);
    if (this.sessionName) {
      try {
        appendSessionMessage(this.sessionName, retained);
      } catch (err) {
        // Disk full or permission denied shouldn't kill the chat — but the
        // failure must be LOUD, never a silent drop of the on-disk transcript.
        process.stderr.write(`reasonix: session append failed — ${messageOf(err)}\n`);
      }
    }
  }

  /** Swap the just-appended assistant entry — used by self-correction to restore the original tool_calls without dropping reasoning_content. */
  private replaceTailAssistantMessage(message: ChatMessage): void {
    const retained = shrinkMessageForRetention(message);
    const entries = this.log.entries;
    const tail = entries[entries.length - 1];
    if (!tail || tail.role !== "assistant") return;
    const kept = entries.slice(0, -1);
    kept.push(retained);
    this.log.compactInPlace(kept);
    this.persistLog(kept);
  }

  private archiveCurrentSession(action: "reset" | "switch"): string | null {
    if (!this.sessionName) return null;
    try {
      const archived = archiveSession(this.sessionName);
      if (archived === null) this.persistLog([]);
      return archived;
    } catch (err) {
      /* disk issue shouldn't block the in-memory reset — but LOG */
      process.stderr.write(`reasonix: session ${action} persist failed — ${messageOf(err)}\n`);
      return null;
    }
  }

  private resetTransientState(): void {
    this.scratch.reset();
    this._inflight.clear();
    this._abandonedCalls.clear();
    // Drain leftover steer text — otherwise the first step() after a new session
    // injects it as a user message and the next turn leaks prior intent.
    this._steerQueue.length = 0;
    this._steerConsumed = false;
    this._userTurnCount = 0;
  }

  private rebuildSystemPrompt(): boolean {
    if (!this._rebuildSystem) return false;
    try {
      return this.prefix.replaceSystem(this._rebuildSystem());
    } catch (err) {
      /* builder threw — keep prior system rather than crash a reset, but LOG */
      process.stderr.write(`reasonix: system prompt rebuild failed — ${messageOf(err)}\n`);
      return false;
    }
  }

  /** "New chat" — drops in-memory messages, archives the on-disk transcript so it survives in Sessions, keeps sessionName so the prefix cache stays warm. Re-runs the system-prompt builder if one was wired (issue #778: REASONIX.md edits otherwise need a restart). */
  clearLog(): { dropped: number; archived: string | null; systemRebuilt: boolean } {
    const dropped = this.log.length;
    this.log.compactInPlace([]);
    const archived = this.archiveCurrentSession("reset");
    this.resetTransientState();
    this.stats.reset();
    this._turn = 0;
    this._lastCacheShape = null;
    const systemRebuilt = this.rebuildSystemPrompt();
    return { dropped, archived, systemRebuilt };
  }

  /** Workspace-switch follow-through — archives the previous session, drops in-memory state, repoints sessionName, and rebuilds the system prompt against whatever the rebuilder closure now resolves (the caller is expected to have already updated the root the closure reads). */
  switchWorkspace(opts: { sessionName: string }): { dropped: number; archived: string | null } {
    const dropped = this.log.length;
    const archived = this.archiveCurrentSession("switch");
    this.log.compactInPlace([]);
    this.resetTransientState();
    this.sessionName = opts.sessionName;
    this._turn = 0;
    this._lastCacheShape = null;
    this.rebuildSystemPrompt();
    return { dropped, archived };
  }

  configure(opts: ReconfigurableOptions): void {
    if (opts.model !== undefined) {
      // The send-time heal is cached per log version, so a model switch would
      // otherwise reuse a history prepared for the previous model's contract.
      if (opts.model !== this.model) this._healedCache = null;
      this.model = opts.model;
    }
    if (opts.stream !== undefined) {
      this._streamPreference = opts.stream;
      this.stream = opts.stream;
    }
    if (opts.reasoningEffort !== undefined) this.reasoningEffort = opts.reasoningEffort;
    if (opts.maxOutputTokens !== undefined) {
      this.maxOutputTokens = opts.maxOutputTokens ?? undefined;
    }
    if (opts.ctxMaxOverride !== undefined) {
      this.ctxMaxOverride = opts.ctxMaxOverride ?? undefined;
    }
    if (opts.autoCompact !== undefined) {
      this.autoCompact = opts.autoCompact;
    }
    if (opts.autoCompactTriggerRatio !== undefined) {
      this.autoCompactTriggerRatio = clampAutoCompactTrigger(
        opts.autoCompactTriggerRatio ?? AUTO_COMPACT_TRIGGER_RATIO,
      );
    }
    if (opts.maxIterPerTurn !== undefined) {
      this.maxIterPerTurn = opts.maxIterPerTurn ?? CacheFirstLoop.DEFAULT_MAX_ITER_PER_TURN;
    }
    if (opts.repetitionGuardEnabled !== undefined) {
      this._repetitionGuardEnabled = Boolean(opts.repetitionGuardEnabled);
    }
  }

  /** UI surface — model id of the call about to run (or running) right now. */
  get currentCallModel(): string {
    return this.model;
  }

  /** A call counts as mutating when its definition reports `readOnly !== true` and any dynamic `readOnlyCheck` doesn't override that for these args. */
  private isMutating(call: ToolCall): boolean {
    const name = call.function?.name;
    if (!name) return false;
    const def = this.tools.get(name);
    if (!def) return false;
    let args: Record<string, unknown> = {};
    const parsed = tryParseJson(call.function?.arguments ?? "{}");
    if (parsed.ok) {
      args = (parsed.value ?? {}) as Record<string, unknown>;
    } else {
      // Malformed args → fall through to the static flag below; the
      // dynamic check would've thrown anyway. But LOG the corrupt payload.
      process.stderr.write(
        `reasonix: malformed tool call arguments — ${messageOf(parsed.error)}\n`,
      );
    }
    return !isReadOnlyTool(def, args);
  }

  private async runOneToolCall(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{
    preWarnings: LoopEvent[];
    postWarnings: LoopEvent[];
    result: string | UserContentPart[];
  }> {
    const name = call.function?.name ?? "";
    const args = call.function?.arguments ?? "{}";
    const parsedArgs = safeParseToolArgs(args);
    const inflightId = this.inflightIdFor(call);
    this._inflight.add(inflightId);
    let cancelController: AbortController | null = null;
    try {
      const preReport = await runHooks({
        hooks: this.hooks,
        payload: {
          event: "PreToolUse",
          cwd: this.hookCwd,
          toolName: name,
          toolArgs: parsedArgs,
        },
      });
      const preWarnings = [...hookWarnings(preReport.outcomes, this._turn)];
      if (signal.aborted) throw new DOMException("Turn aborted", "AbortError");

      if (preReport.blocked) {
        const blocking = preReport.outcomes[preReport.outcomes.length - 1];
        const reason = (
          blocking?.stderr ||
          blocking?.stdout ||
          "blocked by PreToolUse hook"
        ).trim();
        return {
          preWarnings,
          postWarnings: [],
          result: `[hook block] ${blocking?.hook.command ?? "<unknown>"}\n${reason}`,
        };
      }

      // Rotate the per-tool-call cancel controller so a stale cancel from a
      // prior tool can't kill the current one. Keyed by the inflight id so a
      // TUI Stop click cancels exactly this card's tool even when several run
      // in parallel. Shell tools merge this with the turn signal; Ctrl+K /
      // desktop Stop fires only the most recent one.
      cancelController = new AbortController();
      this._toolCancelControllers.set(inflightId, cancelController);
      this._lastToolCancelController = cancelController;
      const result = await this.tools.dispatch(name, args, {
        signal,
        turn: this._turn,
        callId: inflightId,
        cancelSignal: cancelController.signal,
        maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
        confirmationGate: this.confirmationGate,
        sessionName: this.sessionName ?? undefined,
        readTracker: this.readTracker,
        rootDir: this.hookCwd,
        images: this._turnImages.map((d) => d.url),
      });

      const postReport = await runHooks({
        hooks: this.hooks,
        payload: {
          event: "PostToolUse",
          cwd: this.hookCwd,
          toolName: name,
          toolArgs: parsedArgs,
          toolResult: Array.isArray(result) ? contentPartsToString(result) : result,
        },
      });
      const postWarnings = [...hookWarnings(postReport.outcomes, this._turn)];

      return { preWarnings, postWarnings, result };
    } finally {
      this._inflight.delete(inflightId);
      if (cancelController !== null) {
        this._toolCancelControllers.delete(inflightId);
        if (this._lastToolCancelController === cancelController) {
          this._lastToolCancelController = null;
        }
      }
    }
  }

  /** Stable per-call id used as the inflight key AND threaded into tool_start / tool events so the UI matches them up. */
  private inflightIdFor(call: ToolCall): string {
    if (call.id) return call.id;
    const fallback = (call as { _inflightFallback?: string })._inflightFallback;
    if (fallback) return fallback;
    const generated = `inflight-${++this._inflightCounter}`;
    (call as { _inflightFallback?: string })._inflightFallback = generated;
    return generated;
  }
  private _inflightCounter = 0;

  // Cached result from the last healActiveLogBeforeSend() pass.
  // Invalidated when the log version changes (append/compactInPlace).
  private _healedCache: ChatMessage[] | null = null;
  private _healedVersion = -1;

  /** Running count of user turns processed so far. */
  private _userTurnCount = 0;

  private planRepository: PlanRepository | undefined;
  private planRepositoryKey: string | null = null;
  private buildMessages(): ChatMessage[] {
    const healedMessages = this.healActiveLogBeforeSend();
    // Plan context belongs to a bound conversation: a session-less loop (REPL or a
    // test harness) injects nothing, and a workspace/session switch repoints the store.
    const key = this.sessionName ? `${this.hookCwd}\0${this.sessionName}` : null;
    if (key !== this.planRepositoryKey) {
      this.planRepositoryKey = key;
      this.planRepository = key ? planRepository(this.hookCwd) : undefined;
    }
    // Only THIS session's plan: another session's in-flight plan in the same workspace
    // is not ours to continue, and injecting it is exactly how two sessions end up
    // driving one plan. An unclaimed pre-ownership plan is adopted on first read.
    const active =
      this.planRepository?.activeFor(claimingSession(this.sessionName ?? undefined), {
        adoptUnclaimed: true,
      }) ?? null;
    // Only nudge on a plan that still has an unfinished step — a finished leftover
    // (e.g. an imported legacy plan) must not inject "continue the next step" forever.
    const nextStep = active?.steps.find((s) => !Object.hasOwn(active.completions, s.id));
    const planContext: ChatMessage[] =
      active && nextStep
        ? [
            {
              role: "user",
              content: `Authoritative session plan state (not a new user request): ${JSON.stringify({ planId: active.id, summary: active.summary, status: active.status, steps: active.steps, completedStepIds: Object.keys(active.completions), nextStepId: nextStep.id })}\nThis plan belongs to this session, so continue the next unfinished step in order. Supply this planId to mark_step_complete and revise_plan. Use open_plan for full accepted work and list_plans for history. Do not silently abandon or replace the plan, and do not work a plan another session holds: only this planId is yours.`,
            },
          ]
        : [];
    // Send-time image retention (window default = KEEP_LAST_IMAGES): the log
    // keeps every image so transcripts and reloads stay complete, but only the
    // newest image parts are sent. Otherwise screenshots accumulate across a
    // long session until the provider rejects the whole request with an
    // image-count cap ("Too many images in request: 67 > 64") no retry can fix.
    //
    // The prefix is never folded: a durable compaction folds the log only, and
    // the request-only fold below must match that or the system prompt would be
    // summarized away from the outgoing turn.
    return pruneOldImageParts([
      ...this.prefix.toMessages(),
      ...this.foldRequestForRefusal(healedMessages),
      ...planContext,
    ]);
  }

  /** Fold a copy of `messages` down to `targetTokens`, or null when folding
   *  shrinks nothing (no plan, or a plan that keeps every message). */
  private foldMessagesToTarget(
    messages: readonly ChatMessage[],
    targetTokens: number,
  ): ChatMessage[] | null {
    const plan = planCompaction(messages, { targetTokens });
    if (!plan) return null;
    const folded = renderDeterministic(plan);
    return folded && folded.tokensAfter < folded.tokensBefore ? folded.messages : null;
  }

  /** Shrink the outgoing log copy to the refusal ladder's target without touching
   *  the log, so a refused prompt is retried smaller while the transcript keeps
   *  its full history. */
  private foldRequestForRefusal(messages: ChatMessage[]): ChatMessage[] {
    const target = this._requestFoldTarget;
    if (target === null) return messages;
    return this.foldMessagesToTarget(messages, target) ?? messages;
  }

  /** Target for a refusal-recovery fold, or null when the request is too small
   *  for size to be a plausible cause (recovery then only replays it). Tool
   *  schemas count: they are a fixed per-request cost the fold cannot remove. */
  private refusalFoldTarget(): number | null {
    const request = pruneOldImageParts([...this.prefix.toMessages(), ...this.log.entries]);
    const tokens = estimateRequestTokens(request, this.prefix.tools());
    if (tokens < REFUSAL_FOLD_MIN_TOKENS) return null;
    const target = Math.max(REFUSAL_FOLD_MIN_TOKENS, Math.round(tokens * REFUSAL_FOLD_RATIO));
    // Only offer a fold that actually drops history: a fold that keeps
    // everything would relabel the retry without shrinking it.
    return this.foldMessagesToTarget(this.log.entries, target) ? target : null;
  }

  private cacheShapeForRequest(
    prefixEvidence: PrefixDiagnosticHashes,
    toolSpecs: readonly ToolSpec[],
  ): CacheShapeSnapshot {
    return {
      systemHash: prefixEvidence.systemHash,
      toolsHash: prefixEvidence.toolSpecsHash,
      fewShotsHash: prefixEvidence.fewShotsHash,
      prefixHash: prefixEvidence.prefixHash,
      logRewriteVersion: this.log.rewriteVersion,
      toolSchemaTokens: countTokensBounded(JSON.stringify(toolSpecs)),
    };
  }

  private cacheDiagnosticsForUsage(
    shape: CacheShapeSnapshot,
    usage: TurnStats["usage"] | null,
  ): CacheDiagnostics {
    const prev = this._lastCacheShape;
    const prefixChangeReasons: CacheDiagnostics["prefixChangeReasons"] = [];
    if (prev) {
      if (prev.systemHash !== shape.systemHash) prefixChangeReasons.push("system");
      if (prev.toolsHash !== shape.toolsHash) prefixChangeReasons.push("tools");
      if (prev.fewShotsHash !== shape.fewShotsHash) prefixChangeReasons.push("few_shots");
      if (prev.logRewriteVersion !== shape.logRewriteVersion) {
        prefixChangeReasons.push("log_rewrite");
      }
    }
    return {
      prefixHash: shape.prefixHash,
      prefixChanged: prefixChangeReasons.length > 0,
      prefixChangeReasons,
      systemHash: shape.systemHash,
      toolsHash: shape.toolsHash,
      fewShotsHash: shape.fewShotsHash,
      logRewriteVersion: shape.logRewriteVersion,
      toolSchemaTokens: shape.toolSchemaTokens,
      promptCacheMissTokens: usage?.promptCacheMissTokens ?? 0,
      promptCacheHitTokens: usage?.promptCacheHitTokens ?? 0,
    };
  }

  private healActiveLogBeforeSend(): ChatMessage[] {
    // Skip the expensive 3-pass healing pipeline when the log hasn't
    // changed since the last call — the common case between iterations
    // where no new messages were appended.
    if (this._healedCache && this._healedVersion === this.log.version) {
      return this._healedCache;
    }
    const current = this.log.toMessages();
    const healed = healLoadedMessages(current, DEFAULT_MAX_RESULT_CHARS);
    const argsShrunk = shrinkOversizedToolCallArgsByTokens(
      healed.messages,
      DEFAULT_MAX_RESULT_TOKENS,
    );
    // Pruning and stamping fight over the same field: prune drops stale
    // reasoning from earlier plain turns, stamp re-adds it for thinking mode.
    // Once a gateway proves it wants the field back on every turn, the prune
    // loses — a request that alternates the two can never pass.
    const pruned = this._reasoningRoundTripRequired
      ? { messages: argsShrunk.messages, prunedCount: 0, charsDropped: 0 }
      : stripDroppableReasoningContent(argsShrunk.messages);
    // A thinking-mode endpoint rejects the whole request over one bare
    // assistant turn, so never let a current-turn turn go out bare.
    const stamped = stampMissingReasoningForThinkingMode(pruned.messages, this.model, {
      fromIndex: this._reasoningRoundTripRequired ? 0 : lastUserIndex(pruned.messages),
      force: this._reasoningRoundTripRequired,
    });
    if (
      healed.healedCount === 0 &&
      argsShrunk.healedCount === 0 &&
      pruned.prunedCount === 0 &&
      stamped.stampedCount === 0
    ) {
      this._healedCache = current;
      this._healedVersion = this.log.version;
      return current;
    }
    this.log.compactInPlace(stamped.messages);
    this._healedCache = stamped.messages;
    this._healedVersion = this.log.version;
    this.persistLog(stamped.messages);
    return stamped.messages;
  }

  abort(opts: LoopAbortOptions = {}): void {
    if (opts.discardCurrentTurn) this._discardAbortRequested = true;
    this._turnAbort.abort();
    for (const controller of this._toolCancelControllers.values()) controller.abort();
  }

  /** Cancel the running tool call without aborting the turn. Ctrl+K / desktop
   *  Stop kills the subprocess; the tool returns `cancelledByUser:true` and
   *  the conversation continues. Targets the most recent tool; no-op if none. */
  cancelCurrentTool(_reason: string): void {
    this._lastToolCancelController?.abort();
  }

  /** Cancel exactly one running tool call (the TUI Stop button on a shell card). */
  cancelToolCall(callId: string, _reason: string): void {
    this._toolCancelControllers.get(callId)?.abort();
  }

  private resetAbortState(): void {
    this._turnAbort = new AbortController();
    this._discardAbortRequested = false;
  }

  /** Persist the on-disk transcript after an in-memory mutation; a disk failure
   *  must never block the loop, but it must never be silent either. */
  private persistLog(messages: ChatMessage[]): boolean {
    if (!this.sessionName) return true;
    try {
      rewriteSession(this.sessionName, messages);
      return true;
    } catch (err) {
      process.stderr.write(`reasonix: session persist failed — ${messageOf(err)}\n`);
      return false;
    }
  }

  /** Stub tool results for calls a force-closed turn abandoned mid-dispatch,
   *  so healing doesn't silently drop them and the model reads "cancelled"
   *  instead of guessing the tool failed. Idempotent; returns stub count. */
  private settleAbandonedToolCalls(): number {
    if (this._abandonedCalls.size === 0) return 0;
    const entries = this.log.entries;
    let target = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const m = entries[i]!;
      if (
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((c) => c.id !== undefined && this._abandonedCalls.has(c.id))
      ) {
        target = i;
        break;
      }
    }
    if (target < 0) {
      this._abandonedCalls.clear();
      return 0;
    }
    const settled = new Set<string>();
    for (let j = target + 1; j < entries.length; j++) {
      const m = entries[j]!;
      if (m.role === "tool" && m.tool_call_id) settled.add(m.tool_call_id);
    }
    const missing = entries[target]!.tool_calls!.filter(
      (c) => c.id !== undefined && this._abandonedCalls.has(c.id) && !settled.has(c.id),
    );
    this._abandonedCalls.clear();
    if (missing.length === 0) return 0;
    const content = JSON.stringify({
      cancelledByUser: true,
      error: `Tool call cancelled because the conversation stopped. ${USER_CANCEL_NOTE}`,
    });
    for (const call of missing) {
      this.appendAndPersist({
        role: "tool",
        tool_call_id: call.id ?? "",
        name: call.function?.name ?? "",
        content,
      });
    }
    return missing.length;
  }

  private discardLogFrom(index: number): void {
    const preserved = this.log.entries.slice(0, index).map((m) => ({ ...m }));
    this.log.compactInPlace(preserved);
    this.persistLog(preserved);
  }

  /** Drop the thinking-only assistant placeholder when a later recovery stage
   *  replaces it with an explicit instruction the model can act on. */
  private discardTailThinkingOnlyPartial(): void {
    if (!this._thinkingOnlyPartialAppended) return;
    this._thinkingOnlyPartialAppended = false;
    const tail = this.log.entries[this.log.length - 1];
    if (tail?.role === "assistant") this.discardLogFrom(this.log.length - 1);
  }

  /** One escalating step for a thinking-only stop, returning the warning to
   *  surface. Stage 0 shows the model its own stop; later stages ask for the
   *  answer outright, or hand the reasoning back as the material to answer from. */
  private escalateThinkingOnly(
    producingModel: string,
    stage: number,
    reasoning: string,
  ): LoopEvent {
    const warning = { turn: this._turn, role: "warning" as const, severity: "low" as const };
    if (stage === 0) {
      this._thinkingOnlyPartialAppended = true;
      this.appendAndPersist(buildAssistantMessage("", [], producingModel, reasoning));
      return { ...warning, content: t("loop.thinkingOnlyRetry") };
    }
    // Clamp to the last defined stage so raising MAX past the table's length
    // degrades to the strongest ask instead of throwing.
    const nudge = THINKING_ONLY_NUDGES[Math.min(stage - 1, THINKING_ONLY_NUDGES.length - 1)]!;
    this.discardTailThinkingOnlyPartial();
    this.appendAndPersist({
      role: "user",
      synthetic: true,
      content: t(nudge.prompt, { reasoning: truncateReasoning(reasoning) }),
    });
    return { ...warning, content: t(nudge.warning) };
  }

  /** `session_retracted` event recording the truncation after an abort-discard. */
  private abortDiscardEvent(beforeMessages: number): LoopEvent {
    return {
      turn: this._turn,
      role: "session_retracted",
      content: "",
      sessionRetractedKind: "abort-discard",
      beforeMessages,
      afterMessages: this.log.length,
      replacementMessages: this.log.entries,
    };
  }

  /** Drop the last user message + everything after; caller re-sends. Persists to session file. */
  retryLastUser(): string | null {
    const entries = this.log.entries;
    let lastUserIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      // Retry re-sends the last REAL user prompt — steer/nudge records are never retry targets.
      if (entries[i]!.role === "user" && !entries[i]!.synthetic) {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return null;
    const raw = entries[lastUserIdx]!.content;
    const userText = typeof raw === "string" ? raw : "";
    const preserved = entries.slice(0, lastUserIdx).map((m) => ({ ...m }));
    this.log.compactInPlace(preserved);
    this.persistLog(preserved);
    return userText;
  }

  /** Replace the system prompt + log wholesale from the Raw editor. The editor omits
   *  reasoning, so each assistant turn keeps its prior reasoning by position (gaps
   *  backfilled for a thinking model); heals first so an edit can't ship a bad shape. */
  replaceConversation(
    system: string,
    messages: ChatMessage[],
  ): { systemChanged: boolean; dropped: number } {
    const priorReasoning = this.log
      .toMessages()
      .filter((m) => m.role === "assistant")
      .map((m) => (typeof m.reasoning_content === "string" ? m.reasoning_content : undefined));
    let assistantIndex = 0;
    const carried = messages.map((m) => {
      if (m.role !== "assistant") return m;
      const prior = priorReasoning[assistantIndex++];
      return prior !== undefined && !Object.hasOwn(m, "reasoning_content")
        ? { ...m, reasoning_content: prior }
        : m;
    });
    const healed = healLoadedMessages(carried, DEFAULT_MAX_RESULT_CHARS).messages;
    const stamped = stampMissingReasoningForThinkingMode(healed, this.model).messages;
    const systemChanged = this.prefix.replaceSystem(system);
    this.log.compactInPlace(stamped);
    this.readTracker.reset();
    this._abandonedCalls.clear();
    this.persistLog(stamped);
    return { systemChanged, dropped: messages.length - stamped.length };
  }

  /** Serialize compactions: a manual run can overlap the mid-turn overflow
   *  path, and two concurrent folds would race the log rewrite. */
  private _compactLock: Promise<void> = Promise.resolve();

  /** Compact the log: LLM rolling summary of the folded span plus a
   *  verification probe, falling back to a deterministic fold. Overflow
   *  recovery is fold-only (an estimated summarizer call could overflow). */
  async compactNow(
    opts: { trigger?: CompactionTrigger; signal?: AbortSignal; targetTokens?: number } = {},
  ): Promise<CompactionOutcome> {
    const run = this._compactLock.then(() => this.compactNowLocked(opts));
    this._compactLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async compactNowLocked(opts: {
    trigger?: CompactionTrigger;
    signal?: AbortSignal;
    /** Post-compaction token target. Unset = the window-derived default; the
     *  refusal ladder passes a smaller one because the window estimate is not
     *  what the gateway refused on. */
    targetTokens?: number;
  }): Promise<CompactionOutcome> {
    const trigger = opts.trigger ?? "manual";
    const signal = opts.signal ?? this._turnAbort.signal;
    const events: LoopEvent[] = [];
    const ctxMax = resolveContextTokens(this.model, this.ctxMaxOverride);
    const targetTokens =
      opts.targetTokens !== undefined
        ? Math.max(1_000, Math.round(opts.targetTokens))
        : Math.max(1_000, Math.round(ctxMax * COMPACT_TARGET_RATIO));
    // Snapshot boundary: the summarizer call below yields the event loop, and
    // a streaming turn can append to the log while it runs. The fold is
    // re-based onto the live log at apply time (see `appended` below).
    const snapshotLen = this.log.entries.length;
    const plan = planCompaction(this.log.entries, { targetTokens });
    if (!plan) return { status: "noop", trigger, events };
    let result: CompactionResult | null = null;
    let method: "summary" | "fold" = "fold";
    if (trigger !== "overflow") {
      result = await this.summarizeForCompaction(plan, signal);
      if (result) method = "summary";
    }
    if (!result) result = renderDeterministic(plan);
    if (!result) return { status: "noop", trigger, events };
    const checkpoint = this.sessionName
      ? checkpointSessionMessages(this.sessionName, [...this.log.entries], "precompact")
      : null;
    // Re-base the fold onto the live log: replacing the log with the stale
    // snapshot would drop anything the turn appended while the summarizer
    // ran. Appended messages stay verbatim as the fold's tail.
    const appended = this.log.entries.slice(snapshotLen);
    const tailTokens = appended.length > 0 ? estimateConversationTokens(appended) : 0;
    const merged = appended.length > 0 ? [...result.messages, ...appended] : result.messages;
    this.log.compactInPlace(merged);
    this.persistLog(merged);
    events.push({
      turn: this._turn,
      role: "session_retracted",
      content: "",
      sessionRetractedKind: "compact",
      beforeMessages: result.messagesBefore + appended.length,
      afterMessages: merged.length,
      replacementMessages: merged,
    });
    const summaryBody = compactionSummaryBody(result.messages);
    events.push({
      turn: this._turn,
      role: "warning",
      severity: "high",
      content: t(trigger === "overflow" ? "loop.compactedRecovery" : "loop.compacted", {
        before: (result.tokensBefore + tailTokens).toLocaleString(),
        after: (result.tokensAfter + tailTokens).toLocaleString(),
        method,
      }),
      ...(summaryBody ? { compactionSummary: summaryBody } : {}),
    });
    return {
      status: "done",
      trigger,
      method,
      tokensBefore: result.tokensBefore + tailTokens,
      tokensAfter: result.tokensAfter + tailTokens,
      messagesBefore: result.messagesBefore + appended.length,
      messagesAfter: merged.length,
      checkpoint,
      events,
    };
  }

  /** Fold the log for a recovery path. A fold that throws is reported and
   *  returns ok:false rather than propagating, so recovery degrades to a replay
   *  instead of replacing the original failure with a raw error. */
  private async foldLogForRecovery(
    targetTokens: number | undefined,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; events: LoopEvent[] }> {
    try {
      const outcome = await this.compactNow({ trigger: "overflow", signal, targetTokens });
      return { ok: outcome.status === "done", events: outcome.events };
    } catch (foldError) {
      process.stderr.write(`reasonix: recovery compaction failed: ${messageOf(foldError)}\n`);
      return { ok: false, events: [] };
    }
  }

  private async summarizeForCompaction(
    plan: CompactionPlan,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const chat = (messages: ChatMessage[]) =>
      this.client.chat({
        model: this.model,
        messages,
        signal,
        thinking: thinkingModeForModel(this.model),
        reasoningEffort: this.reasoningEffort,
        maxTokens: SUMMARIZER_OUTPUT_HEADROOM,
      });
    try {
      const resp = await chat(buildCompactionRequest(plan));
      let summary = (resp.content ?? "").trim();
      if (!summary) return null;
      try {
        const probe = await chat(buildVerificationRequest(plan, summary));
        const improved = (probe.content ?? "").trim();
        if (improved) summary = improved;
      } catch (probeErr) {
        // Verification probe is best-effort; keep the candidate summary.
        process.stderr.write(
          `reasonix: compaction verification probe failed — ${messageOf(probeErr)}\n`,
        );
      }
      return renderWithSummary(plan, summary);
    } catch {
      return null;
    }
  }

  async *step(
    userInput: string,
    images?: ReadonlyArray<string | TurnImage>,
  ): AsyncGenerator<LoopEvent> {
    // Per-turn abort-state guarantee: whenever this generator completes —
    // normally, via an abort path, or because the consumer broke the
    // for-await (generator.return() delegates through `yield*`, so this
    // finally runs in every case) — a turn that ended with its own
    // controller still aborted must reset it. Leaks come from aborts
    // landing in the turn's tail: suspended at a final assistant_final /
    // done yield, swallowed by a helper's catch, or a
    // desktop Stop that breaks the for-await right after the model's
    // answer. Without the reset, the next step() carries the stale
    // abort forward (carryAbort) and instantly kills the user's next
    // message — the "have to send it a second time" bug.
    try {
      yield* this.stepTurn(userInput, images);
    } finally {
      this._turnImages = [];
      if (this._turnAbort.signal.aborted) this.resetAbortState();
      // A turn force-closed mid-dispatch (desktop Send now / queue force)
      // abandons in-flight tool calls: their results never reach the log.
      // Stub them so the pairing holds and the next prompt tells the truth.
      this.settleAbandonedToolCalls();
    }
  }

  private async *stepTurn(
    userInput: string,
    images?: ReadonlyArray<string | TurnImage>,
  ): AsyncGenerator<LoopEvent> {
    // Reset per-turn flags.
    this._steerConsumed = false;
    this._turnImages = toTurnImages(images);

    this._turn++;
    // Persist before any event for this turn is emitted so a mid-turn crash
    // or rebuild can't reissue the ordinal. Best-effort.
    if (this.sessionName) {
      try {
        patchSessionMeta(this.sessionName, { lastTurn: this._turn });
      } catch (err) {
        process.stderr.write(`reasonix: session meta lastTurn patch failed — ${messageOf(err)}\n`);
      }
    }
    const restoreModelIfNeeded = () => undefined;
    /** Drop a thinking-only partial and any queued steers, then let stepTurn
     *  return — the shared tail of the give-up / stall branches below. */
    const abandonThinkingOnlyTurn = (): void => {
      this.discardTailThinkingOnlyPartial();
      this._steerQueue.length = 0;
      restoreModelIfNeeded();
    };

    this._userTurnCount++;
    this.scratch.reset();
    // A fresh user turn is a new intent — don't let StormBreaker's
    // old sliding window of (name, args) signatures keep blocking
    // calls that are now legitimately on-task. The window repopulates
    // naturally as this turn's tool calls flow through.
    this.repair.resetStorm();
    this._turnSelfCorrected = false;
    this._failureSteers = 0;
    // Grace state is per-turn too: a paused turn's "continue" starts a fresh
    // turn with the base cap restored (and a fresh grace grant if it stays
    // productive). Keeping the latch would silently raise every later turn's
    // cap for the whole session and skip the grace warning on continue.
    this._iterGrace = 0;
    this._iterGraceApplied = false;
    this._iterCapBypassed = false;
    this._emptyResponseRetried = false;
    this._thinkingOnlyRecoveries = 0;
    this._thinkingOnlyPartialAppended = false;
    this._providerErrorRetried = false;
    this._networkReconnects = 0;
    this._truncationContinuations = 0;
    this._prematureStopNudges = 0;
    this._compactRecoveries = 0;
    this._payloadShrinkAttempts = 0;
    this._refusalRecoveryStage = 0;
    this._reasoningRepairs = 0;
    this._requestFoldTarget = null;
    this._midTurnCompacts = 0;
    this._lastReasoningSig = null;
    this._reasoningLoopCount = 0;
    // Fresh controller for this turn: the prior step's signal has
    // already fired (or stayed clean); either way we don't want its
    // state to bleed into the new turn.
    //
    // Edge case — `loop.abort()` may have been called BEFORE step()
    // ran (race: caller fires abort during async setup, but step()
    // hadn't been awaited yet). Naively reassigning _turnAbort would
    // silently drop that abort. Forward the prior aborted state into
    // the fresh controller so the iter-0 check still bails out. This
    // is load-bearing for subagents: the parent's onParentAbort
    // listener calls childLoop.abort(), which can fire before
    // childLoop.step() has reached the `for await` line below.
    //
    // Carry ONLY when the abort predates the loop's first step. Once a
    // step has started, an aborted controller here is stale: step()'s
    // wrapper finally resets any abort that fired during a turn, so the
    // only way to see one is an abort() that landed after the previous
    // generator completed (Esc during the TUI's Stop-hook teardown,
    // desktop Stop at the tail). That abort belonged to the dead turn —
    // carrying it would cancel the user's fresh message and force a
    // re-send.
    const carryAbort = this._turnAbort.signal.aborted && !this._stepStarted;
    this._stepStarted = true;
    this._turnAbort = new AbortController();
    if (carryAbort) this._turnAbort.abort();
    const signal = this._turnAbort.signal;
    // If the PREVIOUS turn was force-closed (queue force / Send now) while a
    // tool call was in flight, its result never reached the log. Stub it now,
    // before buildMessages(), so this turn's first request tells the model
    // the call was cancelled instead of healing silently dropping the
    // dangling tool_calls and leaving the model to guess the tool failed.
    this.settleAbandonedToolCalls();
    // Persist the user message before the first API round-trip so a
    // mid-stream abort or a session switch doesn't drop the prompt and
    // leave a new session orphaned without a .jsonl on disk (issue #943
    // — sidebar globs .jsonl files, so an unpersisted new session vanishes
    // when the user navigates away before the model responds). A failed
    // first round-trip still leaves the message in the log; the user can
    // retry without re-typing.
    // Auto-compaction runs before the new prompt is logged (Codex pre-turn
    // phase): the fresh user message can never be folded away. Mid-turn the
    // check re-fires from the iteration loop once the threshold is crossed.
    if (this.autoCompact) {
      const estimate = estimateRequestTokens(
        pruneOldImageParts([...this.prefix.toMessages(), ...this.log.entries]),
        this.prefix.tools(),
      );
      const ctxMax = resolveContextTokens(this.model, this.ctxMaxOverride);
      if (estimate >= this.autoCompactTriggerRatio * ctxMax) {
        yield {
          turn: this._turn,
          role: "compaction_start",
          compactionTrigger: "auto",
          content: "",
        };
        const outcome = await this.compactNow({ trigger: "auto", signal });
        for (const ev of outcome.events) yield ev;
      }
    }
    const turnStartLogIndex = this.log.length;
    this.appendAndPersist({ role: "user", content: buildUserContent(userInput, this._turnImages) });
    const toolSpecs = this.prefix.tools();
    const rateLimitState = { shown: false };

    // Any tool dispatch this turn — gates the premature-stop nudge so plain
    // Q&A answers are never re-prompted for ending without a "task complete".
    let turnHadToolActivity = false;

    for (let iter = 0; ; iter++) {
      // Mid-turn auto-compaction: a long tool loop crosses the threshold long
      // after turn start, and the pre-turn check above never re-runs inside
      // the iteration loop. Bounded per turn (see _midTurnCompacts).
      if (this.autoCompact && iter > 0 && this._midTurnCompacts < 2) {
        const estimate = estimateRequestTokens(
          pruneOldImageParts([...this.prefix.toMessages(), ...this.log.entries]),
          this.prefix.tools(),
        );
        const ctxMax = resolveContextTokens(this.model, this.ctxMaxOverride);
        if (estimate >= this.autoCompactTriggerRatio * ctxMax) {
          this._midTurnCompacts++;
          yield {
            turn: this._turn,
            role: "compaction_start",
            compactionTrigger: "auto",
            content: "",
          };
          const outcome = await this.compactNow({ trigger: "auto", signal });
          for (const ev of outcome.events) yield ev;
        }
      }
      if (signal.aborted) {
        // Reset in finally — the consumer (desktop runTurn) breaks the
        // for-await on its own aborter between our yields, which calls
        // generator.return() and skips post-yield straight-line code.
        // Without finally the reset is lost and carryAbort locks every
        // future step() at iter 0.
        try {
          const discardTurn = this._discardAbortRequested;
          const stoppedMsg = discardTurn
            ? "[aborted by user (Esc): interrupted turn discarded. Ask again when ready.]"
            : "[aborted by user (Esc): no summary produced. Ask again when ready; prior tool output is still in the log.]";
          if (discardTurn) {
            const beforeDiscard = this.log.length;
            this.discardLogFrom(turnStartLogIndex);
            // The truncated log REPLACES the conversation — record it so the
            // kernel view stays replayable (same swap as session.retracted).
            yield this.abortDiscardEvent(beforeDiscard);
          } else {
            this.appendAndPersist(buildSyntheticAssistantMessage(stoppedMsg, this.model));
          }
          yield {
            turn: this._turn,
            role: "assistant_final",
            content: stoppedMsg,
            forcedSummary: true,
          };
          restoreModelIfNeeded();
          yield { turn: this._turn, role: "done", content: stoppedMsg };
        } finally {
          this.resetAbortState();
        }
        this._steerQueue.length = 0;
        return;
      }
      // Hard iteration cap — prevents runaway tool-call loops from
      // consuming unlimited API budget. What happens at the cap depends
      // on the turn's health (#2037):
      //  - never-ask mode (`getEditMode() === "never-ask"`): the cap never pauses or stops
      //    the turn - nobody is watching to say "continue". Noted once, then the
      //    turn runs without the cap. Genuine repeat loops are still caught in
      //    dispatch by the storm-breaker guard.
      //  - STUCK turn (storm-breaker latched `_turnSelfCorrected`): stop — the
      //    next turn starts fresh instead of re-sending the garbage loop.
      //  - PRODUCTIVE turn (distinct calls, results flowing): the cap grants a
      //    grace window (~50% more, min 5) instead of a hard stop — killing a
      //    healthy long task mid-flow just forces the user to re-prompt. If the
      //    grace window also exhausts, the turn pauses NON-destructively: the log
      //    stays intact, so the next "continue" resumes with full state.
      const hardCap = this.maxIterPerTurn + (this._iterGraceApplied ? this._iterGrace : 0);
      if (iter >= hardCap && !this._iterCapBypassed) {
        if (this._getEditMode?.() === "never-ask") {
          this._iterCapBypassed = true;
          yield {
            turn: this._turn,
            role: "warning",
            severity: "low",
            content: t("loop.iterLimitNeverAsk", { max: this.maxIterPerTurn }),
          };
          continue;
        }
        if (this._turnSelfCorrected) {
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.iterLimitReached", { max: this.maxIterPerTurn }),
          };
          restoreModelIfNeeded();
          this._steerQueue.length = 0;
          return;
        }
        if (!this._iterGraceApplied) {
          this._iterGrace = Math.max(5, Math.round(this.maxIterPerTurn / 2));
          this._iterGraceApplied = true;
          yield {
            turn: this._turn,
            role: "warning",
            severity: "low",
            content: t("loop.iterLimitGrace", {
              max: this.maxIterPerTurn,
              grace: this.maxIterPerTurn + this._iterGrace,
            }),
          };
          continue;
        }
        yield {
          turn: this._turn,
          role: "warning",
          severity: "high",
          content: t("loop.iterLimitPaused", {
            grace: this.maxIterPerTurn + this._iterGrace,
          }),
        };
        restoreModelIfNeeded();
        this._steerQueue.length = 0;
        return;
      }
      // Bridge the silence between the PREVIOUS iter's tool result and
      // THIS iter's first streaming byte. R1 can spend 20-90s reasoning
      // about tool output before the first delta lands, and prior to
      // this hint the UI had nothing to render. Only emit on iter > 0
      // because iter 0's "thinking" phase is already covered by the
      // streaming row / StreamingAssistant's placeholder.
      //
      // Wording is explicit about the two things happening: the tool
      // result IS being uploaded (it's now part of the next prompt) and
      // the model IS thinking. Users were reading "thinking about the
      // tool result" as the model-only phase, but the wait also covers
      // the upload round-trip.
      if (iter > 0) {
        yield {
          turn: this._turn,
          role: "status",
          content: t("loop.toolUploadStatus"),
        };
      }
      let messages = this.buildMessages();

      if (this._steerQueue.length > 0) {
        const steer = this._steerQueue.shift()!;
        this._steerConsumed = this._steerQueue.length === 0;
        this.appendAndPersist({
          role: "user",
          content: formatSteerUserMessage(steer),
          synthetic: true,
        });
        messages = this.buildMessages();
        yield {
          turn: this._turn,
          role: "steer",
          content: steer,
        };
      }

      let assistantContent = "";
      let reasoningContent = "";
      let toolCalls: ToolCall[] = [];
      let usage: TurnStats["usage"] | null = null;
      let finishReason: string | undefined;
      let stopReason: string | undefined;
      let image: { dataUrl: string; mimeType: string } | undefined;
      let repetitionStall:
        | {
            channel: "content" | "reasoning" | "tool_call";
            period: number;
            repeatedChars: number;
            sample?: string;
          }
        | undefined;
      const callModel = this.model;

      // Snapshot prefix evidence from the same turn-start tool list sent to the
      // API so MCP hot-adds during the turn don't rewrite history.
      const prefixEvidence = this.prefix.diagnosticHashes(toolSpecs);

      try {
        if (this.stream) {
          const result = yield* streamModelResponse({
            client: this.client,
            model: callModel,
            messages,
            toolSpecs,
            signal,
            reasoningEffort: this.reasoningEffort,
            maxTokens: this.maxOutputTokens,
            turn: this._turn,
            isUserIntervention: (name) => this.tools.isUserIntervention(name),
            repetitionGuardEnabled: this._repetitionGuardEnabled,
          });
          assistantContent = result.assistantContent;
          reasoningContent = result.reasoningContent;
          toolCalls = result.toolCalls;
          usage = result.usage;
          finishReason = result.finishReason;
          stopReason = result.stopReason;
          image = result.image;
          repetitionStall = result.repetitionStall;
        } else {
          const resp = await this.client.chat({
            model: callModel,
            messages,
            tools: toolSpecs.length ? toolSpecs : undefined,
            signal,
            thinking: thinkingModeForModel(callModel),
            reasoningEffort: this.reasoningEffort,
            maxTokens: this.maxOutputTokens,
          });
          assistantContent = resp.content;
          reasoningContent = resp.reasoningContent ?? "";
          toolCalls = resp.toolCalls;
          usage = resp.usage;
          image = resp.image;
          finishReason = chatFinishReason(resp.raw);
          stopReason = resp.stopReason;
        }
      } catch (err) {
        // An aborted signal here is almost always our own doing —
        // either Esc, or App.tsx calling `loop.abort()` to switch to a
        // queued synthetic input (ShellConfirm "always allow", PlanConfirm
        // approve, etc.). The DeepSeek client's fetch path translates
        // the abort into a generic `AbortError("This operation was
        // aborted")`, which used to bubble up here and render as a
        // scary red "error" row even though nothing actually broke.
        // Treat it as a clean early-exit instead: the next turn (queued
        // synthetic OR user re-prompt) starts immediately and gets to
        // produce its own answer.
        if (signal.aborted) {
          // Reset in finally — same rationale as the iter-start handler:
          // if the consumer breaks the for-await before draining `done`,
          // generator.return() would skip a bare post-yield reset and
          // leave carryAbort locked on the next step().
          if (this._discardAbortRequested) {
            const beforeDiscard = this.log.length;
            this.discardLogFrom(turnStartLogIndex);
            yield this.abortDiscardEvent(beforeDiscard);
          } else if (this._thinkingOnlyPartialAppended) {
            this._thinkingOnlyPartialAppended = false;
            this.discardLogFrom(this.log.length - 1);
          }
          try {
            restoreModelIfNeeded();
            yield { turn: this._turn, role: "done", content: "" };
          } finally {
            this.resetAbortState();
          }
          this._steerQueue.length = 0;
          return;
        }
        const upstreamHost = this.client.baseUrl;
        const dsHost = isDeepSeekHost(upstreamHost);
        const probe =
          is5xxError(err) && dsHost ? await probeDeepSeekReachable(this.client) : undefined;
        const cause = err instanceof Error ? err : new Error(String(err));
        const { code, phase, partialDelivered, timedOut } = errorMeta(cause);
        const isNetworkLoss =
          !partialDelivered &&
          !signal.aborted &&
          cause.name !== "AbortError" &&
          !is4xxError(cause) &&
          this._networkReconnects < 10 &&
          isNetworkConnectionError(cause);
        if (isNetworkLoss) {
          this._networkReconnects++;
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.connectionLostWaiting"),
          };
          const reconnected = await waitForReconnection({
            targetUrl: upstreamHost,
            signal,
          });
          if (reconnected) {
            yield {
              turn: this._turn,
              role: "warning",
              severity: "low",
              content: t("loop.connectionRestoredResuming"),
            };
            continue;
          }
          if (signal.aborted) {
            restoreModelIfNeeded();
            return;
          }
        }
        // A thinking-mode endpoint rejects the whole request when one assistant
        // turn comes back without `reasoning_content`. The bare turn is usually
        // one no model classifier claimed as thinking (an id the family match
        // missed) or one loaded from an older session, so replaying the
        // byte-identical payload can only fail again: back-fill the field on
        // every assistant turn, stop pruning reasoning for the rest of the
        // session so the repair survives the next send, and retry.
        if (!signal.aborted && !partialDelivered && isReasoningRoundTripError(cause)) {
          const repaired = stampMissingReasoningForThinkingMode(this.log.toMessages(), this.model, {
            force: true,
          });
          if (
            repaired.stampedCount > 0 &&
            this._reasoningRepairs < CacheFirstLoop.MAX_REASONING_REPAIRS
          ) {
            this._reasoningRepairs++;
            this._reasoningRoundTripRequired = true;
            this.log.compactInPlace(repaired.messages);
            this.persistLog(repaired.messages);
            yield {
              turn: this._turn,
              role: "warning",
              severity: "high",
              content: t("loop.reasoningRoundTripRepair", {
                count: String(repaired.stampedCount),
                attempt: String(this._reasoningRepairs),
                max: String(CacheFirstLoop.MAX_REASONING_REPAIRS),
              }),
            };
            continue;
          }
        }
        const providerErrorRetryable =
          !this._providerErrorRetried &&
          !partialDelivered &&
          !signal.aborted &&
          cause.name !== "AbortError" &&
          // A genuine HTTP 4xx is a malformed request (e.g. Gemini's
          // deterministic INVALID_ARGUMENT 400), not a transient failure —
          // replaying the identical payload is pointless and hides the real
          // error. The OpenAI `response.failed` synthetic 400 (phase
          // "stream_body_read") is retryable by design and stays eligible.
          (!is4xxError(cause) || phase === "stream_body_read");
        if (providerErrorRetryable) {
          this._providerErrorRetried = true;
          const serverError = code === "server_error";
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t(serverError ? "loop.providerServerErrorRetry" : "loop.providerErrorRetry"),
          };
          if (serverError) await sleepUnlessAborted(PROVIDER_SERVER_ERROR_RETRY_DELAY_MS, signal);
          continue;
        }
        // A provider that rejects the whole request body as too large (Ollama's
        // daemon: `http: request body too large`) is healable when the body is
        // image-heavy: downscale the image parts already in the log, tell the
        // model what happened so it prefers smaller/cropped images, and retry
        // the iteration instead of killing the turn.
        if (!signal.aborted && this._payloadShrinkAttempts < 2 && isPayloadTooLargeError(cause)) {
          const level: ShrinkLevel = this._payloadShrinkAttempts === 0 ? 1 : 2;
          this._payloadShrinkAttempts++;
          const shrink = await shrinkImagePartsForRetry([...this.log.entries], level);
          if (shrink.changed) {
            this.log.compactInPlace(this.log.entries.map((m) => ({ ...m })));
            this.persistLog([...this.log.entries]);
            const fate =
              shrink.dropped > 0
                ? `downscaled and ${shrink.dropped} older image(s) removed`
                : `downscaled (${shrink.shrunk} image(s) shrunk)`;
            const note = t("loop.imagePayloadShrunk", { fate });
            this.appendAndPersist({
              role: "user",
              synthetic: true,
              content: note,
            });
            yield {
              turn: this._turn,
              role: "warning",
              severity: "low",
              content: note,
            };
            continue;
          }
        }
        // A gateway can refuse the whole body without naming a field: OpenCode
        // relays its upstream's bare invalid_request_error that way (param:
        // null). The usual cause is a prompt the upstream takes once it is
        // smaller, so ending the turn here is what made the failure look
        // permanent: every re-prompt replayed the byte-identical body.
        if (!signal.aborted && !partialDelivered && isUpstreamBareRefusal(cause)) {
          if (this._refusalRecoveryStage < CacheFirstLoop.MAX_UPSTREAM_REFUSAL_RECOVERIES) {
            this._refusalRecoveryStage++;
            const attempt = this._refusalRecoveryStage;
            const target = this.refusalFoldTarget();
            let notice: UpstreamRefusalNoticeKey = "loop.upstreamRefusalRetry";
            if (target !== null && attempt === 2) {
              this._requestFoldTarget = target;
              notice = "loop.upstreamRefusalTrimming";
            } else if (target !== null && attempt === 3) {
              yield {
                turn: this._turn,
                role: "compaction_start",
                compactionTrigger: "overflow",
                content: "",
              };
              const folded = await this.foldLogForRecovery(target, signal);
              for (const ev of folded.events) yield ev;
              if (folded.ok) notice = "loop.upstreamRefusalCompacting";
            }
            yield {
              turn: this._turn,
              role: "warning",
              severity: "high",
              content: t(notice, {
                attempt: String(attempt),
                max: String(CacheFirstLoop.MAX_UPSTREAM_REFUSAL_RECOVERIES),
              }),
            };
            // Vitest drives the ladder to exhaustion; a real turn backs off so
            // a gateway that is merely overloaded gets room to recover.
            const retryDelay = process.env.VITEST === "true" ? 0 : UPSTREAM_REFUSAL_RETRY_DELAY_MS;
            await sleepUnlessAborted(retryDelay, signal);
            continue;
          }
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.upstreamRefusalExhausted", {
              max: String(CacheFirstLoop.MAX_UPSTREAM_REFUSAL_RECOVERIES),
            }),
          };
        }
        // Context-overflow recovery folds deterministically (no summarizer
        // call): the estimator just undercounted, so an estimated LLM call
        // could overflow the same window again. Fold, then retry the iteration.
        if (!signal.aborted && this._compactRecoveries < 2 && isContextOverflowError(cause)) {
          this._compactRecoveries++;
          yield {
            turn: this._turn,
            role: "compaction_start",
            compactionTrigger: "overflow",
            content: "",
          };
          const folded = await this.foldLogForRecovery(undefined, signal);
          for (const ev of folded.events) yield ev;
          if (folded.ok) continue;
        }
        const streamBodyError = this.stream && phase === "stream_body_read";
        const retryable =
          !is4xxError(cause) &&
          cause.name !== "AbortError" &&
          !timedOut &&
          (code !== "UND_ERR_ABORTED" || streamBodyError) &&
          !(streamBodyError && (partialDelivered || this._providerErrorRetried));
        yield {
          turn: this._turn,
          role: "error",
          content: "",
          error: formatLoopError(err as Error, probe, {
            upstreamHost,
            provider: providerForModel(this.model),
          }),
          errorDetail: {
            name: cause.name,
            message: cause.message,
            phase,
            code,
            retryable,
            recoverable: false,
          },
        };
        abandonThinkingOnlyTurn();
        return;
      }

      if (repetitionStall?.channel === "reasoning") {
        this.appendAndPersist(buildAssistantMessage("", [], callModel, reasoningContent));
        yield* this.reasoningLoopEvents(
          assistantContent,
          withRepeatedPattern(
            t("loop.reasoningLoopRepeatStall", {
              period: repetitionStall.period,
              repeatedChars: repetitionStall.repeatedChars,
            }),
            repetitionStall.sample ?? "",
          ),
        );
        restoreModelIfNeeded();
        this._steerQueue.length = 0;
        return;
      }

      if (repetitionStall) {
        yield {
          turn: this._turn,
          role: "warning",
          severity: "high",
          cause: "repetition-guard",
          content: withRepeatedPattern(
            t("loop.repetitionStall", {
              channel: repetitionStall.channel,
              period: repetitionStall.period,
              repeatedChars: repetitionStall.repeatedChars,
            }),
            repetitionStall.sample ?? "",
          ),
        };
        if (assistantContent.trim().length === 0 && toolCalls.length === 0) {
          assistantContent = t("loop.repetitionStallNoPrefix");
        }
      }

      // Providers report an output-token cutoff in different shapes: Ollama
      // native sends done_reason "length", OpenAI-compat chat sends
      // finish_reason "length", OpenCode's Responses API marks the response
      // "incomplete", Gemini uses "MAX_TOKENS". The partial answer is already
      // rendered; append it to the log and re-request so the model continues
      // from where it stopped, instead of ending the turn on a truncated
      // answer. Bounded per turn so a model stuck regenerating can't loop.
      // Only continue when there is real content to resume from AND no tool
      // call was cut mid-stream — a truncated tool_call has no result to feed
      // back, and appending it as a phantom would confuse the next request.
      const outputTruncated =
        finishReason === "length" || finishReason === "incomplete" || finishReason === "MAX_TOKENS";
      const partialHasContent = assistantContent.length > 0 || reasoningContent.length > 0;
      if (outputTruncated && partialHasContent && toolCalls.length === 0) {
        if (this._truncationContinuations >= CacheFirstLoop.MAX_TRUNCATION_CONTINUATIONS) {
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.truncatedGiveUp", {
              max: CacheFirstLoop.MAX_TRUNCATION_CONTINUATIONS,
            }),
          };
          // fall through and end the turn with the partial content
        } else {
          this._truncationContinuations++;
          this.appendAndPersist(
            buildAssistantMessage(assistantContent, toolCalls, callModel, reasoningContent),
          );
          yield {
            turn: this._turn,
            role: "warning",
            severity: "low",
            content: t("loop.truncatedContinue"),
          };
          continue;
        }
      }

      // Attribute usage to the model that handled this request.
      const cacheShape = this.cacheShapeForRequest(prefixEvidence, toolSpecs);
      const cacheDiagnostics = this.cacheDiagnosticsForUsage(cacheShape, usage);
      this._lastCacheShape = cacheShape;
      const turnStats = this.stats.record(
        this._turn,
        callModel,
        usage ?? new Usage(),
        cacheDiagnostics,
        { ...this._billingContextFor(callModel), at: Date.now() },
      );

      // Carry cumulative stats across app restarts.
      let cacheDiagnostic = buildCacheDiagnostic({
        turn: this._turn,
        model: callModel,
        usage: turnStats.usage,
        estimatedCostUsd: turnStats.cost,
        prefix: prefixEvidence,
        previous: latestCacheDiagnostic(this.stats.cacheDiagnostics),
        pricingContext:
          turnStats.pricedAt === undefined
            ? undefined
            : { provider: turnStats.provider, at: turnStats.pricedAt },
      });
      if (this.sessionName) {
        try {
          // Rebuild against the persisted chain so a resumed session's first
          // turn infers misses from the pre-restart evidence, not just this boot.
          const meta = loadSessionMeta(this.sessionName);
          cacheDiagnostic = buildCacheDiagnostic({
            turn: this._turn,
            model: callModel,
            usage: turnStats.usage,
            estimatedCostUsd: turnStats.cost,
            prefix: prefixEvidence,
            previous: latestCacheDiagnostic(meta.cacheDiagnostics),
            pricingContext:
              turnStats.pricedAt === undefined
                ? undefined
                : { provider: turnStats.provider, at: turnStats.pricedAt },
          });
          const last =
            this.stats.turns.length > 0 ? this.stats.turns[this.stats.turns.length - 1] : null;
          patchSessionMeta(this.sessionName, {
            totalCostUsd: this.stats.totalCost,
            // Deep-merge per-provider costs: the loop owns USD-kind providers
            // (from its stats), while the desktop accumulates plan-window quota
            // deltas directly into meta — one must never overwrite the other.
            costByProvider: { ...meta.costByProvider, ...this.stats.providerCosts },
            cacheHitTokens: this.stats.cumulativeCacheHitTokens,
            cacheMissTokens: this.stats.cumulativeCacheMissTokens,
            totalCompletionTokens: this.stats.cumulativeCompletionTokens,
            lastPromptTokens: last?.usage.promptTokens,
            cacheDiagnostics: appendCacheDiagnostic(meta.cacheDiagnostics, cacheDiagnostic),
          });
        } catch (err) {
          // Best-effort; don't crash the turn loop on a write failure — but
          // never silent: a lost cost/usage update is real data loss.
          process.stderr.write(`reasonix: session meta patch failed — ${messageOf(err)}\n`);
        }
      }

      // Store the per-turn cache diagnostic so the live cache-miss report
      // replays the prefix hashes that were actually in effect at turn time.
      this.stats.addCacheDiagnostic(cacheDiagnostic);

      this.scratch.reasoning = reasoningContent || null;

      // Reasoning-loop guard: if the model is stuck re-emitting the same
      // thought iteration after iteration without producing an actual answer,
      // collapse the turn to a forced summary. This catches the "thinks in
      // circles" case that the storm breaker misses — e.g. re-reading a file
      // while the tool ARGS drift, so no identical-args repeat ever trips the
      // storm. Producing real assistant text resets the counter. Gated by the
      // repetition guard (Settings → Tools): when off, the loop never collapses
      // the turn on repeated reasoning.
      if (this._repetitionGuardEnabled) {
        const reasoningSig = normalizeReasoning(reasoningContent);
        const producedText = assistantContent.length > 0;
        // Count consecutive iterations of the same reasoning (the first occurrence
        // is count 1). Fire when the identical thought repeats REASONING_LOOP_LIMIT
        // times. Producing real assistant text or a different thought resets.
        if (reasoningSig !== "" && reasoningSig === this._lastReasoningSig && !producedText) {
          this._reasoningLoopCount++;
        } else {
          this._reasoningLoopCount = reasoningSig === "" ? 0 : 1;
        }
        this._lastReasoningSig = reasoningSig || null;
        if (this._reasoningLoopCount >= CacheFirstLoop.REASONING_LOOP_LIMIT) {
          yield* this.reasoningLoopEvents(
            assistantContent,
            withRepeatedPattern(
              t("loop.reasoningLoopRepeated", { count: this._reasoningLoopCount }),
              reasoningContent,
            ),
          );
          restoreModelIfNeeded();
          this._steerQueue.length = 0;
          return;
        }
      }

      // If the model leaked literal <think> tags into content (common with local
      // Ollama DeepSeek R1/Distill models when using native chat transport), extract
      // them into reasoningContent so they don't corrupt history or cause tag doom loops.
      if (assistantContent.includes("<think>") || assistantContent.includes("</think>")) {
        const { content: cleanContent, extractedReasoning } = extractThinkingTags(assistantContent);
        assistantContent = cleanContent;
        if (extractedReasoning) {
          reasoningContent = reasoningContent
            ? `${reasoningContent}\n\n${extractedReasoning}`
            : extractedReasoning;
        }
      }

      // Empty-completion guard: content, reasoning AND tool calls all empty is
      // never a legitimate model answer — the API glitched (empty stream,
      // truncated queue slot, provider hiccup). Ending the turn silently here
      // is the "chat went dead" bug: the message sits in the log, the turn is
      // done, and nothing was ever rendered. Retry ONCE (the empty response is
      // NOT appended to the log — there is nothing to show the model), then
      // give up loudly instead of a second silent exit.
      if (
        assistantContent.trim().length === 0 &&
        reasoningContent.trim().length === 0 &&
        toolCalls.length === 0
      ) {
        if (!this._emptyResponseRetried) {
          this._emptyResponseRetried = true;
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.emptyResponseRetry"),
          };
          continue;
        }
        yield {
          turn: this._turn,
          role: "warning",
          severity: "high",
          content: stopReason
            ? t("loop.emptyResponseGiveUpReason", { reason: stopReason })
            : t("loop.emptyResponseGiveUp"),
        };
        abandonThinkingOnlyTurn();
        return;
      }

      const contentBeforeRepair = assistantContent;
      const {
        calls: repairedCalls,
        report,
        content: repairedContent,
      } = this.repair.process(toolCalls, reasoningContent || null, assistantContent || null);
      assistantContent = repairedContent ?? "";
      const repairedVisibleContent = assistantContent !== contentBeforeRepair;

      // Strip any hallucinated/scavenged tool markup (DSML envelopes, <function_calls>,
      // loose invoke blocks) from assistantContent before persisting into history,
      // preventing the model from seeing its own raw tool tags and looping on them.
      if (assistantContent.includes("DSML") || assistantContent.includes("<function_calls>")) {
        assistantContent = stripHallucinatedToolMarkup(assistantContent);
      }

      // Thinking-only completion guard: a response that ended with reasoning but
      // no content and no tool call is a degenerate stop, not a finished turn.
      // Ollama-hosted reasoning models (deepseek-r1 / v4 with `think` enabled)
      // intermittently end generation right after emitting their thinking, having
      // neither answered nor called a tool, or emit single-token fragments like "p".
      // A bare replay changes nothing the model can act on — it re-stops and the
      // turn ends with no answer — so each recovery stage changes the request:
      // show the model its stop, then ask for the answer, then hand the reasoning
      // back as the material to answer from. Degenerate noise and a stalled stream
      // still exit loudly, and every stage is bounded per turn.
      if (
        assistantContent.trim().length === 0 &&
        toolCalls.length === 0 &&
        repairedCalls.length === 0 &&
        reasoningContent.trim().length > 0
      ) {
        const isDegenerate = reasoningContent.trim().length <= 5;
        if (toolSpecs.length > 0 || isDegenerate) {
          if (repetitionStall || isDegenerate) {
            yield {
              turn: this._turn,
              role: "warning",
              severity: "high",
              content: t("loop.thinkingOnlyGiveUp"),
            };
            abandonThinkingOnlyTurn();
            return;
          }
          const stage = this._thinkingOnlyRecoveries;
          if (stage < CacheFirstLoop.MAX_THINKING_ONLY_RECOVERIES) {
            this._thinkingOnlyRecoveries++;
            yield this.escalateThinkingOnly(callModel, stage, reasoningContent);
            continue;
          }
          // Every stage came back thinking-only: surface the reasoning as the
          // turn's answer instead of ending the conversation with nothing. The
          // warning above the text says exactly where it came from.
          this.discardTailThinkingOnlyPartial();
          yield {
            turn: this._turn,
            role: "warning",
            severity: "high",
            content: t("loop.thinkingOnlyRecovered", {
              max: String(CacheFirstLoop.MAX_THINKING_ONLY_RECOVERIES),
            }),
          };
          assistantContent = reasoningContent.trim();
        } else {
          // Conversational non-tool turns with substantial reasoning: promote so the turn isn't silent
          assistantContent = reasoningContent.trim();
        }
      }

      if (this._thinkingOnlyPartialAppended) {
        this._thinkingOnlyPartialAppended = false;
        this.replaceTailAssistantMessage(
          buildAssistantMessage(
            assistantContent,
            repairedCalls,
            callModel,
            reasoningContent,
            image,
          ),
        );
      } else {
        this.appendAndPersist(
          buildAssistantMessage(
            assistantContent,
            repairedCalls,
            callModel,
            reasoningContent,
            image,
          ),
        );
      }

      yield {
        turn: this._turn,
        role: "assistant_final",
        content: assistantContent,
        ...(repetitionStall || repairedVisibleContent
          ? { reasoningContent, replaceStreamedOutput: true }
          : {}),
        image,
        stats: turnStats,
        cacheDiagnostic,
        repair: report,
      };

      const allSuppressed =
        report.stormsBroken > 0 && repairedCalls.length === 0 && toolCalls.length > 0;

      // First all-suppressed storm: rewrite tail with the original tool_calls
      // (so the next prompt shows what was attempted), stub tool responses to
      // keep the API contract, and continue the iter — model gets one shot to
      // self-correct before the loud-warning path takes over.
      const failureSuppressed = report.failureSuppressed === true && allSuppressed;
      const canSelfCorrect =
        !this._turnSelfCorrected || (failureSuppressed && this._failureSteers < 3);
      if (allSuppressed && canSelfCorrect) {
        this._turnSelfCorrected = true;
        if (failureSuppressed) this._failureSteers++;
        this.replaceTailAssistantMessage(
          buildAssistantMessage(assistantContent, toolCalls, callModel, reasoningContent),
        );
        for (const call of toolCalls) {
          this.appendAndPersist({
            role: "tool",
            tool_call_id: call.id ?? "",
            name: call.function?.name ?? "",
            content: failureSuppressed
              ? "[repeated-failure guard] this call was suppressed because the tool has been failing over and over this turn. Steer to a different tool or approach, or answer with what you already have."
              : "[repeat-loop guard] this call was suppressed because it was identical to a previous call in this turn. Earlier results for it are above — try a meaningfully different approach, or stop and answer if you have enough.",
          });
        }
        yield {
          turn: this._turn,
          role: "warning",
          severity: "low",
          content: failureSuppressed
            ? t("loop.repeatedToolFailureWarning")
            : t("loop.repeatToolCallWarning"),
        };
        continue;
      }

      if (report.stormsBroken > 0) {
        const noteTail = report.notes.length ? ` — ${report.notes[report.notes.length - 1]}` : "";
        const phrase = allSuppressed
          ? t("loop.stormStuck")
          : t("loop.stormSuppressed", { count: report.stormsBroken });
        yield {
          turn: this._turn,
          role: "warning",
          severity: allSuppressed ? "high" : "low",
          content: `${phrase}${noteTail}`,
        };
      }

      if (repairedCalls.length === 0) {
        if (this._steerQueue.length > 0) {
          continue;
        }
        if (allSuppressed) {
          yield {
            turn: this._turn,
            role: "done",
            content: assistantContent || t("loop.stormStuck"),
          };
          restoreModelIfNeeded();
          this._steerQueue.length = 0;
          return;
        }
        // Premature-stop guard: the model ended its reply mid-thought (e.g.
        // "Now the remaining verification:") with no completion message, after
        // having done real work this turn. Ending the turn here strands the
        // task, so re-prompt it — bounded per turn — telling it to end with
        // the proper completion message if the task is done, otherwise
        // continue working. The partial message stays in the log (it was
        // already yielded as assistant_final); the nudge arrives as the next
        // user message and the turn continues in the same iteration loop.
        //
        // A reply cut off mid-sentence ("...all consumers of") is the provider
        // ending the stream under the model, not the model stopping, so it
        // fires even before any tool activity — otherwise the turn reports
        // "Task complete" over a half-written message. The narration-only
        // signal stays gated on tool activity so plain Q&A answers are never
        // re-prompted for ending without a completion message.
        const cutOff = !repetitionStall && looksCutOffMidSentence(assistantContent);
        const stoppedMidTask =
          turnHadToolActivity && !repetitionStall && looksLikePrematureStop(assistantContent);
        if (cutOff || stoppedMidTask) {
          if (this._prematureStopNudges >= CacheFirstLoop.MAX_PREMATURE_STOP_NUDGES) {
            yield {
              turn: this._turn,
              role: "warning",
              severity: "low",
              content: t("loop.prematureStopGiveUp", {
                max: CacheFirstLoop.MAX_PREMATURE_STOP_NUDGES,
              }),
            };
            // fall through and end the turn with the partial message — never silently.
          } else {
            this._prematureStopNudges++;
            this.appendAndPersist({
              role: "user",
              content: t(cutOff ? "loop.cutOffNudge" : "loop.prematureStopNudge"),
              synthetic: true,
            });
            yield {
              turn: this._turn,
              role: "warning",
              severity: "low",
              content: t(cutOff ? "loop.cutOffWarning" : "loop.prematureStopWarning"),
            };
            continue;
          }
        }
        restoreModelIfNeeded();
        yield { turn: this._turn, role: "done", content: assistantContent };
        this._steerQueue.length = 0;
        return;
      }

      turnHadToolActivity = true;
      yield* dispatchToolCallsChunked(repairedCalls, {
        turn: this._turn,
        signal,
        model: this.model,
        isParallelSafe: (name) => this.tools.isParallelSafe(name),
        isUserIntervention: (name) => this.tools.isUserIntervention(name),
        hasPendingGate: () => this.confirmationGate.hasPending(),
        inflightIdFor: (call) => this.inflightIdFor(call),
        inflightAdd: (id) => this._inflight.add(id),
        runOne: (call, sig) => this.runOneToolCall(call, sig),
        appendAndPersist: (m) => this.appendAndPersist(m),
        noteToolResult: (name, failed, args, result) =>
          this.repair.noteResult(name, failed, args, result),
        abandonedCalls: this._abandonedCalls,
        rateLimitState,
      });
    }
    // Unreachable — the for-loop above is unbounded. The model exits the
    // loop via return statements when it produces no more tool calls,
    // when the context guard fires, when an abort fires, or when a fatal
    // error escapes the inner try blocks.
  }

  /** One recovery path for both within-stream periodic reasoning and identical
   *  reasoning across tool iterations. The warning explains the trigger; the
   *  turn then ends so the user can redirect from a fresh prompt. */
  private async *reasoningLoopEvents(
    assistantContent: string,
    warningContent: string,
    cause: WarningCause = "repetition-guard",
  ): AsyncGenerator<LoopEvent, void, void> {
    yield {
      turn: this._turn,
      role: "warning",
      severity: "high",
      cause,
      content: `${warningContent}\n\n${t("loop.reasoningLoopStopping")}`,
    };
    yield {
      turn: this._turn,
      role: "done",
      content: assistantContent || t("loop.reasoningLoop"),
    };
  }

  async run(
    userInput: string,
    onEvent?: (ev: LoopEvent) => void,
    images?: ReadonlyArray<string | TurnImage>,
  ): Promise<string> {
    let final = "";
    for await (const ev of this.step(userInput, images)) {
      onEvent?.(ev);
      if (ev.role === "assistant_final") final = ev.content;
      if (ev.role === "done") break;
    }
    return final;
  }
}

function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Collapse whitespace and cap length for a warning's repeated-pattern excerpt. */
function warningPatternExcerpt(raw: string, max = 240): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/** Append the offending excerpt so a degeneration warning names the pattern, not
 *  just the fact of the stall. No-op when there is nothing to show. */
function withRepeatedPattern(warning: string, rawSample: string): string {
  const pattern = warningPatternExcerpt(rawSample);
  return pattern ? `${warning}\n\n${t("loop.repeatedPatternLabel")}\n${pattern}` : warning;
}

/** Collapse reasoning to a stable signature for repeat detection — trims,
 *  normalizes internal whitespace, and drops punctuation/trailing filler so
 *  re-worded but semantically identical thoughts still match. */
function normalizeReasoning(raw: string): string {
  return flattenText(raw)
    .replace(/[.,;:!?]+$/g, "")
    .toLowerCase();
}
