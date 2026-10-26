/** A model row's weighted cost, read from the prices and multipliers its own provider
 *  declares, so a picker can score every row it lists. */

import {
  type ModelOwnerHints,
  modelOwnerProvider,
  modelWireName,
  providerRatePrices,
  providerRateSchedule,
  providerSpec,
  providerString,
  rateCost,
  ratePeriodForSchedule,
} from "@reasonix/core-utils";
import { costLevel, multiplierLabel } from "./ui/format";

/** What to show beside a model name: the multiple, its badge text and where it sits on
 *  the cost ramp. */
export interface ModelCost {
  /** Times the declared scale a row costs: its amounts charged by the provider's
   *  multipliers, divided by the declared divisor. */
  multiplier: number;
  /** Badge text, already suffixed: "1x", "69x". */
  label: string;
  /** Where `multiplier` sits on the ramp, 0 at 1x and below and 1 at three times it. */
  level: number;
  /** Declared explanation, absent when the provider declares none. */
  title?: string;
}

/** The cost of `model` as billed by `provider`, or null when that provider publishes no
 *  price for it. A card already knows its provider, so it never has to infer one from
 *  the id: the same id can be served, and priced, by two providers. `at` is the moment
 *  to price, so a peak-priced row re-reads its period when the window flips. */
export function providerModelCost(
  provider: string | undefined | null,
  model: string | undefined | null,
  at?: Date,
  hints?: ModelOwnerHints,
): ModelCost | null {
  if (!provider || !model) return null;
  const spec = providerSpec(provider);
  const prices = providerRatePrices(spec);
  if (!spec || !prices) return null;
  // A price that moves with the provider's calendar reads the period in force now;
  // an id the schedule does not name costs the same either way.
  const schedule = providerRateSchedule(spec);
  const peak = schedule ? ratePeriodForSchedule(at ?? new Date(), schedule).peak : false;
  const multiplier = rateCost(model, prices, peak);
  if (multiplier === null) return null;
  const label = multiplierLabel(multiplier);
  return {
    multiplier,
    label: `${label}x`,
    level: costLevel(multiplier),
    title: providerString(spec, "costTitle", {
      model: modelWireName(model, hints) || model,
      multiplier: label,
    }),
  };
}

/** The cost of an id whose provider is not known up front, resolved through the same
 *  ownership rules the row's provider tag uses. */
export function modelCost(
  model: string | undefined | null,
  hints: ModelOwnerHints | undefined,
  at: Date = new Date(),
): ModelCost | null {
  if (!model) return null;
  const owner = modelOwnerProvider(model, hints);
  return owner ? providerModelCost(owner, model, at, hints) : null;
}
