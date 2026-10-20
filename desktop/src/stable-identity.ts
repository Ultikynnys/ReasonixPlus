/** Reference-stability helpers for props that must survive a re-render with the
 *  same identity, so a `memo()` boundary can bail out. React compares props by
 *  reference, and a rebuilt Map/Set with unchanged contents is a changed prop. */

/** True when both maps hold exactly the same keys with strictly equal values. */
export function sameNumberMap(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/** True when both sets hold exactly the same members. */
export function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** True when both lists hold the same names in the same order. */
export function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/** Keeps `previous` when it already equals `next`. The one way every derived
 *  collection in App hands a memoized child a stable prop. */
export function keepStable<T>(previous: T | undefined, next: T, equal: (a: T, b: T) => boolean): T {
  return previous !== undefined && equal(previous, next) ? previous : next;
}
