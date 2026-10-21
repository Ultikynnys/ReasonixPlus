/** Built-in model catalog and capability predicates, derived from providers.json. */

import {
  PROVIDER_IDS,
  PROVIDER_MODEL_PRECEDENCE,
  type ProviderID,
  providerSpec,
  providerSpecsInOrder,
  providerVisionSpec,
} from "./provider-registry.js";

export { PROVIDER_MODEL_PRECEDENCE };

/** The install's default model; a registry test pins it to DeepSeek's default. */
export const DEFAULT_MODEL = "deepseek-flash";

function catalogOf(id: ProviderID): readonly string[] {
  return providerSpec(id)?.models ?? [];
}

function tierCatalogOf(id: ProviderID): readonly string[] {
  return providerSpec(id)?.goModels ?? [];
}

function setOf(ids: readonly string[]): ReadonlySet<string> {
  return new Set(ids);
}

/** Models accepted by the official DeepSeek endpoint. Retired ids stay routable:
 *  the API forwards them to the current Flash build and bills at its price. */
export const SUPPORTED_OFFICIAL_MODELS: readonly string[] = catalogOf("deepseek");

/** OpenAI models accepted by the official OpenAI endpoint. */
export const OPENAI_MODELS: readonly string[] = catalogOf("openai");

/** Alias for backwards compatibility with consumers expecting the GPT-5.6 list. */
export const GPT56_MODELS: readonly string[] = OPENAI_MODELS;

/** Models accepted by Z.AI's general API endpoint. */
export const ZAI_MODELS: readonly string[] = catalogOf("zai");

/** Conversational models served by Xiaomi MiMo's OpenAI-compatible endpoint.
 *  Offline fallback only: the live catalog comes from GET /v1/models. */
export const MIMO_MODELS: readonly string[] = catalogOf("mimo");

/** MiMo speech-only ids (ASR/TTS), never offered as chat models. */
export const MIMO_SPEECH_MODELS: ReadonlySet<string> = setOf(
  providerSpec("mimo")?.speechModels ?? [],
);

/** MiMo's V2.6 conversational models accept images (and audio/video). */
export const MIMO_VISION_MODELS: ReadonlySet<string> = setOf(
  providerVisionSpec("mimo").models ?? [],
);

/** MiMo's V2.6 conversational models accept audio and video input, not just images. */
export function modelAcceptsAudioVideo(model: string | undefined | null): boolean {
  return typeof model === "string" && MIMO_VISION_MODELS.has(stripProviderQualifier(model));
}

/** Free models served through OpenCode Zen. */
export const OPENCODE_MODELS: readonly string[] = catalogOf("opencode");

/** OpenCode Go subscription models on the dedicated Go endpoint. Offline
 *  fallback only — the live catalog is synced from models.dev. */
export const OPENCODE_GO_MODELS: readonly string[] = tierCatalogOf("opencode");

/** Conversational model slugs served by the Experiential Labs gateway. Offline
 *  fallback only; a bare id that another catalog also serves keeps routing there. */
export const EXPERIENTIAL_MODELS: readonly string[] = catalogOf("experiential");

/** Unified models served through Google Antigravity OAuth and Cloud Code.
 *  Offline fallback only: live discovery via retrieveUserQuota is the truth. */
export const ANTIGRAVITY_MODELS: readonly string[] = catalogOf("gemini");

/** Compatibility export for existing consumers. */
export const GEMINI_MODELS = ANTIGRAVITY_MODELS;

/** Drops unusable Antigravity ids: internal chat/tab routing ids, duplicate
 *  vertex buckets, and legacy Gemini models between 2.0 and 3.1 inclusive. */
export function isUsableAntigravityModel(modelId: string | undefined | null): boolean {
  if (typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("_vertex")) return false;
  if (trimmed.startsWith("chat_") || trimmed.startsWith("tab_")) return false;

  const geminiMatch = trimmed.match(/^gemini-(\d+)(?:\.(\d+))?/i);
  if (geminiMatch) {
    const major = Number.parseInt(geminiMatch[1]!, 10);
    const minor = geminiMatch[2] !== undefined ? Number.parseInt(geminiMatch[2], 10) : 0;
    if (major === 2 || (major === 3 && minor <= 1)) {
      return false;
    }
  }

  return true;
}

export function isAntigravityModel(model: string | undefined | null): boolean {
  return (
    typeof model === "string" &&
    isUsableAntigravityModel(model) &&
    (model.startsWith("gemini-") || model.startsWith("claude-") || model.startsWith("gpt-oss-"))
  );
}

/** Model ids offered by the default endpoints and desktop model pickers: every
 *  provider whose registry entry opts into `knownCatalog`, in display order. */
export const KNOWN_MODELS: readonly string[] = providerSpecsInOrder()
  .filter((spec) => spec.knownCatalog)
  .flatMap((spec) => spec.models);

/** Friendly display labels for ambiguous or internal model IDs. */
export const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "gemini-pro-agent": "gemini-3.5-pro",
};

/** Returns the display label for a model id, applying friendly UI mappings. */
export function modelDisplayName(model: string | undefined | null): string {
  if (!model) return "";
  return MODEL_DISPLAY_NAMES[model] ?? model;
}

/** Static OpenCode vision catalog; a models.dev sync overrides it at runtime. */
export const OPENCODE_VISION_MODELS: ReadonlySet<string> = setOf(
  providerVisionSpec("opencode").models ?? [],
);

