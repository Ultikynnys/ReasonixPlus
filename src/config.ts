/** Library reads only DEEPSEEK_API_KEY from env; the CLI bridges config.json → env var. */

import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ANTIGRAVITY_MODELS,
  DEFAULT_MODEL,
  EXPERIENTIAL_MODELS,
  GEMINI_MODELS,
  GPT56_MODELS,
  KNOWN_MODELS,
  MIMO_MODELS,
  MIMO_SPEECH_MODELS,
  MailProvider,
  OPENAI_MODELS,
  OPENCODE_MODELS,
  PROVIDER_IDS,
  PROVIDER_SPECS,
  type ProviderCredentialContext,
  type ProviderModelFilter,
  type ProviderSpec,
  ROUTABLE_PROVIDER_SPECS,
  SEARCH_ENGINE_SPECS,
  SUPPORTED_OFFICIAL_MODELS,
  type SearchSettingSpec,
  WEB_SEARCH_ENGINE_NAMES,
  type WebSearchEngineName,
  ZAI_MODELS,
  enforceQuickSendShorthand,
  isQuickSend,
  isUsableAntigravityModel,
  parseModelRef,
  providerApiKeyValue,
  providerCountsAsConfigured,
  providerDefaultEndpoint,
  providerSpec,
  providerUsable,
  requireProviderSpec,
  resolveProviderEndpoint,
  ruleRegexError,
  searchEngineSpec,
  searchSettingSpec,
  searchSharedCredential,
  specForProvider,
  stripProviderQualifier,
} from "@reasonix/core-utils";
import { z } from "zod";
import { atomicWriteSync, tmpSiblingPath } from "./core/atomic-write.js";
import { loadDotMcpJson } from "./mcp/dot-mcp-json.js";
import { type McpServerSpec, parseMcpSpec } from "./mcp/spec.js";
import { BUILTIN_MEMORY_TYPES } from "./memory/builtin-types.js";
import {
  isDiscoveredOpencodeModel,
  isOpencodeGoModel,
  reasoningEffortsForModel,
} from "./opencode-models.js";
import { discoveredProviderModels, isCatalogProvider } from "./provider-models.js";
import { reasonixHome } from "./reasonix-home.js";
import { MAX_CONTEXT_TOKENS, MIN_CONTEXT_TOKENS } from "./telemetry/stats.js";
import { type ThemeName, isThemeName, resolveThemeName } from "./theme/tokens.js";
import {
  type NormalizedToolRateLimitConfig,
  type ToolRateLimitConfig,
  normalizeToolRateLimitConfig,
} from "./tools/rate-limit.js";

/** Built-in model groups remain public from config for existing library consumers. */
export {
  DEFAULT_MODEL,
  GEMINI_MODELS,
  GPT56_MODELS,
  MIMO_MODELS,
  MIMO_SPEECH_MODELS,
  OPENAI_MODELS,
  OPENCODE_MODELS,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
};

/** Everything the default endpoints accept without a custom baseUrl, across providers. */
export const SUPPORTED_MODELS: readonly string[] = KNOWN_MODELS;

/** Which provider a model id routes to — resolved from positive evidence, never
 *  the id's name shape (a name doesn't imply its provider). Resolution order:
 *  `models` config > Antigravity discovery > catalogs > `ollama/` scheme > DeepSeek default. */
export type ModelProvider = ProviderID; // aliased to core-utils ProviderID (shared reasoning-effort map)

/** Valid ModelProvider literals — config validation for the `models` map.
 *  Reuses the core-utils runtime list so the daemon's validation and the
 *  `ProviderID` union can never drift apart. */
export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Catalog membership sets — exact-id matching, never prefix inference. */
const ROUTABLE_SPECS: readonly ProviderSpec[] = ROUTABLE_PROVIDER_SPECS;

/** Providers whose static catalog claims a bare id, in display order. */
const STATIC_CATALOG_SPECS: ReadonlyArray<{ provider: ModelProvider; ids: ReadonlySet<string> }> =
  ROUTABLE_SPECS.filter((spec) => spec.routing.staticCatalog && !spec.routing.checkedLast).map(
    (spec) => ({ provider: spec.providerId as ModelProvider, ids: new Set(spec.models) }),
  );

/** Providers whose discovery cache may claim a bare id the static pass left alone. */
const DISCOVERY_CATALOG_SPECS: readonly ProviderSpec[] = ROUTABLE_SPECS.filter(
  (spec) => spec.routing.discoveredCatalog,
);

/** Resold gateways, consulted only after every native provider declined. */
const LAST_CHANCE_SPECS: readonly ProviderSpec[] = ROUTABLE_SPECS.filter(
  (spec) => spec.routing.checkedLast,
);

/** Model-id prefixes that always route here (`ollama/` keeps legacy any-id). */
const MODEL_SCHEME_SPECS: readonly ProviderSpec[] = ROUTABLE_SPECS.filter(
  (spec) => spec.routing.modelScheme !== null,
);

/** Discovery strategies that place a bare id, keyed by the strategy declared in
 *  providers.json. A new strategy needs one predicate, not a new if-branch. */
const DISCOVERY_ROUTERS: Readonly<Record<string, (id: string) => boolean>> = {
  "models.dev": (id) => isDiscoveredOpencodeModel(id),
};

/** Providers whose models.dev sync places ids no static catalog claims. */
const MODELS_DEV_SPECS: readonly ProviderSpec[] = ROUTABLE_SPECS.filter(
  (spec) => spec.discovery.strategy === "models.dev",
);

/** The only provider family whose ids a signed-in account discovers by quota. */
const OAUTH_QUOTA_SPEC: ProviderSpec | undefined = ROUTABLE_SPECS.find(
  (spec) => spec.discovery.strategy === "oauth-quota",
);

interface ModelAdmission {
  accepted: boolean;
  provider: ModelProvider;
  discoveredAntigravity: boolean;
}

const ADMITTED = (provider: ModelProvider): ModelAdmission => ({
  accepted: true,
  provider,
  discoveredAntigravity: false,
});
/** The routable label used when nothing admits a model: the first declared provider, or an
 *  empty string when no provider file exists — nothing can resolve it until one does. */
const FALLBACK_PROVIDER = (ROUTABLE_PROVIDER_SPECS[0]?.providerId ?? "") as ModelProvider;
const NOT_ADMITTED: ModelAdmission = {
  accepted: false,
  provider: FALLBACK_PROVIDER,
  discoveredAntigravity: false,
};

/** Look up an id in a provider's discovery cache; providers without a cached
 *  catalog (Ollama, Gemini) never consult one. */
function discoveredCatalogIds(
  catalogId: string,
  endpoint: ResolvedEndpoint,
): readonly string[] | undefined {
  if (!isCatalogProvider(catalogId)) return undefined;
  return discoveredProviderModels(catalogId, endpoint.baseUrl!, endpoint.apiKey);
}

/** Id filters a provider declares for its own catalog (`modelFilter` in JSON). */
const MODEL_FILTERS: Readonly<Record<ProviderModelFilter, (id: string) => boolean>> = {
  antigravity: isUsableAntigravityModel,
};

/** Models a signed-in account reported, read from the config field the registry names. */
function oauthCatalogModels(cfg: ReasonixConfig, field: string): readonly string[] | undefined {
  const creds = cfg[field as keyof ReasonixConfig] as { models?: readonly string[] } | undefined;
  return creds?.models;
}

/** Resolve model admission and routing from positive evidence in one place. */
function resolveModelAdmission(model: string, path: string, cfg: ReasonixConfig): ModelAdmission {
  const id = model.trim();
  if (!id) return NOT_ADMITTED;

  const mapped = cfg.models?.[id]?.provider;
  if (isModelProvider(mapped)) return ADMITTED(mapped);

  // A signed-in account is the only evidence for a quota-discovered catalog.
  const quota = OAUTH_QUOTA_SPEC;
  const quotaMatches =
    quota === undefined || quota.modelFilter === null || MODEL_FILTERS[quota.modelFilter](id);
  const quotaModels = quota?.credentials.oauthConfig
    ? oauthCatalogModels(cfg, quota.credentials.oauthConfig)
    : undefined;
  if (quota?.providerId && quotaMatches && quotaModels?.includes(id)) {
    return { accepted: true, provider: quota.providerId, discoveredAntigravity: true };
  }
  // An explicit `<provider>/<id>` qualifier pins routing over catalog precedence:
  // an id served by two providers must resolve per picker row. The suffix must be
  // a known id (a typo can't mint a routable model), and a declared model scheme
  // (`ollama/`) keeps its legacy any-id behaviour.
  const scheme = MODEL_SCHEME_SPECS.find((spec) =>
    id.startsWith(spec.routing.modelScheme ?? "\u0000"),
  );
  const ref = parseModelRef(id);
  if (ref.provider && !scheme && ref.id) {
    if (resolveModelAdmission(ref.id, path, cfg).accepted) return ADMITTED(ref.provider);
  }
  // Explicit catalogs win over discovery: OpenCode Zen/Go and the Experiential
  // gateway resell ids that other providers serve natively (gpt-6-luna, glm-5.3,
  // deepseek-v4-pro), and those must keep their native endpoint unless the user
  // pins them in the `models` config map.
  for (const catalog of STATIC_CATALOG_SPECS) {
    if (catalog.ids.has(id)) return ADMITTED(catalog.provider);
  }
  for (const spec of MODELS_DEV_SPECS) {
    if (!spec.providerId) continue;
    if (DISCOVERY_ROUTERS[spec.discovery.strategy]?.(id)) return ADMITTED(spec.providerId);
  }
  if (scheme?.providerId) return ADMITTED(scheme.providerId);
  for (const spec of DISCOVERY_CATALOG_SPECS) {
    const provider = spec.providerId;
    if (!provider) continue;
    const endpoint = endpointFor(provider, "", cfg);
    if (discoveredCatalogIds(spec.id, endpoint)?.includes(id)) return ADMITTED(provider);
  }
  // Resold gateways are checked LAST: a bare overlap keeps its native provider
  // and must be pinned with a qualifier or a `models` config mapping. Their
  // static list covers an offline start so the group's rows still route.
  for (const spec of LAST_CHANCE_SPECS) {
    const provider = spec.providerId;
    if (!provider) continue;
    const endpoint = endpointFor(provider, "", cfg);
    if (spec.models.includes(id) || discoveredCatalogIds(spec.id, endpoint)?.includes(id)) {
      return ADMITTED(provider);
    }
  }
  return NOT_ADMITTED;
}

/** One declared provider setting from an in-memory config — the store's only
 *  read path, so every consumer reads the same shape. */
export function providerSettingFromStore(
  cfg: ReasonixConfig,
  providerId: string,
  key: string,
): string | undefined {
  const value = cfg.providerSettings?.[providerId]?.[key]?.trim();
  return value || undefined;
}

/** Read a `<catalogId>.<settingKey>` store path. */
function settingAtPath(cfg: ReasonixConfig, path: string): string | undefined {
  const dot = path.indexOf(".");
  if (dot <= 0 || dot === path.length - 1) return undefined;
  return providerSettingFromStore(cfg, path.slice(0, dot), path.slice(dot + 1));
}

/** Set a declared provider setting on an in-memory config; an empty value clears it.
 *  The caller writes the config once, so a multi-field patch stays a single write. */
export function setProviderSetting(
  cfg: ReasonixConfig,
  providerId: string,
  key: string,
  value: string | null,
): void {
  const spec = providerSpec(providerId);
  if (!spec) throw new Error(`setProviderSetting: unknown provider "${providerId}"`);
  if (!spec.settings.some((setting) => setting.key === key)) {
    const declared = spec.settings.map((setting) => setting.key).join(", ") || "none";
    throw new Error(
      `setProviderSetting: provider "${providerId}" declares no setting "${key}" (declared: ${declared})`,
    );
  }
  const store = cfg.providerSettings ?? {};
  const entry = store[providerId] ?? {};
  cfg.providerSettings = store;
  store[providerId] = entry;
  const trimmed = value?.trim() ?? "";
  if (trimmed) entry[key] = trimmed;
  else delete entry[key];
  if (Object.keys(entry).length === 0) {
    delete store[providerId];
    if (Object.keys(store).length === 0) cfg.providerSettings = undefined;
  }
}

/** Read one declared provider setting. */
export function loadProviderSetting(
  providerId: string,
  key: string,
  path: string = defaultConfigPath(),
): string | undefined {
  return providerSettingFromStore(readConfig(path), providerId, key);
}

/** Persist one declared provider setting; an empty value removes it. */
export function saveProviderSetting(
  providerId: string,
  key: string,
  value: string | null,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  setProviderSetting(cfg, providerId, key, value);
  writeConfig(cfg, path);
}

/** Legacy per-engine fields older versions persisted, and the setting each one
 *  becomes. Derived from the engine files, so the mapping cannot drift. */
const LEGACY_SEARCH_SETTINGS: ReadonlyArray<{ engine: string; key: string; field: string }> =
  SEARCH_ENGINE_SPECS.flatMap((spec) =>
    spec.settings.flatMap((setting) =>
      setting.configKey === null
        ? []
        : [{ engine: spec.id, key: setting.key, field: setting.configKey }],
    ),
  );

/** Fold legacy per-engine fields into the search store. A value already in the store
 *  wins, mirroring the provider migration. */
function migrateSearchSettings(cfg: Record<string, unknown>): void {
  for (const { engine, key, field } of LEGACY_SEARCH_SETTINGS) {
    const legacy = cfg[field];
    if (typeof legacy !== "string" || !legacy.trim()) continue;
    const store = (cfg.searchSettings ?? {}) as Record<string, Record<string, string>>;
    const entry = store[engine] ?? {};
    store[engine] = entry;
    cfg.searchSettings = store;
    if (!entry[key]) entry[key] = legacy.trim();
    delete cfg[field];
  }
}

/** One declared search setting from an in-memory config. A shared engine resolves
 *  through its model provider's entry, which is what keeps one variable serving both. */
export function searchSettingFromConfig(
  cfg: ReasonixConfig,
  engineId: string,
  key: string,
): string | undefined {
  const spec = searchEngineSpec(engineId);
  if (!spec) return undefined;
  const shared = searchSharedCredential(spec);
  const value = shared
    ? cfg.providerSettings?.[shared.provider]?.[shared.key]
    : cfg.searchSettings?.[engineId]?.[key];
  return value?.trim() || undefined;
}

/** Set a declared search setting in memory; an empty value clears it. Writing a shared
 *  engine routes to the model provider's setting, never a second variable. */
export function setSearchSetting(
  cfg: ReasonixConfig,
  engineId: string,
  key: string,
  value: string | null,
): void {
  const spec = searchEngineSpec(engineId);
  if (!spec) throw new Error(`setSearchSetting: unknown engine "${engineId}"`);
  const shared = searchSharedCredential(spec);
  if (shared) {
    setProviderSetting(cfg, shared.provider, shared.key, value);
    return;
  }
  if (!searchSettingSpec(spec, key)) {
    throw new Error(`setSearchSetting: engine "${engineId}" declares no setting "${key}"`);
  }
  const store = cfg.searchSettings ?? {};
  const entry = store[engineId] ?? {};
  cfg.searchSettings = store;
  store[engineId] = entry;
  const trimmed = value?.trim() ?? "";
  if (trimmed) entry[key] = trimmed;
  else delete entry[key];
  if (Object.keys(entry).length === 0) {
    delete store[engineId];
    if (Object.keys(store).length === 0) cfg.searchSettings = undefined;
  }
}

/** Read one declared search setting. */
export function loadSearchSetting(
  engineId: string,
  key: string,
  path: string = defaultConfigPath(),
): string | undefined {
  return searchSettingFromConfig(readConfig(path), engineId, key);
}

/** Persist one declared search setting; an empty value removes it. */
export function saveSearchSetting(
  engineId: string,
  key: string,
  value: string | null,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  setSearchSetting(cfg, engineId, key, value);
  writeConfig(cfg, path);
}

