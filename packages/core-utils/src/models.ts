/** Built-in model catalog and capability predicates shared by the daemon and desktop UI. */

import type { ProviderID } from "./reasoning-efforts.js";

export const DEFAULT_MODEL = "deepseek-flash";

/** Models accepted by the official DeepSeek endpoint. `deepseek-flash` is the
 *  current model (DeepSeek-V4.1-Flash: 1M context, native vision). The
 *  `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` ids are retired but
 *  still accepted: the API routes them to V4.1 Flash and bills at its price.
 *  `deepseek-v4-pro` retires 12:00 Beijing / 04:00 UTC on 2026-09-14. */
export const SUPPORTED_OFFICIAL_MODELS: readonly string[] = [
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
];

/** OpenAI models accepted by the official OpenAI endpoint. The bare `gpt-5.6` alias
 *  is intentionally absent — it was retired; stale configs clamp to the default
 *  model (see tests/config.test.ts "stale configs clamp"). */
export const OPENAI_MODELS: readonly string[] = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

/** Alias for backwards compatibility with consumers expecting the GPT-5.6 list. */
export const GPT56_MODELS: readonly string[] = OPENAI_MODELS;

/** Models accepted by Z.AI's general API endpoint. */
export const ZAI_MODELS: readonly string[] = [
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "glm-4.7",
  "glm-4.7-flash",
  "glm-4.7-flashx",
  "glm-4.6",
  "glm-4.6v",
  "glm-4.6v-flash",
  "glm-4.6v-flashx",
  "glm-4.5",
  "glm-4.5-air",
  "glm-4.5-x",
  "glm-4.5-airx",
  "glm-4.5-flash",
  "glm-4.5v",
  "glm-4-32b-0414-128k",
];

/** Conversational models served by Xiaomi MiMo's OpenAI-compatible endpoint.
 *  Offline fallback only: the live catalog is fetched from GET /v1/models.
 *  mimo-v2.5 and mimo-v2.5-pro are scheduled for deprecation (2026-10-21), so
 *  they must not be a default. Speech ids live in MIMO_SPEECH_MODELS (they are
 *  not chat models), and the same `mimo-*` ids resold through OpenCode route to
 *  their native provider (CATALOG_PROVIDERS order). */
export const MIMO_MODELS: readonly string[] = [
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro-ultraspeed",
  "mimo-v2.5-pro",
  "mimo-v2.5",
];

/** MiMo speech-only ids (ASR/TTS), never offered as chat models. */
export const MIMO_SPEECH_MODELS: ReadonlySet<string> = new Set([
  "mimo-v2.5-asr",
  "mimo-v2.5-tts",
  "mimo-v2.5-tts-voiceclone",
  "mimo-v2.5-tts-voicedesign",
]);

/** MiMo's V2.6 conversational models accept images (and audio/video). */
export const MIMO_VISION_MODELS: ReadonlySet<string> = new Set([
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro-ultraspeed",
]);
/** MiMo's V2.6 conversational models accept audio and video input, not just images. */
export function modelAcceptsAudioVideo(model: string | undefined | null): boolean {
  return typeof model === "string" && MIMO_VISION_MODELS.has(stripProviderQualifier(model));
}

/** Free models served through OpenCode Zen. */
export const OPENCODE_MODELS: readonly string[] = [
  "big-pickle",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "mimo-v2.5-free",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "ling-3.0-flash-fin-free",
  "deepseek-v4-flash-free",
  "glm-4.7-free",
  "glm-5-free",
  "minimax-m2.5-free",
  "minimax-m3-free",
  "qwen3.6-plus-free",
  "mimo-v2-flash-free",
  "mimo-v2-pro-free",
  "mimo-v2-omni-free",
  "kimi-k2.5-free",
  "grok-code",
  "hy3-free",
  "ring-2.6-1t-free",
  "longcat-2.0-free",
  "laguna-s-2.1-free",
  "nemotron-3-super-free",
  "ling-3.0-flash-free",
  "ling-3.0-tiny-free",
  "ling-2.6-flash-free",
  "north-mini-code-free",
  "minimax-m2.1-free",
  "hy3-preview-free",
  "x-preview-f-free",
  "trinity-large-preview-free",
];

