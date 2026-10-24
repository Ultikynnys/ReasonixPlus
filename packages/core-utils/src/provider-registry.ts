/** Declarative model-provider registry: providers/<id>.json is the single source of truth. */

import type { ReasoningEffort } from "./permission-types.js";
import { PROVIDER_DOCUMENTS, PROVIDER_IDS, type ProviderID } from "./providers.generated.js";
import type { RateSchedule } from "./rate-periods.js";

/** Routable provider ids, generated from providers/*.json by `npm run providers:sync`. */
export { PROVIDER_IDS };
export type { ProviderID };

const PROVIDER_ID_SET: ReadonlySet<string> = new Set<string>(PROVIDER_IDS);

export type ProviderEndpointStrategy = "standard" | "fixed" | "tiered";
export type ProviderDiscoveryStrategy =
  | "models-endpoint"
  | "models.dev"
  | "oauth-quota"
  | "runtime";
export type ProviderAuthStrategy = "api-key" | "openai-oauth" | "opencode" | "gemini-oauth";
export type ProviderTransportStrategy =
  | "codex"
  | "zai-responses"
  | "mimo-responses"
  | "opencode-muse-responses";
export type ProviderSetupSource = "apiKey" | "baseUrl" | "oauth";
export type ProviderModelFilter = "antigravity";
/** What must be true before a picker shows this provider's group. */
export type ProviderPickerGate = "catalog" | "signin";

export type ProviderVisionPredicate = "antigravity";

export interface ProviderVisionSpec {
  /** Model ids known to accept images. */
  models?: readonly string[];
  /** Regexes matched against the wire model id. */
  patterns?: readonly string[];
  /** Named predicate for providers whose vision rule is not a list. */
  predicate?: ProviderVisionPredicate;
  /** A sync may replace this catalog at runtime (the static list is a fallback). */
  refreshable?: boolean;
  /** Inherits another provider's vision catalog (Ollama hosting a DeepSeek build). */
  fromProvider?: ProviderID;
  /** Strips an `ollama/`-scheme prefix and `:tag` suffix before matching. */
  stripSchemeAndTag?: boolean;
}

export interface ProviderEndpointSpec {
  strategy: ProviderEndpointStrategy;
  /** Default base URL; null means "no default, the config must supply one". */
  default: string | null;
  /** Alternate endpoints keyed by tier (e.g. OpenCode Zen vs Go, Z.AI responses). */
  tiers: Readonly<Record<string, string>>;
  /** `strict`: a base-URL override owns its key (a stale env key never bleeds
   *  into a custom gateway). `resolve`: the key resolves env-then-config anyway. */
  keyTuple: "strict" | "resolve";
}

export interface ProviderCredentialsSpec {
  baseUrlEnv: readonly string[];
  apiKeyEnv: readonly string[];
  /** Store path (`<catalogId>.<settingKey>`) the base URL persists to, or null. */
  baseUrlSetting: string | null;
  /** Store path (`<catalogId>.<settingKey>`) the API key persists to, or null. */
  apiKeySetting: string | null;
  /** Key assumed when nothing is configured and the endpoint is open (OpenCode's `public`). */
  publicKey: string | null;
  /** Config field holding the OAuth credentials for this provider, when it has a sign-in. */
  oauthConfig: string | null;
}

/** `secret` is masked in the UI, `url` is an endpoint override, and `internal` is
 *  app-managed state that no field renders. */
export type ProviderSettingKind = "secret" | "url" | "internal";

/** A persisted setting a provider declares. The config surface, the settings card
 *  and the masked-status payload are all derived from these entries. */
export interface ProviderSettingSpec {
  /** Setting key inside the provider's own store entry (e.g. `apiKey`, `baseUrl`). */
  key: string;
  kind: ProviderSettingKind;
  editable: boolean;
  /** Environment variables that override the persisted value, highest priority first. */
  env: readonly string[];
  /** Legacy config field this setting migrated from; null when it never had one. */
  configKey: string | null;
  /** Field label text; null for an `internal` setting, which never renders. */
  label: string | null;
  /** Field hint text, when the field needs one. */
  hint: string | null;
  /** Placeholder text; null means the provider's declared endpoint. */
  placeholder: string | null;
  /** Where to obtain a key, rendered as a link. */
  signupUrl: string | null;
}

/** A bespoke behavior panel the settings page renders above the declared fields.
 *  Sign-in flows and provider-specific editors are code; the panel is selected
 *  by name from JSON, never by a provider id. */
export type ProviderSettingsPanel =
  | "openai-auth"
  | "antigravity-auth"
  | "mimo-auth"
  | "opencode-auth"
  | "ollama-generation";

export interface ProviderUsableSpec {
  /** A resolved endpoint API key alone makes the model runnable. */
  apiKey: boolean;
  /** A keyless localhost daemon counts as runnable. */
  keylessLocal: boolean;
  /** A resolved user-declared endpoint counts as runnable without a key (a
   *  self-hosted server the operator named, which may not be loopback). */
  baseUrl: boolean;
  /** The provider always runs (OpenCode falls back to free models). */
  always: boolean;
}

export interface ProviderDiscoverySpec {
  strategy: ProviderDiscoveryStrategy;
  /** JSON list field carrying the ids; null when the strategy has no body to read. */
  listField: string | null;
  /** JSON field carrying a model id. */
  idField: string;
  /** Drops `speechModels` from the discovered catalog. */
  excludeSpeech: boolean;
  /** Dotted field carrying each entry's input modality list; null when the catalog
   *  reports none, which leaves the declared vision rules as the only evidence. */
  visionField: string | null;
}

/** How a bare model id may route to this provider. */
export interface ProviderRoutingSpec {
  /** A bare id listed in `models` routes here. */
  staticCatalog: boolean;
  /** A bare id found in the provider's discovery cache routes here. */
  discoveredCatalog: boolean;
  /** Only consulted after every earlier provider declined (resold gateways). */
  checkedLast: boolean;
  /** Resold catalogs hide this provider's ids: a bare overlap keeps its native route. */
  foreignCatalog: boolean;
  /** Model-id prefix that always routes here, e.g. Ollama's `ollama/` scheme. */
  modelScheme: string | null;
  /** The provider owns its whole catalog, so every picker row carries the model
   *  scheme even when no other provider serves the bare id. */
  qualifyModels: boolean;
}

/** How a provider's 5xx failures are reported. */
export type ProviderServerReport = "standard" | "balance-probe";

/** i18n prefixes that own `errors.<prefix><Kind>` message keys. */
export type ProviderErrorI18nPrefix =
  | "deepseek"
  | "openai"
  | "ollama"
  | "antigravity"
  | "zai"
  | "opencode"
  | "mimo"
  | "experiential"
  | "synthetic"
  | "openrouter"
  | "custom";

/** How a provider names itself in thrown errors. */
export interface ProviderErrorsSpec {
  /** Prefix for `errors.<prefix><Kind>`; `custom` is the generic bucket. */
  i18nPrefix: ProviderErrorI18nPrefix;
  /** Wire brands that prefix "<Brand> <status>: ..." errors. */
  brands: readonly string[];
  /** Hostname suffixes that identify this provider from an upstream URL. */
  hosts: readonly string[];
  serverReport: ProviderServerReport;
}

export const PROVIDER_ERROR_I18N_PREFIXES: ReadonlySet<string> = new Set([
  "deepseek",
  "openai",
  "ollama",
  "antigravity",
  "zai",
  "opencode",
  "mimo",
  "experiential",
  "synthetic",
  "openrouter",
  "custom",
]);

export const PROVIDER_SERVER_REPORTS: ReadonlySet<string> = new Set(["standard", "balance-probe"]);

/** How a provider bills a token: dollars, a plan window, or nothing it can measure. */
export type ProviderBillingKind = "usd" | "quota" | "none" | "usd-unless-oauth" | "quota-if-key";

export const PROVIDER_BILLING_KINDS: ReadonlySet<string> = new Set([
  "usd",
  "quota",
  "none",
  "usd-unless-oauth",
  "quota-if-key",
]);

