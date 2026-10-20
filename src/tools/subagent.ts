/** Isolated child loop. Inherits the parent registry minus delegation entry points and
 *  every plan tool; inherits the parent's hooks and loop policy, bar forced invariants. */

import { PLAN_TOOL_NAMES } from "@reasonix/core-utils";
import { type DeepSeekClient, Usage } from "../client.js";
import {
  type ModelProvider,
  loadMaxIterPerTurn,
  loadMaxOutputTokens,
  providerForModel,
} from "../config.js";
import type { ResolvedHook } from "../hooks.js";
import { CacheFirstLoop } from "../loop.js";
import type { WarningCause } from "../loop/types.js";
import { applyProjectMemory } from "../memory/project.js";
import { ImmutablePrefix } from "../memory/runtime.js";
import { timestampSuffix } from "../memory/session.js";
import {
  NEGATIVE_CLAIM_RULE,
  TUI_FORMATTING_RULES,
  escalationContract,
} from "../prompt-fragments.js";
import { resolveContextTokens } from "../telemetry/stats.js";
import { ToolRegistry } from "../tools.js";
import { mergeSignals } from "./jobs.js";

/** Side-channel — subagents run inside a tool-dispatch frame, can't go through parent's `LoopEvent` stream. */
export interface SubagentEvent {
  kind: "start" | "progress" | "end" | "inner" | "phase" | "stream-progress";
  /** Stable per-spawn id; lets the UI key parallel runs apart instead of overwriting one shared row. */
  runId: string;
  /** Parent loop tool-call identity that owns this spawn. */
  parentCallId?: string;
  parentTurn?: number;
  task: string;
  skillName?: string;
  model?: string;
  iter?: number;
  elapsedMs?: number;
  summary?: string;
  error?: string;
  /** See SubagentResult.stopReason. */
  stopReason?: string;
  /** See SubagentResult.stopCause. */
  stopCause?: WarningCause;
  turns?: number;
  costUsd?: number;
  /** How this run bills: "usd" = token-priced API cost (costUsd is meaningful),
   *  "quota" = provider plan window % consumed (see quotaUsedPct), "none" = not measurable. */
  billingKind?: "usd" | "quota" | "none";
  /** Percent points of the provider plan window consumed by this run, when
   *  billingKind === "quota" and a valid before/after delta was measurable. */
  quotaUsedPct?: number;
  usage?: Usage;
  /** When kind === "inner": the raw child loop event. Parent UI translates to a child summary. */
  inner?: import("../loop.js").LoopEvent;
  /** When kind === "phase": coarse status verb for the activity row. */
  phase?: "exploring" | "summarising";
  /** Latest prompt size reported by the child model call. Updates after every child turn. */
  contextTokens?: number;
  /** Context cap the child loop enforces (resolveContextTokens of the child model) — the meter denominator. */
  contextMax?: number;
  /** When kind === "stream-progress": monotonic char counters across the whole spawn, throttled. Lets the UI prove bytes are flowing during the long gaps between tool calls. `toolReadChars` is the sum of tool-result string lengths — the bytes pulled INTO the subagent from its reads/searches. */
  outputChars?: number;
  reasoningChars?: number;
  toolReadChars?: number;
  thought?: string;
  maxToolIters?: number;
  maxElapsedMs?: number;
  budgetExhausted?: "tool-iters" | "elapsed";
}

let runIdCounter = 0;
function nextRunId(): string {
  runIdCounter++;
  return `sub-${runIdCounter.toString(36)}`;
}

export interface SubagentSink {
  current: ((ev: SubagentEvent) => void) | null;
}

/** Process-wide late-bound channel. `buildCodeToolset` runs before the TUI mounts, so its `subagentRunner` closure can't capture a UI ref directly — it reads `.current` at dispatch time. The TUI's `useSubagent` writes `.current` on mount. Both sides reference the same singleton object so prop-drilling through `chatCommand` is unnecessary. Tests / library callers that want isolation pass their own `subagentSink` to `buildCodeToolset` (overrides the singleton for that toolset). */
export const SHARED_SUBAGENT_SINK: SubagentSink = { current: null };

/** What the child loop gets: every inherited value resolved against the parent's loop,
 *  with compaction forced on. This is the ONE field list — the host-supplied bag below
 *  is derived from it, so neither can gain a field the other never sees. */
export interface ChildLoopConfig {
  /** Parent's configured context-window override. */
  ctxMaxOverride: number | undefined;
  /** Auto-compaction trigger fraction (the loop clamps it to [0.5, 0.95]). */
  autoCompactTriggerRatio: number | undefined;
  /** Per-turn tool-iteration cap, always resolved (config/env fallback). */
  maxIterPerTurn: number;
  /** Per-response output cap (`max_tokens`); undefined = no cap. */
  maxOutputTokens: number | undefined;
  /** The user's PreToolUse / PostToolUse hooks: a control the parent's calls honour, so
   *  a child calling the same tools has to honour it too. */
  hooks: ResolvedHook[] | undefined;
  /** `cwd` reported to hooks — the workspace root the parent runs them in. */
  hookCwd: string | undefined;
  /** Never optional: an unattended child that overflows has nobody to compact for it. */
  autoCompact: true;
}

