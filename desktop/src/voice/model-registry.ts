/**
 * Voice model registry: validates the declarations under `models/` and exposes
 * the ordered set the settings card and the transcriber work from.
 */

import type { TKey } from "../i18n";
import { VOICE_MODEL_DOCUMENTS, type VoiceModelId } from "./models.generated";

export type { VoiceModelId };

/** Which runtime loads and runs a voice model. */
export type VoiceEngine = "transformers" | "cactus" | "bark";

export interface VoiceModelOption {
  /** Declaration id: the `models/<id>.json` file name. */
  id: string;
  /** Persisted selection id, unique, and the key a model is resolved by. */
  modelId: VoiceModelId;
  engine: VoiceEngine;
  /** Settings card order, ascending. */
  order: number;
  /** The model a fresh install uses; exactly one declaration sets this. */
  default: boolean;
  name: string;
  shortName: string;
  /** Badge label shown on the settings card; null keeps the generic one. */
  badge: string | null;
  size: string;
  /** Parameter-count label. Null for models that do not publish one. */
  parameters: string | null;
  description: string;
  /**
   * The Hugging Face repo the model is fetched from. For `transformers` models
   * this is an ONNX repo consumed by the ASR pipeline; for `cactus` and `bark`
   * models it holds the weights archive named by `weightsFile`.
   */
  repoId: string;
  /** `cactus` and `bark` models only: the weights archive within `repoId`. */
  weightsFile: string | null;
  /** `bark` models only: the config file within `repoId` that the runtime reads. */
  configFile: string | null;
}

/** How an engine packages its weights: the archive suffix and whether it also reads a config file. */
export interface VoiceEngineArchive {
  /** Required suffix of a declaration's `weightsFile`. */
  suffix: string;
  /** True when the engine also needs the declaration's `configFile`. */
  configFile: boolean;
}

/** What the settings card says about an engine, and whether this build can run it. */
export interface VoiceEngineRuntime {
  /** i18n key for the engine label beside the model size; null shows no label. */
  labelKey: TKey | null;
  /** i18n key naming what the engine needs when this build cannot load it; null when it can. */
  requirementKey: TKey | null;
  /** Weights packaging, or null when the engine loads a whole ONNX repo instead. */
  archive: VoiceEngineArchive | null;
}

/**
 * Every engine a declaration may name, and the only place its packaging and
 * availability live. `bark` carries a requirement because the Bark weights are
 * entropy-coded MLX for Apple silicon, while this build loads ONNX through
 * transformers.js and `.cact` archives through Cactus.
 */
export const VOICE_ENGINES: Readonly<Record<VoiceEngine, VoiceEngineRuntime>> = {
  transformers: { labelKey: null, requirementKey: null, archive: null },
  cactus: {
    labelKey: "settings.voiceEngineCactus",
    requirementKey: null,
    archive: { suffix: ".cact", configFile: false },
  },
  bark: {
    labelKey: "settings.voiceEngineBark",
    requirementKey: "settings.voiceEngineBarkRequirement",
    archive: { suffix: ".bark", configFile: true },
  },
};

const ENGINES: ReadonlySet<string> = new Set(Object.keys(VOICE_ENGINES));

function fail(where: string, message: string): never {
  throw new Error(`voice-models: ${where}: ${message}`);
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
  if (typeof value !== "boolean") fail(where, "expected a boolean");
  return value;
}

function choice<T extends string>(value: unknown, allowed: ReadonlySet<string>, where: string): T {
  const raw = text(value, where);
  if (!allowed.has(raw)) {
    fail(where, `unsupported value "${raw}" (expected ${[...allowed].join(", ")})`);
  }
  return raw as T;
}

