import { join } from "node:path";
import { readJsonFileSilently, writeJsonFileSilently } from "./core/json-file.js";
import { reasonixHome } from "./reasonix-home.js";

/** How an Ollama model's `think` field can be driven, learned from `/api/show`.
 *  Empty `levels` with allowsOn is a toggle; allowsOn:false cannot think at all.
 *  https://docs.ollama.com/capabilities/thinking */
export interface OllamaThinkingCapability {
  levels: string[];
  allowsOn: boolean;
}

export interface OllamaThinkingEntry extends OllamaThinkingCapability {
  at: number;
}

export type OllamaThinkingMap = Record<string, OllamaThinkingEntry>;

const OLLAMA_THINKING_FILENAME = "ollama-thinking.json";

/** A learned ladder is trusted for a day; `/api/show` is re-probed after that. */
export const OLLAMA_THINKING_TTL_MS = 24 * 60 * 60_000;

export function ollamaThinkingPath(home: string = reasonixHome()): string {
  return join(home, OLLAMA_THINKING_FILENAME);
}

function isThinkingMap(value: unknown): value is OllamaThinkingMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) return false;
    const raw = entry as { levels?: unknown; allowsOn?: unknown; at?: unknown };
    if (!Array.isArray(raw.levels) || raw.levels.some((l) => typeof l !== "string")) return false;
    if (typeof raw.allowsOn !== "boolean") return false;
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return false;
  }
  return true;
}

export function loadOllamaThinking(path: string = ollamaThinkingPath()): OllamaThinkingMap {
  return readJsonFileSilently(path, isThinkingMap) ?? {};
}

/** Record what `/api/show` reported. `undefined` means the server has no thinking
 *  metadata, so nothing is learned and a later probe can still find it. */
export function recordOllamaThinking(
  model: string,
  capability: OllamaThinkingCapability | undefined,
  path: string = ollamaThinkingPath(),
  now: number = Date.now(),
): void {
  if (capability === undefined) return;
  const map = loadOllamaThinking(path);
  map[model] = { ...capability, at: now };
  writeJsonFileSilently(path, map);
}

/** The model's advertised controls, or undefined when never probed or stale. */
export function ollamaThinkingFor(
  model: string,
  path: string = ollamaThinkingPath(),
  now: number = Date.now(),
): OllamaThinkingCapability | undefined {
  const entry = loadOllamaThinking(path)[model];
  if (!entry || now - entry.at >= OLLAMA_THINKING_TTL_MS) return undefined;
  return { levels: entry.levels, allowsOn: entry.allowsOn };
}