/** Response shapes an account-balance endpoint speaks. `balance-infos` is DeepSeek's
 *  `{balance_infos: [...]}`; `credits-usage` is a `{data: {total_credits,
 *  total_usage}}` credits ledger, whose balance is the difference. */
export type ProviderBalanceShape = "balance-infos" | "credits-usage";

export const PROVIDER_BALANCE_SHAPES: ReadonlySet<string> = new Set([
  "balance-infos",
  "credits-usage",
]);

/** Where a provider publishes the account balance, and how to read the reply. */
export interface ProviderBalanceSpec {
  /** Path relative to the provider endpoint, or an absolute URL when the wallet
   *  lives on another route of the same host (`/api/v1/credits` vs `/v1`). */
  url: string;
  shape: ProviderBalanceShape;
}

/** How a provider's model ids read to a person. The wire id stays the value that
 *  routes and persists; this only decides what the label says. */
export interface ProviderModelIdSpec {
  /** Leading scheme markers that carry no meaning for a reader (`hf:`). */
  stripPrefixes: readonly string[];
  /** Drop a hub-style `<owner>/` segment (`Qwen/Qwen3.8-27B` → `Qwen3.8-27B`). */
  stripOwner: boolean;
  /** Exact labels for ids that are an alias rather than a name, keyed by wire id. */
  labels: Readonly<Record<string, string>>;
}

/** Safe defaults: an id is its own label unless the provider says otherwise. */
export const DEFAULT_PROVIDER_MODEL_ID: ProviderModelIdSpec = {
  stripPrefixes: [],
  stripOwner: false,
  labels: {},
};

/** How a provider reports its account state, all declared rather than inferred. */
export interface ProviderBillingSpec {
  kind: ProviderBillingKind;
  /** Published peak/off-peak windows; null when the rate never changes. */
  schedule: RateSchedule | null;
  /** Model ids whose token price moves with the schedule; empty when none do. */
  peakModels: readonly string[];
  /** Where the account balance is published; null means nowhere, so the ribbon
   *  shows no wallet chip it could never fill. */
  balance: ProviderBalanceSpec | null;
}

/** A context window the provider's own server owns (a llama.cpp `--ctx-size`),
 *  so the budget the loop may fill is the setting minus the output reserve the
 *  server must also fit in the same window. */
export interface ProviderContextSpec {
  /** Declared setting holding the server's total window. */
  setting: string;
  /** Tokens the provider keeps for the response, subtracted from `setting`. */
  outputReserve: number;
  /** Window assumed when the setting is unset. */
  defaultTokens: number;
}

/** Relative per-token cost. `cheap` treats a cache read as a rounding error,
 *  `premium` treats every resent byte as real money. */
export type ProviderCostTier = "cheap" | "standard" | "premium";

/** A tier, plus the tuning a provider overrides on top of it. Every numeric field
 *  is optional: absent means "use the tier's value", so a tier change moves the
 *  whole family at once. */
export interface ProviderCostSpec {
  tier: ProviderCostTier;
  /** Per-tool-result token cap. */
  toolResultTokens?: number;
  /** Fraction of the context window at which auto-compaction fires. */
  compactionTrigger?: number;
  /** Image parts re-sent with each request. */
  keepImages?: number;
}

/** Wire format the transport speaks for this provider. `gemini-interactions` is
 *  Google's `POST /v1beta/interactions` step_list protocol: it shares nothing with
 *  chat-completions, so the client builds and parses it from scratch. */
export type ProviderWireFormat = "chat-completions" | "ollama-native" | "gemini-interactions";

/** Where a provider expects its thinking toggle; null when it refuses the field. */
export type ProviderThinkingStyle =
  | "top-level"
  | "zai-top-level"
  | "mimo-top-level"
  | "chat-template";

/** Request field carrying the output-token cap. Newer OpenAI models reject the
 *  chat-completions `max_tokens` spelling in favor of `max_completion_tokens`. */
export type ProviderMaxTokensField = "max_tokens" | "max_completion_tokens";

/** Per-provider request quirks, so the client never branches on a provider id. */
export interface ProviderWireSpec {
  format: ProviderWireFormat;
  /** Stamp wire message ids before sending (the cache contract). */
  stampMessageIds: boolean;
  /** Send `stream_options.include_usage` on a streaming request. */
  streamOptions: boolean;
  /** Send `store: false` on a wire that requires the flag explicitly. */
  storeFlag: boolean;
  /** Field the output-token cap travels in. */
  maxTokensField: ProviderMaxTokensField;
  /** Request-level parallel tool-call gate. null sends nothing, leaving the
   *  provider's default: a burst costs one request instead of one per call. */
  parallelToolCalls: boolean | null;
  /** Send a session-stable `prompt_cache_key` so the provider routes on it. */
  promptCacheKey: boolean;
  /** Send `tool_stream` when streaming with tools. */
  toolStream: boolean;
  thinking: ProviderThinkingStyle | null;
  /** Whether a `reasoning_effort` field is accepted. */
  reasoningEffort: boolean;
  /** Request path appended to the resolved base URL; null means `/chat/completions`. */
  path: string | null;
  /** Header carrying the API key; null means `Authorization: Bearer <key>`. */
  apiKeyHeader: string | null;
}

/** Safe defaults: a provider that declares nothing never inherits a quirk. */
export const DEFAULT_PROVIDER_WIRE: ProviderWireSpec = {
  format: "chat-completions",
  stampMessageIds: false,
  streamOptions: true,
  storeFlag: false,
  maxTokensField: "max_tokens",
  parallelToolCalls: null,
  promptCacheKey: false,
  toolStream: false,
  thinking: null,
  reasoningEffort: true,
  path: null,
  apiKeyHeader: null,
};

const WIRE_FORMATS: ReadonlySet<string> = new Set([
  "chat-completions",
  "ollama-native",
  "gemini-interactions",
]);
const THINKING_STYLES: ReadonlySet<string> = new Set([
  "top-level",
  "zai-top-level",
  "mimo-top-level",
  "chat-template",
]);
const MAX_TOKENS_FIELDS: ReadonlySet<string> = new Set(["max_tokens", "max_completion_tokens"]);
const COST_TIERS: ReadonlySet<string> = new Set(["cheap", "standard", "premium"]);

export type ProviderReasoningControl =
  | "effort"
  | "gemini-level"
  | "gemini-budget"
  | "cloudcode-budget"
  | "none";

export interface ProviderReasoningRule {
  pattern: string;
  efforts: readonly ReasoningEffort[];
  aliases: Readonly<Partial<Record<ReasoningEffort, ReasoningEffort>>>;
  control: ProviderReasoningControl;
  forcedThinking: boolean;
  budgets: Readonly<Partial<Record<ReasoningEffort, number>>>;
}

export interface ProviderClientSpec {
  auth: ProviderAuthStrategy;
  transport: ProviderTransportStrategy | null;
  /** The provider works without a key, so the client may omit one. */
  allowMissingKey: boolean;
}

