import { join } from "node:path";
import { type ChangelogRelease, messageOf, toReleases } from "@reasonix/core-utils";
import { isCacheFresh, readJsonFileSilently, writeJsonFileSilently } from "./core/json-file.js";
import { fetchJson } from "./net/timeout-fetch.js";
import { reasonixHome } from "./reasonix-home.js";

/** Commit history for the public repo, grouped per release by the caller.
 *  Unauthenticated: GitHub allows 60 requests/hour per IP, which is why the
 *  cache below is generous and the UI only fetches when the page is opened. */
export const CHANGELOG_COMMITS_URL =
  "https://api.github.com/repos/Ultikynnys/ReasonixPlus/commits?per_page=100";

/** Cache TTL: 12 hours, matching the OpenCode model catalog. A changelog moves
 *  once per release at most, so anything fresher is wasted requests. */
export const CHANGELOG_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Network timeout. Generous enough for a slow link, short enough that the
 *  Settings page shows its error state rather than spinning indefinitely. */
export const CHANGELOG_FETCH_TIMEOUT_MS = 8_000;

export interface ChangelogCacheEntry {
  releases: ChangelogRelease[];
  checkedAt: number;
}

export interface ChangelogSnapshot {
  releases: ChangelogRelease[];
  checkedAt: number;
  /** Set when the network failed but a cached changelog is being shown. */
  error?: string;
}

export function changelogCachePath(homeDirOverride?: string): string {
  return join(reasonixHome(homeDirOverride), "changelog-cache.json");
}

function isValidCacheEntry(value: unknown): value is ChangelogCacheEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Array.isArray(entry.releases) && typeof entry.checkedAt === "number";
}

export function loadChangelogCache(homeDirOverride?: string): ChangelogCacheEntry | null {
  return readJsonFileSilently(changelogCachePath(homeDirOverride), isValidCacheEntry);
}

export function writeChangelogCache(entry: ChangelogCacheEntry, homeDirOverride?: string): void {
  writeJsonFileSilently(changelogCachePath(homeDirOverride), entry);
}

export interface FetchChangelogOptions {
  /** Bypass the TTL cache (the page's Refresh button). */
  force?: boolean;
  url?: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
}

export async function fetchChangelog(opts: FetchChangelogOptions = {}): Promise<ChangelogSnapshot> {
  const cached = loadChangelogCache(opts.homeDir);
  const ttl = opts.ttlMs ?? CHANGELOG_CACHE_TTL_MS;
  if (cached && isCacheFresh(cached, ttl, opts.force)) {
    return cached;
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = opts.url ?? CHANGELOG_COMMITS_URL;
  const timeout = opts.timeoutMs ?? CHANGELOG_FETCH_TIMEOUT_MS;

  try {
    const payload = await fetchJson(url, fetchImpl, timeout);
    const releases = toReleases(payload);
    if (releases.length === 0) {
      throw new Error("no releases parsed from the commit history");
    }
    const entry: ChangelogCacheEntry = { releases, checkedAt: Date.now() };
    writeChangelogCache(entry, opts.homeDir);
    return entry;
  } catch (err) {
    const error = messageOf(err);
    // Stale history beats an empty settings page, so surface the error but keep
    // showing whatever was cached.
    process.stderr.write(
      `reasonix: failed to fetch the changelog (${error}), falling back to the cached copy\n`,
    );
    if (cached) return { ...cached, error };
    return { releases: [], checkedAt: 0, error };
  }
}
