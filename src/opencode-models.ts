import { join } from "node:path";
import {
  ANTIGRAVITY_MODELS,
  OPENAI_MODELS,
  OPENCODE_GO_MODELS,
  OPENCODE_MODELS,
  OPENCODE_VISION_MODELS,
  type ProviderID,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  messageOf,
} from "@reasonix/core-utils";
import { isCacheFresh, readJsonFileSilently, writeJsonFileSilently } from "./core/json-file.js";
import { fetchJson } from "./net/timeout-fetch.js";
import { reasonixHome } from "./reasonix-home.js";

/** Endpoint database of models across providers, operated by OpenCode community. */
export const OPENCODE_MODELS_DEV_URL = "https://models.dev/api.json";

/** Cache TTL: 12 hours. Keeps startup fast and network traffic light. */
export const OPENCODE_MODELS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Network timeout when fetching models.dev. */
export const OPENCODE_MODELS_FETCH_TIMEOUT_MS = 5_000;

/** Per-model reasoning-effort values from models.dev, keyed by provider then
 *  model id. Inner `[]` = toggle/budget-only (no effort ladder); an absent
 *  model means the model declares none (the provider default applies). */
export type ReasoningEffortMap = Partial<Record<ProviderID, Record<string, string[]>>>;

/** Cached discovery split so the catalog filters per credential without a
 *  second fetch. `goModels` route to the Go endpoint (overlaps stay on Zen). */
export interface OpencodeModelsCacheEntry {
  /** Every discovered id across OpenCode Zen + OpenCode Go. */
  models: string[];
  /** Subset with zero input cost — usable without a credential. */
  freeModels: string[];
  /** Subset with `attachment: true` — accepts image input. */
  visionModels: string[];
  /** Ids that route to the OpenCode Go endpoint. */
  goModels: string[];
  reasoningEfforts: ReasoningEffortMap;
  checkedAt: number;
}

export interface OpencodeModelsSnapshot {
  models: string[];
  visionModels: string[];
  reasoningEfforts: ReasoningEffortMap;
  checkedAt: number;
  error?: string;
}

/** Pulls the effort-value ladder out of a models.dev `reasoning_options` array.
 *  `undefined` = the model declares no options (provider default applies);
 *  `[]` = options exist but none is an effort ladder (toggle/budget-only). */
function modelReasoningEfforts(m: Record<string, unknown>): string[] | undefined {
  const opts = m.reasoning_options;
  if (!Array.isArray(opts) || opts.length === 0) return undefined;
  const effort = opts.find(
    (o) => o && typeof o === "object" && (o as { type?: unknown }).type === "effort",
  ) as { values?: unknown } | undefined;
  if (!effort) return [];
  const values = effort.values;
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is string => typeof v === "string" && v !== "null");
}

/** Validates a persisted provider→model→efforts map (drops malformed entries). */
function reasoningEffortsMap(value: unknown): ReasoningEffortMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ReasoningEffortMap = {};
  for (const [provider, models] of Object.entries(value as Record<string, unknown>)) {
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    const bucket: Record<string, string[]> = {};
    for (const [id, v] of Object.entries(models as Record<string, unknown>)) {
      const arr = stringArray(v);
      if (arr) bucket[id] = arr;
    }
    out[provider as ProviderID] = bucket;
  }
  return out;
}

export function opencodeModelsCachePath(homeDirOverride?: string): string {
  return join(reasonixHome(homeDirOverride), "opencode-models-cache.json");
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((m) => typeof m === "string") ? (value as string[]) : null;
}

/** Normalize a persisted entry, tolerating the pre-Go schema (which stored a
 *  single `models` list with no free/go split) so an upgrade doesn't force a
 *  cold re-fetch before the cache TTL expires. */
function normalizeCacheEntry(value: unknown): OpencodeModelsCacheEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const models = stringArray(entry.models);
  if (!models) return null;
  return {
    models,
    freeModels: stringArray(entry.freeModels) ?? models,
    visionModels: stringArray(entry.visionModels) ?? [],
    goModels: stringArray(entry.goModels) ?? [],
    reasoningEfforts: reasoningEffortsMap(entry.reasoningEfforts),
    checkedAt: typeof entry.checkedAt === "number" ? entry.checkedAt : 0,
  };
}

function isValidCacheEntry(value: unknown): value is OpencodeModelsCacheEntry {
  return normalizeCacheEntry(value) !== null;
}

export function loadOpencodeModelsCache(homeDirOverride?: string): OpencodeModelsCacheEntry | null {
  const raw = readJsonFileSilently<OpencodeModelsCacheEntry>(
    opencodeModelsCachePath(homeDirOverride),
    isValidCacheEntry,
  );
  return raw ? normalizeCacheEntry(raw) : null;
}

