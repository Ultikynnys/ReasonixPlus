import type {
  AntigravityQuota,
  CodexQuota,
  MiMoQuota,
  OllamaQuota,
  OpencodeQuota,
  ProviderUsage,
  ProviderUsageWindow,
  ZaiQuota,
} from "./desktop-protocol.js";
import type { ProviderUsageWindowLabel } from "./provider-registry.js";

/** A provider's plan label + normalized windows: the part of the `$usage` payload the
 *  chip renders, so the wire type stays the single definition. */
export type ProviderUsageView = Pick<ProviderUsage, "plan" | "windows" | "limited" | "credit">;

function parseIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** One declared window, or nothing when the provider reported no such bucket. Every
 *  window every provider exposes funnels through here: % clamped to 0-100, reset as
 *  finite epoch-ms or null, and a non-numeric % dropped rather than shown as 0%. */
function windowOf(
  label: ProviderUsageWindowLabel,
  remaining: number | null | undefined,
  resetsAt: number | string | null = null,
  limited?: boolean,
): ProviderUsageWindow[] {
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return [];
  const remainingPct = Math.min(100, Math.max(0, remaining));
  const resetMs = typeof resetsAt === "number" ? resetsAt : parseIso(resetsAt);
  const rateLimited = limited === true ? { limited: true } : {};
  return [
    {
      label,
      remainingPct,
      resetsAt: Number.isFinite(resetMs) ? resetMs : null,
      ...rateLimited,
    },
  ];
}

/** Codex app-server windows (5-hour + weekly), normalized. The plan-level limit flag is
 *  the payload's own verdict: with the 5-hour window spent, the weekly percentage still
 *  reads high, so no number here can stand in for it. */
export function codexUsageView(quota: CodexQuota): ProviderUsageView {
  return {
    plan: quota.plan ?? null,
    limited: quota.limitReached === true,
    windows: [
      ...windowOf("5h", quota.fiveHour?.remainingPercent, quota.fiveHour?.resetsAt),
      ...windowOf("wk", quota.weekly?.remainingPercent, quota.weekly?.resetsAt),
    ],
  };
}

/** Ollama Cloud windows (5-hour session + weekly). `plan` is the account tier
 *  (the payload has no plan field; the daemon passes it in). */
export function ollamaUsageView(quota: OllamaQuota, plan: string | null = null): ProviderUsageView {
  return {
    plan,
    windows: [
      ...windowOf("5h", quota.session?.remainingPct, quota.session?.resetsAt),
      ...windowOf("wk", quota.weekly?.remainingPct, quota.weekly?.resetsAt),
    ],
  };
}

/** Z.AI GLM Coding Plan windows (5-hour + weekly). */
export function zaiUsageView(quota: Omit<ZaiQuota, "fetchedAt">): ProviderUsageView {
  return {
    plan: quota.plan ?? null,
    windows: [
      ...windowOf("5h", quota.fiveHour?.remainingPct, quota.fiveHour?.resetsAt),
      ...windowOf("wk", quota.weekly?.remainingPct, quota.weekly?.resetsAt),
    ],
  };
}

/** Midnight UTC after `now`: the daily spend cap resets on the UTC day boundary. */
function nextUtcMidnight(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
}

/** What Experiential Labs reports across its balance and quota reads: a spendable
 *  credit, plus the day's spend against the key's daily cap (both in nano-USD). */
export interface ExperientialSpend {
  /** Daily spend cap for the key, in nano-USD; null when uncapped. */
  dailyCapNanoUsd: number | null;
  /** Spend so far in the current UTC day, in nano-USD; null when unreadable. */
  spentNanoUsd: number | null;
  /** Account tier the limits route reports ("free", "pro", …). */
  tier: string | null;
  /** Spendable credit from the balance route, in USD. */
  creditUsd: number | null;
}

/** The gateway's two readings in one view: a "day" window (spend against the cap)
 *  and the wallet alongside it, which the chip tooltip prints via `creditTitle`. */
export function experientialUsageView(
  spend: ExperientialSpend,
  now = Date.now(),
): ProviderUsageView {
  const cap = spend.dailyCapNanoUsd;
  const spent = spend.spentNanoUsd;
  const bounded = typeof cap === "number" && cap > 0 && typeof spent === "number";
  return {
    plan: spend.tier,
    windows: windowOf("day", bounded ? 100 - (spent / cap) * 100 : null, nextUtcMidnight(now)),
    credit:
      typeof spend.creditUsd === "number" ? { currency: "USD", amount: spend.creditUsd } : null,
  };
}

