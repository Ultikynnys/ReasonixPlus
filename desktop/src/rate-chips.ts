/** Which rate calendars the status bar shows for a tab, resolved from the endpoints
 *  the daemon already resolved for its main and subagent models. */

import {
  type ProviderSpec,
  type RateSchedule,
  isPeakPricedModel,
  providerRateSchedule,
  providerSpec,
} from "@reasonix/core-utils";
import type { ModelEndpointInfo } from "./protocol";

/** One rate chip: the provider calendar a session's model bills on. */
export interface RateChip {
  /** React key and dedupe key: one chip per provider, however many of its models
   *  the session runs, because a provider keeps one calendar for all of them. */
  key: string;
  spec: ProviderSpec;
  schedule: RateSchedule;
}

/** The session shape these chips read — the daemon-resolved endpoint per model. */
export interface RateChipSession {
  model?: string;
  modelEndpoint?: ModelEndpointInfo;
  subagentModel?: string;
  subagentModelEndpoint?: ModelEndpointInfo;
  /** The session's frozen subagent capability; false means no child ever runs. */
  subagents?: boolean;
}

/** The chip one model earns, or null when its price does not move with a declared
 *  calendar: no schedule, or an Ollama endpoint that is local, spends nothing, or
 *  serves an id the provider does not price. */
function chipFor(
  model: string | undefined,
  endpoint: ModelEndpointInfo | undefined,
): RateChip | null {
  if (!model || !endpoint?.provider) return null;
  const spec = providerSpec(endpoint.provider);
  const schedule = providerRateSchedule(spec);
  if (!spec || !schedule) return null;
  if (spec.wire.format === "ollama-native") {
    // `quota-if-key` resolves to `quota` on a keyed account and `none` without
    // one, so "can this endpoint spend money" is the gate, never a `usd` kind.
    if (endpoint.deployment !== "cloud" || endpoint.billingKind === "none") return null;
    if (!isPeakPricedModel(model, spec.billing.peakModels)) return null;
  }
  return { key: spec.id, spec, schedule };
}

/** One chip for the tab's model, plus one for a subagent pinned to another
 *  provider: a session billed on two rate calendars shows both. Repeated
 *  providers collapse, so an unpinned subagent adds nothing. */
export function rateChips(session: RateChipSession | null | undefined): RateChip[] {
  if (!session) return [];
  const candidates = [
    chipFor(session.model, session.modelEndpoint),
    session.subagents === false
      ? null
      : chipFor(session.subagentModel, session.subagentModelEndpoint),
  ];
  const seen = new Set<string>();
  return candidates.filter((chip): chip is RateChip => {
    if (!chip || seen.has(chip.key)) return false;
    seen.add(chip.key);
    return true;
  });
}
