/** Retention tuning resolved from a provider's declared cost tier. The loop takes
 *  plain numbers, so a provider file can move a family without touching loop code. */

import { type ProviderCostSpec, type ProviderCostTier, providerSpec } from "@reasonix/core-utils";
import { providerForModel } from "./config.js";
import { AUTO_COMPACT_TRIGGER_RATIO } from "./loop/compaction.js";
import { KEEP_LAST_IMAGES } from "./loop/image-retry.js";
import { DEFAULT_MAX_RESULT_TOKENS } from "./mcp/registry.js";

export interface CostPolicy {
  /** Cap on one tool result, in tokens. Paid again on every later request. */
  maxResultTokens: number;
  /** Fraction of the context window that triggers auto-compaction. */
  compactionTrigger: number;
  /** Image parts resent with each request. */
  keepImages: number;
}

/** `cheap` restates the pre-tier defaults, so a provider that declares nothing
 *  behaves exactly as it did before the tier existed. */
const TIER_POLICY: Record<ProviderCostTier, CostPolicy> = {
  cheap: {
    maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
    compactionTrigger: AUTO_COMPACT_TRIGGER_RATIO,
    keepImages: KEEP_LAST_IMAGES,
  },
  standard: { maxResultTokens: 6_000, compactionTrigger: 0.75, keepImages: 3 },
  premium: { maxResultTokens: 4_000, compactionTrigger: 0.6, keepImages: 2 },
};

/** The tier's numbers, with any per-provider override applied. Takes the parsed
 *  declaration rather than a model so the precedence is testable in isolation. */
export function costPolicyFrom(cost?: ProviderCostSpec): CostPolicy {
  // A declaration is parser-validated; staying total here means a damaged file
  // degrades to the standard row instead of failing a session at send time.
  const tier = TIER_POLICY[cost?.tier ?? "standard"] ?? TIER_POLICY.standard;
  return {
    maxResultTokens: cost?.toolResultTokens ?? tier.maxResultTokens,
    compactionTrigger: cost?.compactionTrigger ?? tier.compactionTrigger,
    keepImages: cost?.keepImages ?? tier.keepImages,
  };
}

/** The policy for one model, read from the provider that serves it. */
export function costPolicyForModel(model: string, path?: string): CostPolicy {
  return costPolicyFrom(providerSpec(providerForModel(model, path))?.cost);
}
