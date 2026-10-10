/** Changelog assembly from a repo's commit list.
 *
 *  Pure: no I/O, no network. `src/changelog.ts` fetches the commits and calls
 *  in here, and the desktop Settings page renders the result.
 *
 *  The grouping rule is the whole point of this module. Release automation
 *  writes a `chore(release): vX.Y.Z` commit right before tagging
 *  (.github/workflows/release.yml), so that marker names the version every
 *  commit above it shipped in. Those markers are never shown as changes; they
 *  only split the list into per-version groups. */

export type ChangelogKind = "feat" | "fix" | "perf" | "change" | "chore" | "other";

export interface ChangelogEntry {
  /** Abbreviated SHA, shown as a stable handle for the commit. */
  hash: string;
  kind: ChangelogKind;
  /** Conventional-commit scope, when the subject carried one. */
  scope?: string;
  /** Subject text with the `type(scope):` prefix stripped. */
  text: string;
  breaking: boolean;
}

export interface ChangelogRelease {
  /** e.g. `v1.0.27`. Null for the group of commits newer than the newest
   *  release marker, which have not shipped under any version yet. */
  version: string | null;
  /** ISO date of the marker commit that closed the group. */
  date: string | null;
  entries: ChangelogEntry[];
  /** True for the not-yet-released group at the top of the list. */
  unreleased: boolean;
}

export interface ChangelogSection {
  kind: ChangelogKind;
  entries: ChangelogEntry[];
}

/** Raw commit as returned by the GitHub commits API (and by `git log`). */
export interface ChangelogCommit {
  sha: string;
  /** First line of the commit message. */
  subject: string;
  /** ISO-8601 author or committer date. */
  date: string | null;
}

/** `chore(release): v1.0.27`, and the variants that show up in a real history:
 *  a bare `release: 1.0.27`, a `v` prefix, or a SemVer pre-release suffix. */
const RELEASE_SUBJECT =
  /^(?:chore\s*\(\s*release(?:-bump)?\s*\)|chore\s*:\s*release|release)\s*:?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/i;

/** Section render order. `chore` sits last so the toggle-able maintenance
 *  bucket never pushes the user-facing changes down the page. */
export const SECTION_ORDER: readonly ChangelogKind[] = [
  "feat",
  "fix",
  "perf",
  "change",
  "other",
  "chore",
];

const KIND_BY_TYPE: Readonly<Record<string, ChangelogKind>> = {
  feat: "feat",
  feature: "feat",
  fix: "fix",
  bugfix: "fix",
  hotfix: "fix",
  perf: "perf",
  performance: "perf",
  refactor: "change",
  style: "change",
  revert: "change",
  docs: "chore",
  doc: "chore",
  test: "chore",
  tests: "chore",
  build: "chore",
  ci: "chore",
  chore: "chore",
};

/** Version named by a release commit's subject, or null if it isn't one. */
export function releaseVersion(subject: string): string | null {
  const match = RELEASE_SUBJECT.exec(subject.trim());
  return match?.[1] ?? null;
}

export function isMergeCommit(subject: string): boolean {
  return /^merge\s/i.test(subject.trim());
}

/** Split `type(scope)!: text` into its parts. A subject that doesn't follow the
 *  convention keeps its full text and lands in `other`, so nothing is lost. */
export function parseCommitSubject(subject: string): Omit<ChangelogEntry, "hash"> {
  const trimmed = subject.trim();
  const match = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i.exec(trimmed);
  if (!match) {
    return { kind: "other", text: trimmed, breaking: false };
  }
  const [, rawType, rawScope, bang, text] = match;
  const type = rawType!.toLowerCase();
  const scope = rawScope?.trim();
  return {
    kind: KIND_BY_TYPE[type] ?? "other",
    text: text!.trim(),
    ...(scope ? { scope } : {}),
    breaking: bang === "!",
  };
}

/** Shorten a SHA for display. GitHub's `sha` is full-length; the short form is
 *  what a reader would recognize from `git log --oneline`. */
export function shortHash(sha: string): string {
  return sha.slice(0, 7);
}

function toEntry(commit: ChangelogCommit): ChangelogEntry | null {
  if (isMergeCommit(commit.subject)) return null;
  const parsed = parseCommitSubject(commit.subject);
  return { hash: shortHash(commit.sha), ...parsed };
}

/** Group commits (newest first) into per-version releases.
 *
 *  Walks down the list accumulating entries; each release marker closes the
 *  group above it and takes its version. Whatever is left over at the end, i.e.
 *  the commits newer than the newest marker, becomes the `unreleased` group.
 */
export function groupReleases(commits: readonly ChangelogCommit[]): ChangelogRelease[] {
  // A release marker names the version of the commits that come AFTER it in the
  // walk (older ones), so each marker opens a new group rather than closing the
  // previous one. `built` therefore comes out newest-first already.
  const built: ChangelogRelease[] = [];
  let current: ChangelogRelease = {
    version: null,
    date: commits[0]?.date ?? null,
    entries: [],
    unreleased: true,
  };

  for (const commit of commits) {
    const version = releaseVersion(commit.subject);
    if (version !== null) {
      built.push(current);
      current = { version, date: commit.date, entries: [], unreleased: false };
      continue;
    }
    const entry = toEntry(commit);
    if (entry) current.entries.push(entry);
  }
  built.push(current);

  // A group with no entries means a release shipped nothing worth listing (or the
  // newest commit is itself a release marker, leaving nothing unreleased).
  return built.filter((r) => r.entries.length > 0);
}

/** Bucket a release's entries into the fixed section order, dropping empties. */
export function groupSections(release: ChangelogRelease): ChangelogSection[] {
  const out: ChangelogSection[] = [];
  for (const kind of SECTION_ORDER) {
    const entries = release.entries.filter((e) => e.kind === kind);
    if (entries.length > 0) out.push({ kind, entries });
  }
  return out;
}

/** Adapt a GitHub commits-API payload. Entries that don't match the expected
 *  shape are skipped rather than throwing, so one odd commit can't blank the
 *  whole page. */
export function toReleases(payload: unknown): ChangelogRelease[] {
  if (!Array.isArray(payload)) return [];
  const commits: ChangelogCommit[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const sha = typeof item.sha === "string" ? item.sha : "";
    if (!sha) continue;
    const commit = item.commit as Record<string, unknown> | undefined;
    const message = typeof commit?.message === "string" ? commit.message : "";
    const author = commit?.author as Record<string, unknown> | undefined;
    const committer = commit?.committer as Record<string, unknown> | undefined;
    const dateCandidate = author?.date ?? committer?.date;
    commits.push({
      sha,
      // Only the subject line matters; a body would just add noise to a bullet.
      subject: message.split("\n", 1)[0] ?? "",
      date: typeof dateCandidate === "string" ? dateCandidate : null,
    });
  }
  return groupReleases(commits);
}

/** The release matching an installed version string like `1.0.27`. Returns null
 *  when the installed build predates the fetched history or is ahead of it. */
export function findRelease(
  releases: readonly ChangelogRelease[],
  version: string | null | undefined,
): ChangelogRelease | null {
  if (!version) return null;
  const wanted = version.trim().replace(/^v/, "");
  return releases.find((r) => r.version?.replace(/^v/, "") === wanted) ?? null;
}
