import type {
  AntigravityQuota,
  CodexQuota,
  OllamaQuota,
  OpencodeQuota,
  ZaiQuota,
} from "./desktop-protocol.js";

/** Short label for a quota window, shared so every provider's ribbon reads the
 *  same: "5h" (rolling/session), "wk", "mo", or "plan" (a per-model bucket). */
export type QuotaWindowKey = "5h" | "wk" | "mo" | "plan";

/** One provider quota window normalized into a common shape. Each provider's
 *  native payload maps here so the status bar renders every provider's usage
 *  with a single code path instead of one implementation per provider. */
export interface QuotaWindowView {
  /** Window label shown in the ribbon, e.g. "5h" or "wk". */
  label: QuotaWindowKey;
  /** % of the window's limit still available (the shared "% left" figure). */
  remainingPct: number;
  /** Epoch-ms reset time, or null when the provider didn't report one. */
  resetsAt: number | null;
  /** True when the provider flagged the window rate-limited (OpenCode Go). */
  limited?: boolean;
}

/** A provider's plan label + normalized windows + a native-unit turn delta. */
export interface ProviderUsageView {
  /** Plan/tier badge text, or null when the provider reports none. */
  plan: string | null;
  /** Ordered windows, primary first. Empty when the provider has no data. */
  windows: QuotaWindowView[];
  /** % of the primary window consumed since the previous fetch, or null. */
  turnUsedPct: number | null;
}

function parseIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Codex app-server windows (5-hour + weekly), normalized. */
export function codexUsageView(quota: CodexQuota): ProviderUsageView {
  const windows: QuotaWindowView[] = [];
  if (quota.fiveHour) {
    windows.push({
      label: "5h",
      remainingPct: quota.fiveHour.remainingPercent,
      resetsAt: parseIso(quota.fiveHour.resetsAt),
    });
  }
  if (quota.weekly) {
    windows.push({
      label: "wk",
      remainingPct: quota.weekly.remainingPercent,
      resetsAt: parseIso(quota.weekly.resetsAt),
    });
  }
  return { plan: quota.plan ?? null, windows, turnUsedPct: quota.turnUsedPct ?? null };
}

/** Ollama Cloud windows (5-hour session + weekly). `plan` is the account tier
 *  (the payload has no plan field; the daemon passes it in). */
export function ollamaUsageView(quota: OllamaQuota, plan: string | null = null): ProviderUsageView {
  const windows: QuotaWindowView[] = [];
  if (quota.session) {
    windows.push({
      label: "5h",
      remainingPct: quota.session.remainingPct,
      resetsAt: quota.session.resetsAt ?? null,
    });
  }
  if (quota.weekly) {
    windows.push({
      label: "wk",
      remainingPct: quota.weekly.remainingPct,
      resetsAt: quota.weekly.resetsAt ?? null,
    });
  }
  return { plan, windows, turnUsedPct: quota.turnUsedPct ?? null };
}

/** Z.AI GLM Coding Plan windows (5-hour + weekly). */
export function zaiUsageView(quota: ZaiQuota): ProviderUsageView {
  const windows: QuotaWindowView[] = [];
  if (quota.fiveHour) {
    windows.push({
      label: "5h",
      remainingPct: quota.fiveHour.remainingPct,
      resetsAt: quota.fiveHour.resetsAt,
    });
  }
  if (quota.weekly) {
    windows.push({
      label: "wk",
      remainingPct: quota.weekly.remainingPct,
      resetsAt: quota.weekly.resetsAt,
    });
  }
  return { plan: quota.plan ?? null, windows, turnUsedPct: quota.turnUsedPct ?? null };
}

/** OpenCode Go windows (5-hour rolling + weekly + monthly). */
export function opencodeUsageView(quota: OpencodeQuota): ProviderUsageView {
  const windows: QuotaWindowView[] = [];
  if (quota.rolling) {
    windows.push({
      label: "5h",
      remainingPct: quota.rolling.remainingPct,
      resetsAt: parseIso(quota.rolling.resetsAt),
      limited: quota.rolling.limited,
    });
  }
  if (quota.weekly) {
    windows.push({
      label: "wk",
      remainingPct: quota.weekly.remainingPct,
      resetsAt: parseIso(quota.weekly.resetsAt),
      limited: quota.weekly.limited,
    });
  }
  if (quota.monthly) {
    windows.push({
      label: "mo",
      remainingPct: quota.monthly.remainingPct,
      resetsAt: parseIso(quota.monthly.resetsAt),
      limited: quota.monthly.limited,
    });
  }
  return { plan: null, windows, turnUsedPct: quota.turnUsedPct ?? null };
}

/** Antigravity (Gemini Code Assist) per-model window, normalized. Only the
 *  active model (or the first bucket) is surfaced — one "plan" window. */
export function antigravityUsageView(
  quota: AntigravityQuota,
  activeModelId?: string | null,
): ProviderUsageView {
  const active =
    quota.windows.find((w) => w.modelId === activeModelId) ?? quota.windows[0] ?? null;
  const windows: QuotaWindowView[] = active
    ? [
        {
          label: "plan",
          remainingPct: Math.max(0, Math.round((1 - active.usedFraction) * 100)),
          resetsAt: parseIso(active.resetTime),
        },
      ]
    : [];
  return {
    plan: quota.plan?.name ?? quota.plan?.tierId ?? null,
    windows,
    turnUsedPct: quota.turnUsedPct ?? null,
  };
}

/** Ribbon text for a window list: "5h 70% · wk 88%" for multiple windows,
 *  "88%" for a single window (its label is implied), "" when there are none. */
export function quotaWindowsSummary(windows: readonly QuotaWindowView[]): string {
  if (windows.length === 0) return "";
  if (windows.length === 1) return `${Math.round(windows[0]!.remainingPct)}%`;
  return windows.map((w) => `${w.label} ${Math.round(w.remainingPct)}%`).join(" · ");
}
