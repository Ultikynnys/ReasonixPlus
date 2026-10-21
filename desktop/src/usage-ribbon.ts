/** Which money chip the ribbon shows for a tab — resolved from the provider
 *  declaration plus the daemon's billing kind, so a new provider needs no ribbon
 *  edit and none can silently fall through. */

import type { ProviderProbeStrategy, ProviderSpec } from "@reasonix/core-utils";

export type RibbonChip = "quota" | "tier" | "wallet" | "none";

export interface RibbonFunds {
  /** Chip that fills the funds slot next to the API indicator. */
  chip: RibbonChip;
  /** Plan-window probe feeding the quota/tier chip, when the provider declares one. */
  probe: ProviderProbeStrategy | null;
}

/** The declared native unit with no config to read — for a daemon that predates the
 *  resolved `billingKind`. A conditional declaration resolves to its plan side. */
export function declaredBillingKind(spec: ProviderSpec | undefined): "usd" | "quota" | "none" {
  switch (spec?.billing.kind) {
    case "quota":
    case "quota-if-key":
    case "usd-unless-oauth":
      return "quota";
    case "none":
      return "none";
    default:
      return "usd";
  }
}

/** Resolve a tab's funds view once, from what the provider declares. The four modes:
 *  `quota` a plan window has a percentage, `tier` the plan measures nothing (so the
 *  chip names the tier), `wallet` a published account balance, `none` nothing else. */
export function resolveRibbonFunds(
  spec: ProviderSpec | undefined,
  endpoint: { billingKind?: "usd" | "quota" | "none" } | undefined,
): RibbonFunds {
  const probe = spec?.usage.probe ?? null;
  const planWindow: RibbonFunds = { chip: probe ? "quota" : "none", probe };
  const tokenPriced: RibbonFunds = {
    chip: spec?.billing.balance ? "wallet" : "none",
    probe: null,
  };
  const resolved = endpoint?.billingKind ?? declaredBillingKind(spec);
  switch (spec?.billing.kind) {
    case "usd-unless-oauth":
      // OAuth bills the plan's windows; a stored key bills tokens.
      return resolved === "usd" ? tokenPriced : planWindow;
    case "none":
      // A tier that bills windows (OpenCode Go) still has a percentage; the rest
      // measure nothing, so the chip names the tier instead of inventing a 0%.
      return resolved === "quota" ? planWindow : { chip: probe ? "tier" : "none", probe };
    case "quota":
    case "quota-if-key":
      // A keyless conditional provider keeps its chip: the tooltip is where the
      // "set a key" hint lives.
      return planWindow;
    default:
      return tokenPriced;
  }
}
