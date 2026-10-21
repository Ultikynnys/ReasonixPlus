import { providerSettingPath, providerSpec } from "./provider-registry.js";
import { SEARCH_ENGINE_DOCUMENTS, type SearchEngineID } from "./search-engines.generated.js";

/** How an engine gets its credential: nothing, an endpoint, its own key, or a key a
 *  model provider already declares. */
export type SearchEngineKind = "keyless" | "endpoint" | "api-key" | "shared";

/** The transport that performs the search. Every value maps to one function in
 *  src/tools/web.ts, so a new engine needs no new dispatch branch. */
export type SearchEngineStrategy =
  | "bing-html"
  | "bing-intl"
  | "searxng"
  | "metaso"
  | "baidu"
  | "tavily"
  | "perplexity"
  | "exa"
  | "brave"
  | "ollama"
  | "zai";

export type SearchSettingKind = "secret" | "url";

/** One persisted setting an engine declares for itself. */
export interface SearchSettingSpec {
  /** Setting key inside the engine's store entry (e.g. `apiKey`, `endpoint`). */
  key: string;
  kind: SearchSettingKind;
  /** Environment variables that override the persisted value, highest priority first. */
  env: readonly string[];
  /** Legacy config field this setting migrated from; null when it never had one. */
  configKey: string | null;
  /** Field label text, declared here so the engine needs no app-side copy. */
  label: string;
  /** Field hint text, when the field needs one. */
  hint: string | null;
  /** Placeholder text; null means the engine has none. */
  placeholder: string | null;
  /** Where to obtain a key, rendered as a link. */
  signupUrl: string | null;
}

/** A credential a model provider owns and this engine reuses verbatim: same store
 *  path, so the value is never declared or entered twice. */
export interface SearchCredentialShare {
  /** Catalog id of the model provider that owns the setting. */
  provider: string;
  key: string;
}

export interface SearchEngineSpec {
  id: string;
  /** Card title / picker entry text. */
  label: string;
  /** One-line description shown under the title, null when it has none. */
  description: string | null;
  order: number;
  kind: SearchEngineKind;
  strategy: SearchEngineStrategy;
  /** Whether `webSearch` falls back to this engine when the primary backend fails. */
  fallback: boolean;
  sharedCredential: SearchCredentialShare | null;
  settings: readonly SearchSettingSpec[];
}

/** One validated write from a search settings patch. */
export interface SearchSettingWrite {
  engineId: string;
  key: string;
  /** Empty string clears the stored value. */
  value: string;
}

const KINDS: ReadonlySet<string> = new Set(["keyless", "endpoint", "api-key", "shared"]);
const STRATEGIES: ReadonlySet<string> = new Set([
  "bing-html",
  "bing-intl",
  "searxng",
  "metaso",
  "baidu",
  "tavily",
  "perplexity",
  "exa",
  "brave",
  "ollama",
  "zai",
]);
const SETTING_KINDS: ReadonlySet<string> = new Set(["secret", "url"]);

