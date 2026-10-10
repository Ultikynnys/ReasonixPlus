import type { ReasoningEffort } from "./permission-types.js";

/** Provider ids that own an endpoint family. Mirrors `ModelProvider` in the
 *  daemon config — kept here so both the daemon and desktop share one list. */
export type ProviderID = "deepseek" | "openai" | "ollama" | "gemini" | "zai" | "opencode";

/** Canonical low→max ordering. Used for nearest-value clamping so a persisted
 *  global effort degrades predictably when a provider(model) drops a level. */
export const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Reasoning-effort levels each provider accepts, used as the fallback when the
 *  synced models.dev catalog has no per-model `reasoning_options` entry (or is
 *  unavailable). Values mirror models.dev's provider catalog — e.g. deepseek
 *  and zai reject `medium`, so it is absent. Sending a level outside this set
 *  is a 400 on the strict endpoints. */
export const PROVIDER_REASONING_EFFORTS: Record<ProviderID, readonly ReasoningEffort[]> = {
  deepseek: ["low", "high", "max"],
  openai: ["low", "medium", "high", "xhigh", "max"],
  zai: ["low", "high", "max"],
  ollama: ["low", "medium", "high", "max"],
  gemini: ["low", "medium", "high"],
  opencode: ["low", "medium", "high"],
};

const EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_ORDER);

/**
 * Levels a provider(model) actually accepts.
 *
 * `modelEfforts` is the model's own declared effort list (models.dev
 * `reasoning_options`, keyed by provider):
 *  - `undefined` → the model declares none: fall back to the provider's static set.
 *  - `[]` → the model is toggle/budget-only: no effort ladder at all.
 *  - non-empty → exactly those values (filtered to levels we can express).
 */
export function reasoningEffortsFor(
  provider: ProviderID,
  modelEfforts?: readonly string[] | null,
): readonly ReasoningEffort[] {
  if (modelEfforts == null) return PROVIDER_REASONING_EFFORTS[provider];
  return modelEfforts.filter((v): v is ReasoningEffort => EFFORT_SET.has(v));
}

/** Nearest supported level for `requested`, by canonical rank; ties resolve to
 *  the higher level (a generic request should not silently lose reasoning
 *  depth). Returns null when the model supports no effort control at all. */
export function clampReasoningEffort(
  supported: readonly ReasoningEffort[],
  requested: ReasoningEffort,
): ReasoningEffort | null {
  if (supported.length === 0) return null;
  if (supported.includes(requested)) return requested;
  const supportedSet = new Set(supported);
  const requestedRank = REASONING_EFFORT_ORDER.indexOf(requested);
  let best: ReasoningEffort | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  // Canonical order + `<=`: on an equidistant tie the higher level wins.
  for (const level of REASONING_EFFORT_ORDER) {
    if (!supportedSet.has(level)) continue;
    const distance = Math.abs(REASONING_EFFORT_ORDER.indexOf(level) - requestedRank);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = level;
    }
  }
  return best;
}