/** OpenCode Go subscription models served through the dedicated Go endpoint
 *  (`https://opencode.ai/zen/go/v1`). Offline fallback only — the live catalog
 *  is synced from models.dev. Ids that also appear in OPENCODE_MODELS route to
 *  the Zen endpoint (the subscription/paid split is disambiguated by the
 *  OpenCode Console config, which the models.dev source cannot see). */
export const OPENCODE_GO_MODELS: readonly string[] = [
  "mimo-v2.6-pro",
  "mimo-v2.5",
  "grok-4.7",
  "longcat-2.5-preview-free",
  "glm-5.3-flash",
  "qwen3.8-max",
  "kimi-k3",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash-vision-exp",
  "longcat-2.0",
  "space-bunny",
  "minimax-m2.7",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "minimax-m3",
  "gpt-5.6-luna",
  "qwen3.8-flash",
  "glm-5.2",
  "hy3",
  "muse-spark-1.2-contributor",
  "claude-haiku-5-5",
  "gpt-6-luna",
  "deepseek-v4-pro",
  "hy4-preview",
  "muse-spark-1.3-contributor",
  "step-5-preview-free",
  "glm-5.3",
  "kimi-k2.7-code",
  "grok-4.6",
  "qwen3.7-plus",
  "deepseek-v4-flash",
];

/** Unified models served through Google Antigravity OAuth and Cloud Code.
 *  Offline fallback only: these ids are known to be served by Cloud Code, and
 *  non-tiered bare `gemini-3.x-flash` ids are NOT (they 404) — live discovery
 *  via retrieveUserQuota is the source of truth when signed in. */
export const ANTIGRAVITY_MODELS: readonly string[] = [
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-tiered",
  "gemini-3.7-flash-tiered",
  "gemini-3.8-flash-tiered",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

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
    // Filter legacy models between 2.0 and 3.1 (2.x and 3.0/3.1)
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

/** Model ids offered by the default endpoints and desktop model pickers. */
export const KNOWN_MODELS: readonly string[] = [
  ...SUPPORTED_OFFICIAL_MODELS,
  ...GPT56_MODELS,
  ...ZAI_MODELS,
  ...MIMO_MODELS,
  ...OPENCODE_MODELS,
  ...ANTIGRAVITY_MODELS,
];

/** Friendly display labels for ambiguous or internal model IDs. */
export const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "gemini-pro-agent": "gemini-3.5-pro",
};

/** Returns the display label for a model id, applying friendly UI mappings. */
export function modelDisplayName(model: string | undefined | null): string {
  if (!model) return "";
  return MODEL_DISPLAY_NAMES[model] ?? model;
}

export const OPENCODE_VISION_MODELS: ReadonlySet<string> = new Set([
  "mimo-v2.5-free",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "qwen3.6-plus-free",
  "mimo-v2-omni-free",
  "mimo-v2-pro-free",
  "kimi-k2.5-free",
  "x-preview-f-free",
]);

/** The current DeepSeek Flash line (V4.1 Flash) is natively multimodal; the two
 *  retired ids are routed to it, so they accept images too. `deepseek-v4-pro`
 *  is text-only (DeepSeek's table lists no vision for it). */
export const DEEPSEEK_FLASH_VISION_MODELS: ReadonlySet<string> = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  // Ollama's catalog spells the V4.1 Flash build with the full version.
  "deepseek-v4.1-flash",
]);

/** Strips the `ollama/` scheme and any `:tag` quantization suffix —
 *  `ollama/deepseek-v4.1-flash:cloud` → `deepseek-v4.1-flash`. */
