import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonFileSilently, writeJsonFileSilently } from "./core/json-file.js";
import { reasonixHome } from "./reasonix-home.js";

export type CatalogProvider = "deepseek" | "openai" | "zai" | "typesafe";
export interface ProviderCatalog {
  provider: CatalogProvider;
  models: string[];
  source: "live" | "cache" | "fallback";
  error?: string;
}
interface CacheEntry {
  models: string[];
  checkedAt: number;
}
const pending = new Map<string, Promise<ProviderCatalog>>();
function validCache(value: unknown): value is CacheEntry {
  const entry = value as CacheEntry | null;
  return Boolean(
    entry &&
      Array.isArray(entry.models) &&
      entry.models.every((id) => typeof id === "string") &&
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
export async function fetchProviderModels(options: {
  provider: CatalogProvider;
  baseUrl: string;
  apiKey?: string;
  fallback: readonly string[];
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
    return { provider, models: cached.models, source: "cache" };
  }
  const pendingKey = `${path}:${scope}`;
  const existing = pending.get(pendingKey);
  if (existing) return existing;
  const request = (async (): Promise<ProviderCatalog> => {
    try {
      if (!apiKey)
        throw new Error("Model discovery requires an API key; using the fallback catalog");
      const response = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`);
      const body = (await response.json()) as { data?: unknown; models?: unknown };
      const entries = provider === "typesafe" ? body.models : body.data;
      if (!Array.isArray(entries)) throw new Error("Provider returned a malformed model catalog");
      const models = [
        ...new Set(
          entries.map((entry: unknown) => {
            const model = entry as { id?: unknown; name?: unknown } | null;
            const id = provider === "typesafe" ? model?.name : model?.id;
            if (typeof id !== "string" || !id.trim())
              throw new Error("Provider returned a malformed model id");
            return id.trim();
          }),
        ),
      ].sort();
      writeJsonFileSilently(path, { models, checkedAt: Date.now() });
      return { provider, models, source: "live" };
    } catch (error) {
      return {
        provider,
        models: cached?.models ?? [...options.fallback],
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