/** First non-empty env override a setting declares. */
function searchEnvValue(setting: SearchSettingSpec, env = process.env): string | undefined {
  for (const name of setting.env) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Effective API key per engine: env first, then the store (its own entry, or the model
 *  provider entry it shares). Engines without a key are absent. */
export function loadSearchApiKeys(
  path: string = defaultConfigPath(),
): Record<string, string | undefined> {
  const cfg = readConfig(path);
  const providerKeys = loadProviderApiKeys(path);
  const out: Record<string, string | undefined> = {};
  for (const spec of SEARCH_ENGINE_SPECS) {
    const shared = searchSharedCredential(spec);
    if (shared) {
      out[spec.id] = providerKeys[shared.provider];
      continue;
    }
    const setting = searchSettingSpec(spec, "apiKey");
    if (!setting) continue;
    out[spec.id] = searchEnvValue(setting) ?? searchSettingFromConfig(cfg, spec.id, "apiKey");
  }
  return out;
}

/** Effective API key for one engine. */
export function loadSearchApiKey(
  engineId: string,
  path: string = defaultConfigPath(),
): string | undefined {
  return loadSearchApiKeys(path)[engineId];
}

/** Legacy per-provider fields older versions persisted, and the setting each one
 *  becomes. Derived from the provider files, so the mapping cannot drift. */
const LEGACY_PROVIDER_SETTINGS: ReadonlyArray<{ provider: string; key: string; field: string }> =
  PROVIDER_SPECS.flatMap((spec) =>
    spec.settings.flatMap((setting) =>
      setting.configKey === null
        ? []
        : [{ provider: spec.id, key: setting.key, field: setting.configKey }],
    ),
  );

/** Fold legacy per-provider fields into the store so a config written by an older
 *  version keeps every value. A value already in the store wins. */
function migrateProviderSettings(cfg: Record<string, unknown>): void {
  if (
    cfg.providerSettings !== undefined &&
    (typeof cfg.providerSettings !== "object" ||
      cfg.providerSettings === null ||
      Array.isArray(cfg.providerSettings))
  ) {
    cfg.providerSettings = undefined;
  }
  const folded = LEGACY_PROVIDER_SETTINGS.flatMap(({ provider, key, field }) => {
    // Read every legacy field before deleting any: several providers declare the
    // same source (the old top-level baseUrl fed both DeepSeek and OpenAI).
    const legacy = cfg[field];
    return typeof legacy === "string" && legacy.trim()
      ? [{ provider, key, value: legacy.trim() }]
      : [];
  });
  for (const { provider, key, value } of folded) {
    const store = (cfg.providerSettings ?? {}) as Record<string, Record<string, string>>;
    const entry = store[provider] ?? {};
    cfg.providerSettings = store;
    store[provider] = entry;
    if (!entry[key]) entry[key] = value;
  }
  for (const { field } of LEGACY_PROVIDER_SETTINGS) {
    if (typeof cfg[field] === "string") delete cfg[field];
  }
}

/** Registry context over the persisted config — provider field names come from
 *  providers.json, so adding one needs no new accessor. */
function providerContext(cfg: ReasonixConfig): ProviderCredentialContext {
  return {
    setting: (path) => settingAtPath(cfg, path),
    oauthToken: (field) => {
      const value = cfg[field as keyof ReasonixConfig] as { accessToken?: string } | undefined;
      return value?.accessToken;
    },
  };
}

/** Model predicates keyed by endpoint tier name (OpenCode Go is the only split). */
const TIER_PREDICATES: Readonly<Record<string, (model: string) => boolean>> = {
  go: isOpencodeGoModel,
};

/** The endpoint tier a model belongs to, when its provider splits its catalog. */
function endpointTierFor(spec: ProviderSpec, model: string): string | null {
  if (spec.endpoint.strategy !== "tiered") return null;
  for (const tier of Object.keys(spec.endpoint.tiers)) {
    if (TIER_PREDICATES[tier]?.(model)) return tier;
  }
  return null;
}

/** Resolved (baseUrl, apiKey) for a provider's model, straight from providers.json. */
function endpointFor(
  provider: ModelProvider,
  model: string,
  cfg: ReasonixConfig,
): ResolvedEndpoint {
  const spec = providerSpec(provider);
  // A provider with no file declares no endpoint; the send path reports that instead.
  if (!spec) return { baseUrl: undefined, apiKey: undefined };
  return resolveProviderEndpoint(spec, {
    ...providerContext(cfg),
    tier: endpointTierFor(spec, model),
  });
}

/** A provider's declared default endpoint (optionally a named tier). A provider
 *  whose JSON was removed yields "", so removal never breaks module load. */
function defaultEndpointOf(provider: ModelProvider, tier?: string): string {
  return providerDefaultEndpoint(provider, tier) ?? "";
}

export function providerForModel(
  model: string | undefined | null,
  path: string = defaultConfigPath(),
): ModelProvider {
  if (typeof model !== "string") return FALLBACK_PROVIDER;
  return resolveModelAdmission(model, path, readConfig(path)).provider;
}

/** Reasoning-effort levels the model's endpoint accepts: the per-model values
 *  from the synced models.dev catalog when known (deepseek/openai/zai/opencode),
 *  else the provider's static fallback set. `[]` = no effort control. */
export function supportedReasoningEfforts(
  model: string,
  path: string = defaultConfigPath(),
): readonly ReasoningEffort[] {
  const provider = providerForModel(model, path);
  return reasoningEffortsFor(
    provider,
    reasoningEffortsForModel(provider, stripProviderQualifier(model)),
  );
}

/** The requested effort clamped to what the model accepts, or undefined when the
 *  model has no effort ladder (toggle/budget-only) so callers omit the field. */
export function effectiveReasoningEffort(
  model: string,
  requested: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!requested) return undefined;
  return clampReasoningEffort(supportedReasoningEfforts(model), requested) ?? undefined;
}

/** True when positive evidence places a model id: a `models` mapping, server
 *  discovery, a catalog entry, or the `ollama/` scheme — a name shape alone
 *  proves nothing. */
export function isKnownModelId(model: string, path: string = defaultConfigPath()): boolean {
  return resolveModelAdmission(model, path, readConfig(path)).accepted;
}

/** Model ids that accept image attachments in user messages — shared with the
 *  desktop UI so both sides agree on which models get the image affordance. */
export { modelAcceptsImages } from "@reasonix/core-utils";

/** Every default endpoint is declared in providers.json; tiers are named there too. */
export const DEFAULT_OLLAMA_CHAT_URL = defaultEndpointOf("ollama");
export const DEFAULT_GEMINI_CHAT_URL = defaultEndpointOf("gemini");
export const DEFAULT_ZAI_CHAT_URL = defaultEndpointOf("zai");
/** GLM Coding Plan endpoint — Coding Plan keys authenticate only here. */
export const DEFAULT_ZAI_CODING_CHAT_URL = defaultEndpointOf("zai", "coding");
/** GLM Coding Plan Responses endpoint — the chat-completions paths 401 them. */
export const DEFAULT_ZAI_RESPONSES_URL = defaultEndpointOf("zai", "responses");
export const DEFAULT_OPENCODE_CHAT_URL = defaultEndpointOf("opencode");
/** Go subscription tier; Go model ids route here, everything else stays on Zen. */
export const DEFAULT_OPENCODE_GO_CHAT_URL = defaultEndpointOf("opencode", "go");
export const DEFAULT_MIMO_CHAT_URL = defaultEndpointOf("mimo");
export const DEFAULT_EXPERIENTIAL_CHAT_URL = defaultEndpointOf("experiential");

/** Positive endpoint evidence that an Ollama provider request targets Ollama Cloud. */
export function isOllamaCloudEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "ollama.com" || hostname.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

/** Native Ollama API origin: strip a trailing `/v1` — the `/api/*` endpoints
 *  live at that root (localhost:11434/v1 → localhost:11434). */
