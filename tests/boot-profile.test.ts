/** Boot profile: 20 workspaces x 10 sessions x 2000 messages, 1000 files per workspace. */

// Opt-in via a gitignored marker (local/perf-probe/.boot-profile) because it builds
// about 1.2 GB of fixture. The marker keeps CI and `npm run verify` out of it.
// Three scans are compared so the workspace files can be isolated from the cache:
//   A = first boot ever (no index cache): reads every transcript on disk
//   B = later boot (cache-backed rescan), before the workspace files exist
//   C = same rescan after 20 x 1000 files + git repos exist
// B against C is the workspace-size question; A against B is the cache question.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const enabled = existsSync(join(process.cwd(), "local", "perf-probe", ".boot-profile"));
const home = mkdtempSync(join(tmpdir(), "reasonix-boot-"));
vi.stubEnv("USERPROFILE", home);
vi.stubEnv("HOME", home);

const layout = await import("../src/memory/session-layout.js");
const store = await import("../src/memory/session.js");
const { writeScaleStore } = await import("./fixtures/scale-sessions.js");

const WORKSPACES = 20;
const SESSIONS_PER_WORKSPACE = 10;
const MESSAGES_PER_SESSION = 2000;
const FILES_PER_WORKSPACE = 1000;
const GIT_WORKSPACES = 5;
const SCRATCH = `boot-profile-${process.pid}`;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const workspaceOf = (w: number): string => `C:\\perf\\workspace-${w}`;

