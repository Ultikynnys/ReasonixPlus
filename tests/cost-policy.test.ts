/** The cost tier decides how much of a conversation a request may carry: premium
 *  providers carry less, because every resent byte is billed again on every request. */

import { providerDeclared, providerSpec } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import { PROVIDER_DOCUMENTS } from "../packages/core-utils/src/providers.generated.js";
import { costPolicyForModel, costPolicyFrom } from "../src/cost-policy.js";
import { AUTO_COMPACT_TRIGGER_RATIO } from "../src/loop/compaction.js";
import { KEEP_LAST_IMAGES } from "../src/loop/image-retry.js";
import { DEFAULT_MAX_RESULT_TOKENS } from "../src/mcp/registry.js";

const CHEAP = {
  maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
  compactionTrigger: AUTO_COMPACT_TRIGGER_RATIO,
  keepImages: KEEP_LAST_IMAGES,
};

describe("cost policy", () => {
  it("derives every provider's tier from its declaration, never from its id", () => {
    for (const { file, document } of PROVIDER_DOCUMENTS) {
      const cost = (document as { cost?: { tier?: string } }).cost;
      expect(cost?.tier, `${file} declares no cost.tier`).toBeDefined();
      expect(["cheap", "standard", "premium"], file).toContain(cost?.tier);
    }
  });

  it("keeps the pre-tier caps for the cheap tier", () => {
    expect(costPolicyFrom({ tier: "cheap" })).toEqual(CHEAP);
  });

  it("retains less as the tier gets more expensive", () => {
    const tiers = (["cheap", "standard", "premium"] as const).map((tier) =>
      costPolicyFrom({ tier }),
    );
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i]!.maxResultTokens).toBeLessThan(tiers[i - 1]!.maxResultTokens);
      expect(tiers[i]!.compactionTrigger).toBeLessThan(tiers[i - 1]!.compactionTrigger);
      expect(tiers[i]!.keepImages).toBeLessThanOrEqual(tiers[i - 1]!.keepImages);
    }
  });

  it("lets a declared override beat the tier, field by field", () => {
    const policy = costPolicyFrom({ tier: "premium", toolResultTokens: 1_234 });
    expect(policy.maxResultTokens).toBe(1_234);
    // Untouched fields still come from the tier.
    expect(policy.compactionTrigger).toBe(costPolicyFrom({ tier: "premium" }).compactionTrigger);
  });

  it("falls back to the standard tier when nothing is declared", () => {
    expect(costPolicyFrom(undefined)).toEqual(costPolicyFrom({ tier: "standard" }));
  });

  it.skipIf(!providerDeclared("openai") || !providerDeclared("deepseek"))(
    "gives a premium provider tighter caps than a cheap one",
    () => {
      const premium = costPolicyForModel("gpt-5.6-sol");
      const cheap = costPolicyForModel("deepseek-v4-flash");
      expect(providerSpec("openai")?.cost.tier).toBe("premium");
      expect(providerSpec("deepseek")?.cost.tier).toBe("cheap");
      expect(premium.maxResultTokens).toBeLessThan(cheap.maxResultTokens);
      expect(premium.compactionTrigger).toBeLessThan(cheap.compactionTrigger);
      expect(premium.keepImages).toBeLessThan(cheap.keepImages);
    },
  );
});
