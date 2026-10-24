import { createHash } from "node:crypto";
import { join } from "node:path";
import { type ProviderSpec, providerSpec, providerSpecsInOrder } from "@reasonix/core-utils";
import { readJsonFileSilently, writeJsonFileSilently } from "./core/json-file.js";
import {
  clampWindowTokens,
  learnModelWindow,
  loadModelWindows,
  modelWindowsPath,
  saveModelWindows,
} from "./model-windows.js";
import { reasonixHome } from "./reasonix-home.js";

/** A provider whose endpoint never authenticates declares so; every other provider
 *  needs a key before its catalog is worth requesting. */
function keylessDiscovery(spec: ProviderSpec | undefined): boolean {
  return Boolean(spec && (spec.usable.keylessLocal || spec.usable.baseUrl));
}

export type CatalogProvider =
  | "local"
  | "deepseek"
  | "openai"
  | "zai"
  | "mimo"
  | "experiential"
  | "synthetic"
  | "openrouter";

/** Providers that publish a discovery catalog, read from their declared
 *  `discovery.strategy` so a new provider needs no second list. */
export const CATALOG_PROVIDER_IDS: readonly CatalogProvider[] = providerSpecsInOrder()
  .filter((spec) => spec.discovery.strategy === "models-endpoint")
  .map((spec) => spec.id as CatalogProvider);

const CATALOG_PROVIDER_SET: ReadonlySet<string> = new Set(CATALOG_PROVIDER_IDS);

