import { parseProviderRegistry } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import { declaredBillingKind, resolveRibbonFunds } from "./usage-ribbon";

/** The shape a future provider file takes, so this suite pins the ribbon contract
 *  rather than today's nine files. */
function specOf(overrides: Record<string, unknown>) {
  const [spec] = parseProviderRegistry({
    providers: [
      {
        id: "future",
        providerId: "zai",
        label: "Future",
        shortLabel: "FUT",
        groupLabelKey: "composer.modelZaiGroup",
        order: 99,
        setupGate: ["apiKey"],
        precedence: null,
        defaultModel: null,
        knownCatalog: false,
        models: ["future-1"],
        endpoint: { strategy: "standard", default: "https://future.test/v1", tiers: {} },
        settings: [],
        usable: { apiKey: true, keylessLocal: false, always: false },
        discovery: {
          strategy: "models-endpoint",
          listField: "data",
          idField: "id",
          excludeSpeech: false,
        },
        client: { auth: "api-key", transport: null, allowMissingKey: false },
        ...overrides,
      },
    ],
  });
  if (!spec) throw new Error("fixture provider did not parse");
  return spec;
}

describe("resolveRibbonFunds", () => {
  it("gives a plan-window provider the quota chip and no dollar figures", () => {
    const spec = specOf({
      billing: { kind: "quota" },
      usage: { probe: "zai-monitor" },
    });
    expect(resolveRibbonFunds(spec, { billingKind: "quota" })).toEqual({
      chip: "quota",
      costFigures: false,
      probe: "zai-monitor",
    });
  });

  it("names the tier when the plan measures nothing", () => {
    const spec = specOf({ billing: { kind: "none" }, usage: { probe: "opencode-usage" } });
    expect(resolveRibbonFunds(spec, { billingKind: "none" })).toEqual({
      chip: "tier",
      costFigures: false,
      probe: "opencode-usage",
    });
  });

  it("upgrades a plan-measured tier to a percentage", () => {
    // OpenCode Go bills its plan windows; the free tier measures nothing.
    const spec = specOf({ billing: { kind: "none" }, usage: { probe: "opencode-usage" } });
    expect(resolveRibbonFunds(spec, { billingKind: "quota" }).chip).toBe("quota");
  });

  it("shows the wallet only when the provider publishes a balance", () => {
    const priced = { "future-1": { inputCacheHit: 0.1, inputCacheMiss: 0.2, output: 0.3 } };
    const wallet = specOf({ billing: { kind: "usd", balance: { url: "/wallet", shape: "balance-infos" }, pricing: priced } });
    expect(resolveRibbonFunds(wallet, { billingKind: "usd" })).toEqual({
      chip: "wallet",
      costFigures: true,
      probe: null,
    });
  });

  it("falls to cost figures when a token-priced provider publishes no balance", () => {
    const spec = specOf({
      billing: {
        kind: "usd",
        pricing: { "future-1": { inputCacheHit: 1, inputCacheMiss: 2, output: 3 } },
      },
    });
    expect(resolveRibbonFunds(spec, { billingKind: "usd" })).toEqual({
      chip: "none",
      costFigures: true,
      probe: null,
    });
  });

  it("claims no figure at all when the provider publishes no rates", () => {
    // A paid gateway with no declared table measures nothing: a $0.0000 chip would
    // be an invented number, so the ribbon shows no money chip.
    const spec = specOf({ billing: { kind: "usd" } });
    expect(resolveRibbonFunds(spec, { billingKind: "usd" })).toEqual({
      chip: "none",
      costFigures: false,
      probe: null,
    });
  });

  it("follows the resolved kind for a conditional declaration", () => {
    const oauth = specOf({ billing: { kind: "usd-unless-oauth" }, usage: { probe: "codex-oauth" } });
    expect(resolveRibbonFunds(oauth, { billingKind: "quota" }).chip).toBe("quota");
    expect(resolveRibbonFunds(oauth, { billingKind: "usd" }).chip).toBe("none");
    // No resolved kind (an older daemon) keeps the plan chip rather than implying $.
    expect(resolveRibbonFunds(oauth, undefined).chip).toBe("quota");
  });

  it("keeps the chip for a keyless conditional provider so its hint still shows", () => {
    const spec = specOf({ billing: { kind: "quota-if-key" }, usage: { probe: "zai-monitor" } });
    expect(resolveRibbonFunds(spec, { billingKind: "none" }).chip).toBe("quota");
  });

  it("claims nothing for a provider that is not declared", () => {
    expect(resolveRibbonFunds(undefined, { billingKind: "usd" })).toEqual({
      chip: "none",
      costFigures: false,
      probe: null,
    });
  });
});

describe("declaredBillingKind", () => {
  it("resolves every declared kind to the side a keyless tab sees", () => {
    expect(declaredBillingKind(undefined)).toBe("usd");
    expect(declaredBillingKind(specOf({ billing: { kind: "usd" } }))).toBe("usd");
    expect(declaredBillingKind(specOf({ billing: { kind: "quota" } }))).toBe("quota");
    expect(declaredBillingKind(specOf({ billing: { kind: "quota-if-key" } }))).toBe("quota");
    expect(declaredBillingKind(specOf({ billing: { kind: "usd-unless-oauth" } }))).toBe("quota");
    expect(declaredBillingKind(specOf({ billing: { kind: "none" } }))).toBe("none");
  });
});
