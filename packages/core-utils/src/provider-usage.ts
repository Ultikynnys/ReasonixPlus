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
export type ProviderUsageView = Pick<ProviderUsage, "plan" | "windows" | "credit">;

function parseIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** One declared window, or nothing when the provider reported no such bucket. Every
 *  window a provider exposes goes through here, so a percentage is clamped to 0-100
 *  and a reset time is either finite epoch-ms or null — a payload cannot make the chip
 *  print "-4%" or "NaN/NaN". */
function windowOf(
  label: ProviderUsageWindowLabel,
  from: { remainingPct: number; resetsAt: number | null; limited?: boolean } | null,
): ProviderUsageWindow[] {
  if (!from) return [];
  const remainingPct = Number.isFinite(from.remainingPct)
    ? Math.min(100, Math.max(0, from.remainingPct))
    : 0;
  const resetsAt =
    typeof from.resetsAt === "number" && Number.isFinite(from.resetsAt) ? from.resetsAt : null;
  const limited = from.limited === true ? { limited: true } : {};
  return [{ label, remainingPct, resetsAt, ...limited }];
}

/** Codex app-server windows (5-hour + weekly), normalized. */
export function codexUsageView(quota: CodexQuota): ProviderUsageView {
  const iso = (w: { remainingPercent: number; resetsAt: string | null } | null) =>
    w ? { remainingPct: w.remainingPercent, resetsAt: parseIso(w.resetsAt) } : null;
  return {
    plan: quota.plan ?? null,
    windows: [...windowOf("5h", iso(quota.fiveHour)), ...windowOf("wk", iso(quota.weekly))],
  };
}

/** Ollama Cloud windows (5-hour session + weekly). `plan` is the account tier
 *  (the payload has no plan field; the daemon passes it in). */
export function ollamaUsageView(quota: OllamaQuota, plan: string | null = null): ProviderUsageView {
  const plain = (w: { remainingPct: number; resetsAt?: number | null } | null) =>
    w ? { remainingPct: w.remainingPct, resetsAt: w.resetsAt ?? null } : null;
  return {
    plan,
    windows: [...windowOf("5h", plain(quota.session)), ...windowOf("wk", plain(quota.weekly))],
  };
}

/** Z.AI GLM Coding Plan windows (5-hour + weekly). */
export function zaiUsageView(quota: Omit<ZaiQuota, "fetchedAt">): ProviderUsageView {
  const plain = (w: { remainingPct: number; resetsAt?: number | null } | null) =>
    w ? { remainingPct: w.remainingPct, resetsAt: w.resetsAt ?? null } : null;
  return {
    plan: quota.plan ?? null,
    windows: [...windowOf("5h", plain(quota.fiveHour)), ...windowOf("wk", plain(quota.weekly))],
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
    windows: bounded
      ? windowOf("day", { remainingPct: 100 - (spent / cap) * 100, resetsAt: nextUtcMidnight(now) })
      : [],
    credit:
      typeof spend.creditUsd === "number" ? { currency: "USD", amount: spend.creditUsd } : null,
  };
}

/** One window of Synthetic's `/v2/quotas` reply: what the plan allows, what it spent,
 *  and when it renews. Every category speaks these three fields. */
export interface SyntheticQuotaWindow {
  limit: number;
  requests: number;
  renewsAt: string | null;
}

/** Only the subscription category is a plan balance. The reply also carries an hourly
 *  `search` bucket and a daily `freeToolCalls` bucket, which the chip's window labels
 *  (5h/wk/mo/plan) cannot describe without inventing one. */
export interface SyntheticQuota {
  subscription: SyntheticQuotaWindow | null;
  fetchedAt: number;
}

/** Synthetic subscription window: the reply carries counts, not percentages, so the
 *  remaining share is computed here (`requests/limit`). */
export function syntheticUsageView(quota: Omit<SyntheticQuota, "fetchedAt">): ProviderUsageView {
  const window = quota.subscription;
  const pct =
    window && Number.isFinite(window.limit) && window.limit > 0
      ? (window.requests / window.limit) * 100
      : null;
  return {
    plan: null,
    windows: windowOf(
      "5h",
      pct === null
        ? null
        : {
            remainingPct: 100 - pct,
            resetsAt: parseIso(window?.renewsAt),
          },
    ),
  };
}

/** OpenCode Go windows (5-hour rolling + weekly + monthly). */
export function opencodeUsageView(quota: Omit<OpencodeQuota, "fetchedAt">): ProviderUsageView {
  const iso = (w: { remainingPct: number; resetsAt: string | null; limited: boolean } | null) =>
    w ? { remainingPct: w.remainingPct, resetsAt: parseIso(w.resetsAt), limited: w.limited } : null;
  return {
    plan: null,
    windows: [
      ...windowOf("5h", iso(quota.rolling)),
      ...windowOf("wk", iso(quota.weekly)),
      ...windowOf("mo", iso(quota.monthly)),
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
      quota?.status === "available" && typeof quota.remainingPercent === "number"
        ? { remainingPct: quota.remainingPercent, resetsAt: parseIso(quota.resetsAt) }
        : null,
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
      active
        ? {
            remainingPct: Math.round((1 - active.usedFraction) * 100),
            resetsAt: parseIso(active.resetTime),
          }
        : null,
    ),
  };
}

/** Ribbon text for a window list: "5h 70% · wk 88%" for multiple windows,
 *  "88%" for a single window (its label is implied), "" when there are none. */
export function quotaWindowsSummary(windows: readonly ProviderUsageWindow[]): string {
  if (windows.length === 0) return "";
  if (windows.length === 1) return `${Math.round(windows[0]!.remainingPct)}%`;
  return windows.map((w) => `${w.label} ${Math.round(w.remainingPct)}%`).join(" · ");
}