export interface ProviderSpec {
  id: string;
  /** Routing id, or null for a catalog-only entry that never routes a model id. */
  providerId: ProviderID | null;
  label: string;
  /** Tag that prefixes a model id in a picker row or a model pill, e.g. `DS`
   *  for DeepSeek. Falls back to `label` when a declaration omits it. */
  shortLabel: string;
  /** i18n key naming the provider's card/group in the desktop UI. */
  groupLabelKey: string;
  /** Desktop picker group this provider renders in; null = its own id. */
  pickerGroup: string | null;
  /** Display and catalog order, ascending. */
  order: number;
  /** Bare-id ownership rank; null means the provider never takes a bare id. */
  precedence: number | null;
  defaultModel: string | null;
  /** Contributes to `KNOWN_MODELS` and the default pickers. */
  knownCatalog: boolean;
  models: readonly string[];
  goModels: readonly string[];
  speechModels: readonly string[];
  /** How this provider's ids read as a label; defaults to the id itself. */
  modelId: ProviderModelIdSpec;
  vision: ProviderVisionSpec;
  modelFilter: ProviderModelFilter | null;
  reasoningEfforts: readonly ReasoningEffort[];
  reasoningAliases: Readonly<Partial<Record<ReasoningEffort, ReasoningEffort>>>;
  reasoningRules: readonly ProviderReasoningRule[];
  endpoint: ProviderEndpointSpec;
  credentials: ProviderCredentialsSpec;
  /** Persisted settings this provider declares, in card order. */
  settings: readonly ProviderSettingSpec[];
  /** Bespoke behavior panel for the settings card, when the provider needs one. */
  settingsPanel: ProviderSettingsPanel | null;
  usable: ProviderUsableSpec;
  /** Credential sources that make the install count as "set up" for this provider. */
  setupGate: readonly ProviderSetupSource[];
  /** What the model picker waits for before showing this provider; null = always. */
  pickerGate: ProviderPickerGate | null;
  /** Whether the desktop model picker has a group for this provider at all. */
  picker: boolean;
  routing: ProviderRoutingSpec;
  /** models.dev provider key whose `reasoning_options` feed this provider, when any. */
  modelsDev: string | null;
  /** Effort this provider's models start at when the user has not chosen one. */
  reasoningDefault: ReasoningEffort | undefined;
  discovery: ProviderDiscoverySpec;
  client: ProviderClientSpec;
  /** Server-owned context window; null when the model table supplies the cap. */
  context: ProviderContextSpec | null;
  errors: ProviderErrorsSpec;
  billing: ProviderBillingSpec;
  cost: ProviderCostSpec;
  wire: ProviderWireSpec;
  usage: ProviderUsageSpec;
  strings: ProviderStringsSpec;
}

/** How a provider reports a plan-window percentage, if it reports one at all. */
export type ProviderProbeStrategy =
  | "codex-oauth"
  | "ollama-balance"
  | "antigravity-quota"
  | "zai-monitor"
  | "mimo-console"
  | "experiential-spend"
  | "synthetic-quotas"
  | "openrouter-key"
  | "opencode-usage";

export const PROVIDER_PROBE_STRATEGIES: ReadonlySet<string> = new Set<ProviderProbeStrategy>([
  "codex-oauth",
  "ollama-balance",
  "antigravity-quota",
  "zai-monitor",
  "mimo-console",
  "experiential-spend",
  "synthetic-quotas",
  "openrouter-key",
  "opencode-usage",
]);

/** Window labels a normalized usage view carries: "5h" (rolling/session), "wk",
 *  "mo", "day" (a daily spend cap), or "plan" for a per-model bucket. */
export type ProviderUsageWindowLabel = "5h" | "wk" | "mo" | "day" | "plan";

/** What a probe's relative URL resolves against: the endpoint's origin (a usage
 *  route rarely shares the chat path prefix) or the configured base URL. */
export type ProviderUsageUrlBase = "origin" | "endpoint";

/** Which host a probe may talk to: any, or only the hosts the provider declares
 *  in `errors.hosts` (a custom proxy must never receive the account's token). */
export type ProviderUsageUrlGate = "any" | "declared-hosts";

/** How a reset time reads in the chip tooltip. */
export type ProviderUsageResetsStyle = "relative" | "absolute";

/** A provider's chip unit: a measured window percentage, or just the plan's name
 *  when reading a percentage needs a second credential. */
export type ProviderUsageMeasures = "windows" | "plan";

/** Where a provider publishes plan usage, and how the daemon should read it. The
 *  probe name selects the payload reader; everything about the address and the
 *  refresh floor is declared here so a provider moving its usage API is a JSON
 *  edit. */
export interface ProviderUsageSpec {
  /** Quota probe this provider exposes, or null when it publishes no plan window. */
  probe: ProviderProbeStrategy | null;
  /** Addresses the probe reads, tried in order: a `/path` resolved against
   *  `urlBase`, or an absolute https URL. Empty when the reader composes its own
   *  address from the declared endpoint (a method-keyed POST RPC or an OAuth
   *  backend that has no single usage route). */
  urls: readonly string[];
  urlBase: ProviderUsageUrlBase;
  urlGate: ProviderUsageUrlGate;
  /** Floor between network reads, in seconds. Declared because each API caps
   *  reads differently (Ollama's balance allows ~10/min). */
  minIntervalSeconds: number;
  /** Window whose "% left" fills `{left}` in the chip copy; null means the first
   *  window the payload reports. */
  primaryWindow: ProviderUsageWindowLabel | null;
  resetsStyle: ProviderUsageResetsStyle;
  /** What the chip shows when the probe reports no percentages (default
   *  `windows`: a dash). */
  measures: ProviderUsageMeasures;
}

/** Provider-specific UI copy. Every key is optional: a missing key falls back to the
 *  generic i18n string, so a declaration carries only the copy that names it. */
export type ProviderStringsSpec = Record<string, string>;

/** Environment and persisted-config accessors the endpoint/credential resolvers need. */
export interface ProviderCredentialContext {
  env?: (name: string) => string | undefined;
  /** Reads a `<catalogId>.<settingKey>` path from the provider settings store. */
  setting: (path: string) => string | undefined;
  /** Reads the access token stored under a provider's `oauthConfig` field. */
  oauthToken?: (field: string) => string | undefined;
}

export interface ProviderEndpoint {
  baseUrl: string | undefined;
  apiKey: string | undefined;
}

const ENDPOINT_STRATEGIES: ReadonlySet<string> = new Set(["standard", "fixed", "tiered"]);
const DISCOVERY_STRATEGIES: ReadonlySet<string> = new Set([
  "models-endpoint",
  "models.dev",
  "oauth-quota",
  "runtime",
]);
const AUTH_STRATEGIES: ReadonlySet<string> = new Set([
  "api-key",
  "openai-oauth",
  "opencode",
  "gemini-oauth",
]);
const TRANSPORT_STRATEGIES: ReadonlySet<string> = new Set([
  "codex",
  "zai-responses",
  "mimo-responses",
  "opencode-muse-responses",
]);
const SETUP_SOURCES: ReadonlySet<string> = new Set(["apiKey", "baseUrl", "oauth"]);
const MODEL_FILTERS: ReadonlySet<string> = new Set(["antigravity"]);
const PICKER_GATES: ReadonlySet<string> = new Set(["catalog", "signin"]);
const VISION_PREDICATES: ReadonlySet<string> = new Set(["antigravity"]);
const SETTING_KINDS: ReadonlySet<string> = new Set(["secret", "url", "internal"]);
const SETTINGS_PANELS: ReadonlySet<string> = new Set([
  "openai-auth",
  "antigravity-auth",
  "mimo-auth",
  "opencode-auth",
  "ollama-generation",
]);
const USAGE_URL_BASES: ReadonlySet<string> = new Set(["origin", "endpoint"]);
const USAGE_URL_GATES: ReadonlySet<string> = new Set(["any", "declared-hosts"]);
const USAGE_RESETS_STYLES: ReadonlySet<string> = new Set(["relative", "absolute"]);
const USAGE_WINDOW_LABELS: ReadonlySet<string> = new Set(["5h", "wk", "mo", "day", "plan"]);
const USAGE_MEASURES: ReadonlySet<string> = new Set(["windows", "plan"]);
/** One read per minute unless a provider's API allows fewer. */
const DEFAULT_USAGE_MIN_INTERVAL_SECONDS = 60;

function fail(where: string, detail: string): never {
  throw new Error(`provider registry: ${where}: ${detail}`);
}

/** A usage or balance address: a `/path` that rides the endpoint, or an absolute
 *  https URL when the route lives on another prefix (the wallet is fetched with
 *  the same bearer key, so plain http is refused). */
function endpointUrl(value: unknown, where: string): string {
  const url = text(value, where);
  if (!url.startsWith("/") && !/^https:\/\//.test(url)) {
    fail(where, "expected a /path or an https URL");
  }
  return url;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(where, "expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) fail(where, "expected a non-empty string");
  return value;
}

function nullableText(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, where);
}