export function deriveNativeOllamaOrigin(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/v1" || path.endsWith("/v1")) {
      url.pathname = path.slice(0, -3) || "/";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

/** (baseUrl, apiKey) tuple for the Ollama provider — OLLAMA_BASE_URL env >
 *  `ollamaBaseUrl` config > cloud default; the key is optional for a local daemon. */
export function loadOllamaEndpoint(path: string = defaultConfigPath()): ResolvedEndpoint {
  return endpointFor("ollama", "", readConfig(path));
}

import {
  REASONING_EFFORT_ORDER,
  clampReasoningEffort,
  reasoningEffortsFor,
} from "@reasonix/core-utils";
import type {
  EditMode,
  FeedbackCueSettings,
  OllamaGenerationPatch,
  OllamaGenerationSettings,
  ProviderID,
  QuickSend,
  ReasoningEffort,
  StatusBarToggles,
} from "@reasonix/core-utils";
import { expandTilde } from "@reasonix/core-utils/expand-tilde";

/** Single trust dial: read-only blocks every non-readonly tool (write_file / edit_file / multi_edit / run_command) at dispatch; follow auto-approves reads and allowlisted shell but asks for every write and non-allowlisted command; ignore auto-approves everything. */
export type { EditMode, OllamaGenerationPatch, OllamaGenerationSettings, ReasoningEffort };

export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = REASONING_EFFORT_ORDER;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

export type HistoryScrollMode = "auto" | "native" | "app";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: "stdio" | "sse" | "streamable-http";
  /** Claude `.mcp.json` alias for `transport`; `"http"` is treated as `"streamable-http"`. */
  type?: "stdio" | "sse" | "streamable-http" | "http";
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface RateLimitConfig {
  /** Client-side self-throttle in requests/minute — paces outbound chat calls with a min-interval timer. NOT a DeepSeek-enforced limit: DeepSeek's actual cap is concurrency, not RPM (500 for v4-pro, 2500 for v4-flash, account-wide), surfaced as HTTP 429. Set this only to be a polite neighbor on shared infra; single-user CLI rarely needs it. */
  rpm?: number;
}

export interface ProxyConfig {
  /** Proxy URL (e.g. `http://127.0.0.1:7897`, `socks5://host:1080`). Takes precedence over HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars when set, so desktop users on Windows can route through Clash without fighting GUI env-var propagation (issue #1868). */
  url?: string;
  /** Skip proxy detection entirely — equivalent to launching with `--no-proxy`. */
  disabled?: boolean;
  /** Additional NO_PROXY patterns (curl syntax). Additive on top of env NO_PROXY and the default DeepSeek-bypass whitelist. */
  noProxy?: string[];
  /** When false, route api.deepseek.com / *.deepseek.com through the proxy too (issue #1497 — corporate firewalls that block direct egress). Default true preserves the clash/v2ray US-exit-IP 403 fix. Env `REASONIX_PROXY_DEEPSEEK_DIRECT` overrides. */
  bypassDeepSeekDirect?: boolean;
}

/** OpenAI website-account OAuth tokens — set by the settings "Sign in with OpenAI" flow. */
export interface OpenAIOAuthCreds {
  accessToken: string;
  refreshToken: string;
  /** ms epoch — OpenAI access tokens are short-lived; refreshed from refreshToken when within 5 min of expiry. */
  expiresAt: number;
  /** Account email from userinfo — shown masked in settings, never shipped over the bridge. */
  account?: string;
}

/** Google Antigravity OAuth tokens — powers gemini-* models on the Antigravity
 *  quota. `projectId` is the Cloud Code companion project from onboarding. */
export interface AntigravityOAuthCreds {
  accessToken: string;
  refreshToken: string;
  /** OAuth client that issued these tokens. Missing on legacy custom-client credentials. */
  clientId?: string;
  /** ms epoch — Google access tokens are short-lived; refreshed from refreshToken when within 5 min of expiry. */
  expiresAt: number;
  /** Account email from userinfo — shown masked in settings, never shipped over the bridge. */
  account?: string;
  /** Cloud Code companion project id resolved for this account. */
  projectId?: string;
  /** Model ids returned by fetchAvailableModels for this account. */
  models?: string[];
}

/** User-owned Google OAuth client and tokens for the official Gmail MCP server. */
export interface GmailOAuthCreds {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  account?: string;
}

/** OpenCode Console device-flow tokens — set by the settings "Sign in with
 *  OpenCode" flow. The access token authenticates Zen + Go inference, so it
 *  unlocks the paid/subscription model catalog the same way an API key does. */
export interface OpencodeOAuthCreds {
  accessToken: string;
  refreshToken: string;
  /** ms epoch — Console access tokens are short-lived; refreshed from refreshToken when within 5 min of expiry. */
  expiresAt: number;
  /** Account email from the Console `/api/user` endpoint — shown masked in settings, never shipped over the bridge. */
  account?: string;
  /** Active Console organization id — sent as `x-opencode-org-id` on inference
   *  so a session token is scoped to this org (the gateway rejects an unscoped
   *  session token with 401). Unused for static API keys. */
  orgId?: string;
  /** Active Console organization display name. */
  orgName?: string;
  /** Console server origin the tokens were issued by (defaults to opencode.ai/console). */
  server?: string;
}

/** A per-model provider declaration from the `models` config map. */
export interface ModelProviderConfig {
  /** Which provider's endpoint family serves the model id. */
  provider: ModelProvider;
}

export interface ReasonixConfig {
  /** Per-provider persisted settings — catalog id → the setting keys that provider
   *  declares in packages/core-utils/src/providers/*.json. Adding a provider or a
   *  field never edits this interface. */
  providerSettings?: Record<string, Record<string, string>>;
  /** Set by the browser OAuth sign-in; auto-refreshed from refreshToken on expiry. */
  openaiOAuth?: OpenAIOAuthCreds;
  /** Google Antigravity OAuth tokens — set by the "Sign in with Google" flow;
   *  powers gemini-* models on the Antigravity quota. */
  antigravityOAuth?: AntigravityOAuthCreds;
  /** OpenCode Console device-flow tokens — set by the "Sign in with OpenCode"
   *  flow; unlocks the OpenCode Zen/Go paid + subscription model catalog. */
  opencodeOAuth?: OpencodeOAuthCreds;
  /** Selected managed mail integration. Outlook remains the default for existing installs. */
  mailProvider?: MailProvider;
  /** User-owned Google OAuth client and tokens for the official Gmail MCP server. */
  gmailOAuth?: GmailOAuthCreds;
  /** Persisted DeepSeek model id — the dashboard model picker writes through this. */
  model?: string;
  /** Explicit per-model provider mapping — the authority when catalogs and discovery can't place an id.
   *  Example: `{ "gpt-4o-custom": { "provider": "openai" } }`. */
  models?: Record<string, ModelProviderConfig>;
  editMode?: EditMode;
  editModeHintShown?: boolean;
  /** User-defined quick sends (built-ins are code-defined). */
  quickSends?: QuickSend[];
  /** Id of the quick send the composer marks as the default. */
  quickSendId?: string;
  mouseClipboardHintShown?: boolean;
  /** When false, skip the boot splash animation and show the main UI immediately. Default true. */
  banner?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** Per-turn output token cap sent as `max_tokens` in the API request. Undefined/null = no cap. */
  maxOutputTokens?: number | null;
  /** Maximum tool-call iterations per turn. Prevents runaway loops from consuming
   *  unlimited API budget. Default 50. Env `REASONIX_MAX_ITER` overrides. */
  maxIterPerTurn?: number;
  /** Context-window cap in tokens, overriding the per-model default (300K). Clamped to
   *  [128000, 1000000] at load; an explicit value is honored up to that ceiling by
   *  resolveContextTokens, even above the model's default window. */
  contextTokens?: number;
  /** Whether the conversation auto-compacts before a turn once the estimated
   *  request reaches the trigger ratio of the context window. Defaults to true. */
  autoCompact?: boolean;
  /** Fraction of the context window at which auto-compaction fires. Defaults
   *  to 0.8; clamped to [MIN_AUTO_COMPACT_TRIGGER, MAX_AUTO_COMPACT_TRIGGER]. */
  autoCompactTrigger?: number;
  /** Token budget for a duplicated session's retained context (newest-first). Default 50 000. */
  duplicateSessionTokens?: number;
  /** When true, a duplicated session auto-runs one continuation turn. Default false. */
  duplicateSessionAutoProceed?: boolean;
  /** Whether `run_command` may run a command elevated via Windows UAC consent.
   *  Defaults to false: even if the model requests `elevate: true`, the tool
   *  refuses unless the user has pre-authorized the capability. */
  elevationEnabled?: boolean;
  /** Whether the stream repetition / "stuck re-thinking" guard may abort a
   *  degenerating model stream. Defaults to false: out of the box the loop lets
   *  repeated output through, and the guard only runs when the user opts in. */
  repetitionGuardEnabled?: boolean;
  /** Per-type desktop sound/notification cue matrix. Absent = all off
   *  (sounds and notifications stay silent until the user opts in). */
  feedbackCues?: FeedbackCueSettings;
  /** Default workspace root for the desktop client. CLI uses cwd. */
  workspaceDir?: string;
  /** Last N workspace paths the desktop client has opened, most recent first. */
  recentWorkspaces?: string[];
  /** Desktop only — open tabs in tab order, each with its workspace dir, loaded session and focus, persisted so restart restores every tab and its conversation (issues #933, #1244). Empty/absent → boot with a single default tab. */
  desktopOpenTabs?: DesktopOpenTab[];
  theme?: ThemeName | "auto";
  /** Stored as `--mcp`-format strings so one parser handles both flag and config. */
  mcp?: string[];
  /** Names of servers in `mcp` to skip on bridge — each can be toggled in Settings. */
  mcpDisabled?: string[];
  /** Model ids offered by every model picker (composer menus, Settings grid).
   *  Opt-in allow-list — models not listed here are hidden. Global persistent
   *  setting — edited from Settings → Models, stored here. */
  enabledModels?: string[];
  /** Ordered backup models (Settings → Backup models): when the active model's
   *  provider reports an exhausted quota the chat falls over to the first usable
   *  entry here. Empty/absent = no failover. */
  fallbackModels?: string[];
  /** Env overlay per MCP server name (matches the `name=` prefix of the spec). Stdio transports merge this over process.env; SSE/HTTP ignore it. */
  mcpEnv?: Record<string, Record<string, string>>;
  /** Canonical MCP server configuration — merges with and overrides legacy `mcp`/`mcpEnv`/`mcpDisabled`. */
  mcpServers?: Record<string, McpServerConfig>;
  session?: string | null;
  setupCompleted?: boolean;
  questionTimer?: boolean;
  questionTimerEnabled?: boolean;
  search?: boolean;
  /** Web search engine backend: "bing" (default, scrapes cn.bing.com), "bing-intl" (www.bing.com, indexes international sites), "searxng" (self-hosted SearXNG), "metaso" (Metaso API), "baidu" (Baidu AI Search API), "tavily" (LLM-friendly API, free tier), "perplexity" (Perplexity AI), "exa" (Exa API), "brave" (Brave Search API), or "ollama" (Ollama cloud web search). */
  webSearchEngine?: WebSearchEngineName;
  /** Per-engine persisted settings — engine id → the keys that engine declares in
   *  packages/core-utils/src/search-engines/*.json. A shared engine reads its model
   *  provider's entry instead, so one value serves both surfaces. */
  searchSettings?: Record<string, Record<string, string>>;
  /** Ollama cloud API key. Falls back to OLLAMA_API_KEY env var. Used for Ollama web_search/web_fetch and chat when the Ollama provider is a cloud endpoint. */
  ollamaApiKey?: string;
  /** Ollama chat endpoint (OpenAI-compatible). Falls back to OLLAMA_BASE_URL env, then https://ollama.com/v1 (Ollama cloud). Local daemon is keyless; cloud requires ollamaApiKey. */
  ollamaBaseUrl?: string;
  /** Sampling temperature sent to native Ollama chat requests. */
  ollamaTemperature?: number;
  /** Nucleus sampling probability sent as Ollama `top_p`. */
  ollamaTopP?: number;
  /** Minimum token probability relative to the most likely token. */
  ollamaMinP?: number;
  /** Deterministic sampling seed. Unset leaves sampling nondeterministic. */
  ollamaSeed?: number;
  /** Keep-alive sent with every Ollama `/api/chat` request: how long the model
   *  stays loaded after a turn. Defaults to "30m"; "-1" pins it loaded
   *  indefinitely, "0" unloads immediately after each turn. */
  ollamaKeepAlive?: string;
  /** Context window (`num_ctx`) sent with every Ollama `/api/chat` request.
   *  When unset, the window learned from `/api/show` (or the server default)
   *  is used. */
  ollamaNumCtx?: number;
  /** Repeat penalty (`repeat_penalty`) for Ollama models. Higher values (e.g.
   *  1.3-1.5) penalize token repetition more aggressively. Unset lets the
   *  model's Modelfile or server default apply. Env OLLAMA_REPEAT_PENALTY overrides. */
  ollamaRepeatPenalty?: number;
  /** Frequency penalty (`frequency_penalty`) for Ollama models. Penalizes tokens
   *  proportional to how often they've appeared so far. Unset lets the model's
   *  Modelfile or server default apply. Env OLLAMA_FREQUENCY_PENALTY overrides. */
  ollamaFrequencyPenalty?: number;
  /** Presence penalty (`presence_penalty`) for Ollama models. Penalizes tokens
   *  that have appeared at all. Unset lets the model's Modelfile or server default
   *  apply. Env OLLAMA_PRESENCE_PENALTY overrides. */
  ollamaPresencePenalty?: number;
  /** Top-K sampling (`top_k`) for Ollama models. Limits the next-token pool
   *  to the top K candidates. Unset lets the model's Modelfile or server default
   *  apply. Env OLLAMA_TOP_K overrides. */
  ollamaTopK?: number;
  /** Repeat penalty window (`repeat_last_n`) for Ollama models. How many tokens
   *  back to consider for the repeat penalty. Unset lets the model's Modelfile or
   *  server default apply. Env OLLAMA_REPEAT_LAST_N overrides. */
  ollamaRepeatLastN?: number;

  /** TUI mouse-wheel scrolling via SGR mouse tracking. Default true. Set false to fall back to native terminal drag-select for copy (then wheel is terminal-dependent — most terminals translate wheel→arrow in alt-screen, some don't). */
  mouseTracking?: boolean;
  /** Rows scrolled per single SGR mouse-wheel report. Default 1 — most terminals emit 2-5 reports per physical notch, so 1 already produces 2-5 rows per notch (#1419). Bump to 3-5 only if your terminal emits one report per notch and scrolling feels slow (#1494). Clamped to [1, 10]. */
  mouseWheelRows?: number;
  /** Chat-history scrolling: "native" leaves terminal scrollback in charge; "app" captures wheel/PgUp/PgDn/End inside the TUI; "auto" enables app mode for terminals with known jumpy native scrollback. */
  historyScrollMode?: HistoryScrollMode;
  dashboard?: {
    /** Whether the embedded dashboard auto-starts on launch. Default true. Set false to disable without passing --no-dashboard each time. */
    enabled?: boolean;
    /** Pin the embedded dashboard to a fixed port — required for stable SSH tunnels. 0/absent → ephemeral. */
    port?: number;
    /** Bind address (#968). Defaults to 127.0.0.1 (loopback only). Set to 0.0.0.0 / :: / a LAN IP to expose to other devices; the URL token is then the only auth, so keep it secret. */
    host?: string;
    /** Stable URL token (#968). If unset, a fresh token is minted each boot. Min 16 chars enforced at load time. */
    token?: string;
  };
  /** Per-field visibility toggles for the bottom status row. All default to true (visible). */
  statusBar?: StatusBarToggles;
  /** Global auto-approved shell command patterns (e.g. "git *", "npm test"). */
  shellAllowed?: string[];
  /** Global auto-approved outside-sandbox directory prefixes. */
  pathAllowed?: string[];
  /** Global-scope rules: each carries a mode, an effect (allow/ask/deny) and a kind. */
  rules?: StoredRule[];
  projects?: {
    [absoluteRootDir: string]: {
      shellAllowed?: string[];
      /** Project-scoped hooks are arbitrary shell commands; load only after explicit trust. */
      hooksTrusted?: boolean;
      /** Absolute directory prefixes the user pre-approved for outside-sandbox file access (#684). */
      pathAllowed?: string[];
      /** Workspace-scope rules: same shape as the top-level `rules`, scoped to this directory. */
      rules?: StoredRule[];
    };
  };
  /** Issue #259 — user-configurable sensitive-path prefixes and filename patterns.
   *  Commands touching these paths are demoted to the confirm gate even when allowlisted. */
  sensitivePaths?: {
    /** Path prefixes (tilde-relative or absolute) that trigger confirmation. */
    prefixes?: string[];
    /** Glob-style filename patterns (matched against basename, case-insensitive). */
    patterns?: string[];
  };
  skills?: {
    paths?: string[];
  };
  /** Per-skill model override for `runAs: subagent` skills, keyed by skill name. Empty / missing entry → spawn site's default. */
  subagentModels?: Record<string, "flash" | "pro">;
  /** User-declared extensions to the built-in memory types (#709). Unknown types round-trip even without a declaration; declaring one lets you attach a default priority + lifecycle. */
  memory?: {
    customTypes?: CustomMemoryTypeConfig[];
  };
  /** Per-app proxy override. Layered on top of HTTPS_PROXY / NO_PROXY env vars + the default DeepSeek-bypass whitelist. */
  proxy?: ProxyConfig;
  rateLimit?: RateLimitConfig;
  toolRateLimit?: ToolRateLimitConfig;
  filesystem?: {
    /** read_file flips to outline mode for files above this. Default 64 KiB — keeps the cache prefix slim while covering ~99% of source files. Raise to 524288 (512 KiB) for the pre-0.46.0 "trust the cache" behavior. */
    outlineThresholdBytes?: number;
  };
  shellOutput?: {
    /** Enable native semantic shell-output reduction. Defaults to true. */
    filtering?: boolean;
    /** Retain reduction-only telemetry without command text or raw output. Defaults to true. */
    telemetry?: boolean;
    /** Maximum bytes retained for one content-addressed recovery artifact. */
    maxRecoveryBytes?: number;
    /** Maximum number of content-addressed recovery entries retained. */
    maxRecoveryEntries?: number;
    /** Maximum recovery artifact age in days. */
    recoveryDays?: number;
  };
}

export interface CustomMemoryTypeConfig {
  name: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  expires?: "project_end";
}

export interface MemoryTypeRegistryEntry {
  name: string;
  builtin: boolean;
  description?: string;
  priority?: "low" | "medium" | "high";
  expires?: "project_end";
}

const BUILTIN_TYPE_DOCS: Record<string, string> = {
  user: "role / skills / preferences",
  feedback: "corrections or confirmed approaches",
  project: "facts / decisions about the current work",
  reference: "pointers to external systems the user uses",
};

/** Resolve the merged registry of memory types — built-ins, overlaid by anything in `config.memory.customTypes`. */
export function loadMemoryTypeRegistry(
  cfg: ReasonixConfig = readConfig(),
): MemoryTypeRegistryEntry[] {
  const out: MemoryTypeRegistryEntry[] = [];
  for (const name of BUILTIN_MEMORY_TYPES) {
    out.push({ name, builtin: true, description: BUILTIN_TYPE_DOCS[name] });
  }
  const seen = new Set(out.map((e) => e.name));
  for (const raw of cfg.memory?.customTypes ?? []) {
    if (!raw || typeof raw.name !== "string") continue;
    const name = raw.name.trim();
    if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry: MemoryTypeRegistryEntry = { name, builtin: false };
    if (typeof raw.description === "string") entry.description = raw.description;
    if (raw.priority === "low" || raw.priority === "medium" || raw.priority === "high") {
      entry.priority = raw.priority;
    }
    if (raw.expires === "project_end") entry.expires = raw.expires;
    out.push(entry);
  }
  return out;
}

export function memoryTypeDefaults(
  typeName: string,
  cfg: ReasonixConfig = readConfig(),
): { priority?: "low" | "medium" | "high"; expires?: "project_end" } {
  const found = loadMemoryTypeRegistry(cfg).find((e) => e.name === typeName);
  if (!found) return {};
  const out: { priority?: "low" | "medium" | "high"; expires?: "project_end" } = {};
  if (found.priority) out.priority = found.priority;
  if (found.expires) out.expires = found.expires;
  return out;
}

/** Resolve an API key as env-var > config-string > undefined. Shared by the
 *  per-provider `load*ApiKey` wrappers so their precedence can't drift apart. */
function resolveApiKey(
  envVars: readonly string[],
  field: keyof ReasonixConfig,
  path: string,
): string | undefined {
  for (const name of envVars) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  const cfg = readConfig(path)[field];
  return typeof cfg === "string" && cfg.trim() ? cfg.trim() : undefined;
}

export function loadMetasoApiKey(path: string = defaultConfigPath()): string | undefined {
  return loadSearchApiKey("metaso", path);
}

export function loadBaiduApiKey(path: string = defaultConfigPath()): string | undefined {
  return loadSearchApiKey("baidu", path);
}

/** Tavily API key — env > config > undefined. Returning undefined means the caller must error out with a clear "go get one at tavily.com" message; we deliberately ship no default because the free 1000/mo quota wouldn't survive being shared. */
export function loadTavilyApiKey(path: string = defaultConfigPath()): string | undefined {
  return loadSearchApiKey("tavily", path);
}

/** Perplexity API key — env > config > undefined. Get one at https://perplexity.ai/settings/api */
export function loadPerplexityApiKey(path: string = defaultConfigPath()): string | undefined {
  return loadSearchApiKey("perplexity", path);
}

/** Exa API key — env > config > undefined. Free 1000/mo signup at https://exa.ai */
export function loadExaApiKey(path: string = defaultConfigPath()): string | undefined {
  return loadSearchApiKey("exa", path);
}

/** The API key a provider declares in providers.json: env > config > undefined. */
function providerApiKey(provider: ModelProvider, path: string): string | undefined {
  const spec = providerSpec(provider);
  return spec ? providerApiKeyValue(spec, providerContext(readConfig(path))) : undefined;
}

/** Z.AI API key shared by glm-* chat and Z.AI web search: env > config > undefined. */
export function loadZaiApiKey(path: string = defaultConfigPath()): string | undefined {
  return providerApiKey("zai", path);
}

/** OpenCode API key: env > config > undefined; the client falls back to `public`
 *  for free models when unconfigured. */
export function loadOpencodeApiKey(path: string = defaultConfigPath()): string | undefined {
  return providerApiKey("opencode", path);
}

/** Xiaomi MiMo API key: env > config > undefined. */
export function loadMimoApiKey(path: string = defaultConfigPath()): string | undefined {
  return providerApiKey("mimo", path);
}

/** Experiential Labs gateway API key: env > config > undefined. Accepts the
 *  vendor's own `EXPLABS_API_KEY` spelling as an alias for the primary env var. */
export function loadExperientialApiKey(path: string = defaultConfigPath()): string | undefined {
  return providerApiKey("experiential", path);
}

/** (baseUrl, apiKey) tuple for the Experiential Labs gateway; a custom baseUrl
 *  owns its key, so a stale env key never bleeds into a gateway override. */
export function loadExperientialEndpoint(path: string = defaultConfigPath()): ResolvedEndpoint {
  return endpointFor("experiential", "", readConfig(path));
}

/** Stable MiMo sign-in key label — generated once and persisted, so repeated
 *  authorizations reuse the account's existing key rather than provisioning a
 *  new one on every sign-in. */
export function loadMimoKeyName(path: string = defaultConfigPath()): string {
  const existing = loadProviderSetting("mimo", "keyName", path);
  if (existing) return existing;
  const name = `reasonix-${randomBytes(8).toString("hex")}`;
  saveProviderSetting("mimo", "keyName", name, path);
  return name;
}

/** Escape hatch for Xiaomi MiMo: Xiaomi documents reasoning text occasionally
 *  interfering with tool-call extraction, so a tool-bearing request can opt out
 *  of thinking via MIMO_DISABLE_THINKING_WITH_TOOLS. */
export function loadMimoDisableThinkingWithTools(): boolean {
  const v = process.env.MIMO_DISABLE_THINKING_WITH_TOOLS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** MiMo wire protocol: `chat` (default) or `responses` (MIMO_API_PROTOCOL). */
export function loadMimoProtocol(): "chat" | "responses" {
  return process.env.MIMO_API_PROTOCOL?.trim().toLowerCase() === "responses" ? "responses" : "chat";
}

/** True when the user holds a usable OpenCode credential — a non-`public` API
 *  key (env or config) or a Console OAuth session. Gates the paid + Go catalog. */
export function hasOpencodeCredential(path: string = defaultConfigPath()): boolean {
  const key = loadOpencodeApiKey(path);
  if (key && key !== "public") return true;
  return Boolean(readConfig(path).opencodeOAuth?.accessToken);
}

/** Ollama cloud API key: env > config > undefined. */
export function loadOllamaApiKey(path: string = defaultConfigPath()): string | undefined {
  return providerApiKey("ollama", path);
}

const DEFAULT_OLLAMA_GENERATION = {
  keepAlive: "30m",
} as const;

const OLLAMA_NUMBER_SPECS = {
  temperature: { config: "ollamaTemperature", env: "OLLAMA_TEMPERATURE", min: 0, max: 2 },
  topP: { config: "ollamaTopP", env: "OLLAMA_TOP_P", min: 0, max: 1 },
  minP: { config: "ollamaMinP", env: "OLLAMA_MIN_P", min: 0, max: 1 },
  seed: { config: "ollamaSeed", env: "OLLAMA_SEED", min: 0, max: 2_147_483_647, integer: true },
  repeatPenalty: {
    config: "ollamaRepeatPenalty",
    env: "OLLAMA_REPEAT_PENALTY",
    min: 0,
    max: 2,
  },
  frequencyPenalty: {
    config: "ollamaFrequencyPenalty",
    env: "OLLAMA_FREQUENCY_PENALTY",
    min: -2,
    max: 2,
  },
  presencePenalty: {
    config: "ollamaPresencePenalty",
    env: "OLLAMA_PRESENCE_PENALTY",
    min: -2,
    max: 2,
  },
  topK: { config: "ollamaTopK", env: "OLLAMA_TOP_K", min: 0, max: 1_000, integer: true },
  repeatLastN: {
    config: "ollamaRepeatLastN",
    env: "OLLAMA_REPEAT_LAST_N",
    min: -1,
    max: 1_000_000,
    integer: true,
  },
} as const;

type OllamaNumberKey = keyof typeof OLLAMA_NUMBER_SPECS;
type OllamaConfigNumberKey = (typeof OLLAMA_NUMBER_SPECS)[OllamaNumberKey]["config"];

function validOllamaNumber(key: OllamaNumberKey, value: unknown): number | undefined {
  const spec = OLLAMA_NUMBER_SPECS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < spec.min || value > spec.max) return undefined;
  return "integer" in spec && spec.integer ? Math.floor(value) : value;
}

function resolveOllamaNumber(key: OllamaNumberKey, config: ReasonixConfig): number | undefined {
  const spec = OLLAMA_NUMBER_SPECS[key];
  const env = process.env[spec.env]?.trim();
  if (env) {
    const parsed = validOllamaNumber(key, Number(env));
    if (parsed !== undefined) return parsed;
  }
  return validOllamaNumber(key, config[spec.config]);
}

/** Resolve all native Ollama generation options once: environment > config >
 *  Reasonix+ policy default. Sampling options remain absent when unconfigured so
 *  the model's Modelfile or server default can apply. */
export function loadOllamaGenerationSettings(
  path: string = defaultConfigPath(),
): OllamaGenerationSettings {
  const config = readConfig(path);
  const keepAliveEnv = process.env.OLLAMA_KEEP_ALIVE?.trim();
  const keepAliveConfig = config.ollamaKeepAlive?.trim();
  return {
    temperature: resolveOllamaNumber("temperature", config),
    topP: resolveOllamaNumber("topP", config),
    minP: resolveOllamaNumber("minP", config),
    seed: resolveOllamaNumber("seed", config),
    keepAlive: keepAliveEnv || keepAliveConfig || DEFAULT_OLLAMA_GENERATION.keepAlive,
    repeatPenalty: resolveOllamaNumber("repeatPenalty", config),
    frequencyPenalty: resolveOllamaNumber("frequencyPenalty", config),
    presencePenalty: resolveOllamaNumber("presencePenalty", config),
    topK: resolveOllamaNumber("topK", config),
    repeatLastN: resolveOllamaNumber("repeatLastN", config),
  };
}

/** Persist a group of Ollama generation overrides atomically. Null clears an
 *  override. Invalid input is rejected rather than silently clamped. */
export function saveOllamaGenerationPatch(
  patch: OllamaGenerationPatch,
  path: string = defaultConfigPath(),
): void {
  const config = readConfig(path);
  for (const key of Object.keys(OLLAMA_NUMBER_SPECS) as OllamaNumberKey[]) {
    const value = patch[key];
    if (value === undefined) continue;
    const configKey: OllamaConfigNumberKey = OLLAMA_NUMBER_SPECS[key].config;
    if (value === null) {
      delete config[configKey];
      continue;
    }
    const valid = validOllamaNumber(key, value);
    if (valid === undefined) throw new RangeError(`Invalid Ollama ${key} value: ${String(value)}`);
    config[configKey] = valid;
  }
  if (patch.keepAlive !== undefined) {
    if (patch.keepAlive === null) {
      // undefined so JSON.stringify omits the persisted key entirely.
      config.ollamaKeepAlive = undefined;
    } else {
      const value = patch.keepAlive.trim();
      if (!value) throw new RangeError("Ollama keepAlive must not be empty");
      config.ollamaKeepAlive = value;
    }
  }
  writeConfig(config, path);
}

/** Explicit persisted overrides, excluding environment/default resolution. */
export function loadOllamaGenerationOverrides(
  path: string = defaultConfigPath(),
): OllamaGenerationPatch {
  const config = readConfig(path);
  const result: OllamaGenerationPatch = {};
  for (const key of Object.keys(OLLAMA_NUMBER_SPECS) as OllamaNumberKey[]) {
    const value = validOllamaNumber(key, config[OLLAMA_NUMBER_SPECS[key].config]);
    if (value !== undefined) result[key] = value;
  }
  const keepAlive = config.ollamaKeepAlive?.trim();
  if (keepAlive) result.keepAlive = keepAlive;
  return result;
}

/** Ollama keep-alive — env OLLAMA_KEEP_ALIVE > config > "30m" default. */
export function loadOllamaKeepAlive(path: string = defaultConfigPath()): string {
  return loadOllamaGenerationSettings(path).keepAlive;
}

/** Ollama context window (`num_ctx`) — env OLLAMA_NUM_CTX > config > undefined. */
export function loadOllamaNumCtx(path: string = defaultConfigPath()): number | undefined {
  const env = process.env.OLLAMA_NUM_CTX?.trim();
  if (env && /^\d+$/.test(env)) return Number(env);
  const cfg = readConfig(path).ollamaNumCtx;
  if (typeof cfg === "number" && Number.isFinite(cfg) && cfg > 0) return Math.floor(cfg);
  return undefined;
}

/** Compatibility loaders for callers that consume one setting at a time. */
export function loadOllamaRepeatPenalty(path: string = defaultConfigPath()): number | undefined {
  return loadOllamaGenerationSettings(path).repeatPenalty;
}

export function loadOllamaFrequencyPenalty(path: string = defaultConfigPath()): number | undefined {
  return loadOllamaGenerationSettings(path).frequencyPenalty;
}

export function loadOllamaPresencePenalty(path: string = defaultConfigPath()): number | undefined {
  return loadOllamaGenerationSettings(path).presencePenalty;
}

export function loadOllamaTopK(path: string = defaultConfigPath()): number | undefined {
  return loadOllamaGenerationSettings(path).topK;
}

export function loadOllamaRepeatLastN(path: string = defaultConfigPath()): number | undefined {
  return loadOllamaGenerationSettings(path).repeatLastN;
}

/** Brave Search API key — env > config > undefined. Free 2000/mo signup at https://brave.com/search/api/ */
export function loadBraveApiKey(path: string = defaultConfigPath()): string | undefined {
  return loadSearchApiKey("brave", path);
}

export function defaultConfigPath(): string {
  const envConfig = process.env.REASONIX_CONFIG?.trim();
  if (envConfig) return envConfig;
  return join(reasonixHome(), "config.json");
}

const STRING_ARRAY_FIELDS: Array<readonly string[]> = [
  ["mcp"],
  ["mcpDisabled"],
  ["enabledModels"],
  ["fallbackModels"],
  ["recentWorkspaces"],
  ["skills", "paths"],
];

const stringArraySchema = z.array(z.string());

/** Mtime-keyed cache for readConfig (shared, read-only — callers must not mutate).
 *  Caveat: mtime resolution ~1 s; external edits may be missed within that window. */
const _configCache = new Map<string, { mtimeMs: number; cfg: ReasonixConfig }>();

function sanitizeStringArrayField(cfg: Record<string, unknown>, segments: readonly string[]): void {
  if (segments.length === 0) return;
  let parent: Record<string, unknown> = cfg;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    const next = parent[seg];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    parent = next as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1] as string;
  const value = parent[leaf];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    delete parent[leaf];
    return;
  }
  const parsed = stringArraySchema.safeParse(value);
  if (parsed.success) return;
  parent[leaf] = value.filter((x): x is string => typeof x === "string");
}

