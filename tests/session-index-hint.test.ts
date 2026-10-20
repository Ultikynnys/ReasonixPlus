/** The index trusts a session's recorded (bytes, records) pair instead of reading it.
 *  These tests prove the trust AND the fallback: a meta that lies is not believed. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionDirectoryIndex } from "../src/desktop/session-directory-index.js";
import type { SessionMeta } from "../src/memory/session.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One session folder whose real transcript has `lines` records, plus a meta that
 *  optionally claims a different count and a size that may be off by `delta`. */
function store(options: {
  lines: number;
  claimedCount?: number;
  claimedBytesDelta?: number;
}): string {
  const root = mkdtempSync(join(tmpdir(), "reasonix-index-hint-"));
  roots.push(root);
  const dir = join(root, "s1");
  mkdirSync(dir, { recursive: true });
  const body = `${Array.from({ length: options.lines }, (_, i) => `{"role":"user","content":"m${i}"}`).join("\n")}\n`;
  writeFileSync(join(dir, "messages.jsonl"), body, "utf8");
  const meta: SessionMeta = {
    workspace: "C:\\ws",
    updatedAt: 1,
    ...(options.claimedCount === undefined
      ? {}
      : {
          messageCount: options.claimedCount,
          messagesBytes: body.length + (options.claimedBytesDelta ?? 0),
        }),
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), "utf8");
  return root;
}

/** A cold index over `root`: no persisted cache, zero TTL, never "fresh". */
function coldIndex(root: string): SessionDirectoryIndex<SessionMeta> {
  return new SessionDirectoryIndex<SessionMeta>(
    () => root,
    (name) => {
      try {
        return JSON.parse(readFileSync(join(root, name, "meta.json"), "utf8")) as SessionMeta;
      } catch {
        // A session folder with no meta is normal: the store tolerates it.
        return {} as SessionMeta;
      }
    },
    0,
    () => 0,
    undefined,
    undefined,
    undefined,
    (meta) =>
      typeof meta.messagesBytes === "number" && typeof meta.messageCount === "number"
        ? { bytes: meta.messagesBytes, count: meta.messageCount }
        : null,
  );
}

const countOf = async (root: string): Promise<number | undefined> => {
  const records = await coldIndex(root).load().value;
  return records[0]?.messageCount;
};

describe("session index count hint", () => {
  it("trusts the recorded count when the byte length still matches", async () => {
    // The transcript has 3 records but meta claims 7: only a listing that skipped
    // the transcript can answer 7, so this proves the read did not happen.
    expect(await countOf(store({ lines: 3, claimedCount: 7 }))).toBe(7);
  });

  it("counts the transcript when the recorded size no longer matches", async () => {
    // Same lie, but the file grew (or was rewritten) since: the pair is stale, so
    // the real count wins.
    expect(await countOf(store({ lines: 3, claimedCount: 7, claimedBytesDelta: 5 }))).toBe(3);
  });

  it("counts the transcript for a session written before the pair existed", async () => {
    expect(await countOf(store({ lines: 3 }))).toBe(3);
  });

  it("falls back to counting when a session has no meta at all", async () => {
    const root = store({ lines: 4 });
    rmSync(join(root, "s1", "meta.json"));
    expect(await countOf(root)).toBe(4);
  });
});