function flag(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") fail(where, "expected a boolean");
  return value;
}

function number(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(where, "expected a number");
  return value;
}

function nullableNumber(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  return number(value, where);
}

/** A count: whole and positive. Token counts and image budgets are counts. */
function positiveInteger(value: unknown, where: string): number {
  const n = number(value, where);
  if (!Number.isInteger(n) || n < 1) fail(where, "expected a whole number above zero");
  return n;
}

/** A ratio the loop multiplies a window by: above zero, at most one. */
function fractionOfWindow(value: unknown, where: string): number {
  const n = number(value, where);
  if (!(n > 0 && n <= 1)) fail(where, "expected a fraction above zero and at most 1");
  return n;
}

/** A boolean, or null when the provider declares none (send the field never). */
function nullableFlag(value: unknown, where: string): boolean | null {
  if (value === null || value === undefined) return null;
  return flag(value, where);
}

function texts(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(where, "expected an array of strings");
  return value.map((entry, index) => text(entry, `${where}[${index}]`));
}

function choice<T extends string>(value: unknown, allowed: ReadonlySet<string>, where: string): T {
  const picked = text(value, where);
  if (!allowed.has(picked)) fail(where, `unsupported value "${picked}"`);
  return picked as T;
}

function nullableChoice<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  where: string,
): T | null {
  if (value === null || value === undefined) return null;
  return choice<T>(value, allowed, where);
}

function subset<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  where: string,
): T[] {
  return texts(value, where).map((entry, index) => choice<T>(entry, allowed, `${where}[${index}]`));
}

function urlTable(value: unknown, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, url] of Object.entries(record(value ?? {}, where))) {
    out[key] = text(url, `${where}.${key}`);
  }
  return out;
}

function parseVision(value: unknown, where: string): ProviderVisionSpec {
  const raw = record(value ?? {}, where);
  const out: ProviderVisionSpec = {};
  if (raw.models !== undefined) out.models = texts(raw.models, `${where}.models`);
  if (raw.patterns !== undefined) {
    const patterns = texts(raw.patterns, `${where}.patterns`);
    for (const [index, pattern] of patterns.entries()) {
      try {
        new RegExp(pattern);
      } catch {
        fail(`${where}.patterns[${index}]`, "invalid regular expression");
      }
    }
    out.patterns = patterns;
  }
  if (raw.predicate !== undefined) {
    out.predicate = choice<ProviderVisionPredicate>(
      raw.predicate,
      VISION_PREDICATES,
      `${where}.predicate`,
    );
  }
  if (raw.fromProvider !== undefined) {
    out.fromProvider = choice<ProviderID>(
      raw.fromProvider,
      PROVIDER_ID_SET,
      `${where}.fromProvider`,
    );
  }
  if (raw.stripSchemeAndTag !== undefined) {
    out.stripSchemeAndTag = flag(raw.stripSchemeAndTag, `${where}.stripSchemeAndTag`);
  }
  if (raw.refreshable !== undefined) {
    out.refreshable = flag(raw.refreshable, `${where}.refreshable`);
  }
  return out;
}

function parseEndpoint(value: unknown, where: string): ProviderEndpointSpec {
  const raw = record(value, where);
  return {
    strategy: choice<ProviderEndpointStrategy>(
      raw.strategy,
      ENDPOINT_STRATEGIES,
      `${where}.strategy`,
    ),
    default: nullableText(raw.default, `${where}.default`),
    tiers: urlTable(raw.tiers, `${where}.tiers`),
    keyTuple:
      raw.keyTuple === undefined
        ? "strict"
        : choice<"strict" | "resolve">(
            raw.keyTuple,
            new Set(["strict", "resolve"]),
            `${where}.keyTuple`,
          ),
  };
}

/** Store path a provider setting persists to: `<catalogId>.<settingKey>`. */
export function providerSettingPath(providerId: string, key: string): string {
  return `${providerId}.${key}`;
}

function parseCredentials(
  value: unknown,
  where: string,
  settings: readonly ProviderSettingSpec[],
  id: string,
): ProviderCredentialsSpec {
  const raw = record(value ?? {}, where);
  // Env names and store paths come from the declared settings, so a provider
  // never repeats its credentials in two places.
  const declared = (key: string): ProviderSettingSpec | undefined =>
    settings.find((setting) => setting.key === key);
  const stored = (key: string): string | null =>
    declared(key) ? providerSettingPath(id, key) : null;
  return {
    baseUrlEnv: declared("baseUrl")?.env ?? [],
    apiKeyEnv: declared("apiKey")?.env ?? [],
    baseUrlSetting: stored("baseUrl"),
    apiKeySetting: stored("apiKey"),
    publicKey: nullableText(raw.publicKey, `${where}.publicKey`),
    oauthConfig: nullableText(raw.oauthConfig, `${where}.oauthConfig`),
  };
}

function parseSetting(value: unknown, where: string): ProviderSettingSpec {
  const raw = record(value, where);
  const key = text(raw.key, `${where}.key`);
  if (!/^[a-z][A-Za-z0-9]*$/.test(key)) fail(`${where}.key`, `invalid setting key "${key}"`);
  const kind = choice<ProviderSettingKind>(raw.kind, SETTING_KINDS, `${where}.kind`);
  const label = nullableText(raw.label, `${where}.label`);
  if (kind !== "internal" && !label) {
    fail(`${where}.label`, "required for a rendered setting");
  }
  return {
    key,
    kind,
    editable: flag(raw.editable ?? false, `${where}.editable`),
    env: texts(raw.env ?? [], `${where}.env`),
    configKey: nullableText(raw.configKey, `${where}.configKey`),
    label,
    hint: nullableText(raw.hint, `${where}.hint`),
    placeholder: nullableText(raw.placeholder, `${where}.placeholder`),
    signupUrl: nullableText(raw.signupUrl, `${where}.signupUrl`),
  };
}

function parseSettings(value: unknown, where: string): ProviderSettingSpec[] {
  if (!Array.isArray(value)) fail(where, "expected an array");
  const settings = value.map((entry, index) => parseSetting(entry, `${where}[${index}]`));
  const seen = new Set<string>();
  for (const setting of settings) {
    if (seen.has(setting.key)) fail(where, `duplicate setting "${setting.key}"`);
    seen.add(setting.key);
  }
  return settings;
}

function parseUsable(value: unknown, where: string): ProviderUsableSpec {
  const raw = record(value, where);
  return {
    apiKey: flag(raw.apiKey, `${where}.apiKey`),
    keylessLocal: flag(raw.keylessLocal, `${where}.keylessLocal`),
    baseUrl: flag(raw.baseUrl ?? false, `${where}.baseUrl`),
    always: flag(raw.always, `${where}.always`),
  };
}

function parseDiscovery(value: unknown, where: string): ProviderDiscoverySpec {
  const raw = record(value, where);
  return {
    strategy: choice<ProviderDiscoveryStrategy>(
      raw.strategy,
      DISCOVERY_STRATEGIES,
      `${where}.strategy`,
    ),
    listField: nullableText(raw.listField, `${where}.listField`),
    idField: text(raw.idField, `${where}.idField`),
    excludeSpeech: flag(raw.excludeSpeech, `${where}.excludeSpeech`),
    visionField: nullableText(raw.visionField, `${where}.visionField`),
  };
}