/** Validate the `models` provider map — drop entries without a valid provider, since a
 *  wrong provider would silently route requests to the wrong endpoint family. */
function sanitizeModelsField(cfg: Record<string, unknown>): void {
  const raw = cfg.models;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    cfg.models = undefined;
    return;
  }
  const cleaned: Record<string, ModelProviderConfig> = {};
  for (const [id, entry] of Object.entries(raw)) {
    const provider = (entry as { provider?: unknown } | null | undefined)?.provider;
    if (isModelProvider(provider)) {
      cleaned[id] = { provider };
    }
  }
  if (Object.keys(cleaned).length > 0) cfg.models = cleaned;
  else cfg.models = undefined;
}

/** Validate Antigravity OAuth models — delegates to `isUsableAntigravityModel`. */
function sanitizeAntigravityOAuthField(cfg: Record<string, unknown>): void {
  const raw = cfg.antigravityOAuth;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const oauth = raw as Record<string, unknown>;
  if (Array.isArray(oauth.models)) {
    oauth.models = oauth.models.filter(
      (m): m is string => typeof m === "string" && isUsableAntigravityModel(m),
    );
  }
}

export function readConfig(path: string = defaultConfigPath()): ReasonixConfig {
  let fd: number | undefined;
  try {
    // Open the file descriptor first, then fstat + read from the same fd.
    // This eliminates the TOCTOU race where statSync sees one mtime but
    // readFileSync reads a different version of the file (CodeQL flagged).
    fd = openSync(path, "r");
    const st = fstatSync(fd);
    const cached = _configCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      closeSync(fd);
      return cached.cfg;
    }
    // Strip the UTF-8 BOM if a foreign writer left one in — Windows
    // PowerShell 5's `Set-Content -Encoding UTF8` and several text
    // editors emit `EF BB BF` at the head of the file. `JSON.parse`
    // refuses BOM-prefixed input and throws, which used to fall
    // through to `return {}` and silently nuke every saved field on
    // the next read-modify-write.
    const raw = readFileSync(fd, "utf8").replace(/^\uFEFF/, "");
    closeSync(fd);
    fd = undefined;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cfg = parsed as Record<string, unknown>;
      for (const segments of STRING_ARRAY_FIELDS) {
        sanitizeStringArrayField(cfg, segments);
      }
      sanitizeModelsField(cfg);
      sanitizeAntigravityOAuthField(cfg);
      migrateProviderSettings(cfg);
      migrateSearchSettings(cfg);
      if (cfg.mailProvider !== MailProvider.Outlook && cfg.mailProvider !== MailProvider.Gmail) {
        // undefined so JSON.stringify omits the persisted key entirely.
        cfg.mailProvider = undefined;
      }
      if (cfg.autoCompact !== undefined && typeof cfg.autoCompact !== "boolean") {
        // Hand-edited JSON can leave a non-boolean; treat it as absent.
        cfg.autoCompact = undefined;
      }
      if (cfg.autoCompactTrigger !== undefined) {
        // Non-number → absent; a number is clamped so display and behavior agree.
        cfg.autoCompactTrigger =
          typeof cfg.autoCompactTrigger === "number"
            ? clampAutoCompactTrigger(cfg.autoCompactTrigger)
            : undefined;
      }
      const result = cfg as ReasonixConfig;
      _configCache.set(path, { mtimeMs: st.mtimeMs, cfg: result });
      return result;
    }
  } catch {
    /* missing or malformed → empty config */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
  return {};
}

export function writeConfig(cfg: ReasonixConfig, path: string = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  // Atomic — write to a sibling tmp then rename. A torn write (process
  // killed mid-write, or another reader catching the file before
  // writeFileSync finished) used to leave a 0-byte or truncated
  // config.json, which readConfig would then parse as `{}` and the next
  // saveX would silently overwrite every other field with that empty
  // baseline (issue #1535).
  const tmp = tmpSiblingPath(path);
  atomicWriteSync(path, JSON.stringify(cfg, null, 2), tmp);
  _configCache.delete(path);
}