/** What a host supplies: the inherited fields, all optional, minus the ones the child
 *  forces. Derived from ChildLoopConfig so the two can never drift apart. */
export type SubagentLoopOptions = Partial<
  Omit<ChildLoopConfig, "autoCompact" | "maxIterPerTurn">
> & { maxIterPerTurn?: number };

/** The child loop's config: an inherited value wins, config/env supplies the fallback for
 *  hosts that pass no bag, and auto-compaction is forced on. `defaults` is a parameter
 *  rather than a hidden read so the policy stays testable. */
export function childLoopOptions(
  inherited?: SubagentLoopOptions,
  defaults: { maxIterPerTurn: number; maxOutputTokens?: number } = {
    maxIterPerTurn: loadMaxIterPerTurn(),
    maxOutputTokens: loadMaxOutputTokens(),
  },
): ChildLoopConfig {
  return {
    ctxMaxOverride: inherited?.ctxMaxOverride,
    autoCompactTriggerRatio: inherited?.autoCompactTriggerRatio,
    maxIterPerTurn: inherited?.maxIterPerTurn ?? defaults.maxIterPerTurn,
    maxOutputTokens: inherited?.maxOutputTokens ?? defaults.maxOutputTokens,
    hooks: inherited?.hooks,
    hookCwd: inherited?.hookCwd,
    // A dead run is worse than an early fold: nobody can press compact for a child.
    autoCompact: true,
  };
}

export interface SpawnSubagentOptions {
  client: DeepSeekClient;
  parentRegistry: ToolRegistry;
  system: string;
  task: string;
  model?: string;
  maxResultChars?: number;
  sink?: SubagentSink;
  /** Forwarded into the child loop so parent Esc cancels nested work. */
  parentSignal?: AbortSignal;
  skillName?: string;
  parentCallId?: string;
  parentTurn?: number;
  /** Scopes the child registry to these names, MCP tools included; an entry ending in
   *  `*` grants a name prefix (`ghidra_*`), so one list can span several servers.
   *  NEVER_INHERITED still wins. Driven by the skill's `allowed-tools` frontmatter. */
  allowedTools?: readonly string[];
  /** Enforced count of real child tool dispatches. */
  maxToolIters?: number;
  /** Enforced wall-clock deadline for the whole child run. */
  maxElapsedMs?: number;
  /** Continue an earlier session instead of starting fresh — loads the prior messages from disk; `task` is treated as a continuation nudge. */
  resumeSession?: string;
  /** Everything the child loop inherits from the parent loop (cap, compaction trigger,
   *  iteration/output caps, tool hooks). */
  inherited?: SubagentLoopOptions;
  /** Provider and native billing unit resolved by the caller. */
  billingContext?: { kind: "usd" | "quota" | "none"; provider: ModelProvider };
  /** @deprecated Compatibility option. Prefer billingContext. */
  billingKind?: "usd" | "quota" | "none";
  /** Returns the provider plan-window used % (0..100) for this run's model.
   *  Snapshotted before and after the run to compute the consumed quota delta.
   *  Only consulted when billingKind === "quota". */
  measureQuota?: () => Promise<number | null>;
}

export interface SubagentResult {
  success: boolean;
  output: string;
  error?: string;
  turns: number;
  toolIters: number;
  elapsedMs: number;
  costUsd: number;
  /** See SubagentEvent.billingKind. */
  billingKind?: "usd" | "quota" | "none";
  /** Percent points of the provider plan window consumed by this run, when measurable. */
  quotaUsedPct?: number;
  model: string;
  skillName?: string;
  /** Zero-filled when no API calls landed so consumers always see a valid shape. */
  usage: Usage;
  /** True when the child terminated without a full answer (a user-abort placeholder) — `output` carries the placeholder text, routed to `error`. */
  forcedSummary?: boolean;
  /** The child loop's own explanation for a stop it initiated (iteration budget,
   *  repetition or context guard). Present so the parent reads WHY the run ended
   *  instead of an unattributed "no answer". */
  stopReason?: string;
  /** Machine tag for that stop. `repetition-guard` means the run was terminated
   *  as lost (degenerate loop) and is the one stop that may carry no answer. */
  stopCause?: WarningCause;
  budgetExhausted?: "tool-iters" | "elapsed";
  maxToolIters?: number;
  maxElapsedMs?: number;
}