function parseUsage(value: unknown, where: string): ProviderUsageSpec {
  const raw = record(value ?? {}, where);
  const urls = raw.urls ?? [];
  if (!Array.isArray(urls)) fail(`${where}.urls`, "expected an array of URLs");
  const minIntervalSeconds = number(
    raw.minIntervalSeconds ?? DEFAULT_USAGE_MIN_INTERVAL_SECONDS,
    `${where}.minIntervalSeconds`,
  );
  if (!Number.isInteger(minIntervalSeconds) || minIntervalSeconds <= 0) {
    fail(`${where}.minIntervalSeconds`, "expected a whole number of seconds above zero");
  }
  return {
    probe: nullableChoice<ProviderProbeStrategy>(
      raw.probe,
      PROVIDER_PROBE_STRATEGIES,
      `${where}.probe`,
    ),
    urls: urls.map((entry, index) => endpointUrl(entry, `${where}.urls[${index}]`)),
    urlBase: choice<ProviderUsageUrlBase>(
      raw.urlBase ?? "origin",
      USAGE_URL_BASES,
      `${where}.urlBase`,
    ),
    urlGate: choice<ProviderUsageUrlGate>(
      raw.urlGate ?? "any",
      USAGE_URL_GATES,
      `${where}.urlGate`,
    ),
    minIntervalSeconds,
    primaryWindow: nullableChoice<ProviderUsageWindowLabel>(
      raw.primaryWindow,
      USAGE_WINDOW_LABELS,
      `${where}.primaryWindow`,
    ),
    resetsStyle: choice<ProviderUsageResetsStyle>(
      raw.resetsStyle ?? "relative",
      USAGE_RESETS_STYLES,
      `${where}.resetsStyle`,
    ),
    measures: choice<ProviderUsageMeasures>(
      raw.measures ?? "windows",
      USAGE_MEASURES,
      `${where}.measures`,
    ),
  };
}

function parseStrings(value: unknown, where: string): ProviderStringsSpec {
  const raw = record(value ?? {}, where);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw)) out[key] = text(entry, `${where}.${key}`);
  return out;
}

function parseWire(value: unknown, where: string): ProviderWireSpec {
  const raw = record(value ?? {}, where);
  return {
    format: choice<ProviderWireFormat>(
      raw.format ?? "chat-completions",
      WIRE_FORMATS,
      `${where}.format`,
    ),
    stampMessageIds: flag(raw.stampMessageIds ?? false, `${where}.stampMessageIds`),
    streamOptions: flag(raw.streamOptions ?? true, `${where}.streamOptions`),
    storeFlag: flag(raw.storeFlag ?? false, `${where}.storeFlag`),
    maxTokensField: choice<ProviderMaxTokensField>(
      raw.maxTokensField ?? "max_tokens",
      MAX_TOKENS_FIELDS,
      `${where}.maxTokensField`,
    ),
    parallelToolCalls: nullableFlag(raw.parallelToolCalls, `${where}.parallelToolCalls`),
    promptCacheKey: flag(raw.promptCacheKey ?? false, `${where}.promptCacheKey`),
    toolStream: flag(raw.toolStream ?? false, `${where}.toolStream`),
    thinking: nullableChoice<ProviderThinkingStyle>(
      raw.thinking,
      THINKING_STYLES,
      `${where}.thinking`,
    ),
    reasoningEffort: flag(raw.reasoningEffort ?? true, `${where}.reasoningEffort`),
    path: nullablePath(raw.path, `${where}.path`),
    apiKeyHeader: nullableText(raw.apiKeyHeader, `${where}.apiKeyHeader`),
  };
}

/** A request path must start with a slash so it appends to the base URL cleanly. */
function nullablePath(value: unknown, where: string): string | null {
  const path = nullableText(value, where);
  if (path !== null && !path.startsWith("/")) fail(where, "expected a path starting with /");
  return path;
}

function parseRateSchedule(value: unknown, where: string): RateSchedule | null {
  if (value === undefined || value === null) return null;
  const raw = record(value, where);
  if (!Array.isArray(raw.peakWindowsUtc)) fail(`${where}.peakWindowsUtc`, "expected an array");
  if (raw.peakWindowsUtc.length === 0) {
    fail(`${where}.peakWindowsUtc`, "expected at least one window: use null for no peak rate");
  }
  const minuteOfDay = (entry: unknown, at: string): number => {
    const minute = number(entry, at);
    if (!Number.isInteger(minute) || minute < 0 || minute > 1440) {
      fail(at, "expected a whole minute-of-day between 0 and 1440");
    }
    return minute;
  };
  const weekendOffsetMinutes = number(
    raw.weekendOffsetMinutes ?? 0,
    `${where}.weekendOffsetMinutes`,
  );
  if (!Number.isInteger(weekendOffsetMinutes) || Math.abs(weekendOffsetMinutes) > 1440) {
    fail(`${where}.weekendOffsetMinutes`, "expected a whole-minute offset within one day");
  }
  return {
    peakWindowsUtc: raw.peakWindowsUtc.map((entry, index) => {
      const at = `${where}.peakWindowsUtc[${index}]`;
      const win = record(entry, at);
      const startMinute = minuteOfDay(win.startMinute, `${at}.startMinute`);
      const endMinute = minuteOfDay(win.endMinute, `${at}.endMinute`);
      // Half-open windows: a reversed or empty range would silently never fire.
      if (endMinute <= startMinute) fail(at, "expected endMinute > startMinute");
      return { startMinute, endMinute };
    }),
    weekendOffsetMinutes,
  };
}

function parseBilling(value: unknown, where: string): ProviderBillingSpec {
  const raw = record(value ?? {}, where);
  return {
    kind: choice<ProviderBillingKind>(raw.kind ?? "quota", PROVIDER_BILLING_KINDS, `${where}.kind`),
    schedule: parseRateSchedule(raw.schedule, `${where}.schedule`),
    peakModels: raw.peakModels === undefined ? [] : texts(raw.peakModels, `${where}.peakModels`),
    balance: parseBalance(raw.balance, `${where}.balance`),
  };
}

function parseBalance(value: unknown, where: string): ProviderBalanceSpec | null {
  if (value === undefined || value === null) return null;
  const raw = record(value, where);
  const url = endpointUrl(raw.url, `${where}.url`);
  return {
    url,
    shape: choice<ProviderBalanceShape>(raw.shape, PROVIDER_BALANCE_SHAPES, `${where}.shape`),
  };
}

function parseCost(value: unknown, where: string): ProviderCostSpec {
  const raw = record(value ?? {}, where);
  return {
    tier: choice<ProviderCostTier>(raw.tier ?? "standard", COST_TIERS, `${where}.tier`),
    ...(raw.toolResultTokens === undefined
      ? {}
      : { toolResultTokens: positiveInteger(raw.toolResultTokens, `${where}.toolResultTokens`) }),
    ...(raw.compactionTrigger === undefined
      ? {}
      : {
          compactionTrigger: fractionOfWindow(raw.compactionTrigger, `${where}.compactionTrigger`),
        }),
    ...(raw.keepImages === undefined
      ? {}
      : { keepImages: positiveInteger(raw.keepImages, `${where}.keepImages`) }),
  };
}

function parseClient(value: unknown, where: string): ProviderClientSpec {
  const raw = record(value, where);
  return {
    auth: choice<ProviderAuthStrategy>(raw.auth, AUTH_STRATEGIES, `${where}.auth`),
    transport: nullableChoice<ProviderTransportStrategy>(
      raw.transport,
      TRANSPORT_STRATEGIES,
      `${where}.transport`,
    ),
    allowMissingKey: flag(raw.allowMissingKey, `${where}.allowMissingKey`),
  };
}

function parseErrors(value: unknown, where: string, label: string): ProviderErrorsSpec {
  // Optional block: a minimal declaration gets the generic wording instead of
  // being rejected for omitting copy.
  const raw = record(value ?? {}, where);
  return {
    i18nPrefix:
      raw.i18nPrefix === undefined
        ? "custom"
        : choice<ProviderErrorI18nPrefix>(
            raw.i18nPrefix,
            PROVIDER_ERROR_I18N_PREFIXES,
            `${where}.i18nPrefix`,
          ),
    brands: raw.brands === undefined ? [label] : texts(raw.brands, `${where}.brands`),
    hosts: texts(raw.hosts ?? [], `${where}.hosts`),
    serverReport: choice<ProviderServerReport>(
      raw.serverReport ?? "standard",
      PROVIDER_SERVER_REPORTS,
      `${where}.serverReport`,
    ),
  };
}