export function mcpEnvFor(
  serverName: string | null | undefined,
  cfg: ReasonixConfig,
): Record<string, string> | undefined {
  if (!serverName) return undefined;
  const entry = cfg.mcpEnv?.[serverName];
  if (!entry) return undefined;
  // Coerce to string and drop empty values — JSON config could be sloppy.
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === "string" && v.length > 0) filtered[k] = v;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function inferMcpTransport(cfg: McpServerConfig): "stdio" | "sse" | "streamable-http" {
  // Claude's `.mcp.json` uses `type` and shortens `streamable-http` to `http`.
  const declared = cfg.transport ?? cfg.type;
  if (declared === "http") return "streamable-http";
  if (declared) return declared;
  const url = cfg.url?.trim() ?? "";
  if (/^streamable\+https?:\/\//i.test(url)) return "streamable-http";
  if (/^https?:\/\//i.test(url)) return "sse";
  return "stdio";
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeMcpConfig(cfg: ReasonixConfig, extraLegacy?: string[]): McpServerSpec[] {
  const result: McpServerSpec[] = [];
  const seen = new Set<string>();

  // 1. Legacy specs first.
  const disabledFromLegacy = new Set(cfg.mcpDisabled ?? []);
  const legacySpecs = extraLegacy && extraLegacy.length > 0 ? extraLegacy : (cfg.mcp ?? []);
  for (const raw of legacySpecs) {
    if (typeof raw !== "string") continue;
    try {
      const spec = parseMcpSpec(raw);
      const env = spec.name ? normalizeStringRecord(cfg.mcpEnv?.[spec.name]) : undefined;
      const disabled = spec.name ? disabledFromLegacy.has(spec.name) : false;
      result.push(spec.transport === "stdio" ? { ...spec, env, disabled } : { ...spec, disabled });
      if (spec.name) seen.add(spec.name);
    } catch {
      /* skip invalid legacy specs */
    }
  }

  // 2. mcpServers objects override on name conflict.
  const upsertSpec = (name: string, spec: McpServerSpec): void => {
    if (seen.has(name)) {
      const idx = result.findIndex((s) => s.name === name);
      if (idx >= 0) result[idx] = spec;
    } else {
      seen.add(name);
      result.push(spec);
    }
  };
  for (const [name, serverCfg] of Object.entries(cfg.mcpServers ?? {})) {
    if (!serverCfg || typeof serverCfg !== "object") continue;
    const transport = inferMcpTransport(serverCfg as McpServerConfig);
    const disabled = (serverCfg as McpServerConfig).disabled === true;
    if (transport === "stdio") {
      const env = normalizeStringRecord((serverCfg as McpServerConfig).env);
      const spec: McpServerSpec = {
        transport: "stdio",
        name,
        command: (serverCfg as McpServerConfig).command ?? "",
        args: (serverCfg as McpServerConfig).args ?? [],
        env,
        disabled,
      };
      upsertSpec(name, spec);
    } else {
      let url = (serverCfg as McpServerConfig).url ?? "";
      const streamMatch = /^streamable\+(https?:\/\/.+)$/i.exec(url);
      if (streamMatch) url = streamMatch[1]!;
      const headers = normalizeStringRecord((serverCfg as McpServerConfig).headers);
      if (transport === "sse") {
        const spec: McpServerSpec = {
          transport: "sse",
          name,
          url,
          headers,
          disabled,
        };
        upsertSpec(name, spec);
      } else {
        const spec: McpServerSpec = {
          transport: "streamable-http",
          name,
          url,
          headers,
          disabled,
        };
        upsertSpec(name, spec);
      }
    }
  }

  return result;
}

/** Ensure `mcpServers[name]` exists — migrate a legacy `mcp` spec-string entry into an
 *  object entry (carrying its `mcpEnv` overlay; one-way, spec strings can't hold toggle
 *  state). No-op for absent names so toggles only target configured servers. */
export function ensureMcpServersEntry(cfg: ReasonixConfig, name: string): void {
  if (cfg.mcpServers?.[name]) return;
  const raw = (cfg.mcp ?? []).find((s) => {
    try {
      return parseMcpSpec(s).name === name;
    } catch {
      return false;
    }
  });
  if (!raw) return;
  const parsed = parseMcpSpec(raw);
  const entry: McpServerConfig = {};
  if (parsed.transport === "stdio") {
    entry.transport = "stdio";
    entry.command = parsed.command;
    entry.args = [...parsed.args];
  } else {
    entry.transport = parsed.transport;
    entry.url = parsed.url;
  }
  const envOverlay = cfg.mcpEnv?.[name];
  if (envOverlay) entry.env = { ...envOverlay };
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: entry };
  if (raw) {
    const rest = (cfg.mcp ?? []).filter((s) => s !== raw);
    if (rest.length > 0) cfg.mcp = rest;
    else cfg.mcp = undefined;
  }
  if (envOverlay) {
    const rest = { ...(cfg.mcpEnv ?? {}) };
    delete rest[name];
    if (Object.keys(rest).length > 0) cfg.mcpEnv = rest;
    else cfg.mcpEnv = undefined;
  }
}

/** Create-or-merge an `mcpServers[name]` entry (legacy spec-string entries migrate
 *  first). Existing entries: scalar fields fill gaps only, only MISSING `--`-prefixed
 *  args are appended — user args (incl. pinned package ids) are never touched. */
export function mergeMcpServerEntry(
  cfg: ReasonixConfig,
  name: string,
  partial: McpServerConfig,
): void {
  ensureMcpServersEntry(cfg, name);
  const existing = cfg.mcpServers?.[name];
  if (!existing) {
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: { ...partial } };
    return;
  }
  const merged: McpServerConfig = { ...existing };
  if (merged.transport === undefined && partial.transport) merged.transport = partial.transport;
  if (merged.type === undefined && partial.type) merged.type = partial.type;
  if (merged.command === undefined && partial.command) merged.command = partial.command;
  if (merged.url === undefined && partial.url) merged.url = partial.url;
  if (partial.env) {
    // Per-key fill — a stored env var (e.g. a relay token) is never clobbered
    // by a re-merge; explicit writes handle rotation.
    merged.env = { ...partial.env, ...(merged.env ?? {}) };
  }
  if (partial.headers) {
    merged.headers = { ...partial.headers, ...(merged.headers ?? {}) };
  }
  const extraFlags = (partial.args ?? []).filter(
    (a) => a.startsWith("--") && !(merged.args ?? []).includes(a),
  );
  if (extraFlags.length > 0) merged.args = [...(merged.args ?? []), ...extraFlags];
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: merged };
}

/** Toggle a server on/off — persists `mcpServers[name].disabled` (migrating
 *  legacy spec-string entries on first toggle). Returns false for unknown names. */
export function setMcpServerDisabled(
  cfg: ReasonixConfig,
  name: string,
  disabled: boolean,
): boolean {
  ensureMcpServersEntry(cfg, name);
  const entry = cfg.mcpServers?.[name];
  if (!entry) return false;
  if (disabled) entry.disabled = true;
  else entry.disabled = undefined;
  return true;
}

/** Load effective MCP server specs from global config and optional workspace `.mcp.json`. */
export function loadEffectiveMcpConfig(
  projectRoot?: string,
  configPath: string = defaultConfigPath(),
  extraLegacy?: string[],
): McpServerSpec[] {
  const cfg = readConfig(configPath);
  const project = projectRoot ? loadDotMcpJson(projectRoot) : undefined;
  const merged: ReasonixConfig = project
    ? { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), ...project } }
    : cfg;
  return normalizeMcpConfig(merged, extraLegacy);
}

export interface ResolvedEndpoint {
  baseUrl: string | undefined;
  apiKey: string | undefined;
}

export interface ResolvedModelEndpoint extends ResolvedEndpoint {
  provider: ModelProvider;
  /** Deployment classification derived from the resolved endpoint, never the model id. */
  deployment: "cloud" | "local" | "custom";
}

// DEEPSEEK_BASE_URL is the original name; DEEPSEEK_API_BASE_URL is accepted as an
// alias so users who copy the OPENAI_BASE_URL pattern land on a working name (#1876).
export function resolveBaseUrlEnv(): string | undefined {
  return process.env.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_API_BASE_URL || undefined;
}

// (baseUrl, apiKey) is a tuple: whichever source defines baseUrl owns apiKey too,
// so a stale env DEEPSEEK_API_KEY doesn't bleed into a custom config baseUrl (#1631).
export function loadEndpoint(path: string = defaultConfigPath()): ResolvedEndpoint {
  return endpointFor("deepseek", "", readConfig(path));
}

/** Resolve provider and deployment metadata alongside its endpoint tuple. */
export function loadResolvedModelEndpoint(
  model: string,
  path: string = defaultConfigPath(),
): ResolvedModelEndpoint {
  const provider = providerForModel(model, path);
  const endpoint = loadEndpointForModel(model, path);
  // Only a provider with a keyless local mode distinguishes cloud/local/custom.
  const deployment = providerSpec(provider)?.usable.keylessLocal
    ? isOllamaCloudEndpoint(endpoint.baseUrl)
      ? "cloud"
      : endpoint.apiKey
        ? "custom"
        : "local"
    : "custom";
  return { ...endpoint, provider, deployment };
}

/** Endpoint tuple per model, resolved from the provider's registry entry: env
 *  override, then config override, then the declared default. */
export function loadEndpointForModel(
  model: string,
  path: string = defaultConfigPath(),
): ResolvedEndpoint {
  const cfg = readConfig(path);
  return endpointFor(resolveModelAdmission(model, path, cfg).provider, model, cfg);
}

/** True when an OpenAI model hits the provider's declared default endpoint (not a
 *  proxy), so OAuth + the Codex backend transport are applicable. */
export function isOpenAIStandardEndpoint(model: string, path?: string): boolean {
  if (providerForModel(model, path) !== "openai") return false;
  return loadEndpointForModel(model, path).baseUrl === providerDefaultEndpoint("openai");
}

/** Endpoint tuple for any catalog entry, routable or catalog-only — discovery
 *  uses it so a new provider needs no new special case. */
export function loadCatalogEndpoint(
  catalogId: string,
  path: string = defaultConfigPath(),
): ResolvedEndpoint {
  const spec = providerSpec(catalogId);
  // An undeclared catalog entry resolves to nothing instead of throwing.
  if (!spec) return { baseUrl: undefined, apiKey: undefined };
  return resolveProviderEndpoint(spec, providerContext(readConfig(path)));
}

/** Every provider's resolved API key, keyed by catalog id. Settings display and
 *  diagnostics read this instead of one loader per provider. */
export function loadProviderApiKeys(
  path: string = defaultConfigPath(),
): Record<string, string | undefined> {
  const context = providerContext(readConfig(path));
  const out: Record<string, string | undefined> = {};
  for (const spec of PROVIDER_SPECS) {
    if (!spec.credentials.apiKeySetting) continue;
    out[spec.id] = providerApiKeyValue(spec, context) ?? undefined;
  }
  return out;
}

export function loadApiKey(path: string = defaultConfigPath()): string | undefined {
  return loadEndpoint(path).apiKey;
}

/** True when the user has ANY usable provider credential (DeepSeek, OpenAI, or
 *  explicit Ollama) — used by the desktop setup gate so a ChatGPT/Ollama-only
 *  install isn't soft-locked behind a DeepSeek key. */
export function anyProviderConfigured(path: string = defaultConfigPath()): boolean {
  const context = providerContext(readConfig(path));
  return ROUTABLE_PROVIDER_SPECS.some((spec) => providerCountsAsConfigured(spec, context));
}

/** Whether `model` can run right now: its provider has a credential in config/env,
 *  or it is a keyless local daemon. Shared by the desktop's per-turn gate and
 *  every quota-failover path, so none can disagree about a backup. */
export function modelUsableFor(model: string, path: string = defaultConfigPath()): boolean {
  const provider = providerForModel(model, path);
  const cfg = readConfig(path);
  const spec = providerSpec(provider);
  if (!spec) return false;
  return providerUsable(spec, {
    ...providerContext(cfg),
    endpoint: endpointFor(provider, model, cfg),
  });
}

export function loadBaseUrl(path: string = defaultConfigPath()): string | undefined {
  return loadEndpoint(path).baseUrl;
}

// Mirrors the resolved tuple into env so subprocess constructions see the same pair.
export function bridgeEndpointEnv(path: string = defaultConfigPath()): void {
  const ep = loadEndpoint(path);
  if (ep.apiKey) process.env.DEEPSEEK_API_KEY = ep.apiKey;
  if (ep.baseUrl) process.env.DEEPSEEK_BASE_URL = ep.baseUrl;
}

export function loadProxyConfig(path: string = defaultConfigPath()): ProxyConfig {
  const cfg = readConfig(path).proxy;
  if (!cfg || typeof cfg !== "object") return {};
  const out: ProxyConfig = {};
  if (typeof cfg.url === "string" && cfg.url.trim() !== "") out.url = cfg.url.trim();
  if (cfg.disabled === true) out.disabled = true;
  if (Array.isArray(cfg.noProxy)) {
    const entries = cfg.noProxy.filter(
      (p): p is string => typeof p === "string" && p.trim() !== "",
    );
    if (entries.length > 0) out.noProxy = entries;
  }
  if (typeof cfg.bypassDeepSeekDirect === "boolean") {
    out.bypassDeepSeekDirect = cfg.bypassDeepSeekDirect;
  }
  return out;
}

export function loadRateLimit(path: string = defaultConfigPath()): RateLimitConfig | undefined {
  const rpm = readConfig(path).rateLimit?.rpm;
  if (typeof rpm !== "number" || !Number.isInteger(rpm) || rpm <= 0) return undefined;
  return { rpm };
}

export function loadMouseWheelRows(path: string = defaultConfigPath()): number | undefined {
  const raw = readConfig(path).mouseWheelRows;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return undefined;
  return Math.min(raw, 10);
}

export function loadToolRateLimit(
  path: string = defaultConfigPath(),
): false | NormalizedToolRateLimitConfig {
  return normalizeToolRateLimitConfig(readConfig(path).toolRateLimit);
}

export function saveBaseUrl(url: string, path: string = defaultConfigPath()): void {
  saveProviderSetting("deepseek", "baseUrl", url, path);
}

export interface SkillPathEntry {
  raw: string;
  resolved: string;
}

export function resolveSkillPath(raw: string, baseDir: string): string {
  const homeExpanded = expandCurrentUserHome(raw.trim());
  return resolve(isAbsolute(homeExpanded) ? homeExpanded : join(baseDir, homeExpanded));
}

export function normalizeSkillPathEntries(
  paths: readonly unknown[],
  baseDir: string,
): SkillPathEntry[] {
  const out: SkillPathEntry[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    if (typeof value !== "string") continue;
    const raw = value.trim();
    if (!raw) continue;
    const resolved = resolveSkillPath(raw, baseDir);
    const key = skillPathKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, resolved });
  }
  return out;
}

export function normalizeSkillPaths(paths: readonly unknown[], baseDir: string): string[] {
  return normalizeSkillPathEntries(paths, baseDir).map((entry) => entry.raw);
}

export function resolveSkillPaths(paths: readonly unknown[], baseDir: string): string[] {
  return normalizeSkillPathEntries(paths, baseDir).map((entry) => entry.resolved);
}

function skillPathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function expandCurrentUserHome(path: string): string {
  return expandTilde(path);
}

export function loadSkillPaths(
  baseDir: string = process.cwd(),
  path: string = defaultConfigPath(),
): string[] {
  const raw = readConfig(path).skills?.paths;
  return Array.isArray(raw) ? normalizeSkillPaths(raw, baseDir) : [];
}

export function loadResolvedSkillPaths(
  baseDir: string = process.cwd(),
  path: string = defaultConfigPath(),
): string[] {
  const raw = readConfig(path).skills?.paths;
  return Array.isArray(raw) ? resolveSkillPaths(raw, baseDir) : [];
}

export function saveSkillPaths(
  paths: readonly unknown[],
  baseDir: string = process.cwd(),
  path: string = defaultConfigPath(),
): string[] {
  const cfg = readConfig(path);
  const normalized = normalizeSkillPaths(paths, baseDir);
  cfg.skills = { ...(cfg.skills ?? {}), paths: normalized };
  writeConfig(cfg, path);
  return normalized;
}

export function loadSubagentModels(
  path: string = defaultConfigPath(),
): Record<string, "flash" | "pro"> {
  const raw = readConfig(path).subagentModels;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, "flash" | "pro"> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === "flash" || value === "pro") out[name] = value;
  }
  return out;
}

export function saveSubagentModels(
  map: Record<string, "flash" | "pro">,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  const out: Record<string, "flash" | "pro"> = {};
  for (const [name, value] of Object.entries(map)) {
    if (value === "flash" || value === "pro") out[name] = value;
  }
  cfg.subagentModels = Object.keys(out).length > 0 ? out : undefined;
  writeConfig(cfg, path);
}

export function addSkillPath(
  skillPath: string,
  baseDir: string = process.cwd(),
  path: string = defaultConfigPath(),
): { added: boolean; path: string; resolved: string; paths: string[] } | { error: string } {
  const entry = normalizeSkillPathEntries([skillPath], baseDir)[0];
  if (!entry) return { error: "skill path is empty" };
  const existing = loadSkillPaths(baseDir, path);
  const seen = new Set(resolveSkillPaths(existing, baseDir).map(skillPathKey));
  const key = skillPathKey(entry.resolved);
  if (seen.has(key))
    return { added: false, path: entry.raw, resolved: entry.resolved, paths: existing };
  const paths = saveSkillPaths([...existing, entry.raw], baseDir, path);
  return { added: true, path: entry.raw, resolved: entry.resolved, paths };
}

export function removeSkillPath(
  target: string,
  baseDir: string = process.cwd(),
  path: string = defaultConfigPath(),
): { removed: boolean; path?: string; resolved?: string; paths: string[] } {
  const existing = loadSkillPaths(baseDir, path);
  const trimmed = target.trim();
  if (!trimmed) return { removed: false, paths: existing };
  const existingEntries = normalizeSkillPathEntries(existing, baseDir);
  const idx = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) - 1 : -1;
  let removeAt = idx >= 0 && idx < existing.length ? idx : -1;
  if (removeAt < 0) {
    const targetEntry = normalizeSkillPathEntries([trimmed], baseDir)[0];
    const targetKey = targetEntry ? skillPathKey(targetEntry.resolved) : undefined;
    removeAt = existingEntries.findIndex(
      (entry) =>
        entry.raw === trimmed ||
        (targetKey !== undefined && skillPathKey(entry.resolved) === targetKey),
    );
  }
  if (removeAt < 0) return { removed: false, paths: existing };
  const removed = existingEntries[removeAt];
  const paths = saveSkillPaths(
    existing.filter((_, i) => i !== removeAt),
    baseDir,
    path,
  );
  return {
    removed: true,
    path: removed?.raw ?? existing[removeAt],
    resolved: removed?.resolved,
    paths,
  };
}

