/** The moment a cost multiple is priced at: a clock that moves only when a declared
 *  peak/off-peak window flips, so an open picker re-prices itself at the boundary. */

import {
  PROVIDER_SPECS,
  minutesUntilRateChangeForSchedule,
  providerRateSchedule,
} from "@reasonix/core-utils";
import { useEffect, useState } from "react";

/** Milliseconds until the next flip across every provider that declares a calendar,
 *  or 0 when none does and a price can never move on its own. */
export function msUntilNextRateFlip(at: Date): number {
  let minutes = Number.POSITIVE_INFINITY;
  for (const spec of PROVIDER_SPECS) {
    const schedule = providerRateSchedule(spec);
    if (!schedule) continue;
    minutes = Math.min(minutes, minutesUntilRateChangeForSchedule(at, schedule));
  }
  return Number.isFinite(minutes) ? minutes * 60_000 : 0;
}

/** A `Date` that steps at the next declared transition. Reading it during render keeps
 *  every cost multiple on the period in force, and the timer re-arms from the new
 *  moment, so one badge flip costs one wake-up instead of a poll. */
export function useRateClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const delay = msUntilNextRateFlip(now);
    if (delay <= 0) return;
    const id = setTimeout(() => setNow(new Date()), delay);
    return () => clearTimeout(id);
  }, [now]);
  return now;
}
