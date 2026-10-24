import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { LARGEST_WINDOW_TOKENS, SMALLEST_WINDOW_TOKENS } from "./context-window";
import { atomicWriteSync, tmpSiblingPath } from "./core/atomic-write";
import { readJsonFileSilently } from "./core/json-file";
import { reasonixHome } from "./reasonix-home";

/** A learned window is trusted for 24 h, then ignored until a server states one
 *  again: the window is a launch flag, so a restart with a different `--ctx-size`
 *  must be able to supersede what was learned. */
export const MODEL_WINDOW_TTL_MS = 24 * 60 * 60_000;

const MODEL_WINDOWS_FILENAME = "model-windows.json";

/** A context window a server reported for one model, learned from its own
 *  refusal rather than assumed from the model id. */
export interface ModelWindowEntry {
  contextTokens: number;
  /** Epoch ms when the window was learned — staleness is measured from here. */
  at: number;
}

export interface ModelWindowStore {
  version: 1;
  windows: Record<string, ModelWindowEntry>;
}

/** `~/.reasonix/model-windows.json` — global user state, next to config.json. */
export function modelWindowsPath(home: string = reasonixHome()): string {
  return join(home, MODEL_WINDOWS_FILENAME);
}

export function emptyModelWindows(): ModelWindowStore {
  return { version: 1, windows: {} };
}

/** A window value inside the supported bounds, or undefined for one no server could
 *  have meant (a stray number, a parsed field of the wrong unit). */
export function clampWindowTokens(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const tokens = Math.floor(value);
  if (tokens < SMALLEST_WINDOW_TOKENS || tokens > LARGEST_WINDOW_TOKENS) return undefined;
  return tokens;
}

function isWindowEntry(value: unknown): value is ModelWindowEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { contextTokens?: unknown; at?: unknown };
  if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return false;
  return (
    typeof entry.contextTokens === "number" && clampWindowTokens(entry.contextTokens) !== undefined
  );
}

function isModelWindowStore(value: unknown): value is ModelWindowStore {
  if (typeof value !== "object" || value === null) return false;
  const store = value as { version?: unknown; windows?: unknown };
  if (store.version !== 1 || typeof store.windows !== "object" || store.windows === null) {
    return false;
  }
  return Object.values(store.windows as Record<string, unknown>).every(isWindowEntry);
}

interface CachedRead {
  mtimeMs: number;
  size: number;
  store: ModelWindowStore;
}

/** Window resolution runs on every loop iteration and meter render, so the file
 *  is re-read only when its stat signature changes. */
const readCache = new Map<string, CachedRead>();

/** Read the learned windows, returning an empty store on any failure (missing,
 *  malformed, wrong shape) — never throws, and forgetting a window is the safe
 *  direction because the server corrects it on the next refusal. */
export function loadModelWindows(path: string = modelWindowsPath()): ModelWindowStore {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    readCache.delete(path);
    return emptyModelWindows();
  }
  const cached = readCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.store;
  const store = readJsonFileSilently(path, isModelWindowStore) ?? emptyModelWindows();
  readCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, store });
  return store;
}

/** Persist learned windows atomically (sibling tmp + rename, mode 0o600). */
export function saveModelWindows(store: ModelWindowStore, path: string = modelWindowsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteSync(path, JSON.stringify(store, null, 2), tmpSiblingPath(path));
  readCache.delete(path);
}

/** Record a window for one model, returning a new store (the cached one is
 *  shared, so a failure to persist must not leak a mutation into it). */
export function learnModelWindow(
  store: ModelWindowStore,
  model: string,
  contextTokens: number,
  now: number = Date.now(),
): ModelWindowStore {
  const tokens = clampWindowTokens(contextTokens);
  const id = model.trim();
  if (!id || tokens === undefined) return store;
  return { ...store, windows: { ...store.windows, [id]: { contextTokens: tokens, at: now } } };
}

/** The freshest learned window for a model within the TTL, or undefined. */
export function contextTokensForLearnedModel(
  store: ModelWindowStore,
  model: string,
  now: number = Date.now(),
  ttlMs: number = MODEL_WINDOW_TTL_MS,
): number | undefined {
  const entry = store.windows[model.trim()];
  if (!entry) return undefined;
  // A backwards clock jump must not pin a window forever: age is measured unsigned.
  if (Math.abs(now - entry.at) >= ttlMs) return undefined;
  return entry.contextTokens;
}

/** Learned window for a model through the shared store cache: the read path every
 *  ctxMax consumer shares. An omitted path means the user's own store, which a test
 *  run must not resolve against. */
export function learnedContextTokens(
  model: string,
  now: number = Date.now(),
  path?: string,
): number | undefined {
  if (path === undefined && process.env.VITEST === "true") return undefined;
  return contextTokensForLearnedModel(loadModelWindows(path ?? modelWindowsPath()), model, now);
}

/** The single write path for a window a server stated for one model, whether the
 *  server said so in its catalog or in a refusal. Skips a value the store already
 *  reports fresh, and never throws: a read-only home must not disturb the caller. */
export function recordModelWindow(
  model: string,
  contextTokens: number,
  opts: { path?: string; now?: number } = {},
): void {
  // A test run must never write the user's store: a fixture window would change
  // resolution for the rest of the run. An explicit path is a test-owned file.
  if (opts.path === undefined && process.env.VITEST === "true") return;
  const tokens = clampWindowTokens(contextTokens);
  const ref = model.trim();
  if (!ref || tokens === undefined) return;
  const path = opts.path ?? modelWindowsPath();
  try {
    const store = loadModelWindows(path);
    // A stale entry is refreshed even at the same value: the TTL is measured from `at`.
    if (contextTokensForLearnedModel(store, ref, opts.now) === tokens) return;
    saveModelWindows(learnModelWindow(store, ref, tokens, opts.now), path);
  } catch (writeFailure) {
    process.stderr.write(
      `reasonix: could not save the learned context window: ${
        writeFailure instanceof Error ? writeFailure.message : String(writeFailure)
      }\n`,
    );
  }
}