export function writeOpencodeModelsCache(
  entry: OpencodeModelsCacheEntry,
  homeDirOverride?: string,
): void {
  writeJsonFileSilently(opencodeModelsCachePath(homeDirOverride), entry);
}

/** Ids owned by another provider's native catalog — dropped from the OpenCode
 *  picker because the resolver keeps native-provider precedence for overlaps. */
const FOREIGN_CATALOG_IDS: ReadonlySet<string> = new Set<string>([
  ...SUPPORTED_OFFICIAL_MODELS,
  ...OPENAI_MODELS,
  ...ZAI_MODELS,
  ...ANTIGRAVITY_MODELS,
]);

/** Static fallback ids for the active credential state: free Zen always, plus
 *  the Go subscription catalog when a credential is present. */
function baselineIds(credentialed: boolean): Set<string> {
  const ids = new Set<string>();
  for (const id of OPENCODE_MODELS) {
    if (!FOREIGN_CATALOG_IDS.has(id)) ids.add(id);
  }
  if (credentialed) {
    for (const id of OPENCODE_GO_MODELS) {
      if (!FOREIGN_CATALOG_IDS.has(id)) ids.add(id);
    }
  }
  return ids;
}

/** Project the full cache into the current credential's view — free models
 *  keyless, the whole catalog (Zen paid + Go) when credentialed. */
function snapshotFromCache(
  cached: OpencodeModelsCacheEntry,
  credentialed: boolean,
  error?: string,
): OpencodeModelsSnapshot {
  const ids = baselineIds(credentialed);
  for (const id of credentialed ? cached.models : cached.freeModels) {
    if (!FOREIGN_CATALOG_IDS.has(id)) ids.add(id);
  }

  const vision = new Set<string>(OPENCODE_VISION_MODELS);
  for (const id of cached.visionModels) vision.add(id);
  const visionModels = Array.from(vision).filter((id) => ids.has(id));

  return {
    models: Array.from(ids),
    visionModels,
    reasoningEfforts: { ...cached.reasoningEfforts },
    checkedAt: cached.checkedAt,
    ...(error !== undefined ? { error } : {}),
  };
}

export interface FetchOpencodeModelsOptions {
  force?: boolean;
  url?: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
  /** Whether the caller holds an OpenCode credential (API key / Console OAuth).
   *  Gates the paid + Go catalog; defaults to keyless. */
  credentialed?: boolean;
}

function collect(
  provider: Record<string, unknown> | undefined,
  models: Set<string>,
  free: Set<string>,
  vision: Set<string>,
): void {
  const rawModels = (provider?.models ?? {}) as Record<string, unknown>;
  for (const [id, rawModel] of Object.entries(rawModels)) {
    if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
    const m = rawModel as Record<string, unknown>;
    models.add(id);
    // Free tier: cost.input === 0. A model with no cost entry is paid.
    const cost = m.cost as { input?: number } | undefined;
    if (cost && cost.input === 0) free.add(id);
    if (m.attachment === true) vision.add(id);
  }
}

/** models.dev provider keys whose `reasoning_options` feed a native Reasonix+
 *  provider. OpenCode Zen/Go are handled alongside the catalog split above. */
const NATIVE_REASONING_PROVIDERS: ReadonlyArray<{ key: string; provider: ProviderID }> = [
  { key: "deepseek", provider: "deepseek" },
  { key: "openai", provider: "openai" },
  { key: "zai", provider: "zai" },
];

/** Copy every model's `reasoning_options` from a models.dev provider block into
 *  the `out[provider]` bucket. `undefined` options leave the model absent. */
function captureReasoning(
  provider: Record<string, unknown> | undefined,
  providerID: ProviderID,
  out: ReasoningEffortMap,
): void {
  const rawModels = (provider?.models ?? {}) as Record<string, unknown>;
  const bucket: Record<string, string[]> = out[providerID] ?? {};
  out[providerID] = bucket;
  for (const [id, rawModel] of Object.entries(rawModels)) {
    if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
    const efforts = modelReasoningEfforts(rawModel as Record<string, unknown>);
    if (efforts !== undefined) bucket[id] = efforts;
  }
}