export interface SubagentToolOptions {
  /** A client, or a per-model resolver so a mid-session model switch applies to the next
   *  spawn without rebuilding the toolset. */
  client: DeepSeekClient | ((model: string) => DeepSeekClient);
  /** Config path for provider resolution when no `billingFor` is supplied. */
  configPath?: string;
  defaultSystem?: string;
  projectRoot?: string;
  /** Fixed model id, or a live getter read at spawn time. */
  defaultModel?: string | (() => string);
  maxResultChars?: number;
  sink?: SubagentSink;
  /** Per-spawn billing resolution (unit + quota probe), so a quota-billed child reports
   *  its consumption the way the parent loop does. */
  billingFor?: (model: string) =>
    | {
        kind: "usd" | "quota" | "none";
        /** Defaults to the provider resolved from the model id. */
        provider?: ModelProvider;
        measureQuota?: () => Promise<number | null>;
      }
    | undefined;
  /** Fires once per spawn, after `spawnSubagent` returns and before its result is formatted for the parent. Bind a `SubagentTelemetry.record` here for automatic distillation capture. */
  onSpawnComplete?: (result: SubagentResult) => void;
  /** Folds the child loop's usage (cost, cache hit/miss, completion tokens) into the
   *  parent session's SessionStats via `recordExternal` — the parent stats panel then
   *  shows the full spend, not just parent-loop API calls. (#2008) */
  recordExternal?: (
    model: string,
    usage: Usage,
    billing: { kind: "usd" | "quota" | "none"; quotaUsedPct?: number },
  ) => void;
  /** Live inherited-loop options, resolved at spawn time so a mid-session cap, ratio or
   *  hook change applies to the next child without rebuilding the toolset. */
  inherited?: () => SubagentLoopOptions | undefined;
}

/** Memory-stable prefix — shared across spawns, cached. The model-dependent escalation contract is appended per spawn so a pro spawn doesn't get told it's running on flash (#582). */
const SUBAGENT_BASE_SYSTEM = `You are a Reasonix+ subagent. The parent agent spawned you to handle one focused subtask, then return.

Rules:
- Stay on the task you were given. Do not expand scope.
- Use the tools you have. A tool you cannot see was not granted to this run: MCP tools, when this run has them, arrive under their server-name prefix. You share the parent's sandbox and safety rules.
- When you're done, your final assistant message is the only thing the parent will see: make it complete and self-contained. Always state your findings, conclusion, and reason for stopping. Never end silently. No follow-up offers, no questions, no "let me know if you need more."
- Prefer one clear, distilled answer over a long log of what you tried.
- You must return an answer. Ending a run with nothing is a failure, and nobody will ask you again: when your budget runs out, stop calling tools and return the best answer you have, naming what you could not verify.

${NEGATIVE_CLAIM_RULE}

${TUI_FORMATTING_RULES}`;

const DEFAULT_MAX_RESULT_CHARS = 8000;
// Subagents default to flash: most work is read-and-synthesize
// (explore, research), which doesn't need the pro tier. Skill
// frontmatter `model: deepseek-v4-pro` is the opt-in override for
// skills that empirically benefit from the stronger model.
export const DEFAULT_SUBAGENT_MODEL = "deepseek-flash";
const DEFAULT_SUBAGENT_EFFORT: import("../config.js").ReasoningEffort = "high";

const SUBAGENT_TOOL_NAME = "spawn_subagent";
/** Delegation entry points are excluded → depth=1 hard cap; every plan tool is excluded
 *  too, ungated ones included: a child that can read the parent's plan will work a task
 *  nobody delegated to it, and a plan picker must never surface mid-parent-turn. */
export const NEVER_INHERITED_TOOLS: ReadonlySet<string> = new Set<string>([
  SUBAGENT_TOOL_NAME,
  ...PLAN_TOOL_NAMES,
]);

/** One `allowed-tools` entry against one tool name: exact, or a prefix when the entry
 *  ends in `*` (`ghidra_*` grants a bridged server's surface without listing every
 *  tool). No other pattern syntax is read, so an entry is never an accidental regex. */
export function allowEntryCovers(entry: string, toolName: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  return trimmed.endsWith("*") ? toolName.startsWith(trimmed.slice(0, -1)) : trimmed === toolName;
}

/** Whether the allow-list grants this tool. The fork and the spawn-time validation read
 *  the list through this one rule, so a pattern cannot widen the child and still be
 *  reported as an unregistered name. */
export function allowListCovers(allow: Iterable<string>, toolName: string): boolean {
  for (const entry of allow) {
    if (allowEntryCovers(entry, toolName)) return true;
  }
  return false;
}

/** Per-session spawn count past which the soft hint fires on every subsequent return. */
const SOFT_HINT_AFTER_SPAWNS = 1;
/** Per-session count past which the strong hint fires (asks the model to justify the next spawn). */
const STRONG_HINT_AFTER_SPAWNS = 4;
/** Per-session cumulative subagent token total past which the strong hint also fires. */
const STRONG_HINT_TOKEN_THRESHOLD = 50_000;

/** null → first spawn of the session, no hint. Pure for testability. */
export function subagentBudgetHint(spawnCount: number, totalTokens: number): string | null {
  if (spawnCount > STRONG_HINT_AFTER_SPAWNS || totalTokens >= STRONG_HINT_TOKEN_THRESHOLD) {
    return `[budget: this session has now spawned ${spawnCount} subagents totalling ${totalTokens} tokens. Each spawn pays a fresh prefix-cache miss plus a full child loop: confirm the next spawn is genuinely needed (parallel fan-out or >10-read context blow-up) before calling spawn_subagent again. If you can answer with direct tools, do that instead.]`;
  }
  if (spawnCount > SOFT_HINT_AFTER_SPAWNS) {
    return `[note: this session has spawned ${spawnCount} subagents totalling ${totalTokens} tokens; confirm this one is worth it.]`;
  }
  return null;
}

/** The one stop that kills a run outright instead of forcing an answer out of it —
 *  the single predicate behind both the error text and the `terminated` flag. */