function parseRouting(value: unknown, where: string): ProviderRoutingSpec {
  const raw = record(value ?? {}, where);
  return {
    staticCatalog: flag(raw.staticCatalog ?? false, `${where}.staticCatalog`),
    discoveredCatalog: flag(raw.discoveredCatalog ?? false, `${where}.discoveredCatalog`),
    checkedLast: flag(raw.checkedLast ?? false, `${where}.checkedLast`),
    foreignCatalog: flag(raw.foreignCatalog ?? false, `${where}.foreignCatalog`),
    modelScheme: nullableText(raw.modelScheme, `${where}.modelScheme`),
    qualifyModels: flag(raw.qualifyModels ?? false, `${where}.qualifyModels`),
  };
}

/** A server-owned window must fit the declared setting and reserve, so a
 *  declaration that cannot produce a positive prompt budget fails to load. */
function parseContext(
  value: unknown,
  where: string,
  settings: readonly ProviderSettingSpec[],
): ProviderContextSpec | null {
  if (value === undefined || value === null) return null;
  const raw = record(value, where);
  const setting = text(raw.setting, `${where}.setting`);
  if (!settings.some((entry) => entry.key === setting)) {
    fail(`${where}.setting`, `"${setting}" is not a declared setting`);
  }
  const outputReserve = number(raw.outputReserve, `${where}.outputReserve`);
  if (!Number.isInteger(outputReserve) || outputReserve <= 0) {
    fail(`${where}.outputReserve`, "expected a positive integer");
  }
  const defaultTokens = number(raw.defaultTokens, `${where}.defaultTokens`);
  if (!Number.isInteger(defaultTokens) || defaultTokens <= outputReserve) {
    fail(`${where}.defaultTokens`, "expected an integer above outputReserve");
  }
  return { setting, outputReserve, defaultTokens };
}

function parseModelId(value: unknown, where: string): ProviderModelIdSpec {
  if (value === undefined || value === null) return DEFAULT_PROVIDER_MODEL_ID;
  const raw = record(value, where);
  const labels: Record<string, string> = {};
  for (const [id, label] of Object.entries(record(raw.labels ?? {}, `${where}.labels`))) {
    labels[id] = text(label, `${where}.labels.${id}`);
  }
  return {
    stripPrefixes: texts(raw.stripPrefixes ?? [], `${where}.stripPrefixes`),
    stripOwner: flag(raw.stripOwner ?? false, `${where}.stripOwner`),
    labels,
  };
}

const REASONING_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const REASONING_CONTROLS: ReadonlySet<string> = new Set([
  "effort",
  "gemini-level",
  "gemini-budget",
  "cloudcode-budget",
  "none",
]);

function parseReasoningAliases(
  value: unknown,
  where: string,
): Partial<Record<ReasoningEffort, ReasoningEffort>> {
  const out: Partial<Record<ReasoningEffort, ReasoningEffort>> = {};
  for (const [key, mapped] of Object.entries(record(value ?? {}, where))) {
    out[choice<ReasoningEffort>(key, REASONING_LEVELS, where)] = choice<ReasoningEffort>(
      mapped,
      REASONING_LEVELS,
      `${where}.${key}`,
    );
  }
  return out;
}

function parseReasoningRules(value: unknown, where: string): ProviderReasoningRule[] {
  if (!Array.isArray(value)) fail(where, "expected an array");
  return value.map((entry, index) => {
    const at = `${where}[${index}]`;
    const raw = record(entry, at);
    const pattern = text(raw.pattern, `${at}.pattern`);
    try {
      new RegExp(pattern);
    } catch {
      fail(at, "invalid regular expression");
    }
    const efforts = subset<ReasoningEffort>(raw.efforts, REASONING_LEVELS, `${at}.efforts`);
    if (new Set(efforts).size !== efforts.length) fail(at, "duplicate effort");
    const budgets: Partial<Record<ReasoningEffort, number>> = {};
    for (const [key, value] of Object.entries(record(raw.budgets ?? {}, `${at}.budgets`))) {
      const level = choice<ReasoningEffort>(key, REASONING_LEVELS, at);
      const budget = number(value, at);
      if (!efforts.includes(level) || !Number.isInteger(budget) || budget < 1)
        fail(at, "invalid thinking budget");
      budgets[level] = budget;
    }
    const control = choice<ProviderReasoningControl>(
      raw.control ?? "effort",
      REASONING_CONTROLS,
      `${at}.control`,
    );
    if (
      (control === "gemini-budget" || control === "cloudcode-budget") &&
      efforts.some((level) => budgets[level] === undefined)
    )
      fail(at, "missing thinking budget");
    if (control === "none" && efforts.length) fail(at, "disabled control has efforts");
    return {
      pattern,
      efforts,
      budgets,
      control,
      aliases: parseReasoningAliases(raw.aliases, `${at}.aliases`),
      forcedThinking: flag(raw.forcedThinking ?? false, `${at}.forcedThinking`),
    };
  });
}

function parseProvider(value: unknown, source: string): ProviderSpec {
  const raw = record(value, source);
  const id = text(raw.id, `${source}: id`);
  const scope = `${source}: provider "${id}"`;
  const settings = parseSettings(raw.settings ?? [], `${scope}: settings`);
  const label = text(raw.label, `${scope}: label`);
  return {
    id,
    providerId: nullableChoice<ProviderID>(raw.providerId, PROVIDER_ID_SET, `${scope}: providerId`),
    label,
    // Optional so a minimal declaration still loads; the full name is a usable tag.
    shortLabel: raw.shortLabel === undefined ? label : text(raw.shortLabel, `${scope}: shortLabel`),
    groupLabelKey: text(raw.groupLabelKey, `${scope}: groupLabelKey`),
    pickerGroup: nullableText(raw.pickerGroup, `${scope}: pickerGroup`),
    order: number(raw.order, `${scope}: order`),
    precedence: nullableNumber(raw.precedence, `${scope}: precedence`),
    defaultModel: nullableText(raw.defaultModel, `${scope}: defaultModel`),
    knownCatalog: flag(raw.knownCatalog, `${scope}: knownCatalog`),
    models: texts(raw.models ?? [], `${scope}: models`),
    goModels: texts(raw.goModels ?? [], `${scope}: goModels`),
    speechModels: texts(raw.speechModels ?? [], `${scope}: speechModels`),
    modelId: parseModelId(raw.modelId, `${scope}: modelId`),
    vision: parseVision(raw.vision, `${scope}: vision`),
    modelFilter: nullableChoice<ProviderModelFilter>(
      raw.modelFilter,
      MODEL_FILTERS,
      `${scope}: modelFilter`,
    ),
    reasoningEfforts: subset<ReasoningEffort>(
      raw.reasoningEfforts ?? [],
      REASONING_LEVELS,
      `${scope}: reasoningEfforts`,
    ),
    reasoningAliases: parseReasoningAliases(raw.reasoningAliases, `${scope}: reasoningAliases`),
    reasoningRules: parseReasoningRules(raw.reasoningRules ?? [], `${scope}: reasoningRules`),
    endpoint: parseEndpoint(raw.endpoint, `${scope}: endpoint`),
    credentials: parseCredentials(raw.credentials, `${scope}: credentials`, settings, id),
    settings,
    settingsPanel: nullableChoice<ProviderSettingsPanel>(
      raw.settingsPanel,
      SETTINGS_PANELS,
      `${scope}: settingsPanel`,
    ),
    usable: parseUsable(raw.usable, `${scope}: usable`),
    setupGate: subset<ProviderSetupSource>(
      raw.setupGate ?? [],
      SETUP_SOURCES,
      `${scope}: setupGate`,
    ),
    pickerGate: nullableChoice<ProviderPickerGate>(
      raw.pickerGate,
      PICKER_GATES,
      `${scope}: pickerGate`,
    ),
    picker: flag(raw.picker ?? true, `${scope}: picker`),
    routing: parseRouting(raw.routing, `${scope}: routing`),
    modelsDev: nullableText(raw.modelsDev, `${scope}: modelsDev`),
    reasoningDefault:
      raw.reasoningDefault === undefined
        ? undefined
        : choice<ReasoningEffort>(
            raw.reasoningDefault,
            REASONING_LEVELS,
            `${scope}: reasoningDefault`,
          ),
    discovery: parseDiscovery(raw.discovery, `${scope}: discovery`),
    client: parseClient(raw.client, `${scope}: client`),
    context: parseContext(raw.context, `${scope}: context`, settings),
    errors: parseErrors(raw.errors, `${scope}: errors`, label),
    billing: parseBilling(raw.billing, `${scope}: billing`),
    cost: parseCost(raw.cost, `${scope}: cost`),
    wire: parseWire(raw.wire, `${scope}: wire`),
    usage: parseUsage(raw.usage, `${scope}: usage`),
    strings: parseStrings(raw.strings, `${scope}: strings`),
  };
}

