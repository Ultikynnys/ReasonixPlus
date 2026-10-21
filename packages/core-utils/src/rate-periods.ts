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
  return [stripProviderQualifier(model), stripOllamaSchemeAndTag(model)].some((candidate) =>
    peakModels.includes(candidate),
  );
}