describe.skipIf(!enabled)("boot at 20 workspaces x 10 sessions x 2000 messages", () => {
  it("profiles the boot path", async () => {
    const seeded = writeScaleStore(layout.sessionsRootDir(), {
      workspaces: WORKSPACES,
      sessionsPerWorkspace: SESSIONS_PER_WORKSPACE,
      messagesPerSession: MESSAGES_PER_SESSION,
    });
    console.log(
      `fixture: ${seeded.sessions} sessions, ${(seeded.bytes / 1e6).toFixed(0)} MB of transcripts`,
    );

    // A: first boot ever. The index has no cache, so every transcript is read.
    const aStart = performance.now();
    const listed = await store.listSessionsForWorkspaceAsync(workspaceOf(0)).value;
    const coldMs = performance.now() - aStart;
    expect(listed).toHaveLength(SESSIONS_PER_WORKSPACE);

    // Every later boot: the persisted index answers from stat identities.
    store.appendSessionMessage(SCRATCH, { role: "user", content: "invalidate" });
    const bStart = performance.now();
    await store.listSessionsForWorkspaceAsync(workspaceOf(0)).value;
    const cachedMs = performance.now() - bStart;

    // The remaining 19 workspaces on the same boot.
    const perWorkspace: number[] = [];
    for (let w = 1; w < WORKSPACES; w++) {
      const start = performance.now();
      const items = await store.listSessionsForWorkspaceAsync(workspaceOf(w)).value;
      perWorkspace.push(performance.now() - start);
      expect(items).toHaveLength(SESSIONS_PER_WORKSPACE);
    }
    const median = [...perWorkspace].sort((x, y) => x - y)[Math.floor(perWorkspace.length / 2)];

    console.log(
      `boot scans: first ever ${coldMs.toFixed(0)} ms, cache-backed ${cachedMs.toFixed(0)} ms, ` +
        `other 19 workspaces median ${median.toFixed(1)} ms (max ${Math.max(...perWorkspace).toFixed(1)} ms)`,
    );

    // 20 workspaces of 1000 files, 10 MB each, five of them git repos.
    const payload = `${"export const value = 1;\n".repeat(400)}`;
    const roots: string[] = [];
    const filesStart = performance.now();
    for (let w = 0; w < WORKSPACES; w++) {
      const root = join(home, "projects", `workspace-${w}`);
      mkdirSync(root, { recursive: true });
      for (let f = 0; f < FILES_PER_WORKSPACE; f++) {
        writeFileSync(join(root, `file-${f}.ts`), payload);
      }
      roots.push(root);
    }
    const filesMs = performance.now() - filesStart;
    const bytesPerWorkspace = statSync(join(roots[0], "file-0.ts")).size * FILES_PER_WORKSPACE;
    for (const root of roots.slice(0, GIT_WORKSPACES)) {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    }
    const repoBytes = statSync(join(roots[0], "file-0.ts")).size;
    console.log(
      `workspace files: ${WORKSPACES * FILES_PER_WORKSPACE} files in ${filesMs.toFixed(0)} ms, ` +
        `${(bytesPerWorkspace / 1e6).toFixed(1)} MB per workspace, ` +
        `${GIT_WORKSPACES} git repos (file ${repoBytes} B)`,
    );

    // C: the same rescan as B, now that the workspace files exist.
    store.appendSessionMessage(SCRATCH, { role: "user", content: "invalidate again" });
    const cStart = performance.now();
    await store.listSessionsForWorkspaceAsync(workspaceOf(0)).value;
    const withFilesMs = performance.now() - cStart;
    console.log(
      `workspace-file effect on the scan: ${cachedMs.toFixed(0)} ms without them, ` +
        `${withFilesMs.toFixed(0)} ms with them`,
    );

    // What a git sniff would cost if anything called it (nothing on the boot path does).
    const { detectGitBranch } = store;
    const gitSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      detectGitBranch(roots[0]);
      gitSamples.push(performance.now() - start);
    }
    const plainSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      detectGitBranch(roots[GIT_WORKSPACES]);
      plainSamples.push(performance.now() - start);
    }
    const avg = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
    console.log(
      `detectGitBranch: ${avg(gitSamples).toFixed(1)} ms avg in a repo, ` +
        `${avg(plainSamples).toFixed(1)} ms avg outside one ` +
        `(x${WORKSPACES} workspaces = ${(avg(gitSamples) * WORKSPACES).toFixed(0)} ms if it were called)`,
    );

    // Realistic launch cost: current code stamps the (bytes, records) pair into meta,
    // so a cold scan can stat plus read a small meta instead of reading the transcript.
    const dirs = readdirSync(layout.sessionsRootDir()).filter((d) => d.startsWith("desktop-"));
    const hintedStart = performance.now();
    for (const dir of dirs) {
      const size = statSync(layout.sessionMessagesPath(dir)).size;
      const meta = JSON.parse(readFileSync(layout.sessionMetaPath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        layout.sessionMetaPath(dir),
        JSON.stringify({ ...meta, messagesBytes: size, messageCount: MESSAGES_PER_SESSION }),
      );
    }
    const stampMs = performance.now() - hintedStart;

    // The scan's work when every pair is trustworthy: one stat + one small meta read.
    const hintedScanStart = performance.now();
    let trusted = 0;
    for (const dir of dirs) {
      const size = statSync(layout.sessionMessagesPath(dir)).size;
      const meta = JSON.parse(readFileSync(layout.sessionMetaPath(dir), "utf8")) as {
        messagesBytes?: number;
        messageCount?: number;
      };
      if (meta.messagesBytes === size && typeof meta.messageCount === "number") trusted += 1;
    }
    const hintedScanMs = performance.now() - hintedScanStart;

    // A restart's cache read: one file holding every session's identity and counts.
    const cacheFile = join(home, ".reasonix", "cache", "session-directory-index.json");
    let cacheBytes = 0;
    let cacheParseMs = 0;
    try {
      const raw = readFileSync(cacheFile, "utf8");
      cacheBytes = Buffer.byteLength(raw);
      const parseStart = performance.now();
      JSON.parse(raw);
      cacheParseMs = performance.now() - parseStart;
    } catch {
      cacheBytes = 0;
    }
    console.log(
      `realistic scan (pair trusted): ${hintedScanMs.toFixed(0)} ms for ${trusted}/${dirs.length} sessions ` +
        `(stamping the pairs took ${stampMs.toFixed(0)} ms); index cache ` +
        `${(cacheBytes / 1e6).toFixed(2)} MB, parse ${cacheParseMs.toFixed(1)} ms`,
    );

    expect(coldMs).toBeGreaterThan(0);
  }, 900_000);
});