/** Rejects duplicate ids across a set of provider documents. */
function assertUnique(specs: readonly ProviderSpec[]): void {
  const seenIds = new Set<string>();
  const seenProviders = new Set<string>();
  for (const spec of specs) {
    if (seenIds.has(spec.id)) fail(`provider "${spec.id}"`, "duplicate id");
    seenIds.add(spec.id);
    if (spec.providerId === null) continue;
    if (seenProviders.has(spec.providerId)) fail(`provider "${spec.id}"`, "duplicate providerId");
    seenProviders.add(spec.providerId);
  }
}

/** Validates a `{ providers: [...] }` document — an embedder's own registry. An empty
 *  set is valid: data is optional, so a build with no provider files must still parse. */
function parseRegistry(value: unknown): ProviderSpec[] {
  const root = record(value, "root");
  if (!Array.isArray(root.providers)) fail("root.providers", "expected an array");
  const specs = root.providers.map((entry, index) => parseProvider(entry, `providers[${index}]`));
  assertUnique(specs);
  return specs;
}

/** Parses every `providers/<id>.json`, rejecting a file whose name and id disagree. */
function loadProviderSpecs(): ProviderSpec[] {
  const specs = PROVIDER_DOCUMENTS.map((source) => {
    const label = `providers/${source.file}`;
    const spec = parseProvider(source.document, label);
    if (`${spec.id}.json` !== source.file) {
      fail(label, `declares id "${spec.id}" — the file must be named after its id`);
    }
    return spec;
  });
  assertUnique(specs);
  return specs;
}

/** Validate and normalize a provider registry document. Exported so embedders can
 *  load their own registry and tests can prove a provider needs no code edit. */
export function parseProviderRegistry(value: unknown): ProviderSpec[] {
  return parseRegistry(value);
}

/** Every catalog entry, one per providers/*.json file. */
export const PROVIDER_SPECS: readonly ProviderSpec[] = loadProviderSpecs();

const SPEC_BY_ID: ReadonlyMap<string, ProviderSpec> = new Map(
  PROVIDER_SPECS.map((spec) => [spec.id, spec]),
);

const SPEC_BY_PROVIDER: ReadonlyMap<ProviderID, ProviderSpec> = new Map(
  PROVIDER_SPECS.flatMap((spec) =>
    spec.providerId === null ? [] : [[spec.providerId, spec] as const],
  ),
);

/** Every routable entry, ascending by display/`order`. */
export const ROUTABLE_PROVIDER_SPECS: readonly ProviderSpec[] = [...PROVIDER_SPECS]
  .filter((spec) => spec.providerId !== null)
  .sort((a, b) => a.order - b.order);

/** Every entry, ascending by display/`order`. */
export function providerSpecsInOrder(): readonly ProviderSpec[] {
  return [...PROVIDER_SPECS].sort((a, b) => a.order - b.order);
}

/** A provider's declared setting, when it declares one with this key. */
export function providerSettingSpec(
  spec: ProviderSpec,
  key: string,
): ProviderSettingSpec | undefined {
  return spec.settings.find((setting) => setting.key === key);
}

/** Providers whose ids keep their native route even when a reseller serves them. */
export const FOREIGN_CATALOG_SPECS: readonly ProviderSpec[] = PROVIDER_SPECS.filter(
  (spec) => spec.providerId !== null && spec.routing.foreignCatalog,
);

/** Providers whose models.dev block supplies per-model reasoning ladders. */
export const MODELS_DEV_SPECS: readonly ProviderSpec[] = PROVIDER_SPECS.filter(
  (spec) => spec.providerId !== null && spec.modelsDev !== null,
);

/** Catalog entry by its catalog id (e.g. `opencode`), or undefined when unknown. */
export function providerSpec(id: string): ProviderSpec | undefined {
  return SPEC_BY_ID.get(id);
}

/** The floor between usage reads for a provider, in ms. The default lives here and
 *  nowhere else, so a caller that holds a spec never restates it. */
export function usageMinIntervalMs(spec: ProviderSpec | undefined): number {
  return (spec?.usage.minIntervalSeconds ?? DEFAULT_USAGE_MIN_INTERVAL_SECONDS) * 1000;
}

/** A provider's short model-prefix tag (`DS`), or "" when the id is undeclared. */
export function providerShortLabel(id: string): string {
  return providerSpec(id)?.shortLabel ?? "";
}

/** The peak/off-peak calendar a provider declares, or null when its rate never
 *  changes. Takes an id or an already-resolved spec, like `providerString`. */
export function providerRateSchedule(
  provider: string | ProviderSpec | undefined,
): RateSchedule | null {
  const spec = typeof provider === "string" ? providerSpec(provider) : provider;
  return spec?.billing.schedule ?? null;
}

/** Declared UI copy with `{name}` placeholders filled from `vars`; an unmatched
 *  placeholder stays literal. Undefined when the provider or key is undeclared, or
 *  the declared value is empty, so the caller keeps its own generic wording. */
export function providerString(
  provider: string | ProviderSpec | undefined,
  key: string,
  vars: Record<string, string> = {},
): string | undefined {
  const raw = (typeof provider === "string" ? providerSpec(provider) : provider)?.strings[key];
  if (!raw) return undefined;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}

/** True when a provider declares this id: the tolerant membership check, without
 *  building or destructuring a spec. */
export function providerDeclared(id: string): boolean {
  return SPEC_BY_ID.has(id);
}

/** A provider's effort ladder, or an empty ladder when the id is undeclared. */
export function providerReasoningEfforts(id: string): readonly ReasoningEffort[] {
  return (
    (PROVIDER_REASONING_EFFORTS as Record<string, readonly ReasoningEffort[] | undefined>)[id] ?? []
  );
}

const ERROR_BRANDS: ReadonlyMap<string, string> = new Map(
  PROVIDER_SPECS.flatMap((spec) => spec.errors.brands.map((brand) => [brand, spec.id] as const)),
);

const ERROR_HOSTS: readonly { suffix: string; id: string }[] = PROVIDER_SPECS.flatMap((spec) =>
  spec.errors.hosts.map((suffix) => ({ suffix: suffix.toLowerCase(), id: spec.id })),
);

/** Provider that declares `brand` as its wire error prefix, or undefined. */
export function providerForErrorBrand(brand: string): string | undefined {
  return ERROR_BRANDS.get(brand);
}

/** Provider that declares `url`'s host, or undefined. A host must equal the
 *  declared suffix or end with `.` + suffix, so a lookalike domain cannot match. */
export function providerForErrorHost(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return ERROR_HOSTS.find(({ suffix }) => host === suffix || host.endsWith(`.${suffix}`))?.id;
}

