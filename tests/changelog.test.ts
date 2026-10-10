import { describe, expect, it } from "vitest";
import {
  findRelease,
  groupReleases,
  groupSections,
  isMergeCommit,
  parseCommitSubject,
  releaseVersion,
  shortHash,
  toReleases,
} from "../packages/core-utils/src/changelog.js";

describe("releaseVersion", () => {
  it("matches the exact message the release workflow writes", () => {
    expect(releaseVersion("chore(release): v1.0.27")).toBe("1.0.27");
  });

  it("tolerates a missing v and a pre-release suffix", () => {
    expect(releaseVersion("chore(release): 1.0.28")).toBe("1.0.28");
    expect(releaseVersion("chore(release): v2.0.0-rc.5")).toBe("2.0.0-rc.5");
  });

  it("accepts the bare spellings a human might type", () => {
    expect(releaseVersion("release: v1.2.3")).toBe("1.2.3");
    expect(releaseVersion("chore: release v1.2.3")).toBe("1.2.3");
  });

  it("rejects ordinary commits and a partial version", () => {
    expect(releaseVersion("fix(desktop): render PDFs")).toBeNull();
    expect(releaseVersion("chore(release): v1.0")).toBeNull();
    expect(releaseVersion("chore(release): bump")).toBeNull();
  });
});

describe("parseCommitSubject", () => {
  it("splits type, scope and breaking marker", () => {
    expect(parseCommitSubject("feat(chat): add inline audio playback")).toEqual({
      kind: "feat",
      scope: "chat",
      text: "add inline audio playback",
      breaking: false,
    });
    expect(parseCommitSubject("fix(core)!: drop the legacy adapter")).toEqual({
      kind: "fix",
      scope: "core",
      text: "drop the legacy adapter",
      breaking: true,
    });
  });

  it("maps types onto changelog kinds", () => {
    expect(parseCommitSubject("perf: faster fold").kind).toBe("perf");
    expect(parseCommitSubject("refactor: extract reducer").kind).toBe("change");
    expect(parseCommitSubject("style: scrollbar corner").kind).toBe("change");
    expect(parseCommitSubject("chore: bump dep").kind).toBe("chore");
    expect(parseCommitSubject("docs: fix typo").kind).toBe("chore");
  });

  it("keeps the full text of a non-conventional subject", () => {
    expect(parseCommitSubject("Re-encode opaque PNGs as JPEG")).toEqual({
      kind: "other",
      text: "Re-encode opaque PNGs as JPEG",
      breaking: false,
    });
  });

  it("tolerates a missing scope", () => {
    expect(parseCommitSubject("fix: stop the stutter")).toEqual({
      kind: "fix",
      text: "stop the stutter",
      breaking: false,
    });
  });
});

describe("isMergeCommit", () => {
  it("detects merges so they can be dropped", () => {
    expect(isMergeCommit("Merge branch 'main' into fix")).toBe(true);
    expect(isMergeCommit("fix: merge the rules")).toBe(false);
  });
});