export function searchEnabled(path: string = defaultConfigPath()): boolean {
  const env = process.env.REASONIX_SEARCH;
  if (env === "off" || env === "false" || env === "0") return false;
  const cfg = readConfig(path).search;
  if (cfg === false) return false;
  return true;
}

export function webSearchEngine(
  path: string = defaultConfigPath(),
): WebSearchEngineName | undefined {
  const cfg = readConfig(path).webSearchEngine;
  // Widened on purpose: with no engine files the generated tuple has no members, and
  // calling `includes`/index on an empty tuple narrows the argument to `never`.
  const known: readonly string[] = WEB_SEARCH_ENGINE_NAMES;
  if (cfg && known.includes(cfg)) return cfg as WebSearchEngineName;
  // Any other value (including legacy "mojeek" from configs predating the engine
  // swap) falls through. With no engine files there is no default: callers show their
  // empty state rather than searching a phantom backend. Read-only, never rewritten.
  return known[0] as WebSearchEngineName | undefined;
}

export function webSearchEndpoint(path: string = defaultConfigPath()): string {
  return loadSearchSetting("searxng", "endpoint", path) ?? "http://localhost:8080";
}

export function saveApiKey(key: string, path: string = defaultConfigPath()): void {
  const trimmed = key.trim();
  saveProviderSetting("deepseek", "apiKey", trimmed, path);
  // A stale process env (User-level Windows env, `.env`, shell rc) shadows config in
  // loadEndpoint's fallback branch — an explicit UI save must win for the current run.
  if (trimmed) process.env.DEEPSEEK_API_KEY = trimmed;
  // biome-ignore lint/performance/noDelete: undefined-assign leaks the string "undefined" into process.env
  else delete process.env.DEEPSEEK_API_KEY;
}

export function saveOpenAIApiKey(key: string, path: string = defaultConfigPath()): void {
  const trimmed = key.trim();
  saveProviderSetting("openai", "apiKey", trimmed, path);
  // biome-ignore lint/performance/noDelete: undefined-assign leaks the string "undefined" into process.env
  if (!trimmed) delete process.env.OPENAI_API_KEY;
}

export function saveOpenAIOAuth(creds: OpenAIOAuthCreds, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.openaiOAuth = creds;
  writeConfig(cfg, path);
}

export function clearOpenAIOAuth(path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  if (!cfg.openaiOAuth) return;
  const { openaiOAuth: _drop, ...rest } = cfg;
  writeConfig(rest, path);
}

export function saveAntigravityOAuth(
  creds: AntigravityOAuthCreds,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  const models = creds.models?.filter(isUsableAntigravityModel);
  cfg.antigravityOAuth = {
    ...creds,
    ...(models !== undefined ? { models } : {}),
  };
  writeConfig(cfg, path);
}

export function clearAntigravityOAuth(path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  if (!cfg.antigravityOAuth) return;
  const { antigravityOAuth: _drop, ...rest } = cfg;
  writeConfig(rest, path);
}

export function saveOpencodeOAuth(
  creds: OpencodeOAuthCreds,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  cfg.opencodeOAuth = creds;
  writeConfig(cfg, path);
}

export function clearOpencodeOAuth(path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  if (!cfg.opencodeOAuth) return;
  const { opencodeOAuth: _drop, ...rest } = cfg;
  writeConfig(rest, path);
}

/** Persist the inference key issued by MiMo browser authorization (an API key,
 *  not an OAuth token). Records the base URL the flow returned, when present. */
export function saveMimoCredential(
  cred: { apiKey: string; baseUrl?: string },
  path: string = defaultConfigPath(),
): void {
  saveProviderSetting("mimo", "apiKey", cred.apiKey, path);
  if (cred.baseUrl) saveProviderSetting("mimo", "baseUrl", cred.baseUrl, path);
}

/** Sign-out drops the stored MiMo inference key (does not revoke it upstream). */
export function clearMimoApiKey(path: string = defaultConfigPath()): void {
  saveProviderSetting("mimo", "apiKey", null, path);
}

export function saveMailProvider(provider: MailProvider, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.mailProvider = provider;
  writeConfig(cfg, path);
}

export function saveGmailOAuth(creds: GmailOAuthCreds, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.gmailOAuth = creds;
  writeConfig(cfg, path);
}

export function clearGmailOAuth(path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  if (!cfg.gmailOAuth) return;
  const { gmailOAuth: _drop, ...rest } = cfg;
  writeConfig(rest, path);
}

/** Windows: case-insensitive — NTFS treats `F:\Foo` and `f:\foo` as one directory (#402). */
function findProjectKey(cfg: ReasonixConfig, rootDir: string): string | undefined {
  const projects = cfg.projects;
  if (!projects) return undefined;
  if (Object.hasOwn(projects, rootDir)) return rootDir;
  if (process.platform !== "win32") return undefined;
  const lower = rootDir.toLowerCase();
  for (const k of Object.keys(projects)) {
    if (k.toLowerCase() === lower) return k;
  }
  return undefined;
}

type AllowListField = "shellAllowed" | "pathAllowed";

/** Add `prefix` (trimmed, deduped) through a list accessor; true when the list changed. */
function listAdd(get: () => string[], set: (next: string[]) => void, prefix: string): boolean {
  const trimmed = prefix.trim();
  if (!trimmed) return false;
  const existing = get();
  if (existing.includes(trimmed)) return false;
  set([...existing, trimmed]);
  return true;
}

/** Remove an exact `prefix` (trimmed) through a list accessor; true when the list changed. */
function listRemove(get: () => string[], set: (next: string[]) => void, prefix: string): boolean {
  const trimmed = prefix.trim();
  if (!trimmed) return false;
  const existing = get();
  if (!existing.includes(trimmed)) return false;
  set(existing.filter((p) => p !== trimmed));
  return true;
}

/** Clear a list accessor, returning the prior count (0 = nothing to write). */
function listClear(get: () => string[], set: (next: string[]) => void): number {
  const existing = get();
  if (existing.length === 0) return 0;
  set([]);
  return existing.length;
}

/** Accessor over a top-level allow-list field on the config. */
function globalListAccessor(
  cfg: ReasonixConfig,
  field: AllowListField,
): { get: () => string[]; set: (next: string[]) => void } {
  return {
    get: () => cfg[field] ?? [],
    set: (next) => {
      cfg[field] = next;
    },
  };
}

/** Accessor over a per-project allow-list field; `set` materializes the project entry. */
function projectListAccessor(
  cfg: ReasonixConfig,
  key: string,
  field: AllowListField,
): { get: () => string[]; set: (next: string[]) => void } {
  return {
    get: () => cfg.projects?.[key]?.[field] ?? [],
    set: (next) => {
      if (!cfg.projects) cfg.projects = {};
      if (!cfg.projects[key]) cfg.projects[key] = {};
      cfg.projects[key][field] = next;
    },
  };
}

export function loadProjectShellAllowed(
  rootDir: string,
  path: string = defaultConfigPath(),
): string[] {
  const cfg = readConfig(path);
  const key = findProjectKey(cfg, rootDir);
  return key === undefined ? [] : projectListAccessor(cfg, key, "shellAllowed").get();
}

export function addProjectShellAllowed(
  rootDir: string,
  prefix: string,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  const acc = projectListAccessor(cfg, findProjectKey(cfg, rootDir) ?? rootDir, "shellAllowed");
  if (listAdd(acc.get, acc.set, prefix)) writeConfig(cfg, path);
}

/** Match is exact after trim — NOT prefix-match: removing `git` MUST NOT drop `git push origin main`. */
export function removeProjectShellAllowed(
  rootDir: string,
  prefix: string,
  path: string = defaultConfigPath(),
): boolean {
  const cfg = readConfig(path);
  const key = findProjectKey(cfg, rootDir);
  if (key === undefined) return false;
  const acc = projectListAccessor(cfg, key, "shellAllowed");
  if (!listRemove(acc.get, acc.set, prefix)) return false;
  writeConfig(cfg, path);
  return true;
}

export function clearProjectShellAllowed(
  rootDir: string,
  path: string = defaultConfigPath(),
): number {
  const cfg = readConfig(path);
  const key = findProjectKey(cfg, rootDir);
  if (key === undefined) return 0;
  const acc = projectListAccessor(cfg, key, "shellAllowed");
  const removed = listClear(acc.get, acc.set);
  if (removed === 0) return 0;
  writeConfig(cfg, path);
  return removed;
}

export function projectHooksTrusted(rootDir: string, path: string = defaultConfigPath()): boolean {
  const cfg = readConfig(path);
  const key = findProjectKey(cfg, rootDir);
  return key !== undefined && cfg.projects?.[key]?.hooksTrusted === true;
}

export function trustProjectHooks(rootDir: string, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  if (!cfg.projects) cfg.projects = {};
  const key = findProjectKey(cfg, rootDir) ?? rootDir;
  if (!cfg.projects[key]) cfg.projects[key] = {};
  if (cfg.projects[key].hooksTrusted === true) return;
  cfg.projects[key].hooksTrusted = true;
  writeConfig(cfg, path);
}

export function loadProjectPathAllowed(
  rootDir: string,
  path: string = defaultConfigPath(),
): string[] {
  const cfg = readConfig(path);
  const key = findProjectKey(cfg, rootDir);
  return key === undefined ? [] : projectListAccessor(cfg, key, "pathAllowed").get();
}

export function addProjectPathAllowed(
  rootDir: string,
  prefix: string,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  const acc = projectListAccessor(cfg, findProjectKey(cfg, rootDir) ?? rootDir, "pathAllowed");
  if (listAdd(acc.get, acc.set, prefix)) writeConfig(cfg, path);
}

export function removeProjectPathAllowed(
  rootDir: string,
  prefix: string,
  path: string = defaultConfigPath(),
): boolean {
  const cfg = readConfig(path);
  const key = findProjectKey(cfg, rootDir);
  if (key === undefined) return false;
  const acc = projectListAccessor(cfg, key, "pathAllowed");
  if (!listRemove(acc.get, acc.set, prefix)) return false;
  writeConfig(cfg, path);
  return true;
}

export function clearProjectPathAllowed(
  rootDir: string,
  path: string = defaultConfigPath(),
): number {
  const cfg = readConfig(path);
  const key = findProjectKey(cfg, rootDir);
  if (key === undefined) return 0;
  const acc = projectListAccessor(cfg, key, "pathAllowed");
  const removed = listClear(acc.get, acc.set);
  if (removed === 0) return 0;
  writeConfig(cfg, path);
  return removed;
}

export function loadGlobalShellAllowed(path: string = defaultConfigPath()): string[] {
  return globalListAccessor(readConfig(path), "shellAllowed").get();
}

export function addGlobalShellAllowed(prefix: string, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  const acc = globalListAccessor(cfg, "shellAllowed");
  if (listAdd(acc.get, acc.set, prefix)) writeConfig(cfg, path);
}

export function removeGlobalShellAllowed(
  prefix: string,
  path: string = defaultConfigPath(),
): boolean {
  const cfg = readConfig(path);
  const acc = globalListAccessor(cfg, "shellAllowed");
  if (!listRemove(acc.get, acc.set, prefix)) return false;
  writeConfig(cfg, path);
  return true;
}

export function clearGlobalShellAllowed(path: string = defaultConfigPath()): number {
  const cfg = readConfig(path);
  const acc = globalListAccessor(cfg, "shellAllowed");
  const removed = listClear(acc.get, acc.set);
  if (removed === 0) return 0;
  writeConfig(cfg, path);
  return removed;
}

export function loadGlobalPathAllowed(path: string = defaultConfigPath()): string[] {
  return globalListAccessor(readConfig(path), "pathAllowed").get();
}

export function addGlobalPathAllowed(prefix: string, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  const acc = globalListAccessor(cfg, "pathAllowed");
  if (listAdd(acc.get, acc.set, prefix)) writeConfig(cfg, path);
}

export function removeGlobalPathAllowed(
  prefix: string,
  path: string = defaultConfigPath(),
): boolean {
  const cfg = readConfig(path);
  const acc = globalListAccessor(cfg, "pathAllowed");
  if (!listRemove(acc.get, acc.set, prefix)) return false;
  writeConfig(cfg, path);
  return true;
}

export function clearGlobalPathAllowed(path: string = defaultConfigPath()): number {
  const cfg = readConfig(path);
  const acc = globalListAccessor(cfg, "pathAllowed");
  const removed = listClear(acc.get, acc.set);
  if (removed === 0) return 0;
  writeConfig(cfg, path);
  return removed;
}

/** Merged view of global and project-specific auto-approved shell command patterns. */
export function loadAllShellAllowed(
  rootDir?: string,
  path: string = defaultConfigPath(),
): string[] {
  const globalRules = loadGlobalShellAllowed(path);
  if (!rootDir) return globalRules;
  const projectRules = loadProjectShellAllowed(rootDir, path);
  const set = new Set([...globalRules, ...projectRules]);
  return Array.from(set);
}

/** Merged view of global and project-specific auto-approved outside-sandbox directory prefixes. */
export function loadAllPathAllowed(rootDir?: string, path: string = defaultConfigPath()): string[] {
  const globalRules = loadGlobalPathAllowed(path);
  if (!rootDir) return globalRules;
  const projectRules = loadProjectPathAllowed(rootDir, path);
  const set = new Set([...globalRules, ...projectRules]);
  return Array.from(set);
}

export type RuleMode = "follow" | "never-ask";
export type RuleEffect = "allow" | "ask" | "deny" | "ignore";
export type RuleKind = "shell" | "path";
export type RuleScope = "workspace" | "global";

/** A rule as stored. Its scope is implied by where it lives: top-level means global. */
export interface StoredRule {
  mode: RuleMode;
  effect: RuleEffect;
  kind: RuleKind;
  pattern: string;
  match?: "pattern" | "regex";
}

/** A rule as the UI and the wire see it, with the scope named explicitly. */
export interface ScopedRule extends StoredRule {
  scope: RuleScope;
}

const ruleKey = (r: ScopedRule): string =>
  `${r.mode}\u0000${r.effect}\u0000${r.kind}\u0000${r.scope}\u0000${r.match ?? "pattern"}\u0000${r.pattern}`;

/** The pre-structured allow lists, read as Follow allow rules so existing configs keep working. */
function legacyAllowRules(cfg: ReasonixConfig, rootDir: string | undefined): ScopedRule[] {
  const out: ScopedRule[] = [];
  const take = (scope: RuleScope, kind: RuleKind, patterns: readonly string[] | undefined) => {
    for (const pattern of patterns ?? [])
      out.push({ mode: "follow", effect: "allow", kind, scope, pattern });
  };
  take("global", "shell", cfg.shellAllowed);
  take("global", "path", cfg.pathAllowed);
  if (rootDir) {
    const project = cfg.projects?.[findProjectKey(cfg, rootDir) ?? rootDir];
    take("workspace", "shell", project?.shellAllowed);
    take("workspace", "path", project?.pathAllowed);
  }
  return out;
}

/** Every rule in force for a workspace: global + that workspace's own, plus legacy allow lists. */
export function loadRules(rootDir?: string, path: string = defaultConfigPath()): ScopedRule[] {
  const cfg = readConfig(path);
  const globalRules: ScopedRule[] = (cfg.rules ?? []).map((r) => ({ ...r, scope: "global" }));
  const workspaceRules: ScopedRule[] = rootDir
    ? (cfg.projects?.[findProjectKey(cfg, rootDir) ?? rootDir]?.rules ?? []).map((r) => ({
        ...r,
        scope: "workspace",
      }))
    : [];
  const seen = new Set<string>();
  const merged: ScopedRule[] = [];
  for (const rule of [...globalRules, ...workspaceRules, ...legacyAllowRules(cfg, rootDir)]) {
    const key = ruleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rule);
  }
  return merged;
}

