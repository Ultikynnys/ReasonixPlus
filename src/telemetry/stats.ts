import { providerSpec, stripProviderQualifier } from "@reasonix/core-utils";
import type { Usage } from "../client.js";
import {
  type ModelProvider,
  loadEndpointForModel,
  loadProviderSetting,
  providerForModel,
  readConfig,
} from "../config.js";
import type { CacheDiagnosticEntry } from "./cache-diagnostics.js";

/** Default per-model context window (tokens), prompt-side only. Supplies the cap when no
 *  user `contextTokens` override is set; an explicit override may exceed this up to the 1M
 *  API ceiling (see resolveContextTokens). */
export const DEEPSEEK_CONTEXT_TOKENS: Record<string, number> = {
  // V4.1 Flash (2026-09-10) has a 1M window; the retired v4-flash ids route to it.
  "deepseek-flash": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-flash-vision-exp": 1_000_000,
  "deepseek-v4-pro": 300_000,
  "deepseek-chat": 300_000,
  "deepseek-reasoner": 300_000,
  // GPT-6 family (1M token window); 6.1 Sol advertises 1.05M but is held
  // to the shared 1M API ceiling like the rest of the line.
  "gpt-6.1-sol": 1_000_000,
  "gpt-6-astra": 1_000_000,
  "gpt-6-sol": 1_000_000,
  "gpt-6-luna": 1_000_000,
  // GPT-5.6 advertises a 1.05M window but is held to a 300K quality cap here
  // (the context meter reads as a fraction of this cap).
  "gpt-5.6": 300_000,
  "gpt-5.6-sol": 300_000,
  "gpt-5.6-terra": 300_000,
  "gpt-5.6-luna": 300_000,
  // Google Antigravity Gemini and Claude models: 1M token window.
  "gemini-3.5-flash-low": 1_000_000,
  "gemini-3.6-flash": 1_000_000,
  "gemini-3.7-flash": 1_000_000,
  "gemini-3.7-flash-tiered": 1_000_000,
  "gemini-3.8-flash": 1_000_000,
  "gemini-3.8-flash-tiered": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-6-thinking": 1_000_000,
  "claude-opus-4-6-thinking": 1_000_000,
};

/** Lower bound of the user-configurable `contextTokens` setting. */
export const MIN_CONTEXT_TOKENS = 128_000;
/** Upper bound of the user-configurable `contextTokens` setting — the API's 1M-token ceiling. */
export const MAX_CONTEXT_TOKENS = 1_000_000;

/** Fallback when the caller's model id isn't in the table — safe lower bound. */
export const DEFAULT_CONTEXT_TOKENS = 131_072;

/** The effective context cap for a model: the configured `contextTokens` override when set
 *  (honored up to the 1M API ceiling, even above the model's default window), else the model
 *  table, else the safe fallback — every ctxMax consumer resolves through here so they agree. */
export function resolveContextTokens(model: string, configured?: number): number {
  const provider = providerForModel(model);
  const context = providerSpec(provider)?.context;
  if (context) {
    // The server owns this window (`--ctx-size`), so the global override cannot
    // raise it: exceeding a serving window fails the request outright.
    const stored = Number(loadProviderSetting(provider, context.setting));
    const total =
      Number.isInteger(stored) && stored > context.outputReserve ? stored : context.defaultTokens;
    return total - context.outputReserve;
  }
  // Ollama windows are set by the model/server (`num_ctx`) and can be far
  // below the DeepSeek 300K floor — never clamp an explicit Ollama value up.
  const isOllama = typeof model === "string" && model.startsWith("ollama/");
  // The window table is keyed on the wire id; a `<provider>/` qualifier is
  // routing syntax, so a qualified ref shares the native id's window.
  const modelDefault = DEEPSEEK_CONTEXT_TOKENS[stripProviderQualifier(model)];
  if (typeof configured === "number" && Number.isFinite(configured)) {
    const floor = isOllama ? 1_024 : MIN_CONTEXT_TOKENS;
    // An explicit override is the source of truth: honor it up to the 1M API
    // ceiling, even above the model's default window. The table only supplies
    // the default when no override is set, so the meter and the request budget
    // check agree on the value the user asked for.
    return Math.min(MAX_CONTEXT_TOKENS, Math.max(floor, Math.floor(configured)));
  }
  return modelDefault ?? DEFAULT_CONTEXT_TOKENS;
}