export function isCatalogProvider(value: string): value is CatalogProvider {
  return CATALOG_PROVIDER_SET.has(value);
}
export interface ProviderCatalog {
  provider: CatalogProvider;
  models: string[];
  /** Ids whose declared `discovery.visionField` lists `image`, so a catalog the JSON
   *  cannot enumerate still grants the vision affordance. */
  visionModels: string[];
  source: "live" | "cache" | "fallback";
  error?: string;
}
interface CacheEntry {
  models: string[];
  visionModels?: string[];
  checkedAt: number;
}
const pending = new Map<string, Promise<ProviderCatalog>>();
function validCache(value: unknown): value is CacheEntry {
  const entry = value as CacheEntry | null;
  return Boolean(
    entry &&
      Array.isArray(entry.models) &&
      entry.models.every((id) => typeof id === "string") &&
      (entry.visionModels === undefined ||
        (Array.isArray(entry.visionModels) &&
          entry.visionModels.every((id) => typeof id === "string"))) &&
      typeof entry.checkedAt === "number",
  );
}
export function catalogScope(provider: CatalogProvider, baseUrl: string, apiKey?: string): string {
  return createHash("sha256")
    .update(JSON.stringify([provider, baseUrl, apiKey ?? ""]))
    .digest("hex");
}
function cachePath(scope: string, homeDir?: string): string {
  return join(reasonixHome(homeDir), "provider-models", `${scope}.json`);
}
export function discoveredProviderModels(
  provider: CatalogProvider,
  baseUrl: string,
  apiKey?: string,
  homeDir?: string,
): string[] | undefined {
  return readJsonFileSilently(
    cachePath(catalogScope(provider, baseUrl, apiKey), homeDir),
    validCache,
  )?.models;
}
/** Reads a dotted field (`architecture.input_modalities`) off one catalog entry. */
function fieldAt(value: unknown, dotted: string): unknown {
  let cursor: unknown = value;
  for (const key of dotted.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** Records the window a context-owning server advertises in its own catalog
 *  (`meta.n_ctx` from llama.cpp), so the ctx cap follows the server rather than a
 *  hand-entered setting. Recorded under the wire id and its qualified ref. */
function recordServedWindows(
  spec: ProviderSpec | undefined,
  entries: readonly unknown[],
  idField: string,
  homeDir?: string,
): void {
  if (!spec?.context) return;
  const path = modelWindowsPath(homeDir);
  let store = loadModelWindows(path);
  let changed = false;
  for (const entry of entries) {
    const model = entry as Record<string, unknown> | null;
    const id = model?.[idField];
    const reported = fieldAt(model, "meta.n_ctx");
    if (typeof id !== "string" || !id.trim() || typeof reported !== "number") continue;
    const tokens = clampWindowTokens(reported);
    if (tokens === undefined) continue;
    for (const key of [id.trim(), `${spec.id}/${id.trim()}`]) {
      const next = learnModelWindow(store, key, tokens);
      if (next !== store) {
        store = next;
        changed = true;
      }
    }
  }
  if (changed) saveModelWindows(store, path);
}

/** Ids whose declared modality field lists `image`. Empty when the provider declares
 *  no field, which leaves the JSON vision rules as the only evidence. */
function visionIdsOf(
  entries: readonly unknown[],
  idField: string,
  visionField: string | null,
): string[] {
  if (!visionField) return [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const model = entry as Record<string, unknown> | null;
    const id = model?.[idField];
    const modalities = fieldAt(model, visionField);
    if (
      typeof id === "string" &&
      id.trim() &&
      Array.isArray(modalities) &&
      modalities.includes("image")
    ) {
      ids.add(id.trim());
    }
  }
  return [...ids];
}

export async function fetchProviderModels(options: {
  provider: CatalogProvider;
  baseUrl: string;
  apiKey?: string;
  fallback: readonly string[];
  /** Model ids to drop from the discovered catalog. `discovery.excludeSpeech`
   *  adds the provider's speech-only ids automatically. */
  exclude?: ReadonlySet<string>;
  force?: boolean;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProviderCatalog> {
  const { provider, baseUrl, apiKey } = options;
  const scope = catalogScope(provider, baseUrl, apiKey);
  const path = cachePath(scope, options.homeDir);
  const cached = readJsonFileSilently(path, validCache);
  if (!options.force && cached && Date.now() - cached.checkedAt < 3_600_000) {
    return {
      provider,
      models: cached.models,
      source: "cache",
      visionModels: cached.visionModels ?? [],
    };
  }
  const pendingKey = `${path}:${scope}`;
  const existing = pending.get(pendingKey);
  if (existing) return existing;
  const request = (async (): Promise<ProviderCatalog> => {
    try {
      const spec = providerSpec(provider);
      if (!apiKey && !keylessDiscovery(spec))
        throw new Error("Model discovery requires an API key; using the fallback catalog");
      const response = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`);
      const body = (await response.json()) as { data?: unknown; models?: unknown };
      const listField = spec?.discovery.listField ?? "data";
      const idField = spec?.discovery.idField ?? "id";
      const entries = (body as Record<string, unknown>)[listField];
      if (!Array.isArray(entries)) throw new Error("Provider returned a malformed model catalog");
      const excluded = new Set<string>([
        ...(options.exclude ?? []),
        ...(spec?.discovery.excludeSpeech ? spec.speechModels : []),
      ]);
      const models = [
        ...new Set(
          entries.map((entry: unknown) => {
            const model = entry as Record<string, unknown> | null;
            const id = model?.[idField];
            if (typeof id !== "string" || !id.trim())
              throw new Error("Provider returned a malformed model id");
            return id.trim();
          }),
        ),
      ]
        .filter((id) => !excluded.has(id))
        .sort();
      const visionModels = visionIdsOf(entries, idField, spec?.discovery.visionField ?? null)
        .filter((id) => !excluded.has(id))
        .sort();
      recordServedWindows(spec, entries, idField, options.homeDir);
      writeJsonFileSilently(path, { models, visionModels, checkedAt: Date.now() });
      return { provider, models, visionModels, source: "live" };
    } catch (error) {
      return {
        provider,
        models: cached?.models ?? [...options.fallback],
        visionModels: cached?.visionModels ?? [],
        source: cached ? "cache" : "fallback",
        error: error instanceof Error ? error.message : "Model discovery failed",
      };
    }
  })();
  pending.set(pendingKey, request);
  try {
    return await request;
  } finally {
    pending.delete(pendingKey);
  }
}