export async function fetchOpencodeModels(
  opts: FetchOpencodeModelsOptions = {},
): Promise<OpencodeModelsSnapshot> {
  const ttl = opts.ttlMs ?? OPENCODE_MODELS_CACHE_TTL_MS;
  const credentialed = opts.credentialed === true;
  const cached = loadOpencodeModelsCache(opts.homeDir);

  if (cached && isCacheFresh(cached, ttl, opts.force)) {
    return snapshotFromCache(cached, credentialed);
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = opts.url ?? OPENCODE_MODELS_DEV_URL;
  const timeout = opts.timeoutMs ?? OPENCODE_MODELS_FETCH_TIMEOUT_MS;

  try {
    const data = await fetchJson(url, fetchImpl, timeout);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid response format from models.dev (expected JSON object)");
    }
    const root = data as Record<string, unknown>;
    const zen = (root.opencode ?? root["opencode-zen"]) as Record<string, unknown> | undefined;
    const go = root["opencode-go"] as Record<string, unknown> | undefined;

    const modelsSet = new Set<string>();
    const freeSet = new Set<string>();
    const visionSet = new Set<string>();
    const reasoningEfforts: ReasoningEffortMap = {};
    collect(zen, modelsSet, freeSet, visionSet);
    collect(go, modelsSet, freeSet, visionSet);
    captureReasoning(zen, "opencode", reasoningEfforts);
    captureReasoning(go, "opencode", reasoningEfforts);
    for (const { key, provider } of NATIVE_REASONING_PROVIDERS) {
      captureReasoning(
        root[key] as Record<string, unknown> | undefined,
        provider,
        reasoningEfforts,
      );
    }

    // Go routing: ids the Go provider serves that Zen does not. Overlapping ids
    // stay on Zen; static Go-only ids cover the pre-fetch fallback.
    const zenIds = new Set(Object.keys((zen?.models ?? {}) as Record<string, unknown>));
    const goSet = new Set<string>();
    for (const id of Object.keys((go?.models ?? {}) as Record<string, unknown>)) {
      if (!zenIds.has(id)) goSet.add(id);
    }
    for (const id of OPENCODE_GO_MODELS) {
      if (!zenIds.has(id)) goSet.add(id);
    }

    // Always include the static catalog as a base guarantee.
    for (const id of OPENCODE_MODELS) {
      modelsSet.add(id);
      freeSet.add(id);
    }
    for (const id of OPENCODE_VISION_MODELS) visionSet.add(id);

    const snapshot: OpencodeModelsCacheEntry = {
      models: Array.from(modelsSet),
      freeModels: Array.from(freeSet),
      visionModels: Array.from(visionSet),
      goModels: Array.from(goSet),
      reasoningEfforts,
      checkedAt: Date.now(),
    };

    writeOpencodeModelsCache(snapshot, opts.homeDir);
    return snapshotFromCache(snapshot, credentialed);
  } catch (err) {
    const errorMsg = messageOf(err);
    // AntiSilentFallback: Loudly log to stderr that network fetch failed and we fall back to cache/catalog.
    process.stderr.write(
      `reasonix: failed to fetch models.dev (${errorMsg}), falling back to cached/catalog OpenCode models\n`,
    );
    if (cached) return snapshotFromCache(cached, credentialed, errorMsg);
    const ids = baselineIds(credentialed);
    return {
      models: Array.from(ids),
      visionModels: Array.from(OPENCODE_VISION_MODELS).filter((id) => ids.has(id)),
      reasoningEfforts: {},
      checkedAt: 0,
      error: errorMsg,
    };
  }
}

/** Check whether an arbitrary model ID belongs to the discovered OpenCode models. */
export function isDiscoveredOpencodeModel(modelId: string, homeDirOverride?: string): boolean {
  if (OPENCODE_MODELS.includes(modelId) || OPENCODE_GO_MODELS.includes(modelId)) return true;
  const cached = loadOpencodeModelsCache(homeDirOverride);
  return Boolean(cached?.models.includes(modelId));
}

/** True when a model id is served by the OpenCode Go subscription endpoint
 *  rather than Zen. Static Go-only ids always route to Go, so a stale or
 *  pre-Go cache can't mis-route them; discovery adds the rest. */
export function isOpencodeGoModel(modelId: string, homeDirOverride?: string): boolean {
  const staticGo = OPENCODE_GO_MODELS.includes(modelId) && !OPENCODE_MODELS.includes(modelId);
  const cached = loadOpencodeModelsCache(homeDirOverride);
  if (cached) return cached.goModels.includes(modelId) || staticGo;
  return staticGo;
}

/** True when a model id is a free (anonymous, no-plan) OpenCode Zen model: no
 *  usage API, capped per-IP. Go wins, so a Go-served id is never free. */
export function isOpencodeFreeModel(modelId: string, homeDirOverride?: string): boolean {
  if (OPENCODE_GO_MODELS.includes(modelId) && !OPENCODE_MODELS.includes(modelId)) return false;
  if (OPENCODE_MODELS.includes(modelId)) return true;
  const cached = loadOpencodeModelsCache(homeDirOverride);
  return Boolean(cached?.freeModels.includes(modelId));
}

/** The model's declared reasoning-effort values from the last models.dev sync.
 *  `undefined` = unknown (no cache, or the model declares none → provider
 *  default); `[]` = toggle/budget-only model with no effort ladder. */
export function reasoningEffortsForModel(
  provider: ProviderID,
  modelId: string,
  homeDirOverride?: string,
): string[] | undefined {
  return loadOpencodeModelsCache(homeDirOverride)?.reasoningEfforts[provider]?.[modelId];
}
