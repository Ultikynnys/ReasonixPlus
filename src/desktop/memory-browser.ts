import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { MemoryEntryDetail, MemoryEntryInfo } from "@reasonix/core-utils";
import { readProjectMemory } from "../memory/project.js";
import {
  type MemoryEntry,
  type MemoryExpires,
  type MemoryPriority,
  type MemoryScope,
  MemoryStore,
  readGlobalReasonixMemory,
} from "../memory/user.js";

export type {
  MemoryEntryDetail,
  MemoryEntryInfo,
  MemoryEntryKind,
} from "@reasonix/core-utils";

export interface MemoryBrowserOptions {
  /** Absolute ~/.reasonix directory. Tests override this; production uses homedir(). */
  reasonixHome?: string;
}

export function collectMemoryEntriesForWorkspace(
  projectRoot: string,
  opts: MemoryBrowserOptions = {},
): MemoryEntryInfo[] {
  const out: MemoryEntryInfo[] = [];
  const project = readProjectMemory(projectRoot);
  if (project) {
    out.push({
      kind: "project_file",
      scope: "project",
      name: basename(project.path),
      path: project.path,
      description: "Project memory file",
      type: "freeform",
    });
  }

  const global = readGlobalReasonixMemory(opts.reasonixHome);
  if (global) {
    out.push({
      kind: "global_file",
      scope: "global",
      name: basename(global.path),
      path: global.path,
      description: "Global memory file",
      type: "freeform",
    });
  }

  const store = new MemoryStore({ homeDir: opts.reasonixHome, projectRoot });
  for (const entry of store.list()) {
    out.push(structuredInfo(store, entry));
  }
  return out;
}

export function readMemoryEntryDetail(
  request: { path: string },
  projectRoot: string,
  opts: MemoryBrowserOptions = {},
): MemoryEntryDetail {
  const requested = resolve(request.path);
  const entry = collectMemoryEntriesForWorkspace(projectRoot, opts).find(
    (candidate) => resolve(candidate.path) === requested,
  );
  if (!entry) throw new Error(`memory path not available: ${request.path}`);

  if (entry.kind === "structured") {
    const store = new MemoryStore({ homeDir: opts.reasonixHome, projectRoot });
    const structured = store.read(entry.scope, entry.name);
    return {
      ...entry,
      description: structured.description,
      type: structured.type,
      body: structured.body,
      createdAt: structured.createdAt,
      ...memoryFidelity(structured),
    };
  }

  if (!existsSync(entry.path)) throw new Error(`memory file missing: ${entry.path}`);
  return {
    ...entry,
    body: readFileSync(entry.path, "utf8").trim(),
  };
}

/** Optional fidelity fields a structured entry may carry; omitted when absent so
 *  the wire shape stays sparse (matches MemoryEntryInfo's optional fields). */
function memoryFidelity(
  entry: Pick<MemoryEntry, "priority" | "expires">,
): Pick<MemoryEntryInfo, "priority" | "expires"> {
  return {
    ...(entry.priority ? { priority: entry.priority } : {}),
    ...(entry.expires ? { expires: entry.expires } : {}),
  };
}

function structuredInfo(store: MemoryStore, entry: MemoryEntry): MemoryEntryInfo {
  return {
    kind: "structured",
    scope: entry.scope,
    name: entry.name,
    path: store.pathFor(entry.scope, entry.name),
    description: entry.description,
    type: entry.type,
    ...memoryFidelity(entry),
  };
}

export interface MemoryWriteInput {
  scope: MemoryScope;
  name: string;
  description: string;
  body: string;
  type?: string;
  priority?: MemoryPriority;
  expires?: MemoryExpires;
}

/** Create/overwrite a structured memory via MemoryStore — regenerates MEMORY.md so the
 *  next new session or launch pins it. Throws on invalid names / empty description / body. */
export function writeMemoryEntry(
  input: MemoryWriteInput,
  projectRoot: string,
  opts: MemoryBrowserOptions = {},
): { path: string } {
  const store = new MemoryStore({ homeDir: opts.reasonixHome, projectRoot });
  const path = store.write({
    name: input.name,
    scope: input.scope,
    type: input.type ?? (input.scope === "project" ? "project" : "user"),
    description: input.description,
    body: input.body,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.expires ? { expires: input.expires } : {}),
  });
  return { path };
}

/** Delete by the exact path the browser surfaced. Structured entries go through
 *  MemoryStore (MEMORY.md regenerated); freeform project/global files are unlinked. */
export function deleteMemoryEntry(
  path: string,
  projectRoot: string,
  opts: MemoryBrowserOptions = {},
): boolean {
  const requested = resolve(path);
  const entry = collectMemoryEntriesForWorkspace(projectRoot, opts).find(
    (candidate) => resolve(candidate.path) === requested,
  );
  if (!entry) return false;
  if (entry.kind === "structured") {
    const store = new MemoryStore({ homeDir: opts.reasonixHome, projectRoot });
    return store.delete(entry.scope, entry.name);
  }
  if (!existsSync(entry.path)) return false;
  unlinkSync(entry.path);
  return true;
}
