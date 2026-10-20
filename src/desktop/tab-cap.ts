/** Tab-count cap policy: which already-open tab a new one is allowed to replace.
 *  Pure so the rule is testable without standing up the daemon. */

/** How many tabs may stay open at once. Each tab keeps a whole session runtime,
 *  and the desktop holds that tab's transcript in memory, so the set is capped. */
export const MAX_OPEN_TABS = 12;

/** What the policy needs to know about one open tab. */
export interface TabCapCandidate {
  id: string;
  /** Monotonic focus stamp, higher = more recent. Absent means never focused. */
  focusedAt?: number;
  /** True while an agent has a turn in flight: never evicted. */
  running: boolean;
}

/** The tab a new one may replace, or null when nothing is safe to close. The active
 *  tab and any running agent are never candidates; the least recently focused goes
 *  first, and returns null below the cap so callers can ask unconditionally. */
export function pickTabToEvict(
  candidates: readonly TabCapCandidate[],
  activeId: string,
  cap: number = MAX_OPEN_TABS,
): TabCapCandidate | null {
  if (candidates.length < cap) return null;
  let worst: TabCapCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.id === activeId || candidate.running) continue;
    if (worst === null || (candidate.focusedAt ?? 0) < (worst.focusedAt ?? 0)) worst = candidate;
  }
  return worst;
}