describe("groupReleases", () => {
  const commits = [
    { sha: "aaa1", subject: "fix(desktop): center image zoom", date: "2026-01-05" },
    { sha: "bbb2", subject: "chore(release): v1.0.27", date: "2026-01-04" },
    { sha: "ccc3", subject: "fix(desktop): render PDFs", date: "2026-01-03" },
    { sha: "ddd4", subject: "feat(chat): add audio playback", date: "2026-01-02" },
    { sha: "eee5", subject: "chore(release): v1.0.26", date: "2026-01-01" },
    { sha: "fff6", subject: "chore: bump dep", date: "2025-12-31" },
  ];

  it("puts each commit in the release marker below it", () => {
    const releases = groupReleases(commits);
    expect(releases.map((r) => r.version)).toEqual([null, "1.0.27", "1.0.26"]);
    expect(releases[1]!.entries.map((e) => e.text)).toEqual(["render PDFs", "add audio playback"]);
    expect(releases[2]!.entries.map((e) => e.text)).toEqual(["bump dep"]);
  });

  it("matches the real repo history shape", () => {
    // The tag sits ON the release commit, so a commit above it landed after the
    // tag and is not part of that version.
    const releases = groupReleases([
      { sha: "a1bd13d", subject: "fix(desktop): center image zoom", date: "2026-01-09" },
      { sha: "18dbb16", subject: "chore(release): v1.0.27", date: "2026-01-08" },
      { sha: "37f6488", subject: "fix(desktop): render PDFs", date: "2026-01-07" },
    ]);
    expect(releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
    expect(releases[0]!.entries.map((e) => e.hash)).toEqual(["a1bd13d"]);
    expect(releases[1]!.entries.map((e) => e.hash)).toEqual(["37f6488"]);
  });

  it("never lists a release marker as a change", () => {
    for (const release of groupReleases(commits)) {
      expect(release.entries.some((e) => releaseVersion(e.text) !== null)).toBe(false);
    }
  });

  it("collects commits newer than the newest marker as unreleased", () => {
    const unreleased = groupReleases(commits)[0]!;
    expect(unreleased.unreleased).toBe(true);
    expect(unreleased.version).toBeNull();
    expect(unreleased.date).toBe("2026-01-05");
    expect(unreleased.entries.map((e) => e.text)).toEqual(["center image zoom"]);
  });

  it("omits the unreleased group when the tip is a release marker", () => {
    const releases = groupReleases([commits[1]!, commits[2]!]);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.unreleased).toBe(false);
  });

  it("drops merge commits", () => {
    const releases = groupReleases([
      { sha: "m1", subject: "Merge branch 'main'", date: "2026-01-05" },
      { sha: "x1", subject: "fix: real work", date: "2026-01-05" },
      { sha: "r1", subject: "chore(release): v1.0.27", date: "2026-01-04" },
      { sha: "x2", subject: "feat: older work", date: "2026-01-03" },
    ]);
    expect(releases[0]!.entries.map((e) => e.hash)).toEqual(["x1"]);
    expect(releases[1]!.entries.map((e) => e.hash)).toEqual(["x2"]);
  });

  it("returns nothing for an empty history", () => {
    expect(groupReleases([])).toEqual([]);
  });
});

describe("groupSections", () => {
  it("buckets entries in the fixed order and drops empty sections", () => {
    const release = groupReleases([
      { sha: "a1", subject: "chore: bump dep", date: null },
      { sha: "a2", subject: "fix: a bug", date: null },
      { sha: "a3", subject: "feat: a thing", date: null },
      { sha: "a4", subject: "chore(release): v1.0.27", date: null },
    ])[0]!;
    expect(groupSections(release).map((s) => s.kind)).toEqual(["feat", "fix", "chore"]);
  });
});

describe("toReleases", () => {
  it("adapts a GitHub commits payload", () => {
    const releases = toReleases([
      {
        sha: "1234567890abcdef",
        commit: {
          message: "feat(chat): add audio\n\nlong body ignored",
          author: { date: "2026-01-05" },
        },
      },
      {
        sha: "bbbb",
        commit: { message: "chore(release): v1.0.27", committer: { date: "2026-01-04" } },
      },
      { sha: "cccc", commit: { message: "fix: older", committer: { date: "2026-01-03" } } },
    ]);
    expect(releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
    expect(releases[1]!.entries.map((e) => e.hash)).toEqual(["cccc"]);
    expect(releases[0]!.entries[0]).toEqual({
      hash: "1234567",
      kind: "feat",
      scope: "chat",
      text: "add audio",
      breaking: false,
    });
  });

  it("skips malformed entries instead of blanking the page", () => {
    const releases = toReleases([null, 42, {}, { commit: { message: "fix: no sha" } }, "nope"]);
    expect(releases).toEqual([]);
  });

  it("returns nothing for a non-array payload", () => {
    expect(toReleases({ message: "rate limited" })).toEqual([]);
  });
});

describe("shortHash", () => {
  it("shortens to the git log --oneline width", () => {
    expect(shortHash("1234567890abcdef")).toBe("1234567");
  });
});

describe("findRelease", () => {
  const releases = groupReleases([
    { sha: "a1", subject: "feat: new", date: null },
    { sha: "r1", subject: "chore(release): v1.0.27", date: null },
    { sha: "a2", subject: "fix: shipped", date: null },
  ]);

  it("matches with or without the v prefix", () => {
    expect(findRelease(releases, "1.0.27")?.version).toBe("1.0.27");
    expect(findRelease(releases, "v1.0.27")?.version).toBe("1.0.27");
  });

  it("returns null for an unknown or missing version", () => {
    expect(findRelease(releases, "9.9.9")).toBeNull();
    expect(findRelease(releases, undefined)).toBeNull();
  });
});