/** Validate one model document. Exported so tests can parse a synthetic model. */
export function parseVoiceModel(value: unknown, source: string): VoiceModelOption {
  const raw = record(value, source);
  const id = text(raw.id, `${source}: id`);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`${source}: id`, `invalid model id "${id}"`);
  const scope = `${source}: model "${id}"`;
  const engine = choice<VoiceEngine>(raw.engine, ENGINES, `${scope}: engine`);
  const { archive } = VOICE_ENGINES[engine];
  const weightsFile = nullableText(raw.weightsFile, `${scope}: weightsFile`);
  const configFile = nullableText(raw.configFile, `${scope}: configFile`);
  // The archive is the whole download for an archive engine, so its absence cannot
  // be recovered from anywhere else, and no other engine reads one.
  if (!archive) {
    if (weightsFile) fail(`${scope}: weightsFile`, `the ${engine} engine packages no archive`);
    if (configFile) fail(`${scope}: configFile`, `the ${engine} engine reads no config file`);
  } else {
    if (!weightsFile) fail(`${scope}: weightsFile`, `required for the ${engine} engine`);
    if (!weightsFile.endsWith(archive.suffix)) {
      fail(`${scope}: weightsFile`, `expected a ${archive.suffix} archive`);
    }
    if (archive.configFile && !configFile) {
      fail(`${scope}: configFile`, `required for the ${engine} engine`);
    }
    if (!archive.configFile && configFile) {
      fail(`${scope}: configFile`, `the ${engine} engine reads no config file`);
    }
  }
  return {
    id,
    modelId: text(raw.modelId, `${scope}: modelId`) as VoiceModelId,
    engine,
    order: number(raw.order, `${scope}: order`),
    default: raw.default === undefined ? false : flag(raw.default, `${scope}: default`),
    name: text(raw.name, `${scope}: name`),
    shortName: text(raw.shortName, `${scope}: shortName`),
    badge: nullableText(raw.badge, `${scope}: badge`),
    size: text(raw.size, `${scope}: size`),
    parameters: nullableText(raw.parameters, `${scope}: parameters`),
    description: text(raw.description, `${scope}: description`),
    repoId: text(raw.repoId, `${scope}: repoId`),
    weightsFile,
    configFile,
  };
}

/** True when this build can download and run a model. */
export function isVoiceModelAvailable(model: VoiceModelOption): boolean {
  return VOICE_ENGINES[model.engine].requirementKey === null;
}

/** Validate a whole registry document (`{ models: [...] }`), ordered by card order. */
export function parseVoiceModelRegistry(value: unknown): VoiceModelOption[] {
  const raw = record(value, "document");
  if (!Array.isArray(raw.models)) fail("models", "expected an array");
  const specs = raw.models.map((entry, index) => parseVoiceModel(entry, `models[${index}]`));
  // Voice input cannot run without a model and every consumer expects a resolved
  // spec, so an empty set is a load error rather than an empty feature.
  if (specs.length === 0) fail("models", "at least one model must be declared");
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.modelId)) fail("models", `duplicate modelId "${spec.modelId}"`);
    seen.add(spec.modelId);
  }
  const defaults = specs.filter((spec) => spec.default);
  if (defaults.length !== 1) {
    fail("models", `${defaults.length} models are marked default; exactly one must be`);
  }
  // A fresh install has to land on a model this build can actually run.
  const defaultModel = defaults[0]!;
  if (!isVoiceModelAvailable(defaultModel)) {
    fail(
      "models",
      `default "${defaultModel.modelId}" runs on the ${defaultModel.engine} engine, which this build does not load`,
    );
  }
  return specs.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Every declared model, in card order. Built from the generated barrel, so adding
 *  a model is a JSON file plus a sync, never a code edit. */
export const VOICE_MODELS: readonly VoiceModelOption[] = parseVoiceModelRegistry({
  models: VOICE_MODEL_DOCUMENTS.map((entry) => entry.document),
});

const BY_MODEL_ID: ReadonlyMap<string, VoiceModelOption> = new Map(
  VOICE_MODELS.map((model) => [model.modelId, model]),
);

const DEFAULT_MODEL: VoiceModelOption = VOICE_MODELS.find((model) => model.default)!;

/** The model a fresh install selects. */
export const DEFAULT_VOICE_MODEL_ID: VoiceModelId = DEFAULT_MODEL.modelId;

/** Model by selection id, or undefined when no declaration matches. */
export function voiceModelSpec(id: string): VoiceModelOption | undefined {
  return BY_MODEL_ID.get(id);
}

/** Model by selection id, falling back to the declared default when unknown. */
export function getVoiceModelOption(id: string): VoiceModelOption {
  return voiceModelSpec(id) ?? DEFAULT_MODEL;
}