/** Maximum turns retained in memory before old entries are rolled into carryover.
 *  Each TurnStats holds usage — at N=200 this caps memory at ~50KB. */
const MAX_TURNS = 200;

export interface TurnStats {
  turn: number;
  model: string;
  usage: Usage;
  cacheHitRatio: number;
  /** Raw prefix-shape snapshot for this turn — lets UIs attribute a miss to
   *  system/tool/few-shot churn or a log rewrite. */
  cacheDiagnostics?: CacheDiagnostics;
}

export type CacheChurnReason = "system" | "tools" | "few_shots" | "log_rewrite";

export interface CacheDiagnostics {
  prefixHash: string;
  prefixChanged: boolean;
  prefixChangeReasons: CacheChurnReason[];
  systemHash: string;
  toolsHash: string;
  fewShotsHash: string;
  logRewriteVersion: number;
  toolSchemaTokens: number;
  promptCacheMissTokens: number;
  promptCacheHitTokens: number;
}

/** How a provider bills its usage: a plan-window quota or no metric at all. */
export type BillingKind = "usd" | "quota" | "none";

export interface BillingContext {
  kind: BillingKind;
  /** Resolved provider identity. Never derive this from the model name. */
  provider: ModelProvider;
}

/** True when the OAuth field a provider declares holds an access token. */
function hasOAuthToken(path: string | undefined, field: string | null): boolean {
  if (!field) return false;
  const tokens = readConfig(path) as unknown as Record<
    string,
    { accessToken?: string } | undefined
  >;
  return Boolean(tokens[field]?.accessToken);
}

/** Resolve a model's native billing unit from the provider's declaration. */
export function billingContextForModel(model: string, path?: string): BillingContext {
  const provider = providerForModel(model, path);
  const spec = providerSpec(provider);
  // Declared kind, not an id switch: a newly added provider states its native
  // unit instead of silently inheriting one.
  switch (spec?.billing.kind ?? "quota") {
    case "usd":
      return { kind: "usd", provider };
    case "none":
      return { kind: "none", provider };
    case "quota":
      return { kind: "quota", provider };
    case "usd-unless-oauth":
      return {
        kind: hasOAuthToken(path, spec?.credentials.oauthConfig ?? null) ? "quota" : "usd",
        provider,
      };
    case "quota-if-key":
      // A stored key is endpoint evidence that the quota-backed usage endpoint exists.
      return { kind: loadEndpointForModel(model, path).apiKey ? "quota" : "none", provider };
  }
}

/** Compatibility helper for consumers that only need the native unit. */
export function billingKindForModel(model: string): BillingKind {
  return billingContextForModel(model).kind;
}

export interface SessionSummary {
  turns: number;
  cacheHitRatio: number;
  /** Floor estimate for the next call — actual size = this + user delta + new tool outputs. */
  lastPromptTokens: number;
  totalCacheHitTokens: number;
  totalCacheMissTokens: number;
  lastCacheMissTokens: number;
  lastToolSchemaTokens: number;
  lastPrefixChanged: boolean;
  lastPrefixChangeReasons: CacheChurnReason[];
}

export class SessionStats {
  readonly turns: TurnStats[] = [];
  /** Turn count from prior runs of a resumed session. */
  private _carryoverTurns = 0;
  private _carryoverCacheHit = 0;
  private _carryoverCacheMiss = 0;
  private _carryoverCompletion = 0;
  /** Last turn's promptTokens before exit — surfaced via summary() until the next live turn lands. */
  private _carryoverLastPromptTokens = 0;

  /** Per-turn cache diagnostics stored as each turn completes, so the live
   *  cache-miss report can replay accurate prefix hashes per historical turn
   *  rather than computing them all from the current prefix. */
  private _cacheDiagnostics: CacheDiagnosticEntry[] = [];

  /** Seed totals from a resumed session's persisted meta — only call once at construction. */
  seedCarryover(opts: {
    turnCount?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    totalCompletionTokens?: number;
    lastPromptTokens?: number;
  }): void {
    if (typeof opts.turnCount === "number" && opts.turnCount > 0) {
      this._carryoverTurns = opts.turnCount;
    }
    if (typeof opts.cacheHitTokens === "number" && opts.cacheHitTokens > 0) {
      this._carryoverCacheHit = opts.cacheHitTokens;
    }
    if (typeof opts.cacheMissTokens === "number" && opts.cacheMissTokens > 0) {
      this._carryoverCacheMiss = opts.cacheMissTokens;
    }
    if (typeof opts.totalCompletionTokens === "number" && opts.totalCompletionTokens > 0) {
      this._carryoverCompletion = opts.totalCompletionTokens;
    }
    if (typeof opts.lastPromptTokens === "number" && opts.lastPromptTokens > 0) {
      this._carryoverLastPromptTokens = opts.lastPromptTokens;
    }
  }

