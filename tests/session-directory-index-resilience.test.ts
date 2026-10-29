import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Injected transcript-handle faults: an unreadable descriptor, and one whose release
 *  fails after the read. Both surface as `EBADF: bad file descriptor` in the field. */
const faults = vi.hoisted(() => ({
  path: "",
  read: false,
  close: false,
  /** Reads still to fail before the descriptor behaves again. */
  remaining: Number.POSITIVE_INFINITY,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (path, ...rest) => {
    const handle = await actual.open(path, ...rest);
    const faulty = () => faults.path !== "" && String(path) === faults.path;
    const ebdf = (syscall: string) =>
      Object.assign(new Error(`EBADF: bad file descriptor, ${syscall}`), { code: "EBADF" });
    return {
      read: async (buffer, offset, length, position) => {
        if (faulty() && faults.read && faults.remaining > 0) {
          faults.remaining -= 1;
          throw ebdf("read");
        }
        return handle.read(buffer, offset, length, position);
      },
      stat: (options) => handle.stat(options),
      close: async () => {
        await handle.close();
        if (faulty() && faults.close) throw ebdf("close");
      },
    } as unknown as Awaited<ReturnType<typeof actual.open>>;
  };
  return { ...actual, open };
});

import { SessionDirectoryIndex } from "../src/desktop/session-directory-index.js";

const dirs: string[] = [];

async function fixture(): Promise<string> {
  const dir = join(tmpdir(), `reasonix-session-index-faults-${crypto.randomUUID()}`);
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Seed a folder-per-session fixture and return its `messages.jsonl` path. */
async function seedSession(root: string, name: string, body: string): Promise<string> {
  const sessionDir = join(root, name);
  await mkdir(sessionDir, { recursive: true });
  const path = join(sessionDir, "messages.jsonl");
  await writeFile(path, body);
  return path;
}

function indexFor(dir: string): SessionDirectoryIndex<Record<string, never>> {
  return new SessionDirectoryIndex(
    () => dir,
    () => ({}),
    0,
  );
}

function countOf(
  records: readonly { name: string; messageCount: number }[],
  name: string,
): number | undefined {
  return records.find((record) => record.name === name)?.messageCount;
}

function quietStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

afterEach(async () => {
  faults.path = "";
  faults.read = false;
  faults.close = false;
  faults.remaining = Number.POSITIVE_INFINITY;
  vi.restoreAllMocks();
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe("SessionDirectoryIndex unreadable-transcript resilience", () => {
  it("keeps a session whose handle release fails instead of failing the listing", async () => {
    const dir = await fixture();
    const messagesPath = await seedSession(dir, "one", "a\nb\n");
    await seedSession(dir, "two", "c\n");
    const stderr = quietStderr();

    faults.path = messagesPath;
    faults.close = true;

    const records = await indexFor(dir).load().value;
    expect(records).toHaveLength(2);
    expect(countOf(records, "one")).toBe(2);
    expect(countOf(records, "two")).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("session handle release failed"));
  });

  it("retries a transient descriptor failure before giving up on the session", async () => {
    const dir = await fixture();
    const messagesPath = await seedSession(dir, "one", "a\nb\n");
    const stderr = quietStderr();

    faults.path = messagesPath;
    faults.read = true;
    faults.remaining = 1;

    const records = await indexFor(dir).load().value;
    expect(countOf(records, "one")).toBe(2);
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("session index skipped"));
  });

  it("carries a session's previous record when its transcript cannot be read", async () => {
    const dir = await fixture();
    const messagesPath = await seedSession(dir, "one", "a\n");
    await seedSession(dir, "two", "c\n");
    const index = indexFor(dir);
    expect(countOf(await index.load().value, "one")).toBe(1);

    const stderr = quietStderr();
    await appendFile(messagesPath, "b\n");
    faults.path = messagesPath;
    faults.read = true;
    index.invalidate();

    const records = await index.load().value;
    expect(records).toHaveLength(2);
    // The failed read degrades to the last record instead of rejecting the walk.
    expect(countOf(records, "one")).toBe(1);
    expect(countOf(records, "two")).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('session index skipped for "one"'));
  });

  it("lists the readable sessions when a transcript the index never saw cannot be read", async () => {
    const dir = await fixture();
    await seedSession(dir, "one", "a\n");
    const brokenPath = await seedSession(dir, "two", "c\n");
    quietStderr();

    faults.path = brokenPath;
    faults.read = true;

    const records = await indexFor(dir).load().value;
    expect(records.map((record) => record.name)).toEqual(["one"]);
  });
});