/** The stored array a rule belongs in, created on demand. */
function ruleTarget(
  cfg: ReasonixConfig,
  scope: ScopedRule["scope"],
  projectKey: string,
): StoredRule[] {
  if (scope === "global") {
    cfg.rules = cfg.rules ?? [];
    return cfg.rules;
  }
  cfg.projects = cfg.projects ?? {};
  const project = cfg.projects[projectKey] ?? {};
  project.rules = project.rules ?? [];
  cfg.projects[projectKey] = project;
  return project.rules;
}

/** The structured rule array for a scope, or undefined when it does not exist yet. */
function ruleList(
  cfg: ReasonixConfig,
  scope: RuleScope,
  projectKey: string,
): StoredRule[] | undefined {
  return scope === "global" ? cfg.rules : cfg.projects?.[projectKey]?.rules;
}

/** The pre-structured allow-list array a rule of this scope and kind lives in, if any. */
function legacyList(
  cfg: ReasonixConfig,
  scope: RuleScope,
  projectKey: string,
  kind: RuleKind,
): string[] | undefined {
  const key: AllowListField = kind === "shell" ? "shellAllowed" : "pathAllowed";
  return scope === "global" ? cfg[key] : cfg.projects?.[projectKey]?.[key];
}

/** Two stored rules are the same rule: same mode, effect, kind, and pattern. */
function rulesEqual(a: StoredRule, b: StoredRule): boolean {
  return (
    a.mode === b.mode &&
    a.effect === b.effect &&
    a.kind === b.kind &&
    (a.match ?? "pattern") === (b.match ?? "pattern") &&
    a.pattern === b.pattern
  );
}

/** The pre-structured allow lists only ever encode a Follow/allow rule. */
function isLegacyAllowRule(rule: StoredRule): boolean {
  return rule.mode === "follow" && rule.effect === "allow" && rule.match !== "regex";
}

function validateRule(rule: StoredRule): void {
  if (rule.match !== undefined && rule.match !== "pattern" && rule.match !== "regex") {
    throw new Error("Unknown rule matching mode.");
  }
  if (rule.match !== "regex") return;
  if (rule.kind !== "shell") throw new Error("Regex is only supported for command rules.");
  const error = ruleRegexError(rule.pattern);
  if (error) throw new Error(error);
}

/** Add a rule to the list its scope implies. Returns false when it was already there. */
export function addRule(
  rule: ScopedRule,
  rootDir: string,
  path: string = defaultConfigPath(),
): boolean {
  validateRule(rule);
  const trimmed = rule.pattern.trim();
  if (!trimmed) return false;
  const stored: StoredRule = {
    mode: rule.mode,
    effect: rule.effect,
    kind: rule.kind,
    pattern: trimmed,
    ...(rule.match === "regex" ? { match: "regex" as const } : {}),
  };
  const cfg = readConfig(path);
  const target = ruleTarget(cfg, rule.scope, findProjectKey(cfg, rootDir) ?? rootDir);
  if (target.some((r) => rulesEqual(r, stored))) return false;
  target.push(stored);
  writeConfig(cfg, path);
  return true;
}

/** Remove an exact rule. Returns false when it was not present. */
export function removeRule(
  rule: ScopedRule,
  rootDir: string,
  path: string = defaultConfigPath(),
): boolean {
  const cfg = readConfig(path);
  const projectKey = findProjectKey(cfg, rootDir) ?? rootDir;
  let removed = false;

  const target = ruleList(cfg, rule.scope, projectKey);
  if (target) {
    const next = target.filter((r) => !rulesEqual(r, rule));
    if (next.length !== target.length) {
      removed = true;
      if (rule.scope === "global") cfg.rules = next;
      else if (cfg.projects?.[projectKey]) cfg.projects[projectKey].rules = next;
    }
  }

  // A rule read in from the pre-structured allow lists has no structured entry, so the
  // legacy list is where it actually lives; without this a delete click on such a row
  // writes nothing and the rule reappears, which reads as an unresponsive button.
  const legacy = legacyList(cfg, rule.scope, projectKey, rule.kind);
  if (legacy && isLegacyAllowRule(rule)) {
    const at = legacy.indexOf(rule.pattern);
    if (at >= 0) {
      legacy.splice(at, 1);
      removed = true;
    }
  }

  if (!removed) return false;
  writeConfig(cfg, path);
  return true;
}

/** Change a stored rule in place: its effect or kind, in one config write. False when the
 *  original is gone or the result would duplicate an existing rule. */
export function updateRule(
  from: ScopedRule,
  to: ScopedRule,
  rootDir: string,
  path: string = defaultConfigPath(),
): boolean {
  validateRule(to);
  const trimmed = to.pattern.trim();
  if (!trimmed) return false;
  const cfg = readConfig(path);
  const projectKey = findProjectKey(cfg, rootDir) ?? rootDir;
  const source = ruleList(cfg, from.scope, projectKey);
  const index = source?.findIndex((r) => rulesEqual(r, from));

  // A rule read in from the pre-structured allow lists has no structured entry yet, so an
  // explicit edit migrates that one entry: drop it from the flat list, store it structured.
  const legacy = legacyList(cfg, from.scope, projectKey, from.kind);
  const legacyIndex = legacy?.indexOf(from.pattern) ?? -1;
  const fromStructured = index !== undefined && index >= 0;
  const fromLegacy = isLegacyAllowRule(from) && legacyIndex >= 0;
  if (!fromStructured && !fromLegacy) return false;

  const stored: StoredRule = {
    mode: to.mode,
    effect: to.effect,
    kind: to.kind,
    pattern: trimmed,
    ...(to.match === "regex" ? { match: "regex" as const } : {}),
  };
  const target = ruleTarget(cfg, to.scope, projectKey);
  if (target.some((r) => rulesEqual(r, stored))) return false;
  if (fromStructured) source!.splice(index!, 1);
  else legacy!.splice(legacyIndex, 1);
  target.push(stored);
  writeConfig(cfg, path);
  return true;
}

/** Split rules into per-effect pattern lists, keeping only the given mode and kind. */
function bucketByEffect(
  rules: readonly ScopedRule[],
  mode: RuleMode,
  kind: RuleKind,
): { allow: string[]; ask: string[]; deny: string[] } {
  const out = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  for (const rule of rules) {
    if (
      rule.mode !== mode ||
      rule.kind !== kind ||
      rule.match === "regex" ||
      rule.effect === "ignore"
    )
      continue;
    out[rule.effect].push(rule.pattern);
  }
  return out;
}

/** Patterns for one mode and kind, split by effect, ready for the enforcement checks. */
export function rulePatterns(
  mode: RuleMode,
  kind: RuleKind,
  rootDir: string,
  path: string = defaultConfigPath(),
): { allow: string[]; ask: string[]; deny: string[] } {
  return bucketByEffect(loadRules(rootDir, path), mode, kind);
}

export function regexRulePatterns(
  mode: RuleMode,
  rootDir: string,
  path: string = defaultConfigPath(),
): { allow: string[]; ask: string[]; deny: string[] } {
  const out = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  for (const rule of loadRules(rootDir, path)) {
    if (
      rule.mode === mode &&
      rule.kind === "shell" &&
      rule.match === "regex" &&
      rule.effect !== "ignore"
    ) {
      out[rule.effect].push(rule.pattern);
    }
  }
  return out;
}

/** `rulePatterns`, split by scope as well: lets an approval prompt tell whether a given
 *  scope already carries a rule for the target and stop offering to add a duplicate. */
export function rulePatternsByScope(
  mode: RuleMode,
  kind: RuleKind,
  rootDir: string,
  path: string = defaultConfigPath(),
): Record<RuleScope, { allow: string[]; ask: string[]; deny: string[] }> {
  const rules = loadRules(rootDir, path);
  return {
    global: bucketByEffect(
      rules.filter((r) => r.scope === "global"),
      mode,
      kind,
    ),
    workspace: bucketByEffect(
      rules.filter((r) => r.scope === "workspace"),
      mode,
      kind,
    ),
  };
}

/** A workspace and how many of its own rules it carries. */
export interface WorkspaceRuleSet {
  rootDir: string;
  ruleCount: number;
}

/** One workspace's own rules for `mode`: structured rules of that mode, plus the
 *  pre-structured allow lists, which only ever encode follow rules. */
function workspaceOwnRules(cfg: ReasonixConfig, key: string, mode: EditMode): ScopedRule[] {
  const project = cfg.projects?.[key];
  const rules: ScopedRule[] = (project?.rules ?? [])
    .filter((r) => r.mode === mode)
    .map((r) => ({ ...r, scope: "workspace" }));
  const take = (kind: RuleKind, patterns: readonly string[] | undefined): void => {
    if (mode !== "follow") return;
    for (const pattern of patterns ?? []) {
      rules.push({ mode: "follow", effect: "allow", kind, scope: "workspace", pattern });
    }
  };
  take("shell", project?.shellAllowed);
  take("path", project?.pathAllowed);
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = ruleKey(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Workspaces that carry workspace-scope rules for `mode`, for the copy picker. */
export function listWorkspacesWithRules(
  path: string = defaultConfigPath(),
  mode: EditMode = loadEditMode(),
): WorkspaceRuleSet[] {
  const cfg = readConfig(path);
  const out: WorkspaceRuleSet[] = [];
  for (const key of Object.keys(cfg.projects ?? {})) {
    const ruleCount = workspaceOwnRules(cfg, key, mode).length;
    if (ruleCount > 0) out.push({ rootDir: key, ruleCount });
  }
  return out.sort((a, b) => a.rootDir.localeCompare(b.rootDir));
}

/** Copy the source workspace's rules for `mode` onto the target, replacing the target's rules
 *  of that mode only. Rules of every other mode survive on the target. Returns the count. */
export function copyWorkspaceRules(
  from: string,
  to: string,
  path: string = defaultConfigPath(),
  mode: EditMode = loadEditMode(),
): number {
  const cfg = readConfig(path);
  const fromKey = findProjectKey(cfg, from) ?? from;
  const toKey = findProjectKey(cfg, to) ?? to;
  if (fromKey === toKey) return 0;
  const source: StoredRule[] = workspaceOwnRules(cfg, fromKey, mode).map(
    ({ scope: _scope, ...rule }) => rule,
  );
  cfg.projects = cfg.projects ?? {};
  const target = cfg.projects[toKey] ?? {};
  cfg.projects[toKey] = target;
  target.rules = [...(target.rules ?? []).filter((r) => r.mode !== mode), ...source];
  if (mode === "follow") {
    target.shellAllowed = undefined;
    target.pathAllowed = undefined;
  }
  writeConfig(cfg, path);
  return source.length;
}

/** Unknown values fall back to "follow" so hand-edited bad config gets the safe gated default. Legacy 4-mode values migrate onto the 3-mode dial. */
export function loadEditMode(path: string = defaultConfigPath()): EditMode {
  // Read raw (widened to string) so legacy plan/review/auto/yolo values migrate
  // instead of silently falling back to the default.
  const raw = readConfig(path).editMode as string | undefined;
  if (raw === "read-only" || raw === "follow" || raw === "never-ask") return raw;
  if (raw === "plan") return "read-only";
  if (raw === "review" || raw === "auto") return "follow";
  if (raw === "yolo" || raw === "ignore") return "never-ask";
  return "follow";
}

/** True when the persisted edit mode is never-ask. */
export function isNeverAskMode(path: string = defaultConfigPath()): boolean {
  return loadEditMode(path) === "never-ask";
}

/** The rule mode whose patterns apply for an edit mode: never-ask when it is selected,
 *  else follow (`read-only` never consults rules, so it maps to follow here). */
export function ruleModeFor(editMode: EditMode): RuleMode {
  return editMode === "never-ask" ? "never-ask" : "follow";
}

/** The rule mode whose patterns are in force now. */
export function ruleModeInForce(path: string = defaultConfigPath()): RuleMode {
  return ruleModeFor(loadEditMode(path));
}

/** Persist the edit mode so the chosen mode survives a relaunch. */
export function saveEditMode(mode: EditMode, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.editMode = mode;
  writeConfig(cfg, path);
}

/** Load user-defined quick sends (built-ins are code-defined); malformed entries are dropped. */
export function loadCustomQuickSends(path: string = defaultConfigPath()): QuickSend[] {
  const v = readConfig(path).quickSends;
  if (!Array.isArray(v)) return [];
  return v.filter(isQuickSend).map((q) => {
    const rawShorthand = q.shorthand || (q as { label?: string }).label || "";
    return {
      id: q.id,
      shorthand: enforceQuickSendShorthand(rawShorthand),
      message: q.message,
    };
  });
}

/** Persist the full user-defined quick-send list. */
export function saveCustomQuickSends(list: QuickSend[], path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.quickSends = list.map((q) => {
    const rawShorthand = q.shorthand || (q as { label?: string }).label || "";
    return {
      id: q.id,
      shorthand: enforceQuickSendShorthand(rawShorthand),
      message: q.message,
    };
  });
  writeConfig(cfg, path);
}

/** The quick send the composer dropdown marks; absent until a pick is persisted. */
export function loadQuickSendId(path: string = defaultConfigPath()): string | undefined {
  const v = readConfig(path).quickSendId;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Persist the quick send the user last picked from the composer dropdown. */
export function saveQuickSendId(id: string, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.quickSendId = id;
  writeConfig(cfg, path);
}

/** Default retained-context budget (tokens) for a duplicated session. */
export const DEFAULT_DUPLICATE_SESSION_TOKENS = 50_000;
export const MIN_DUPLICATE_SESSION_TOKENS = 1_000;
export const MAX_DUPLICATE_SESSION_TOKENS = 1_000_000;

/** Retained-context budget (tokens, newest-first) for a duplicated session.
 *  Unset / non-numeric → the 50 000 default; otherwise clamped to [1000, 1M]. */
export function loadDuplicateSessionTokens(path: string = defaultConfigPath()): number {
  const v = readConfig(path).duplicateSessionTokens;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_DUPLICATE_SESSION_TOKENS;
  return Math.min(
    MAX_DUPLICATE_SESSION_TOKENS,
    Math.max(MIN_DUPLICATE_SESSION_TOKENS, Math.floor(v)),
  );
}

/** Persist the duplicated-session token budget. null / undefined clears it back to
 *  the 50 000 default; out-of-range values clamp to [1000, 1M]. */
export function saveDuplicateSessionTokens(
  value: number | null | undefined,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    const { duplicateSessionTokens: _drop, ...rest } = cfg;
    writeConfig(rest, path);
    return;
  }
  const clamped = Math.min(
    MAX_DUPLICATE_SESSION_TOKENS,
    Math.max(MIN_DUPLICATE_SESSION_TOKENS, Math.floor(value)),
  );
  writeConfig({ ...cfg, duplicateSessionTokens: clamped }, path);
}

/** Whether a duplicated session auto-runs one continuation turn. Defaults to false. */
export function loadDuplicateSessionAutoProceed(path: string = defaultConfigPath()): boolean {
  return readConfig(path).duplicateSessionAutoProceed === true;
}

/** Persist whether a duplicated session auto-runs one continuation turn. */
export function saveDuplicateSessionAutoProceed(
  enabled: boolean,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  cfg.duplicateSessionAutoProceed = enabled;
  writeConfig(cfg, path);
}

/** Whether `run_command` may run a command elevated via Windows UAC consent.
 *  Defaults to false: the capability is opt-in, so the model cannot even
 *  prompt for elevation until the user has enabled it. */
export function loadElevationEnabled(path: string = defaultConfigPath()): boolean {
  return readConfig(path).elevationEnabled === true;
}

/** Persist whether `run_command` may run commands elevated. */
export function saveElevationEnabled(enabled: boolean, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.elevationEnabled = enabled;
  writeConfig(cfg, path);
}

/** Whether the stream repetition / "stuck re-thinking" guard is active.
 *  Defaults to false: the guard is opt-in, so a fresh install never aborts a
 *  stream on repeated output. */
export function loadRepetitionGuardEnabled(path: string = defaultConfigPath()): boolean {
  return readConfig(path).repetitionGuardEnabled === true;
}

/** Persist whether the stream repetition / "stuck re-thinking" guard is active. */
export function saveRepetitionGuardEnabled(
  enabled: boolean,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  cfg.repetitionGuardEnabled = enabled;
  writeConfig(cfg, path);
}

/** Whether pre-turn auto-compaction runs. Defaults to true: the conversation
 *  compacts before a turn when the request estimate nears the context window. */
export function loadAutoCompact(path: string = defaultConfigPath()): boolean {
  return readConfig(path).autoCompact !== false;
}

/** Persist whether pre-turn auto-compaction runs. */
export function saveAutoCompact(enabled: boolean, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.autoCompact = enabled;
  writeConfig(cfg, path);
}

/** Auto-compaction trigger bounds + default (fraction of the context window).
 *  The default matches AUTO_COMPACT_TRIGGER_RATIO in loop/compaction.ts. */
export const MIN_AUTO_COMPACT_TRIGGER = 0.5;
export const MAX_AUTO_COMPACT_TRIGGER = 0.95;
export const DEFAULT_AUTO_COMPACT_TRIGGER = 0.8;

/** Clamp a trigger fraction to the supported range (non-finite → default). */
export function clampAutoCompactTrigger(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_COMPACT_TRIGGER;
  return Math.min(MAX_AUTO_COMPACT_TRIGGER, Math.max(MIN_AUTO_COMPACT_TRIGGER, value));
}

/** Fraction of the context window at which pre-turn auto-compaction fires.
 *  Defaults to 0.8 when unset; a persisted value is clamped to [0.5, 0.95]. */
export function loadAutoCompactTrigger(path: string = defaultConfigPath()): number {
  const raw = readConfig(path).autoCompactTrigger;
  return typeof raw === "number" ? clampAutoCompactTrigger(raw) : DEFAULT_AUTO_COMPACT_TRIGGER;
}

/** Persist the auto-compaction trigger fraction. `null` clears the override. */
export function saveAutoCompactTrigger(
  ratio: number | null,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  cfg.autoCompactTrigger = ratio === null ? undefined : clampAutoCompactTrigger(ratio);
  writeConfig(cfg, path);
}

/** Persisted per-type cue matrix. Missing entries read as all-off defaults, so
 *  a config written before this feature (or with a subset of cues) stays valid. */
export function loadFeedbackCues(path: string = defaultConfigPath()): FeedbackCueSettings {
  return readConfig(path).feedbackCues ?? {};
}

export function saveFeedbackCues(
  cues: FeedbackCueSettings,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  cfg.feedbackCues = cues;
  writeConfig(cfg, path);
}

export function loadQuestionTimerEnabled(path: string = defaultConfigPath()): boolean {
  const cfg = readConfig(path);
  // On unless the user turned it off: every never-ask picker (choice, plan,
  // revision) counts down to its first option, so an unset config must not leave
  // choice gates as the one kind that waits forever.
  return cfg.questionTimerEnabled ?? cfg.questionTimer ?? true;
}

export function saveQuestionTimerEnabled(
  enabled: boolean,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  cfg.questionTimerEnabled = enabled;
  writeConfig(cfg, path);
}

/** Trimmed, duplicate-free, ORDER-PRESERVING model-id list: the enabled allow-list
 *  and the backup-model failover order both rely on the caller's order surviving. */
function sanitizeModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/** Model ids offered by every model picker. Empty/absent = none enabled (all hidden). */
export function loadEnabledModels(path: string = defaultConfigPath()): string[] {
  return sanitizeModelIds(readConfig(path).enabledModels);
}

/** Persist the enabled-model allow-list. Dedupes + trims; empty clears the field. */
export function saveEnabledModels(models: string[], path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  const cleaned = sanitizeModelIds(models);
  cfg.enabledModels = cleaned.length > 0 ? cleaned : undefined;
  writeConfig(cfg, path);
}

/** Ordered backup models tried when the active provider runs out of quota.
 *  Order is priority: the first entry that is usable takes over. */
export function loadFallbackModels(path: string = defaultConfigPath()): string[] {
  return sanitizeModelIds(readConfig(path).fallbackModels);
}

/** Persist the backup-model list. Trims + dedupes in place; empty clears the field. */
export function saveFallbackModels(models: string[], path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  const cleaned = sanitizeModelIds(models);
  cfg.fallbackModels = cleaned.length > 0 ? cleaned : undefined;
  writeConfig(cfg, path);
}

/** First backup model that can take over: the configured order, minus the models
 *  this run already failed on, minus any that cannot run here. `tried` is the
 *  caller's chain state, so successive calls walk the list exactly once. */
export function pickFallbackModel(
  configured: readonly string[],
  tried: ReadonlySet<string>,
  usable: (model: string) => boolean,
): string | null {
  for (const raw of configured) {
    const id = raw.trim();
    if (!id || tried.has(id)) continue;
    try {
      if (!usable(id)) continue;
    } catch {
      // A credential lookup that throws means "cannot run it here" — skip rather
      // than let one broken provider entry abort the whole failover chain.
      continue;
    }
    return id;
  }
  return null;
}

/** Bytes above which `read_file` flips to outline mode. Returns `undefined` so callers can apply the registered default; non-positive / non-numeric config values fall through to the default too. */
export function loadFilesystemOutlineThresholdBytes(
  path: string = defaultConfigPath(),
): number | undefined {
  const v = readConfig(path).filesystem?.outlineThresholdBytes;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.floor(v);
}

/** User-configured context-window cap in tokens, clamped to [128K, 1M] (the API ceiling).
 *  Unset / non-numeric → undefined (callers fall back to the per-model default). An explicit
 *  value is honored up to that ceiling in resolveContextTokens, above the model's default. */
export function loadContextTokens(path: string = defaultConfigPath()): number | undefined {
  const v = readConfig(path).contextTokens;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, Math.floor(v)));
}