  /** Cumulative cache hit tokens across carryover + current turns. */
  get cumulativeCacheHitTokens(): number {
    let hit = this._carryoverCacheHit;
    for (const t of this.turns) hit += t.usage.promptCacheHitTokens;
    return hit;
  }

  /** Cumulative cache miss tokens across carryover + current turns. */
  get cumulativeCacheMissTokens(): number {
    let miss = this._carryoverCacheMiss;
    for (const t of this.turns) miss += t.usage.promptCacheMissTokens;
    return miss;
  }

  /** Cumulative completion (output) tokens across carryover + current turns. */
  get cumulativeCompletionTokens(): number {
    let comp = this._carryoverCompletion;
    for (const t of this.turns) comp += t.usage.completionTokens;
    return comp;
  }

  reset(): void {
    this.turns.length = 0;
    this._carryoverTurns = 0;
    this._carryoverCacheHit = 0;
    this._carryoverCacheMiss = 0;
    this._carryoverCompletion = 0;
    this._carryoverLastPromptTokens = 0;
    this._cacheDiagnostics = [];
  }

  record(
    turn: number,
    model: string,
    usage: Usage,
    cacheDiagnostics?: CacheDiagnostics,
  ): TurnStats {
    const stats: TurnStats = {
      turn,
      model,
      usage,
      cacheHitRatio: usage.cacheHitRatio,
      cacheDiagnostics,
    };
    this.turns.push(stats);
    this.trimOldTurns();
    return stats;
  }

  /** Store a cache diagnostic entry per turn so the live cache-miss report
   *  replays the prefix hashes that were actually in effect at turn time. */
  addCacheDiagnostic(entry: CacheDiagnosticEntry): void {
    this._cacheDiagnostics.push(entry);
  }

  /** Per-turn cache diagnostics stored in-memory for the current process. */
  get cacheDiagnostics(): readonly CacheDiagnosticEntry[] {
    return this._cacheDiagnostics;
  }

  /** Drop oldest turns beyond MAX_TURNS, folding their token counts into carryover so
   *  session totals remain accurate even after trimming. */
  private trimOldTurns(): void {
    if (this.turns.length <= MAX_TURNS) return;
    const excess = this.turns.length - MAX_TURNS;
    const dropped = this.turns.splice(0, excess);
    for (const t of dropped) {
      this._carryoverCacheHit += t.usage.promptCacheHitTokens;
      this._carryoverCacheMiss += t.usage.promptCacheMissTokens;
      this._carryoverCompletion += t.usage.completionTokens;
    }
    this._carryoverTurns += excess;
  }

  get aggregateCacheHitRatio(): number {
    let hit = this._carryoverCacheHit;
    let miss = this._carryoverCacheMiss;
    for (const t of this.turns) {
      hit += t.usage.promptCacheHitTokens;
      miss += t.usage.promptCacheMissTokens;
    }
    const denom = hit + miss;
    return denom > 0 ? hit / denom : 0;
  }

  summary(): SessionSummary {
    const last = this.turns[this.turns.length - 1];
    return {
      turns: this.turns.length + this._carryoverTurns,
      cacheHitRatio: round(this.aggregateCacheHitRatio, 4),
      lastPromptTokens: last?.usage.promptTokens ?? this._carryoverLastPromptTokens,
      totalCacheHitTokens: this.cumulativeCacheHitTokens,
      totalCacheMissTokens: this.cumulativeCacheMissTokens,
      lastCacheMissTokens: last?.usage.promptCacheMissTokens ?? 0,
      lastToolSchemaTokens: last?.cacheDiagnostics?.toolSchemaTokens ?? 0,
      lastPrefixChanged: last?.cacheDiagnostics?.prefixChanged ?? false,
      lastPrefixChangeReasons: last?.cacheDiagnostics?.prefixChangeReasons ?? [],
    };
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
