import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { orphanSessionNames, quarantineOrphanSessions } from "../src/memory/session-maintenance.js";

const temps: string[] = [];
const workspace = join("C:", "Users", "uraan", "Documents", "ReasonixPlus");

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reasonix-quarantine-test-"));
  temps.push(dir);
  return dir;
}

function makeSession(root: string, name: string, meta?: Record<string, unknown>): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "messages.jsonl"), "", "utf8");
  if (meta) writeFileSync(join(root, name, "meta.json"), JSON.stringify(meta), "utf8");
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("orphanSessionNames", () => {
  it("keeps stamped sessions and legacy sessions reachable from a known workspace", () => {
    const entries = [
      { name: "alpha" },
      { name: "bad-alias", workspace: "" },
      { name: "code-ReasonixPlus-20260101" },
      { name: "desktop-20261123", workspace },
      { name: "code-other-20260101" },
    ];
    expect(orphanSessionNames(entries, [workspace])).toEqual([
      "alpha",
      "bad-alias",
      "code-other-20260101",
    ]);
  });

  it("treats every unstamped session as an orphan when no workspace is known", () => {
    expect(orphanSessionNames([{ name: "alpha" }, { name: "code-a-1" }], [])).toEqual([
      "alpha",
      "code-a-1",
    ]);
  });
});

describe("quarantineOrphanSessions", () => {
  it("moves orphans, keeps reachable sessions, and writes a reversible manifest", async () => {
    const source = tempDir();
    makeSession(source, "alpha");
    makeSession(source, "code-ReasonixPlus-20260101");
    makeSession(source, "desktop-20261123", { workspace });
    const quarantineRoot = join(tempDir(), "quarantine");
    const dropped: string[] = [];

    const result = await quarantineOrphanSessions({
      now: Date.UTC(2026, 10, 24),
      index: [
        { name: "alpha" },
        { name: "code-ReasonixPlus-20260101" },
        { name: "desktop-20261123", workspace },
        { name: "gone" },
      ],
      knownWorkspaces: [workspace],
      sourceDir: source,
      quarantineRoot,
      drop: (names) => dropped.push(...names),
      refresh: async () => {},
    });

    expect(result.moved).toEqual(["alpha"]);
    expect(result.vanished).toEqual(["gone"]);
    expect(result.keptLegacy).toBe(1);
    expect(dropped.sort()).toEqual(["alpha", "gone"]);
    expect(existsSync(join(source, "alpha"))).toBe(false);
    expect(existsSync(join(quarantineRoot, "alpha", "messages.jsonl"))).toBe(true);
    expect(existsSync(join(source, "code-ReasonixPlus-20260101"))).toBe(true);
    expect(existsSync(join(source, "desktop-20261123"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(quarantineRoot, "manifest.json"), "utf8"));
    expect(manifest.moved).toEqual(["alpha"]);
    expect(manifest.vanished).toEqual(["gone"]);
  });

  it("does nothing when every session is reachable", async () => {
    const source = tempDir();
    makeSession(source, "desktop-20261123", { workspace });
    const result = await quarantineOrphanSessions({
      index: [{ name: "desktop-20261123", workspace }],
      sourceDir: source,
      quarantineRoot: join(tempDir(), "quarantine"),
      drop: () => {
        throw new Error("drop must not run");
      },
      refresh: async () => {},
    });
    expect(result.moved).toEqual([]);
    expect(result.directory).toBeNull();
    expect(existsSync(join(source, "desktop-20261123"))).toBe(true);
  });

  it("caps one sweep and reports the remainder for the next boot", async () => {
    const source = tempDir();
    for (const name of ["a", "b", "c"]) makeSession(source, name);
    const result = await quarantineOrphanSessions({
      index: [{ name: "a" }, { name: "b" }, { name: "c" }],
      knownWorkspaces: [],
      sourceDir: source,
      quarantineRoot: join(tempDir(), "quarantine"),
      maxMoves: 2,
      drop: () => {},
      refresh: async () => {},
    });
    expect(result.moved).toHaveLength(2);
    expect(result.remaining).toBe(1);
    expect(["a", "b", "c"].filter((name) => existsSync(join(source, name)))).toHaveLength(1);
  });

  it("reports a path that escapes the sessions root instead of moving it", async () => {
    const source = tempDir();
    const result = await quarantineOrphanSessions({
      index: [{ name: "../escape" }],
      sourceDir: source,
      quarantineRoot: join(tempDir(), "quarantine"),
      drop: () => {},
      refresh: async () => {},
    });
    expect(result.moved).toEqual([]);
    expect(result.skipped).toEqual([{ name: "../escape", error: "invalid session name" }]);
  });
});