/** Persist the context-window cap. `null` / undefined clears it back to the per-model
 *  default; out-of-range values clamp to [128K, 1M]. Values are kept as entered and resolved
 *  at run time (resolveContextTokens), which honors them up to the 1M ceiling. */
export function saveContextTokens(
  value: number | null | undefined,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  const clamped =
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, Math.floor(value)))
      : undefined;
  if (clamped === undefined) {
    const { contextTokens: _drop, ...rest } = cfg;
    writeConfig(rest, path);
  } else {
    writeConfig({ ...cfg, contextTokens: clamped }, path);
  }
}

/** True when the onboarding tip for the review/AUTO gate has been shown. */
export function editModeHintShown(path: string = defaultConfigPath()): boolean {
  return readConfig(path).editModeHintShown === true;
}

/** Unknown / missing fall back to "high" — the only value every OpenAI-compatible endpoint accepts (vLLM rejects "max"). */
export function loadReasoningEffort(path: string = defaultConfigPath()): ReasoningEffort {
  const v = readConfig(path).reasoningEffort;
  return isReasoningEffort(v) ? v : "high";
}

export function loadTheme(path: string = defaultConfigPath()): ThemeName | "auto" | undefined {
  const value = readConfig(path).theme;
  if (value === "auto") return "auto";
  if (typeof value === "string" && isThemeName(value)) return value;
  return undefined;
}

export function resolveThemePreference(
  configTheme: ThemeName | "auto" | undefined,
  envTheme?: string | null,
): ThemeName {
  if (configTheme && configTheme !== "auto") return configTheme;
  return resolveThemeName(envTheme);
}

export function saveTheme(theme: ThemeName | "auto", path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.theme = theme;
  writeConfig(cfg, path);
}

/** Persist the reasoning_effort cap so the chosen cap survives a relaunch. */
export function saveReasoningEffort(
  effort: ReasoningEffort,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  cfg.reasoningEffort = effort;
  writeConfig(cfg, path);
}

/** Load the per-turn iteration cap. Config > env > default (50). Clamped to [50, 100]. */
export function loadMaxIterPerTurn(path: string = defaultConfigPath()): number {
  const fromConfig = readConfig(path).maxIterPerTurn;
  if (typeof fromConfig === "number" && Number.isFinite(fromConfig) && fromConfig > 0) {
    return Math.min(100, Math.max(50, Math.floor(fromConfig)));
  }
  const fromEnv = process.env.REASONIX_MAX_ITER;
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return Math.min(100, Math.max(50, Math.floor(n)));
  }
  return 50;
}

/** Persist the per-turn iteration cap. `null` / undefined clears it back to default (50). */
export function saveMaxIterPerTurn(
  value: number | null | undefined,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  if (value === null || value === undefined) {
    const { maxIterPerTurn: _drop, ...rest } = cfg;
    writeConfig(rest, path);
  } else {
    const clamped = Math.min(100, Math.max(50, Math.floor(value)));
    writeConfig({ ...cfg, maxIterPerTurn: clamped }, path);
  }
}

/** Returns undefined when no cap is set (caller passes nothing to the API, server default applies). */
export function loadMaxOutputTokens(path: string = defaultConfigPath()): number | undefined {
  const v = readConfig(path).maxOutputTokens;
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  return undefined;
}

export function saveMaxOutputTokens(
  tokens: number | null,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  cfg.maxOutputTokens = tokens ?? undefined;
  writeConfig(cfg, path);
}

export function loadModel(path: string = defaultConfigPath()): string {
  const cfg = readConfig(path);
  const raw = cfg.model;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return DEFAULT_MODEL;
  // Custom-endpoint owners pick their own model namespace; trust them.
  const customEndpoint =
    providerSettingFromStore(cfg, "deepseek", "baseUrl") ?? resolveBaseUrlEnv();
  if (customEndpoint) return trimmed;
  return resolveModelAdmission(trimmed, path, cfg).accepted ? trimmed : DEFAULT_MODEL;
}

export function saveModel(model: string, path: string = defaultConfigPath()): void {
  const trimmed = model.trim();
  if (!trimmed) return;
  // On the official endpoints, refuse to persist a model the API won't accept.
  // Custom-endpoint owners set their own namespace — validation is on them.
  const cfg = readConfig(path);
  const customEndpoint =
    providerSettingFromStore(cfg, "deepseek", "baseUrl") ?? resolveBaseUrlEnv();
  const admission = resolveModelAdmission(trimmed, path, cfg);
  if (!customEndpoint && !admission.accepted) {
    throw new Error(
      `Unsupported model "${trimmed}". Official endpoints only accept: ${SUPPORTED_MODELS.join(", ")}. Set a custom baseUrl to use other models.`,
    );
  }
  cfg.model = trimmed;
  // Discovery is positive endpoint evidence. Persist it in the existing
  // authoritative provider map so session restores remain correctly routed if
  // Google's current discovery response later changes.
  if (admission.discoveredAntigravity) {
    cfg.models = { ...(cfg.models ?? {}), [trimmed]: { provider: "gemini" } };
  }
  writeConfig(cfg, path);
}

export function loadWorkspaceDir(path: string = defaultConfigPath()): string | undefined {
  const v = readConfig(path).workspaceDir;
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function saveWorkspaceDir(dir: string, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  const trimmed = dir.trim();
  if (trimmed) cfg.workspaceDir = trimmed;
  else cfg.workspaceDir = undefined;
  writeConfig(cfg, path);
}

export function loadRecentWorkspaces(path: string = defaultConfigPath()): string[] {
  const v = readConfig(path).recentWorkspaces;
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

const MAX_RECENT_WORKSPACES = 8;
export function pushRecentWorkspace(dir: string, path: string = defaultConfigPath()): void {
  const trimmed = dir.trim();
  if (!trimmed) return;
  const cfg = readConfig(path);
  const list = (cfg.recentWorkspaces ?? []).filter((s) => s !== trimmed);
  list.unshift(trimmed);
  cfg.recentWorkspaces = list.slice(0, MAX_RECENT_WORKSPACES);
  writeConfig(cfg, path);
}

export function removeRecentWorkspace(dir: string, path: string = defaultConfigPath()): void {
  const trimmed = dir.trim();
  if (!trimmed) return;
  const cfg = readConfig(path);
  const normalized = resolve(trimmed);
  cfg.recentWorkspaces = (cfg.recentWorkspaces ?? []).filter(
    (s) => s !== trimmed && resolve(s) !== normalized,
  );
  if (Array.isArray(cfg.desktopOpenTabs)) {
    cfg.desktopOpenTabs = cfg.desktopOpenTabs.filter((t) => {
      const tabDir = typeof t === "string" ? t : t?.dir;
      return typeof tabDir === "string" && tabDir !== trimmed && resolve(tabDir) !== normalized;
    });
    if (cfg.desktopOpenTabs.length === 0) cfg.desktopOpenTabs = undefined;
  }
  writeConfig(cfg, path);
}

/** Desktop only — one open session channel's restorable state. Multiple
 *  records may share a workspace tab because every session has an independent
 *  runtime that must survive app restarts. */
export interface DesktopOpenTab {
  dir: string;
  /** Channel id (t1, t2, …) — persisted so a restarted backend reuses the same
   *  ids instead of re-minting t1..tN that collide with the frontend's still-
   *  open channels (events then route to the wrong agent). */
  id?: string;
  /** Session the channel had loaded; reopened on boot if its jsonl still exists. */
  session?: string;
  /** The channel was in the neutral state (no session bound) when the app closed.
   *  Restoring it as neutral avoids minting an empty session the user never asked
   *  for just because the tab came back. */
  detached?: boolean;
  /** Workspace-tab identity. Every channel for the same canonical workspace
   *  is normalized onto one group during desktop restore. */
  groupId?: string;
  /** Whether this was the focused tab. */
  active?: boolean;
}

export function loadDesktopOpenTabs(path: string = defaultConfigPath()): DesktopOpenTab[] {
  const v: unknown = readConfig(path).desktopOpenTabs;
  if (!Array.isArray(v)) return [];
  const out: DesktopOpenTab[] = [];
  for (const entry of v) {
    // Legacy format (issue #933) persisted bare workspace-dir strings.
    if (typeof entry === "string") {
      if (entry) out.push({ dir: entry });
    } else if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as DesktopOpenTab).dir === "string" &&
      (entry as DesktopOpenTab).dir.length > 0
    ) {
      const e = entry as DesktopOpenTab;
      out.push({
        dir: e.dir,
        id: e.id,
        session: e.session,
        detached: e.detached === true ? true : undefined,
        groupId: e.groupId,
        active: e.active,
      });
    }
  }
  return out;
}

export function saveDesktopOpenTabs(
  tabs: DesktopOpenTab[],
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  const cleaned = tabs
    .filter((t) => t && typeof t.dir === "string" && t.dir.length > 0)
    .map((t) => {
      const e: DesktopOpenTab = { dir: t.dir };
      if (t.id) e.id = t.id;
      if (t.session) e.session = t.session;
      if (t.detached) e.detached = true;
      if (t.groupId) e.groupId = t.groupId;
      if (t.active) e.active = true;
      return e;
    });
  cfg.desktopOpenTabs = cleaned.length === 0 ? undefined : cleaned;
  writeConfig(cfg, path);
}

/** Mark the onboarding tip as shown so subsequent launches skip it. */
export function markEditModeHintShown(path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  if (cfg.editModeHintShown === true) return;
  cfg.editModeHintShown = true;
  writeConfig(cfg, path);
}

/** Self-hosted DeepSeek-compatible endpoints may issue any token shape, so we only typo-guard here — the real auth check is the first API call against `baseUrl`. */
export function isPlausibleKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length < 16) return false;
  return !/\s/.test(trimmed);
}

/** Mask a key for display: `sk-abcd...wxyz`. */
export function redactKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
