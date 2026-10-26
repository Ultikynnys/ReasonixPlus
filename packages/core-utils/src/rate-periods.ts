import { stripOllamaSchemeAndTag, stripProviderQualifier } from "./models.js";

/**
 * A provider's peak/off-peak calendar, declared in its `providers/<id>.json`
 * `billing.schedule`. Changing peak hours is a JSON edit, never a code change;
 * these functions only interpret whatever the declaration states.
 */
export interface RateSchedule {
  /** Half-open UTC peak windows: [start minute, end minute). */
  peakWindowsUtc: readonly { startMinute: number; endMinute: number }[];
  /** Offset used to decide whether the provider's billing calendar is on a weekend. */
  weekendOffsetMinutes: number;
}

/** The billing period a moment falls in, resolved once from a declared schedule. */
export interface RatePeriod {
  /** Inside a peak window on a billing weekday. */
  peak: boolean;
  /** Minutes until the next real transition, weekend suppression included. */
  minutesUntilChange: number;
}

/** True when `date` falls on Saturday or Sunday in the schedule's billing calendar. */
export function isRateScheduleWeekend(date: Date, schedule: RateSchedule): boolean {
  const shifted = new Date(date.getTime() + schedule.weekendOffsetMinutes * 60_000);
  const day = shifted.getUTCDay();
  return day === 0 || day === 6;
}

/** True when `date` is inside a configured peak window on a billing weekday. */
export function isPeakRate(date: Date, schedule: RateSchedule): boolean {
  if (isRateScheduleWeekend(date, schedule)) return false;
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return schedule.peakWindowsUtc.some(
    (window) => minute >= window.startMinute && minute < window.endMinute,
  );
}

/** Minutes from `date` to the next peak/off-peak flip, skipping weekend hours. */
function minutesUntilRateChange(date: Date, schedule: RateSchedule, peak: boolean): number {
  const minuteStart = Math.floor(date.getTime() / 60_000) * 60_000;
  for (let minutes = 1; minutes <= 8 * 24 * 60; minutes++) {
    if (isPeakRate(new Date(minuteStart + minutes * 60_000), schedule) !== peak) return minutes;
  }
  return 8 * 24 * 60;
}

/** The whole period at `date` — one call, so a chip's label and countdown read
 *  from a single computation instead of two that could drift. */
export function ratePeriodForSchedule(date: Date, schedule: RateSchedule): RatePeriod {
  const peak = isPeakRate(date, schedule);
  return { peak, minutesUntilChange: minutesUntilRateChange(date, schedule, peak) };
}

export function isOffPeakRate(date: Date, schedule: RateSchedule): boolean {
  return !isPeakRate(date, schedule);
}

/** Minutes until the next actual peak/off-peak transition, including weekend suppression. */
export function minutesUntilRateChangeForSchedule(date: Date, schedule: RateSchedule): number {
  return ratePeriodForSchedule(date, schedule).minutesUntilChange;
}

/** True when `model` is one of the ids a provider declares as peak-priced
 *  (`billing.peakModels`). The `<provider>/` scheme and any `:tag` suffix are
 *  ignored, so a hosted copy of a priced id still matches. */
export function isPeakPricedModel(
  model: string,
  peakModels: readonly string[] | null | undefined,
): boolean {
  if (!peakModels || peakModels.length === 0) return false;
  return declaredIdForms(model).some((candidate) => peakModels.includes(candidate));
}

/** A token price in one rate period, in the provider's own currency per million
 *  tokens: what it charges for fresh input, cached input and output. */
export interface RatePrice {
  input: number;
  cachedInput: number;
  output: number;
}

/** The prices a provider publishes: one row per id, the multipliers every row
 *  blends with, the fraction off-peak charges of it, and the ids whose row moves with
 *  the calendar. */
export interface RatePriceTable {
  models: Readonly<Record<string, RatePrice>>;
  /** The three values every row of this provider blends with. One triple for the whole
   *  provider, so two models can never be scored on different scales. */
  multipliers: RatePrice;
  /** What the weighted cost is divided by to read as a multiple, declared once so the
   *  scale is data rather than a constant in code. */
  divisor: number;
  offPeakFactor: number;
  /** Ids whose price moves with the schedule. Empty means every priced id moves. */
  scheduled: readonly string[];
}

/** Both periods' prices for the model a caller asked about. */
export interface RateModelPrices {
  /** The declared id the prices key on, so a surface can name what it shows:
   *  `ollama/deepseek-v4.1-flash:1017` resolves to `deepseek-v4.1-flash`. */
  id: string;
  peak: RatePrice;
  offPeak: RatePrice;
}

/** The id forms a declaration may key on: as given, without a `<provider>/`
 *  scheme, and without a `:tag` suffix. */
function declaredIdForms(model: string): string[] {
  return [stripProviderQualifier(model), stripOllamaSchemeAndTag(model)];
}

/** Both periods' prices for `model`, or null when the provider prices no id it
 *  names. Off-peak is derived from the declared amount and factor, and an id the
 *  schedule does not name keeps one price all day. */
export function ratePricesForModel(
  model: string,
  table: RatePriceTable | null | undefined,
): RateModelPrices | null {
  if (!table) return null;
  const id = declaredIdForms(model).find((candidate) => candidate in table.models);
  if (id === undefined) return null;
  const peak = table.models[id];
  if (!peak) return null;
  const moves = table.scheduled.length === 0 || table.scheduled.includes(id);
  // Six decimals hold every published amount ($0.006) and shed the float noise
  // the factor multiplication leaves behind (0.044 * 0.5 = 0.022000000000000002).
  const offPeakAmount = (amount: number): number =>
    moves ? Math.round(amount * table.offPeakFactor * 1e6) / 1e6 : amount;
  return {
    id,
    peak,
    offPeak: {
      input: offPeakAmount(peak.input),
      cachedInput: offPeakAmount(peak.cachedInput),
      output: offPeakAmount(peak.output),
    },
  };
}

/** One row's weighted cost: each column charged by the provider's multipliers. The
 *  scale is absolute, so two rows of one provider compare by their two numbers and no
 *  model is divided by another. */
export function blendedRateCost(price: RatePrice, multipliers: RatePrice): number {
  return (
    price.input * multipliers.input +
    price.cachedInput * multipliers.cachedInput +
    price.output * multipliers.output
  );
}

/** A model's cost multiple in `peak`'s period: its own row charged by the provider's
 *  declared multipliers and divided by the declared divisor, or null when the provider
 *  prices no id it names. */
export function rateCost(
  model: string,
  table: RatePriceTable | null | undefined,
  peak: boolean,
): number | null {
  if (!table) return null;
  const row = ratePricesForModel(model, table);
  if (!row) return null;
  // The parser rejects a divisor of zero, so this only fails closed on a hand-built
  // table: no scale, no badge, rather than a number that looks like a multiple.
  if (!(table.divisor > 0)) return null;
  return blendedRateCost(peak ? row.peak : row.offPeak, table.multipliers) / table.divisor;
}