/** One request-count bucket of Synthetic's `/v2/quotas` reply: what the plan allows,
 *  what it spent, and when the bucket renews. These buckets reset every few hours and
 *  are NOT the plan balance the dashboard's weekly-credit gauge draws. */
export interface SyntheticQuotaWindow {
  limit: number;
  requests: number;
  renewsAt: string | null;
}

/** The reply's `weeklyTokenLimit`: the weekly credit pool, the only field matching the
 *  "Remaining weekly credits" gauge. It regenerates continuously, so the share is
 *  never `1 - spentThisWeek/limit` and cannot come from the request buckets. */
export interface SyntheticCreditWindow {
  /** % of the weekly pool still available (`percentRemaining`, 0-100). */
  remainingPct: number;
  /** Next regeneration tick (`nextRegenAt`), or null when unreported. */
  nextRegenAt: string | null;
}

export interface SyntheticQuota {
  /** Weekly credit pool — the plan balance. */
  weeklyCredits: SyntheticCreditWindow | null;
  /** Request-count bucket, kept for diagnostics only: rendering it as a percentage is
   *  what made the chip claim 100% left while the pool was a fifth spent. */
  subscription: SyntheticQuotaWindow | null;
  fetchedAt: number;
}

/** Synthetic weekly credit window. The reply states the remaining share directly, so
 *  it is passed through untouched; a reply without `weeklyTokenLimit` (pay-as-you-go,
 *  or a bucket we cannot read) yields no window rather than an invented 100%. */
export function syntheticUsageView(quota: Omit<SyntheticQuota, "fetchedAt">): ProviderUsageView {
  return {
    plan: null,
    windows: windowOf("wk", quota.weeklyCredits?.remainingPct, quota.weeklyCredits?.nextRegenAt),
  };
}

/** OpenCode Go windows (5-hour rolling + weekly + monthly). */
export function opencodeUsageView(quota: Omit<OpencodeQuota, "fetchedAt">): ProviderUsageView {
  return {
    plan: null,
    windows: [
      ...windowOf(
        "5h",
        quota.rolling?.remainingPct,
        quota.rolling?.resetsAt,
        quota.rolling?.limited,
      ),
      ...windowOf("wk", quota.weekly?.remainingPct, quota.weekly?.resetsAt, quota.weekly?.limited),
      ...windowOf(
        "mo",
        quota.monthly?.remainingPct,
        quota.monthly?.resetsAt,
        quota.monthly?.limited,
      ),
    ],
  };
}

/** Xiaomi MiMo subscription usage. The console usage API needs web-session
 *  cookies (not the inference key), so with no console session this stays a
 *  static plan chip and NO percentage is ever fabricated. When the daemon
 *  supplies a console-reported quota (`status: "available"`), its remaining
 *  percent renders as a single "plan" window. */
export function mimoUsageView(
  quota?: MiMoQuota | null,
  plan: string | null = null,
): ProviderUsageView {
  return {
    plan: quota?.plan ?? plan,
    windows: windowOf(
      "plan",
      quota?.status === "available" ? quota.remainingPercent : null,
      quota?.resetsAt,
    ),
  };
}

/** Antigravity (Gemini Code Assist) per-model window, normalized. Only the
 *  active model (or the first bucket) is surfaced — one "plan" window. */
export function antigravityUsageView(
  quota: AntigravityQuota,
  activeModelId?: string | null,
): ProviderUsageView {
  const active = quota.windows.find((w) => w.modelId === activeModelId) ?? quota.windows[0] ?? null;
  return {
    plan: quota.plan?.name ?? quota.plan?.tierId ?? null,
    windows: windowOf(
      "plan",
      active ? Math.round((1 - active.usedFraction) * 100) : null,
      active?.resetTime,
    ),
  };
}

/** Ribbon text for a window list: "5h 70% · wk 88%", "" when there are none. Each
 *  label stays explicit: a bare percentage cannot say which bucket it describes, so a
 *  weekly-only reading would pass for whole-plan health. */
export function quotaWindowsSummary(windows: readonly ProviderUsageWindow[]): string {
  return windows.map((w) => `${w.label} ${Math.round(w.remainingPct)}%`).join(" · ");
}