/** Regex alternation of every declared error brand, longest first. */
export function errorBrandPattern(): string {
  return PROVIDER_SPECS.flatMap((spec) => spec.errors.brands)
    .sort((a, b) => b.length - a.length)
    .map((brand) => brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

/** Catalog entry by catalog id; throws when providers.json has no such entry. */
export function requireProviderSpec(id: string): ProviderSpec {
  const spec = SPEC_BY_ID.get(id);
  if (!spec) throw new Error(`providers.json has no entry for "${id}"`);
  return spec;
}

/** The entry that routes a provider id. */
export function specForProvider(id: ProviderID): ProviderSpec {
  const spec = SPEC_BY_PROVIDER.get(id);
  if (!spec) throw new Error(`providers.json has no routable entry for "${id}"`);
  return spec;
}

/** One validated write from a settings patch. */
export interface ProviderSettingWrite {
  providerId: string;
  key: string;
  /** Empty string clears the stored value. */
  value: string;
}

/** Validate a client-supplied settings map against the declarations: only a
 *  declared catalog id and a declared setting key are accepted, so a patch can
 *  never invent a persisted field. */
export function parseProviderSettingsPatch(value: unknown): {
  writes: ProviderSettingWrite[];
  rejected: string[];
} {
  const writes: ProviderSettingWrite[] = [];
  const rejected: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { writes, rejected };
  }
  for (const [providerId, raw] of Object.entries(value)) {
    const spec = providerSpec(providerId);
    if (!spec || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      rejected.push(providerId);
      continue;
    }
    for (const [key, entryValue] of Object.entries(raw)) {
      if (typeof entryValue !== "string" || !spec.settings.some((s) => s.key === key)) {
        rejected.push(`${providerId}.${key}`);
        continue;
      }
      writes.push({ providerId, key, value: entryValue });
    }
  }
  return { writes, rejected };
}

/** A provider's default endpoint, optionally a named tier (e.g. OpenCode `go`). */
export function providerDefaultEndpoint(id: string, tier?: string): string | undefined {
  const endpoint = providerSpec(id)?.endpoint;
  if (!endpoint) return undefined;
  const tiered = tier ? endpoint.tiers[tier] : undefined;
  return tiered ?? endpoint.default ?? undefined;
}

/** Bare-id ownership rank, lowest first. */
export const PROVIDER_MODEL_PRECEDENCE: readonly ProviderID[] = PROVIDER_SPECS.filter(
  (spec): spec is ProviderSpec & { providerId: ProviderID; precedence: number } =>
    spec.providerId !== null && spec.precedence !== null,
)
  .sort((a, b) => a.precedence - b.precedence)
  .map((spec) => spec.providerId);

/** Every routable provider's static reasoning-effort ladder. */
export const PROVIDER_REASONING_EFFORTS: Record<ProviderID, readonly ReasoningEffort[]> =
  Object.fromEntries(
    PROVIDER_SPECS.filter((spec) => spec.providerId !== null).map((spec) => [
      spec.providerId,
      spec.reasoningEfforts,
    ]),
  ) as Record<ProviderID, readonly ReasoningEffort[]>;

function firstEnv(
  names: readonly string[],
  env: (name: string) => string | undefined,
): string | undefined {
  for (const name of names) {
    const value = env(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

/** (baseUrl, apiKey) for a provider, honouring the endpoint strategy in providers.json.
 *  The tuple rule holds per provider: whichever source supplies the base URL owns
 *  the key, so a stale env key never bleeds into a custom gateway. */
export function resolveProviderEndpoint(
  spec: ProviderSpec,
  options: ProviderCredentialContext & { tier?: string | null },
): ProviderEndpoint {
  const env = options.env ?? ((name: string) => process.env[name]);
  const readSetting = (path: string | null): string | undefined => readSettingValue(options, path);
  const publicKey = spec.credentials.publicKey ?? undefined;
  const { endpoint, credentials } = spec;

  if (endpoint.strategy === "fixed") {
    return { baseUrl: endpoint.default ?? undefined, apiKey: undefined };
  }

  const envKey = firstEnv(credentials.apiKeyEnv, env);
  const storedKey = readSetting(credentials.apiKeySetting);
  // Whichever source supplies the base URL owns the key, unless the provider
  // opts into `resolve` (Ollama), which falls back to the other source anyway.
  const tupleKey = (own: string | undefined, other: string | undefined): string | undefined =>
    own ?? (endpoint.keyTuple === "resolve" ? other : undefined);

  const envBaseUrl = firstEnv(credentials.baseUrlEnv, env);
  if (envBaseUrl) return { baseUrl: envBaseUrl, apiKey: tupleKey(envKey, storedKey) ?? publicKey };

  const storedBaseUrl = readSetting(credentials.baseUrlSetting);
  if (storedBaseUrl) {
    return { baseUrl: storedBaseUrl, apiKey: tupleKey(storedKey, envKey) ?? publicKey };
  }

  const tierUrl =
    endpoint.strategy === "tiered" && options.tier ? endpoint.tiers[options.tier] : undefined;
  return {
    baseUrl: tierUrl ?? endpoint.default ?? undefined,
    apiKey: envKey ?? storedKey ?? publicKey,
  };
}

/** True for a keyless localhost daemon (localhost / 127.0.0.1 / ::1). An
 *  unresolved endpoint counts as local, mirroring the Ollama default. */
export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Whether the model can run now: its provider has a usable credential, a local
 *  daemon, or no credential requirement at all. */
export function providerUsable(
  spec: ProviderSpec,
  context: ProviderCredentialContext & { endpoint: ProviderEndpoint },
): boolean {
  if (spec.usable.always) return true;
  if (spec.usable.apiKey && context.endpoint.apiKey) return true;
  const oauthField = spec.credentials.oauthConfig;
  if (oauthField && context.oauthToken?.(oauthField)) return true;
  if (spec.usable.keylessLocal && isLocalBaseUrl(context.endpoint.baseUrl)) return true;
  if (spec.usable.baseUrl && context.endpoint.baseUrl) return true;
  return spec.usable.always;
}

function readSettingValue(
  context: ProviderCredentialContext,
  path: string | null,
): string | undefined {
  if (!path) return undefined;
  const value = context.setting(path)?.trim();
  return value || undefined;
}

function credentialValue(
  spec: ProviderSpec,
  context: ProviderCredentialContext,
  kind: "apiKey" | "baseUrl",
): string | undefined {
  const env = context.env ?? ((name: string) => process.env[name]);
  const envNames = kind === "apiKey" ? spec.credentials.apiKeyEnv : spec.credentials.baseUrlEnv;
  const settingPath =
    kind === "apiKey" ? spec.credentials.apiKeySetting : spec.credentials.baseUrlSetting;
  return firstEnv(envNames, env) ?? readSettingValue(context, settingPath);
}

/** The API key a provider resolves from env-then-config, independent of any
 *  base-URL override (the `strict` tuple rule lives in `resolveProviderEndpoint`). */
export function providerApiKeyValue(
  spec: ProviderSpec,
  context: ProviderCredentialContext,
): string | undefined {
  return credentialValue(spec, context, "apiKey");
}

/** The base URL a provider resolves from env-then-config, before any default. */
export function providerBaseUrlValue(
  spec: ProviderSpec,
  context: ProviderCredentialContext,
): string | undefined {
  return credentialValue(spec, context, "baseUrl");
}

/** Whether any credential source this provider gates setup on is present. */
export function providerCountsAsConfigured(
  spec: ProviderSpec,
  context: ProviderCredentialContext,
): boolean {
  for (const source of spec.setupGate) {
    if (source === "apiKey" && providerApiKeyValue(spec, context)) return true;
    if (source === "baseUrl" && providerBaseUrlValue(spec, context)) return true;
    const oauthField = spec.credentials.oauthConfig;
    if (source === "oauth" && oauthField && context.oauthToken?.(oauthField)) return true;
  }
  return false;
}

/** The vision rules a provider declares, resolved through any `fromProvider` link.
 *  A provider absent from providers/ contributes no rules, so removing one can
 *  never break module load. */
export function providerVisionSpec(id: string): ProviderVisionSpec {
  const spec = providerSpec(id);
  if (!spec) return {};
  const inherited = spec.vision.fromProvider
    ? providerSpec(spec.vision.fromProvider)?.vision
    : undefined;
  if (!inherited) return spec.vision;
  return {
    models: inherited.models,
    patterns: inherited.patterns,
    predicate: inherited.predicate,
    refreshable: spec.vision.refreshable,
    stripSchemeAndTag: spec.vision.stripSchemeAndTag,
  };
}
