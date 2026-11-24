import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { messageOf } from "@reasonix/core-utils";
import { loadRecentWorkspaces } from "../config.js";
import { reasonixHome } from "../reasonix-home.js";
import { sessionsDir } from "./session-layout.js";
import {
  type SessionIndexEntry,
  dropSessionIndexEntries,
  legacySessionPrefixForWorkspace,
  refreshSessionIndex,
  sessionIndexEntries,
} from "./session.js";

const BATCH_SIZE = 200;

export interface QuarantineOptions {
  now?: number;
  maxMoves?: number;
  index?: ReadonlyArray<SessionIndexEntry> | null;
  knownWorkspaces?: ReadonlyArray<string>;
  sourceDir?: string;
  quarantineRoot?: string;
  drop?: (names: readonly string[]) => void;
  refresh?: () => Promise<void>;
}

export interface QuarantineResult {
  directory: string | null;
  moved: string[];
  vanished: string[];
  skipped: Array<{ name: string; error: string }>;
  orphanCount: number;
  total: number;
  keptLegacy: number;
  remaining: number;
}

/** Unstamped sessions are invisible unless their name carries a known workspace's
 *  `code-<workspace>-` prefix; everything else is an orphan. */
export function orphanSessionNames(
  sessions: ReadonlyArray<SessionIndexEntry>,
  knownWorkspaces: ReadonlyArray<string>,
): string[] {
  const prefixes = knownWorkspaces
    .map((workspace) => legacySessionPrefixForWorkspace(workspace.trim()))
    .filter(Boolean);
  return sessions
    .filter((session) => {
      if (session.workspace?.trim()) return false;
      return !prefixes.some((prefix) => session.name.startsWith(prefix));
    })
    .map((session) => session.name);
}

function knownWorkspacesFor(entries: ReadonlyArray<SessionIndexEntry>): string[] {
  const workspaces = new Set<string>();
  for (const entry of entries) {
    const workspace = entry.workspace?.trim();
    if (workspace) workspaces.add(workspace);
  }
  for (const workspace of loadRecentWorkspaces()) {
    const trimmed = workspace.trim();
    if (trimmed) workspaces.add(trimmed);
  }
  return [...workspaces];
}

function emptyResult(total = 0, orphanCount = 0, keptLegacy = 0): QuarantineResult {
  return {
    directory: null,
    moved: [],
    vanished: [],
    skipped: [],
    orphanCount,
    total,
    keptLegacy,
    remaining: 0,
  };
}

/** Move unreachable sessions to `sessions-quarantine/<timestamp>/` with a manifest, so
 *  the sweep is reversible; locked folders are retried on the next boot. */
export async function quarantineOrphanSessions(
  options: QuarantineOptions = {},
): Promise<QuarantineResult> {
  const entries = options.index !== undefined ? options.index : await sessionIndexEntries();
  if (entries === null) return emptyResult();
  const knownWorkspaces = options.knownWorkspaces ?? knownWorkspacesFor(entries);
  const orphans = orphanSessionNames(entries, knownWorkspaces);
  const stamped = entries.filter((entry) => entry.workspace?.trim()).length;
  const keptLegacy = Math.max(0, entries.length - stamped - orphans.length);
  if (orphans.length === 0) return emptyResult(entries.length, 0, keptLegacy);

  const limit = options.maxMoves ?? 10_000;
  const selected = orphans.slice(0, limit);
  const now = options.now ?? Date.now();
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const source = options.sourceDir ?? sessionsDir();
  const directory = options.quarantineRoot ?? join(reasonixHome(), "sessions-quarantine", stamp);
  await mkdir(directory, { recursive: true });

  const moved: string[] = [];
  const vanished: string[] = [];
  const skipped: Array<{ name: string; error: string }> = [];
  for (let offset = 0; offset < selected.length; offset += BATCH_SIZE) {
    const batch = selected.slice(offset, offset + BATCH_SIZE);
    await Promise.all(
      batch.map(async (name) => {
        if (name !== basename(name)) {
          skipped.push({ name, error: "invalid session name" });
          return;
        }
        try {
          await rename(join(source, name), join(directory, name));
          moved.push(name);
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") {
            vanished.push(name);
            return;
          }
          skipped.push({ name, error: messageOf(error) });
        }
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (moved.length > 0 || vanished.length > 0) {
    const manifest = {
      createdAt: new Date(now).toISOString(),
      source,
      moved,
      vanished,
      skipped,
      orphanCount: orphans.length,
      total: entries.length,
      remaining: orphans.length - selected.length,
    };
    await writeFile(
      join(directory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    (options.drop ?? dropSessionIndexEntries)([...moved, ...vanished]);
    await (options.refresh ?? refreshSessionIndex)();
  }

  return {
    directory: moved.length > 0 ? directory : null,
    moved,
    vanished,
    skipped,
    orphanCount: orphans.length,
    total: entries.length,
    keptLegacy,
    remaining: orphans.length - selected.length,
  };
}
