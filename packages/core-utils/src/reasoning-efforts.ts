import type { ReasoningEffort } from "./permission-types.js";
import {
  PROVIDER_IDS,
  PROVIDER_REASONING_EFFORTS,
  providerReasoningEfforts,
  providerSpec,
  type ProviderReasoningRule,
} from "./provider-registry.js";

/** Provider ids and their effort ladders come from providers.json via the registry. */
export { PROVIDER_IDS, PROVIDER_REASONING_EFFORTS, providerReasoningEfforts };
export type { ProviderID } from "./provider-registry.js";

/** Canonical low→max ordering. Used for nearest-value clamping so a persisted
 *  global effort degrades predictably when a provider(model) drops a level. */
export const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_ORDER);

export function modelReasoningContract(provider: string, model: string): ProviderReasoningRule {
  const spec = providerSpec(provider);
  const rule = spec?.reasoningRules.find((rule) => new RegExp(rule.pattern, "i").test(model));
  return rule ?? {
    pattern: ".*",
    efforts: spec?.reasoningEfforts ?? [],
    aliases: spec?.reasoningAliases ?? {},
    control: "effort",
    forcedThinking: false,
    budgets: {},
  };
}

export function modelReasoningEfforts(
  provider: string,
  model: string,
  discovered?: readonly string[] | null,
): readonly ReasoningEffort[] {
  const contract = modelReasoningContract(provider, model);
  if (contract.control === "none") return [];
  if (contract.control !== "effort") return contract.efforts;
  return discovered == null ? contract.efforts : reasoningEffortsFor(provider, discovered);
}

export function resolveReasoningEffort(
  provider: string,
  model: string,
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | null {
  const spec = providerSpec(provider);
  const contract = modelReasoningContract(provider, model);
  const mapped = contract.aliases[requested] ?? spec?.reasoningAliases[requested] ?? requested;
  return clampReasoningEffort(supported, mapped);
}

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
  provider: string,
  modelEfforts?: readonly string[] | null,
): readonly ReasoningEffort[] {
  if (modelEfforts == null) return providerReasoningEfforts(provider);
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
