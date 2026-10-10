import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChangelogRelease } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANGELOG_CACHE_TTL_MS,
  changelogCachePath,
  fetchChangelog,
  loadChangelogCache,
  writeChangelogCache,
} from "../src/changelog.js";

const TEST_DIR = join(process.cwd(), ".tmp-test-changelog");

const FAKE_PAYLOAD = [
  {
    sha: "aaa1111",
    commit: { message: "fix(desktop): center image zoom", author: { date: "2026-01-05" } },
  },
  {
    sha: "bbb2222",
    commit: { message: "chore(release): v1.0.27", committer: { date: "2026-01-04" } },
  },
  { sha: "ccc3333", commit: { message: "feat(chat): add audio", author: { date: "2026-01-03" } } },
];

function cachedRelease(version: string): ChangelogRelease {
  return {
    version,
    date: "2026-01-04",
    entries: [{ hash: "deadbee", kind: "fix", text: "cached work", breaking: false }],
    unreleased: false,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe("changelog fetch", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("groups a fetched history into releases", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYLOAD));

    const snapshot = await fetchChangelog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
    });

    expect(fetchImpl).toHaveBeenCalled();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
    expect(snapshot.releases[1]!.entries.map((e) => e.text)).toEqual(["add audio"]);
  });

  it("caches the result under the reasonix home", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYLOAD));

    await fetchChangelog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
    });

    const cached = loadChangelogCache(TEST_DIR);
    expect(cached?.releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
    expect(changelogCachePath(TEST_DIR)).toContain("changelog-cache.json");
  });

  it("serves from cache when within the TTL and force is false", async () => {
    writeChangelogCache({ releases: [cachedRelease("1.0.26")], checkedAt: Date.now() }, TEST_DIR);
    const fetchImpl = vi.fn();

    const snapshot = await fetchChangelog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: false,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshot.releases.map((r) => r.version)).toEqual(["1.0.26"]);
  });

  it("refetches once the cache goes stale", async () => {
    writeChangelogCache(
      { releases: [cachedRelease("1.0.26")], checkedAt: Date.now() - CHANGELOG_CACHE_TTL_MS - 1 },
      TEST_DIR,
    );
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYLOAD));

    const snapshot = await fetchChangelog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: false,
    });

    expect(fetchImpl).toHaveBeenCalled();
    expect(snapshot.releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
  });

  it("bypasses the cache when force is true", async () => {
    writeChangelogCache({ releases: [cachedRelease("1.0.26")], checkedAt: Date.now() }, TEST_DIR);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYLOAD));

    const snapshot = await fetchChangelog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
    });

    expect(fetchImpl).toHaveBeenCalled();
    expect(snapshot.releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
  });

  it("falls back to the cache when the network fails, and says so", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    writeChangelogCache(
      { releases: [cachedRelease("1.0.26")], checkedAt: Date.now() - 1000 },
      TEST_DIR,
    );
    const fetchImpl = vi.fn().mockRejectedValue(new Error("Network unreachable"));

    const snapshot = await fetchChangelog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
    });

    expect(stderrSpy).toHaveBeenCalled();
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("reasonix: failed to fetch the changelog");
    expect(snapshot.error).toContain("Network unreachable");
    expect(snapshot.releases.map((r) => r.version)).toEqual(["1.0.26"]);
  });

  it("reports an empty result when there is neither network nor cache", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    const snapshot = await fetchChangelog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
    });

    expect(snapshot.releases).toEqual([]);
    expect(snapshot.error).toContain("offline");
  });

  it("treats an unparseable payload as a failure rather than an empty changelog", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "rate limited" }));

    const snapshot = await fetchChangelog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
    });

    expect(snapshot.releases).toEqual([]);
    expect(snapshot.error).toContain("no releases parsed");
  });
});