function fail(where: string, message: string): never {
  throw new Error(`search-engines: ${where}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(where, "expected an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) fail(where, "expected a non-empty string");
  return value.trim();
}

function nullableText(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  return text(value, where);
}

function number(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(where, "expected a number");
  return value;
}

function flag(value: unknown, where: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") fail(where, "expected a boolean");
  return value;
}

function texts(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(where, "expected an array");
  return value.map((entry, index) => text(entry, `${where}[${index}]`));
}

function choice<T extends string>(value: unknown, allowed: ReadonlySet<string>, where: string): T {
  const raw = text(value, where);
  if (!allowed.has(raw)) {
    fail(where, `unsupported value "${raw}" (expected ${[...allowed].join(", ")})`);
  }
  return raw as T;
}

function parseSetting(value: unknown, where: string): SearchSettingSpec {
  const raw = record(value, where);
  const key = text(raw.key, `${where}.key`);
  if (!/^[a-z][A-Za-z0-9]*$/.test(key)) fail(`${where}.key`, `invalid setting key "${key}"`);
  return {
    key,
    kind: choice<SearchSettingKind>(raw.kind, SETTING_KINDS, `${where}.kind`),
    env: texts(raw.env ?? [], `${where}.env`),
    configKey: nullableText(raw.configKey, `${where}.configKey`),
    label: text(raw.label, `${where}.label`),
    hint: nullableText(raw.hint, `${where}.hint`),
    placeholder: nullableText(raw.placeholder, `${where}.placeholder`),
    signupUrl: nullableText(raw.signupUrl, `${where}.signupUrl`),
  };
}

function parseShare(
  value: unknown,
  where: string,
  settings: readonly SearchSettingSpec[],
): SearchCredentialShare {
  const raw = record(value, where);
  const providerId = text(raw.provider, `${where}.provider`);
  const key = text(raw.key, `${where}.key`);
  const provider = providerSpec(providerId);
  if (!provider) fail(`${where}.provider`, `no model provider declares "${providerId}"`);
  // The share is only honest if the provider really declares that setting — that
  // declaration is what makes both sides read and write the same variable.
  if (!provider.settings.some((setting) => setting.key === key)) {
    fail(`${where}.key`, `provider "${providerId}" declares no setting "${key}"`);
  }
  if (settings.length > 0) {
    fail(where, "a shared engine declares no settings of its own");
  }
  return { provider: providerId, key };
}

/** Validate one engine document. Exported so tests can parse a synthetic engine. */
export function parseSearchEngine(value: unknown, source: string): SearchEngineSpec {
  const raw = record(value, source);
  const id = text(raw.id, `${source}: id`);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`${source}: id`, `invalid engine id "${id}"`);
  const scope = `${source}: engine "${id}"`;
  const settingsRaw = raw.settings ?? [];
  if (!Array.isArray(settingsRaw)) fail(`${scope}: settings`, "expected an array");
  const settings = settingsRaw.map((entry, index) =>
    parseSetting(entry, `${scope}: settings[${index}]`),
  );
  const kind = choice<SearchEngineKind>(raw.kind, KINDS, `${scope}: kind`);
  if (kind === "shared" && raw.sharedCredential === undefined) {
    fail(`${scope}: sharedCredential`, "required for a shared engine");
  }
  if (kind !== "shared" && raw.sharedCredential !== undefined) {
    fail(`${scope}: sharedCredential`, "only a shared engine may reuse a provider credential");
  }
  return {
    id,
    label: text(raw.label, `${scope}: label`),
    description: nullableText(raw.description, `${scope}: description`),
    order: number(raw.order, `${scope}: order`),
    kind,
    strategy: choice<SearchEngineStrategy>(raw.strategy, STRATEGIES, `${scope}: strategy`),
    fallback: flag(raw.fallback, `${scope}: fallback`),
    sharedCredential:
      raw.sharedCredential === undefined
        ? null
        : parseShare(raw.sharedCredential, `${scope}: sharedCredential`, settings),
    settings,
  };
}

/** Validate a whole registry document (`{ engines: [...] }`), ordered by `order`. */
export function parseSearchRegistry(value: unknown): SearchEngineSpec[] {
  const raw = record(value, "document");
  if (!Array.isArray(raw.engines)) fail("engines", "expected an array");
  const specs = raw.engines.map((entry, index) => parseSearchEngine(entry, `engines[${index}]`));
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.id)) fail("engines", `duplicate engine id "${spec.id}"`);
    seen.add(spec.id);
  }
  return specs.sort((a, b) => a.order - b.order);
}

/** Every engine, in picker order. Built from the generated barrel, so adding an engine
 *  is a JSON file plus a sync — never a code edit. */
export const SEARCH_ENGINE_SPECS: readonly SearchEngineSpec[] = parseSearchRegistry({
  engines: SEARCH_ENGINE_DOCUMENTS.map((entry) => entry.document),
});

export type { SearchEngineID };

const BY_ID: ReadonlyMap<string, SearchEngineSpec> = new Map(
  SEARCH_ENGINE_SPECS.map((spec) => [spec.id, spec]),
);

/** Engine ids in picker order. */
export const SEARCH_ENGINE_IDS: readonly string[] = SEARCH_ENGINE_SPECS.map((spec) => spec.id);

/** Engines `webSearch` falls back to when the primary backend fails. */
export const SEARCH_FALLBACK_ENGINES: readonly string[] = SEARCH_ENGINE_SPECS.filter(
  (spec) => spec.fallback,
).map((spec) => spec.id);

/** Engine by id, or undefined when unknown. */
export function searchEngineSpec(id: string): SearchEngineSpec | undefined {
  return BY_ID.get(id);
}

/** True when an engine declares this id: the tolerant membership check. */
export function searchEngineDeclared(id: string): boolean {
  return BY_ID.has(id);
}

/** Engine by id; throws when the registry has no such entry. */
export function requireSearchEngineSpec(id: string): SearchEngineSpec {
  const spec = BY_ID.get(id);
  if (!spec) throw new Error(`search-engines: no engine declares "${id}"`);
  return spec;
}

/** One declared setting of an engine, when it declares that key. */
export function searchSettingSpec(
  spec: SearchEngineSpec,
  key: string,
): SearchSettingSpec | undefined {
  return spec.settings.find((setting) => setting.key === key);
}

/** Store path an engine's own setting persists to: `<engineId>.<settingKey>`. */
export function searchSettingPath(engineId: string, key: string): string {
  return `${engineId}.${key}`;
}

/** The store path a setting resolves through. A shared engine returns its provider's
 *  path, which is what keeps one variable serving both surfaces. */
export function searchSettingStorePath(spec: SearchEngineSpec, key: string): string | null {
  if (spec.sharedCredential) return providerSettingPath(spec.sharedCredential.provider, key);
  return searchSettingSpec(spec, key) ? searchSettingPath(spec.id, key) : null;
}

/** The credential a shared engine reuses, or null when the engine owns its own. */
export function searchSharedCredential(spec: SearchEngineSpec): SearchCredentialShare | null {
  return spec.sharedCredential;
}

/** Validate a client-supplied search settings map: only a declared engine id and a
 *  key that engine declares for itself is accepted, so a shared credential can never
 *  be written through the search surface. */
export function parseSearchSettingsPatch(value: unknown): {
  writes: SearchSettingWrite[];
  rejected: string[];
} {
  const writes: SearchSettingWrite[] = [];
  const rejected: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { writes, rejected };
  }
  for (const [engineId, raw] of Object.entries(value)) {
    const spec = searchEngineSpec(engineId);
    if (!spec || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      rejected.push(engineId);
      continue;
    }
    for (const [key, entryValue] of Object.entries(raw)) {
      if (typeof entryValue !== "string" || !searchSettingSpec(spec, key)) {
        rejected.push(`${engineId}.${key}`);
        continue;
      }
      writes.push({ engineId, key, value: entryValue });
    }
  }
  return { writes, rejected };
}
