/** A create and a delete are single-session edits: the listing that reports one must
 *  never walk the rest of the store, including when a walk is already in flight. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionDirectoryIndex } from "../src/desktop/session-directory-index.js";

const dirs: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "reasonix-index-incremental-"));
  dirs.push(dir);
  return dir;
}

function seedSession(root: string, name: string, body: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "messages.jsonl");
  writeFileSync(path, body);
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ workspace: "/ws" }));
  return path;
}

/** Waits for the deferred cache write a settle schedules to land, bounded. */
async function flushDeferredWrites(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionDirectoryIndex single-session edits", () => {
  it("lists a created session without walking the directory", async () => {
    const dir = fixture();
    seedSession(dir, "one", "a\n");
    seedSession(dir, "two", "b\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
    );
    await index.load().value;

    seedSession(dir, "three", "c\n");
    index.markStale("three");
    // The freshness window is untouched, so nothing revalidates the whole store.
    expect(index.load().cache).toBe("hit");

    const names = (await index.load().value).map((record) => record.name).sort();
    expect(names).toEqual(["one", "three", "two"]);
  });

  it("drops a deleted session without walking the directory", async () => {
    const dir = fixture();
    seedSession(dir, "one", "a\n");
    seedSession(dir, "two", "b\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
    );
    await index.load().value;

    rmSync(join(dir, "one"), { recursive: true, force: true });
    index.remove("one");
    expect(index.load().cache).toBe("hit");
    expect((await index.load().value).map((record) => record.name)).toEqual(["two"]);
  });

  it("leaves an untouched session alone, which is only true when no walk ran", async () => {
    const dir = fixture();
    seedSession(dir, "touched", "a\n");
    seedSession(dir, "untouched", "b\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
    );
    await index.load().value;

    // Removed behind the index's back: only a directory walk could notice.
    rmSync(join(dir, "untouched"), { recursive: true, force: true });
    appendFileSync(join(dir, "touched", "messages.jsonl"), "c\n");
    index.markStale("touched");

    const records = await index.load().value;
    expect(records.map((record) => record.name).sort()).toEqual(["touched", "untouched"]);
    expect(records.find((record) => record.name === "touched")?.messageCount).toBe(2);

    // An explicit revalidation is what discovers it, as before.
    index.invalidate();
    expect((await index.load().value).map((record) => record.name)).toEqual(["touched"]);
  });

  it("re-reads only the edited folder", async () => {
    const dir = fixture();
    seedSession(dir, "edited", "a\n");
    seedSession(dir, "other", "b\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
    );
    const before = await index.load().value;
    const otherBefore = before.find((record) => record.name === "other");

    appendFileSync(join(dir, "edited", "messages.jsonl"), "c\nd\n");
    index.markStale("edited");

    const after = await index.load().value;
    expect(after.find((record) => record.name === "edited")?.messageCount).toBe(3);
    // The untouched record is the very same object, so its folder was not opened.
    expect(after.find((record) => record.name === "other")).toBe(otherBefore);
  });

  it("cannot resurrect a session deleted while a walk was in flight", async () => {
    const dir = fixture();
    seedSession(dir, "one", "a\n");
    seedSession(dir, "two", "b\n");
    // TTL 0 makes every load walk, so the delete below lands mid-walk.
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
      0,
    );
    await index.load().value;

    const walking = index.load();
    rmSync(join(dir, "one"), { recursive: true, force: true });
    index.remove("one");

    expect((await walking.value).map((record) => record.name)).toEqual(["two"]);
    expect((await index.load().value).map((record) => record.name)).toEqual(["two"]);
  });

  it("answers a burst of edits with one pass", async () => {
    const dir = fixture();
    seedSession(dir, "one", "a\n");
    let metaReads = 0;
    const index = new SessionDirectoryIndex(
      () => dir,
      () => {
        metaReads += 1;
        return {};
      },
    );
    await index.load().value;
    metaReads = 0;
    seedSession(dir, "two", "b\n");
    seedSession(dir, "three", "c\n");
    index.markStale("two");
    index.markStale("three");
    const [first, second] = await Promise.all([index.currentList(), index.currentList()]);
    expect(first.map((record) => record.name).sort()).toEqual(["one", "three", "two"]);
    expect(second.map((record) => record.name).sort()).toEqual(["one", "three", "two"]);
    // One pass over the two edited folders, not one pass per caller.
    expect(metaReads).toBe(2);
  });

  it("writes the cache after the edit is answered, not on the calling tick", async () => {
    const dir = fixture();
    const cacheFile = join(dir, "index-cache.json");
    seedSession(dir, "one", "a\n");
    seedSession(dir, "kept", "b\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
      undefined,
      undefined,
      undefined,
      cacheFile,
    );
    await index.load().value;

    rmSync(join(dir, "one"), { recursive: true, force: true });
    index.remove("one");
    const cachedOnReturn = readFileSync(cacheFile, "utf8");
    expect(cachedOnReturn).toContain('"one"');

    await flushDeferredWrites();
    expect(existsSync(cacheFile)).toBe(true);
    expect(readFileSync(cacheFile, "utf8")).not.toContain('"one"');
  });

  it("settles a folder that vanished behind a stale edit as absent", async () => {
    const dir = fixture();
    seedSession(dir, "one", "a\n");
    seedSession(dir, "two", "b\n");
    const index = new SessionDirectoryIndex(
      () => dir,
      () => ({}),
    );
    await index.load().value;

    // Marked stale instead of removed: the folder a re-read needs is gone, and the
    // listing still owes the caller every other row.
    rmSync(join(dir, "two"), { recursive: true, force: true });
    index.markStale("two");
    expect((await index.load().value).map((record) => record.name)).toEqual(["one"]);
  });
});