function isRepetitionGuardStop(cause: WarningCause | undefined): boolean {
  return cause === "repetition-guard";
}

/** Errors captured in the result shape, never thrown — caller decides how to surface. */
export async function spawnSubagent(opts: SpawnSubagentOptions): Promise<SubagentResult> {
  const model = opts.model ?? DEFAULT_SUBAGENT_MODEL;
  const billingContext = opts.billingContext ?? {
    kind: opts.billingKind ?? "usd",
    provider: providerForModel(model),
  };
  // The child inherits the parent's configured cap, so its enforced limit and the
  // denominator the UI's ctx meter displays are the same number the tab runs on.
  const contextMax = resolveContextTokens(model, opts.inherited?.ctxMaxOverride);
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const sink = opts.sink;
  const skillName = opts.skillName;
  const parentCallId = opts.parentCallId;
  const parentTurn = opts.parentTurn;
  const runId = nextRunId();
  const maxToolIters = opts.maxToolIters;
  const maxElapsedMs = opts.maxElapsedMs;
  const sessionName = opts.resumeSession ?? `subagent-${runId}-${timestampSuffix()}`;

  const startedAt = Date.now();
  /** Later events repeat it, so they carry a preview; START carries it whole. */
  const taskPreview = opts.task.length > 30 ? `${opts.task.slice(0, 30)}…` : opts.task;
  const emit = (event: Omit<SubagentEvent, "parentCallId" | "parentTurn">): void => {
    sink?.current?.({
      ...event,
      ...(parentCallId ? { parentCallId } : {}),
      ...(parentTurn !== undefined ? { parentTurn } : {}),
    });
  };
  emit({
    kind: "start",
    runId,
    task: opts.task,
    skillName,
    model,
    iter: 0,
    elapsedMs: 0,
    maxToolIters,
    maxElapsedMs,
    // The meter denominator is known at spawn time, before the first model call.
    contextMax,
  });

  if (opts.allowedTools) {
    const registered = opts.parentRegistry.specs().map((spec) => spec.function.name);
    const missing = opts.allowedTools.filter(
      (entry) => !registered.some((name) => allowEntryCovers(entry, name)),
    );
    if (missing.length > 0) {
      const errorMessage = `subagent allow-list names tool(s) the parent does not register: ${missing.join(", ")}. Fix the skill's \`allowed-tools\` frontmatter or check spelling. An entry ending in "*" matches by name prefix.`;
      emit({
        kind: "end",
        runId,
        task: taskPreview,
        skillName,
        model,
        iter: 0,
        elapsedMs: Date.now() - startedAt,
        error: errorMessage,
        turns: 0,
        costUsd: 0,
        billingKind: billingContext.kind,
        usage: new Usage(),
      });
      return {
        success: false,
        output: "",
        error: errorMessage,
        turns: 0,
        toolIters: 0,
        elapsedMs: Date.now() - startedAt,
        costUsd: 0,
        billingKind: billingContext.kind,
        model,
        skillName,
        usage: new Usage(),
      };
    }
  }

  const childTools = opts.allowedTools
    ? forkRegistryWithAllowList(
        opts.parentRegistry,
        new Set(opts.allowedTools),
        NEVER_INHERITED_TOOLS,
      )
    : forkRegistryExcluding(opts.parentRegistry, NEVER_INHERITED_TOOLS);
  let budgetExhausted: "tool-iters" | "elapsed" | undefined;
  let dispatchedTools = 0;
  if (maxToolIters !== undefined) {
    childTools.addToolInterceptor("subagent-tool-budget", () => {
      if (dispatchedTools >= maxToolIters) {
        budgetExhausted = "tool-iters";
        return JSON.stringify({
          error: `subagent tool budget exhausted after ${maxToolIters} calls: stop using tools and return your verified findings now`,
          __reasonixSubagentBudgetRefusal: true,
          budgetExhausted,
        });
      }
      dispatchedTools++;
      return undefined;
    });
  }
  // Quota-billed runs snapshot the provider plan window before the child does
  // any work; the after-snapshot (post-loop) yields this run's consumed delta.
  let quotaBaseline: number | null = null;
  if (billingContext.kind === "quota" && opts.measureQuota) {
    quotaBaseline = await opts.measureQuota().catch(() => null);
  }
  const childPrefix = new ImmutablePrefix({
    system: opts.system,
    toolSpecs: childTools.specs(),
  });
  const childLoop = new CacheFirstLoop({
    // Inherited FIRST, so the forced invariants below can never be overridden by the
    // bag: it carries data from another object, not policy of its own.
    ...childLoopOptions(opts.inherited),
    client: opts.client,
    prefix: childPrefix,
    tools: childTools,
    model,
    // Subagents run on a constrained thinking budget by default — the
    // task is already narrow by construction, and `high` cuts output
    // tokens substantially vs `max`.
    reasoningEffort: DEFAULT_SUBAGENT_EFFORT,
    stream: true,
    session: sessionName,
    // ALWAYS on, regardless of the parent's config: a child has no operator to
    // notice a degenerate stream, and a runaway child spends real tokens before
    // any budget caps it. Terminating a lost run early is the cheap outcome.
    repetitionGuardEnabled: true,
    billingContextFor: () => billingContext,
    // Nobody can type "continue" into a child: the loop drives the cap's own
    // recovery (wrap-up nudge, then a forced summary carrying the reason).
    unattended: true,
    // A plan belongs to the session that authored it: no injection, no adoption.
    planContext: false,
  });
  // Wire parent-abort → child-abort. Two pitfalls we have to handle:
  //
  //   1. `addEventListener("abort", ...)` does NOT fire for a signal
  //      that's already aborted (the abort event has already been
  //      dispatched once and `once: true` is moot). If the parent
  //      aborted between dispatch entry and our listener attach,
  //      the listener stays silent forever and the child runs free.
  //      → Check `.aborted` synchronously and forward immediately.
  //
  //   2. childLoop.step() reassigns its internal _turnAbort at the
  //      top of step(). loop.ts forwards prior aborted state into
  //      the fresh controller, so abort() called BEFORE step() runs
  //      still kills the new step at iter 0.
  const onParentAbort = () => childLoop.abort();
  const deadlineTimer =
    maxElapsedMs === undefined
      ? undefined
      : setTimeout(() => {
          budgetExhausted = "elapsed";
          childLoop.abort();
        }, maxElapsedMs);
  deadlineTimer?.unref?.();
  if (opts.parentSignal?.aborted) {
    childLoop.abort();
  } else {
    opts.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  let final = "";
  let errorMessage: string | undefined;
  let stopReason: string | undefined;
  let stopCause: WarningCause | undefined;
  let toolIter = 0;
  let summarisingEmitted = false;
  let forcedSummaryFired = false;
  let outputChars = 0;
  let streamedContent = "";
  let reasoningChars = 0;
  let toolReadChars = 0;
  let contextTokens = 0;
  let lastStreamEmitAt = 0;
  let charsSinceLastEmit = 0;
  let recentThought = "";
  // Throttle gates — 200ms or 400 chars between emits, whichever first.
  // Cheap enough that React doesn't drown, often enough that the seconds
  // counter has company.
  const STREAM_EMIT_INTERVAL_MS = 200;
  const STREAM_EMIT_CHARS = 400;
  /** Cadence of the silence-breaker below. */
  const HEARTBEAT_MS = 1000;
  /** The one place a live-counter event is built, so a new counter cannot reach the
   *  throttled path and miss the heartbeat. `resetCharBudget` is the caller's: a
   *  heartbeat reports the clock without spending the delta budget it does not own. */
  const emitStreamProgress = (now: number, resetCharBudget: boolean): void => {
    lastStreamEmitAt = now;
    if (resetCharBudget) charsSinceLastEmit = 0;
    emit({
      kind: "stream-progress",
      runId,
      task: taskPreview,
      skillName,
      model,
      iter: toolIter,
      elapsedMs: now - startedAt,
      contextTokens,
      contextMax,
      outputChars,
      reasoningChars,
      toolReadChars,
      ...(recentThought ? { thought: recentThought } : {}),
    });
  };
  const maybeEmitStreamProgress = (now: number, force: boolean): void => {
    if (!sink?.current) return;
    if (
      !force &&
      now - lastStreamEmitAt < STREAM_EMIT_INTERVAL_MS &&
      charsSinceLastEmit < STREAM_EMIT_CHARS
    ) {
      return;
    }
    emitStreamProgress(now, true);
  };
  // Nothing else reports while the child waits on its provider: the wrapper speaks on a
  // delta, a tool, or a stop, and a request sitting queued for minutes is none of those.
  // Without this tick the card keeps the `start` event's elapsed of 0s, so a slow spawn
  // and a hung one draw identically. Gated on the delta interval so it only fills
  // silences; every early return above leaves before this timer exists.
  const heartbeatTick = (): void => {
    if (!sink?.current) return;
    const now = Date.now();
    if (now - lastStreamEmitAt < STREAM_EMIT_INTERVAL_MS) return;
    try {
      emitStreamProgress(now, false);
    } catch {
      // A timer callback has no caller to report to, and a transport that died under
      // the card must not escalate a clock tick into an uncaught exception. The stamp
      // above is already advanced, so the next beat simply retries.
    }
  };
  const heartbeat = setInterval(heartbeatTick, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    for await (const ev of childLoop.step(opts.task)) {
      emit({ kind: "inner", runId, task: taskPreview, skillName, model, inner: ev });

      if (ev.role === "tool") {
        recentThought = "";
        let budgetRefusal = false;
        try {
          budgetRefusal = JSON.parse(ev.content ?? "{}").__reasonixSubagentBudgetRefusal === true;
        } catch {
          // Normal non-JSON tool results are real work and count toward the budget.
        }
        if (!budgetRefusal) toolIter++;
        // New tool dispatched — the model went back to deciding, summarising flag resets so the next final-answer delta re-emits.
        summarisingEmitted = false;
        if (!budgetRefusal) toolReadChars += ev.content?.length ?? 0;
        emit({
          kind: "progress",
          runId,
          task: taskPreview,
          skillName,
          model,
          iter: toolIter,
          elapsedMs: Date.now() - startedAt,
        });
        // Force-emit so the read counter ticks visibly even if the
        // subsequent assistant_delta gap is short and the throttle gates
        // would otherwise hold the next emit back.
        maybeEmitStreamProgress(Date.now(), true);
      }
      if (ev.role === "assistant_delta") {
        const dContent = ev.content?.length ?? 0;
        const dReason = ev.reasoningDelta?.length ?? 0;
        const delta = ev.reasoningDelta || ev.content || "";
        if (delta) {
          recentThought = (recentThought + delta).slice(-800);
        }
        if (dContent > 0 || dReason > 0) {
          streamedContent += ev.content ?? "";
          outputChars += dContent;
          reasoningChars += dReason;
          charsSinceLastEmit += dContent + dReason;
          maybeEmitStreamProgress(Date.now(), false);
        }
      }
      // First content delta (no concurrent tool_call_delta role) = the
      // model is now writing its final answer, not deciding the next tool.
      if (ev.role === "assistant_delta" && !summarisingEmitted && (ev.content ?? "").length > 0) {
        summarisingEmitted = true;
        emit({
          kind: "phase",
          runId,
          task: taskPreview,
          skillName,
          model,
          phase: "summarising",
          iter: toolIter,
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (ev.role === "assistant_final") {
        if (ev.stats) {
          contextTokens = ev.stats.usage.promptTokens;
          maybeEmitStreamProgress(Date.now(), true);
        }
        if (ev.forcedSummary) {
          // forcedSummary marks a placeholder final rather than a real answer.
          // A user-abort placeholder ("aborted by user (Esc)…") is useless to a
          // parent loop — route it to `error`; otherwise keep the content.
          if (opts.parentSignal?.aborted) {
            errorMessage = ev.content?.trim() || "subagent aborted before producing an answer";
          } else {
            final = ev.content ?? "";
            forcedSummaryFired = true;
          }
        } else {
          final = ev.content ?? "";
        }
      }
      if (ev.role === "error") {
        errorMessage = ev.error ?? "subagent error";
      }
      if (ev.role === "warning" && ev.severity === "high" && ev.content) {
        // The child loop's only statement of WHY it stopped. A warning never
        // reaches the parent by itself, so keep the last one for attribution.
        stopReason = ev.content;
        if (ev.cause) stopCause = ev.cause;
      }
    }
  } catch (err) {
    errorMessage = (err as Error).message;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    clearInterval(heartbeat);
    opts.parentSignal?.removeEventListener("abort", onParentAbort);
  }
  // The loop yields `done` without an `error` event when its API call
  // is aborted mid-flight (intentional UX — see the matching catch in
  // CacheFirstLoop.step). From a SUBAGENT consumer's perspective that
  // still counts as a failure: no answer came back, the parent has
  // nothing to render. Synthesize an error so `success: false` and the
  // UI surfaces the abort instead of returning empty output.
  if (!final && streamedContent.trim() && (budgetExhausted || stopReason)) {
    // Content already streamed is real work: keep it as the partial result for
    // ANY stop, not just the wrapper's own timers. A loop-initiated stop carries
    // no error text here, so the reason rides alongside instead of replacing it.
    final = streamedContent.trim();
    forcedSummaryFired = true;
    errorMessage = undefined;
  }
  // The repetition guard terminated this run: it is lost by construction, and the
  // guard firing is the ONE stop allowed to carry no answer. Prompting a
  // degenerate run again is exactly how the tokens get burned.
  if (!final && isRepetitionGuardStop(stopCause)) {
    errorMessage = stopReason
      ? `subagent terminated by the repetition guard: ${stopReason}`
      : "subagent terminated by the repetition guard";
  }
  if (!errorMessage && !final) {
    errorMessage = budgetExhausted
      ? `subagent ${budgetExhausted === "elapsed" ? "time" : "tool-call"} budget exhausted before a final answer`
      : opts.parentSignal?.aborted
        ? "subagent aborted before producing an answer"
        : stopReason
          ? `subagent stopped before producing a final answer: ${stopReason}`
          : "subagent ended without producing an answer";
  }

  const elapsedMs = Date.now() - startedAt;
  const turns = childLoop.stats.turns.length;
  const costUsd = childLoop.stats.totalCost;
  const usage = aggregateChildUsage(childLoop);
  const billingKind = billingContext.kind;
  // After-snapshot the provider window for quota-billed runs. Only a non-negative
  // delta under 100pp (no window reset / no overlap double-count) is trustworthy.
  let quotaUsedPct: number | undefined;
  if (billingKind === "quota" && opts.measureQuota && quotaBaseline !== null) {
    const after = await opts.measureQuota().catch(() => null);
    const delta = after !== null ? after - quotaBaseline : null;
    if (delta !== null && Number.isFinite(delta) && delta >= 0 && delta < 100) {
      quotaUsedPct = delta;
    }
  }

  const truncated =
    final.length > maxResultChars
      ? `${final.slice(0, maxResultChars)}\n\n[…truncated ${final.length - maxResultChars} chars; ask the subagent for a tighter summary if you need more.]`
      : final;

  emit({
    kind: "end",
    runId,
    task: taskPreview,
    skillName,
    model,
    iter: toolIter,
    elapsedMs,
    summary: errorMessage ? undefined : truncated.slice(0, 120),
    error: errorMessage,
    ...(stopReason ? { stopReason } : {}),
    ...(stopCause ? { stopCause } : {}),
    turns,
    costUsd,
    billingKind,
    ...(quotaUsedPct !== undefined ? { quotaUsedPct } : {}),
    usage,
    contextTokens,
    contextMax,
    maxToolIters,
    maxElapsedMs,
    budgetExhausted,
  });

  return {
    success: !errorMessage && !forcedSummaryFired && !budgetExhausted,
    output: errorMessage ? "" : truncated,
    error: errorMessage,
    turns,
    toolIters: toolIter,
    elapsedMs,
    costUsd,
    billingKind,
    ...(quotaUsedPct !== undefined ? { quotaUsedPct } : {}),
    model,
    skillName,
    usage,
    forcedSummary: forcedSummaryFired || undefined,
    ...(stopReason ? { stopReason } : {}),
    ...(stopCause ? { stopCause } : {}),
    budgetExhausted,
    maxToolIters,
    maxElapsedMs,
  };
}

/** Zero-filled when no API calls landed so downstream consumers always see a valid shape. */
function aggregateChildUsage(loop: CacheFirstLoop): Usage {
  const agg = new Usage();
  for (const t of loop.stats.turns) {
    agg.promptTokens += t.usage.promptTokens;
    agg.completionTokens += t.usage.completionTokens;
    agg.totalTokens += t.usage.totalTokens;
    agg.promptCacheHitTokens += t.usage.promptCacheHitTokens;
    agg.promptCacheMissTokens += t.usage.promptCacheMissTokens;
  }
  return agg;
}

export function formatSubagentResult(r: SubagentResult): string {
  // Model + billing metadata ride in the result envelope so the UI can render
  // model name / cost / quota even when the live `subagent.progress` event
  // stream (which normally carries them) was never attached — e.g. after a
  // session reload, where `subagentRuns` is not persisted.
  const meta = {
    ...(r.model ? { model: r.model } : {}),
    ...(r.billingKind ? { billing_kind: r.billingKind } : {}),
    ...(r.quotaUsedPct !== undefined ? { quota_used_pct: r.quotaUsedPct } : {}),
    // The loop's own reason for stopping. Skipped when the forced summary body
    // already IS that text, so the parent does not read the same sentence twice.
    ...(r.stopReason && r.stopReason !== r.output ? { stop_reason: r.stopReason } : {}),
    ...(r.stopCause ? { stop_cause: r.stopCause } : {}),
    // Derived, not a second flag to keep in sync: the guard is the only stop that
    // kills a run outright.
    ...(isRepetitionGuardStop(r.stopCause) ? { terminated: true } : {}),
  };
  if (r.budgetExhausted) {
    return JSON.stringify({
      success: false,
      partial: true,
      output: r.output || undefined,
      error: r.error,
      budget_exhausted: r.budgetExhausted,
      max_tool_iters: r.maxToolIters,
      max_elapsed_ms: r.maxElapsedMs,
      turns: r.turns,
      tool_iters: r.toolIters,
      elapsed_ms: r.elapsedMs,
      cost_usd: r.costUsd,
      ...meta,
      note: "Subagent stopped at its enforced work budget. Treat any output as partial findings; follow up directly only on a specific unresolved risk.",
    });
  }
  if (r.forcedSummary) {
    return JSON.stringify({
      success: false,
      partial: true,
      output: r.output,
      turns: r.turns,
      tool_iters: r.toolIters,
      elapsed_ms: r.elapsedMs,
      cost_usd: r.costUsd,
      ...meta,
      note: "Subagent was force-summarized: it was stopped before finishing (iteration cap, work budget, repetition or context guard) and never produced an answer of its own. `output` carries what it had produced: useful but potentially incomplete. Decide whether to accept the partial, narrow the task and re-spawn, or fall back to direct tools.",
    });
  }
  if (!r.success) {
    return JSON.stringify({
      success: false,
      error: r.error ?? "unknown subagent error",
      turns: r.turns,
      tool_iters: r.toolIters,
      elapsed_ms: r.elapsedMs,
      ...meta,
    });
  }
  return JSON.stringify({
    success: true,
    output: r.output,
    turns: r.turns,
    tool_iters: r.toolIters,
    elapsed_ms: r.elapsedMs,
    cost_usd: r.costUsd,
    ...meta,
  });
}

/** The one subagent tool: a child is its `task` plus, optionally, the tools it may use.
 *  Everything else (model, effort, caps, compaction, hooks, cwd) is inherited from the
 *  parent loop, and the task carries the instructions. */
export function registerSubagentTool(
  parentRegistry: ToolRegistry,
  opts: SubagentToolOptions,
): ToolRegistry {
  const baseSystem = opts.defaultSystem ?? SUBAGENT_BASE_SYSTEM;
  // Bake project memory into the default once — re-reading on every
  // spawn would (a) make the child prefix unstable when REASONIX.md
  // changes mid-session, defeating cache reuse across multiple
  // subagent calls, and (b) cost a stat() per call. The parent itself
  // also reads memory once at startup; matching that semantics keeps
  // subagent and parent on the same page. The escalation contract is
  // appended per-spawn against the spawn's resolved model id (#582).
  const defaultSystemBase = opts.projectRoot
    ? applyProjectMemory(baseSystem, opts.projectRoot)
    : baseSystem;
  /** Read per spawn, so a model switch mid-session applies to the next child. */
  const resolveModel = (): string =>
    (typeof opts.defaultModel === "function" ? opts.defaultModel() : opts.defaultModel) ??
    DEFAULT_SUBAGENT_MODEL;
  const resolveClient = (model: string): DeepSeekClient =>
    typeof opts.client === "function" ? opts.client(model) : opts.client;
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  // Per-session counters survive across spawn calls because registerSubagentTool
  // runs once per parent registry — closure scope is the session scope.
  let sessionSpawnCount = 0;
  let sessionSpawnTokens = 0;

  parentRegistry.register({
    name: SUBAGENT_TOOL_NAME,
    parallelSafe: true,
    description:
      "Run one subtask in an isolated subagent and get back only its final answer. It shares your sandbox, safety rules, model and limits, but has none of your conversation: put everything it needs in 'task', including what to check and what the answer must contain. **Prefer direct tools**; spawn for parallel fan-out (2+ independent tasks issued in one batch) or when the work needs more than 10 reads whose trail you do not want to keep.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The complete instruction for the subagent: what to do, the files or symbols involved, and what the final answer must contain. It sees nothing else of this conversation.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional tool whitelist for this subtask, e.g. ['read_file','search_content'], or ['ghidra_*'] for a whole MCP server. Omit to give the subagent every tool you have, minus delegation and plan tools.",
        },
      },
      required: ["task"],
    },
    fn: async (args: { task?: unknown; tools?: unknown }, ctx) => {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) {
        return JSON.stringify({
          error: "spawn_subagent requires a non-empty 'task' argument.",
        });
      }
      const tools = Array.isArray(args.tools)
        ? args.tools.filter(
            (name): name is string => typeof name === "string" && name.trim() !== "",
          )
        : [];
      const model = resolveModel();
      const billing = opts.billingFor?.(model);
      const result = await spawnSubagent({
        client: resolveClient(model),
        parentRegistry,
        system: `${defaultSystemBase}\n\n${escalationContract(model)}`,
        task,
        model,
        maxResultChars,
        sink: opts.sink,
        billingContext: {
          kind: billing?.kind ?? "usd",
          provider: billing?.provider ?? providerForModel(model, opts.configPath),
        },
        ...(billing?.measureQuota ? { measureQuota: billing.measureQuota } : {}),
        // The whitelist IS the child's tool set; absent means "inherit mine".
        ...(tools.length > 0 ? { allowedTools: tools } : {}),
        parentSignal: mergeSignals(ctx?.signal, ctx?.cancelSignal),
        inherited: opts.inherited?.(),
      });
      sessionSpawnCount++;
      sessionSpawnTokens += result.usage.totalTokens;
      if (opts.recordExternal && result.usage) {
        try {
          opts.recordExternal(result.model, result.usage, {
            kind: result.billingKind ?? "usd",
            quotaUsedPct: result.quotaUsedPct,
          });
        } catch {
          // Stats folding must never break the spawn-tool dispatch.
        }
      }
      if (opts.onSpawnComplete) {
        try {
          opts.onSpawnComplete(result);
        } catch {
          // Telemetry callback errors must not break the spawn-tool dispatch.
        }
      }
      const formatted = formatSubagentResult(result);
      const hint = subagentBudgetHint(sessionSpawnCount, sessionSpawnTokens);
      return hint ? `${formatted}\n${hint}` : formatted;
    },
  });

  return parentRegistry;
}