export function stripOllamaSchemeAndTag(model: string): string {
  return model.replace(/^ollama\//, "").replace(/:[^/]*$/, "");
}

/** True when `model` is an `ollama/`-prefixed copy of a natively multimodal
 *  DeepSeek V4.1 Flash id. The official DeepSeek build of these ids is
 *  multimodal regardless of hosting, so a local/cloud Ollama tag inherits
 *  image support even when the daemon's runtime probe was inconclusive or
 *  mis-cached a text-only verdict. */
export function isOllamaDeepSeekVisionModel(model: string): boolean {
  if (!model.startsWith("ollama/")) return false;
  return DEEPSEEK_FLASH_VISION_MODELS.has(stripOllamaSchemeAndTag(model));
}

/** Providers that can appear in a `<provider>/<id>` model reference. Mirrors
 *  the daemon's ModelProvider union; `ollama/` predates this scheme and shares it. */
const QUALIFIER_PROVIDERS: ReadonlySet<string> = new Set<ProviderID>([
  "deepseek",
  "openai",
  "ollama",
  "gemini",
  "zai",
  "mimo",
  "opencode",
]);

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

/** Built-in catalog precedence (mirrors the daemon's CATALOG_PROVIDERS order:
 *  first match wins for a bare id). OpenCode also serves the paid/Go catalog
 *  through its live sync, so both lists count as "served by opencode". */
const PROVIDER_CATALOGS: readonly { provider: ProviderID; ids: readonly string[] }[] = [
  { provider: "deepseek", ids: SUPPORTED_OFFICIAL_MODELS },
  { provider: "openai", ids: OPENAI_MODELS },
  { provider: "zai", ids: ZAI_MODELS },
  { provider: "mimo", ids: MIMO_MODELS },
  { provider: "opencode", ids: [...new Set([...OPENCODE_MODELS, ...OPENCODE_GO_MODELS])] },
];

/** True when a bare `modelId` shown in `groupProvider`'s picker group would
 *  route to a DIFFERENT provider (an earlier catalog serves it too), so the
 *  entry needs a `<provider>/` qualifier there. Overlaps with later catalogs
 *  never qualify: the bare id already routes to this group's provider. */
export function needsProviderQualifier(groupProvider: ProviderID, modelId: string): boolean {
  const group = PROVIDER_CATALOGS.findIndex((c) => c.provider === groupProvider);
  if (group < 0) return false;
  return PROVIDER_CATALOGS.some((catalog, index) => index < group && catalog.ids.includes(modelId));
}

/** Model ids that accept image attachments in user messages — the GPT-5.6
 *  family, DeepSeek's vision line, and every Gemini model (natively
 *  multimodal). Drives the composer's paste/drop affordance, the daemon's
 *  @-mention conversion, and the images hard gate.
 *
 *  `ollamaVision` is the set of `ollama/`-prefixed ids confirmed vision-capable
 *  by runtime probing (see the daemon's `$ollama_models.visionModels`). When
 *  provided, an Ollama model in that set accepts images; when omitted, all
 *  Ollama models are treated as non-vision (conservative default). Non-Ollama
 *  ids are unaffected by this argument.
 *
 *  `opencodeVision` is the set of OpenCode model ids dynamically confirmed vision-capable
 *  via models.dev sync. When provided, it overrides the static OpenCode vision catalog. */
export function modelAcceptsImages(
  model: string | undefined | null,
  ollamaVision?: ReadonlySet<string> | null,
  opencodeVision?: ReadonlySet<string> | null,
): boolean {
  if (typeof model !== "string") return false;
  // Catalog membership matches the wire id, so `opencode/mimo-v2.6-pro` sees
  // the same vision verdict as the native id; ollama stays keyed on the full
  // id (its probe sets store `ollama/`-prefixed entries).
  const id = stripProviderQualifier(model);
  if (id.startsWith("gpt-")) return true;
  if (DEEPSEEK_FLASH_VISION_MODELS.has(id)) return true;
  if (id === "glm-5.3-flash" || /^glm-\d+(?:\.\d+)?v(?:-|$)/.test(id)) return true;
  if (MIMO_VISION_MODELS.has(id)) return true;
  if (opencodeVision ? opencodeVision.has(id) : OPENCODE_VISION_MODELS.has(id)) return true;
  if (isAntigravityModel(id)) return true;
  if (model.startsWith("ollama/") && ollamaVision && ollamaVision.has(model)) return true;
  if (isOllamaDeepSeekVisionModel(model)) return true;
  return false;
}