/** DeepSeek's native vision line. The official build is multimodal regardless of
 *  hosting, so an Ollama tag inherits image support (see `isOllamaDeepSeekVisionModel`). */
export const DEEPSEEK_FLASH_VISION_MODELS: ReadonlySet<string> = setOf(
  providerVisionSpec("deepseek").models ?? [],
);

/** Strips the `ollama/` scheme and any `:tag` quantization suffix —
 *  `ollama/deepseek-v4.1-flash:cloud` → `deepseek-v4.1-flash`. */
export function stripOllamaSchemeAndTag(model: string): string {
  return model.replace(/^ollama\//, "").replace(/:[^/]*$/, "");
}

/** True when `model` is an `ollama/`-prefixed copy of a natively multimodal
 *  DeepSeek id, which keeps image support even when the daemon's runtime probe
 *  was inconclusive. */
export function isOllamaDeepSeekVisionModel(model: string): boolean {
  if (!model.startsWith("ollama/")) return false;
  return DEEPSEEK_FLASH_VISION_MODELS.has(stripOllamaSchemeAndTag(model));
}

/** Providers that can appear in a `<provider>/<id>` model reference — every
 *  provider id; `ollama/` predates this scheme and shares it. */
const QUALIFIER_PROVIDERS: ReadonlySet<string> = new Set<ProviderID>(PROVIDER_IDS);

export interface ParsedModelRef {
  /** Qualifying provider, or null when the reference is a bare id. */
  provider: ProviderID | null;
  /** Wire id with any qualifier stripped. */
  id: string;
}

/** Splits `<provider>/<id>` into its parts. An unrecognized prefix is not a
 *  qualifier (only provider ids count): `foo/bar` stays one bare id. */
export function parseModelRef(model: string): ParsedModelRef {
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return { provider: null, id: trimmed };
  const prefix = trimmed.slice(0, slash);
  if (QUALIFIER_PROVIDERS.has(prefix)) {
    return { provider: prefix as ProviderID, id: trimmed.slice(slash + 1) };
  }
  return { provider: null, id: trimmed };
}

/** Prefixes a wire id with its provider:
 *  `qualifyModelRef("opencode", "mimo-v2.6-pro")` → `opencode/mimo-v2.6-pro`.
 *  An already-qualified id is rewritten, never stacked. */
export function qualifyModelRef(provider: ProviderID, model: string): string {
  return `${provider}/${parseModelRef(model).id}`;
}

/** The wire id: strips a recognized `<provider>/` qualifier. An unrecognized
 *  prefix belongs to the id and survives untouched. */
export function stripProviderQualifier(model: string): string {
  return parseModelRef(model).id;
}

interface VisionRule {
  models: ReadonlySet<string>;
  patterns: readonly RegExp[];
  antigravity: boolean;
  stripSchemeAndTag: boolean;
  /** A runtime sync may replace this catalog, so a caller-provided set wins. */
  refreshable: boolean;
}

/** Vision rules in display order, compiled once. */
const VISION_RULES: readonly VisionRule[] = providerSpecsInOrder()
  .filter((spec) => spec.providerId !== null)
  .map((spec) => {
    const rule = providerVisionSpec(spec.providerId as ProviderID);
    return {
      models: setOf(rule.models ?? []),
      patterns: (rule.patterns ?? []).map((pattern) => new RegExp(pattern)),
      antigravity: rule.predicate === "antigravity",
      stripSchemeAndTag: rule.stripSchemeAndTag === true,
      refreshable: rule.refreshable === true,
    };
  });

/** Model-id schemes that route to a provider (`ollama/`), data-declared. */
const MODEL_SCHEME_PREFIXES: readonly string[] = providerSpecsInOrder().flatMap((spec) =>
  spec.routing.modelScheme ? [spec.routing.modelScheme] : [],
);

/** Model ids that accept image attachments in user messages — the GPT family,
 *  DeepSeek's vision line, every Gemini model, and whatever a provider declares
 *  in providers.json. Drives the composer affordance, the @-mention conversion
 *  and the images hard gate.
 *
 *  `ollamaVision` holds `ollama/`-prefixed ids confirmed by runtime probing;
 *  `opencodeVision` replaces the static OpenCode set once models.dev syncs. */
export function modelAcceptsImages(
  model: string | undefined | null,
  ollamaVision?: ReadonlySet<string> | null,
  opencodeVision?: ReadonlySet<string> | null,
): boolean {
  if (typeof model !== "string") return false;
  const wireId = stripProviderQualifier(model);
  for (const rule of VISION_RULES) {
    // A refreshed catalog replaces the static set for the provider allowing it.
    const models = rule.refreshable && opencodeVision ? opencodeVision : rule.models;
    const candidate = rule.stripSchemeAndTag ? stripOllamaSchemeAndTag(model) : wireId;
    if (rule.antigravity && isAntigravityModel(wireId)) return true;
    if (models.has(candidate)) return true;
    if (rule.patterns.some((pattern) => pattern.test(candidate))) return true;
  }
  // A probed catalog stores scheme-prefixed ids, so it is keyed on the raw model.
  if (
    ollamaVision?.has(model) &&
    MODEL_SCHEME_PREFIXES.some((scheme) => model.startsWith(scheme))
  ) {
    return true;
  }
  return false;
}