/** Registry forks inherit policy but start fresh counters (session-local limits); plan
 *  mode propagates, so a child spawned in plan mode cannot escape it. */
export function forkRegistryExcluding(
  parent: ToolRegistry,
  exclude: ReadonlySet<string>,
): ToolRegistry {
  const child = new ToolRegistry({ rateLimit: parent.rateLimitPolicy });
  for (const spec of parent.specs()) {
    const name = spec.function.name;
    if (exclude.has(name)) continue;
    const def = parent.get(name);
    if (!def) continue;
    // Re-register copies the public ToolDefinition fields. The child
    // re-runs auto-flatten analysis on its own, which produces an
    // identical flatSchema for the same input — no surprise.
    child.register(def);
  }
  if (parent.planMode) child.setPlanMode(true);
  return child;
}

/** alsoExclude wins over allow so NEVER_INHERITED still drops `spawn_subagent` even if a
 *  skill allow-list names it. */
export function forkRegistryWithAllowList(
  parent: ToolRegistry,
  allow: ReadonlySet<string>,
  alsoExclude: ReadonlySet<string>,
): ToolRegistry {
  const child = new ToolRegistry({ rateLimit: parent.rateLimitPolicy });
  for (const spec of parent.specs()) {
    const name = spec.function.name;
    if (alsoExclude.has(name)) continue;
    if (!allowListCovers(allow, name)) continue;
    const def = parent.get(name);
    if (!def) continue;
    child.register(def);
  }
  if (parent.planMode) child.setPlanMode(true);
  return child;
}
