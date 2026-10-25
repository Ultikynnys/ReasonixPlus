import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_MODEL_ID,
  BARK_FORMATS,
  VOICE_ENGINES,
  VOICE_MODELS,
  getVoiceModelOption,
  isVoiceModelAvailable,
  parseVoiceModel,
  parseVoiceModelRegistry,
  voiceModelSpec,
  type VoiceEngine,
} from "./model-registry";
import { VOICE_MODEL_DOCUMENTS, VOICE_MODEL_IDS } from "./models.generated";
import { BARK_RUNTIME } from "./runtimes";

const DOCUMENTS = VOICE_MODEL_DOCUMENTS.map((entry) => entry.document as Record<string, unknown>);

const BASE_MODEL: Record<string, unknown> = {
  id: "acme-voice",
  modelId: "acme/voice",
  engine: "transformers",
  order: 50,
  name: "Acme Voice",
  shortName: "Acme",
  size: "~10 MB",
  description: "Synthetic model for schema tests.",
  repoId: "acme/voice-onnx",
};

const parseOne = (overrides: Record<string, unknown> = {}) =>
  parseVoiceModel({ ...BASE_MODEL, ...overrides }, "models/acme-voice.json");

describe("Voice model registry", () => {
  it("resolves one spec per declared model, in card order", () => {
    expect(VOICE_MODELS).toHaveLength(VOICE_MODEL_DOCUMENTS.length);
    expect(VOICE_MODELS.map((model) => model.modelId)).toEqual([...VOICE_MODEL_IDS]);
    const orders = VOICE_MODELS.map((model) => model.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("ships the files each engine's packaging requires", () => {
    for (const model of VOICE_MODELS) {
      const { archive } = VOICE_ENGINES[model.engine];
      expect(Boolean(archive), model.id).toBe(model.weightsFile !== null);
      const format = model.format ? BARK_FORMATS[model.format] : null;
      const needsLoader = format ? format.loader : archive?.loaderFile === true;
      expect(needsLoader, model.id).toBe(model.loaderFile !== null);
      expect(Boolean(format?.supportingFiles), model.id).toBe(
        model.supportingFiles.length > 0,
      );
    }
  });

  it("ships a loader for every declared engine, so every model is usable", () => {
    for (const engine of Object.keys(VOICE_ENGINES) as VoiceEngine[]) {
      expect(VOICE_ENGINES[engine].requirementKey, engine).toBeNull();
    }
    for (const model of VOICE_MODELS) {
      expect(isVoiceModelAvailable(model), model.id).toBe(true);
    }
  });

  it("names the host runtime the bark family installs on first use", () => {
    const bark = VOICE_MODELS.filter((model) => model.engine === "bark");
    expect(bark.length).toBeGreaterThan(0);
    expect(VOICE_ENGINES.bark.runtime).toBe(BARK_RUNTIME);
    for (const engine of ["transformers", "cactus"] as const) {
      expect(VOICE_ENGINES[engine].runtime, engine).toBeNull();
    }
    for (const model of bark) {
      const spec = BARK_FORMATS[model.format!];
      expect(model.loaderFile !== null, model.id).toBe(spec.loader);
      expect(model.weightsFile?.endsWith(spec.suffix), model.id).toBe(true);
    }
  });

  it("derives the default id from the single declaration marked default", () => {
    const defaults = DOCUMENTS.filter((document) => document.default === true);
    expect(defaults).toHaveLength(1);
    expect(DEFAULT_VOICE_MODEL_ID).toBe(defaults[0]!.modelId);
    expect(voiceModelSpec(DEFAULT_VOICE_MODEL_ID)?.default).toBe(true);
  });

  it("resolves a model by its selection id and falls back to the default", () => {
    for (const model of VOICE_MODELS) {
      expect(getVoiceModelOption(model.modelId)).toBe(model);
      expect(voiceModelSpec(model.modelId)).toBe(model);
    }
    expect(voiceModelSpec("retired-model")).toBeUndefined();
    expect(getVoiceModelOption("retired-model").modelId).toBe(DEFAULT_VOICE_MODEL_ID);
  });
});

describe("Voice model declarations", () => {
  it("accepts a complete declaration", () => {
    const spec = parseOne({ badge: "Fast", parameters: "12M" });
    expect(spec.modelId).toBe("acme/voice");
    expect(spec.badge).toBe("Fast");
    expect(spec.parameters).toBe("12M");
    expect(spec.default).toBe(false);
  });

  it("rejects an unknown engine", () => {
    expect(() => parseOne({ engine: "onnx" })).toThrow(/unsupported value "onnx"/);
  });

  it("requires a weights archive for an archive engine and rejects one elsewhere", () => {
    expect(() => parseOne({ engine: "cactus" })).toThrow(/weightsFile: required/);
    expect(() => parseOne({ weightsFile: "acme.cact" })).toThrow(/packages no archive/);
    expect(parseOne({ engine: "cactus", weightsFile: "acme.cact" }).weightsFile).toBe("acme.cact");
  });

  it("requires a .bark archive, an official loader and a padding for the bark format", () => {
    const bark = parseOne({
      engine: "bark",
      format: "bark",
      weightsFile: "model.bark",
      loaderFile: "bark_loader.py",
      paddingSeconds: 0.25,
    });
    expect(bark.weightsFile).toBe("model.bark");
    expect(bark.loaderFile).toBe("bark_loader.py");
    expect(bark.supportingFiles).toEqual([]);
    expect(bark.paddingSeconds).toBe(0.25);
    expect(isVoiceModelAvailable(bark)).toBe(true);

    expect(() => parseOne({ engine: "bark" })).toThrow(/weightsFile: required/);
    expect(() => parseOne({ engine: "bark", weightsFile: "model.bark" })).toThrow(
      /format: required/,
    );
    expect(() =>
      parseOne({ engine: "bark", format: "bark", weightsFile: "model.bark" }),
    ).toThrow(/loaderFile: required/);
    expect(() =>
      parseOne({
        engine: "bark",
        format: "bark",
        weightsFile: "model.bark",
        loaderFile: "bark_loader.py",
      }),
    ).toThrow(/paddingSeconds: required/);
    expect(() =>
      parseOne({
        engine: "bark",
        format: "bark",
        weightsFile: "model.safetensors",
        loaderFile: "bark_loader.py",
        paddingSeconds: 0,
      }),
    ).toThrow(/expected a \.bark file/);
    expect(() => parseOne({ loaderFile: "bark_loader.py" })).toThrow(/reads no loader/);
    expect(() => parseOne({ paddingSeconds: 0.25 })).toThrow(/takes no padding/);
    expect(() =>
      parseOne({
        engine: "bark",
        format: "bark",
        weightsFile: "model.bark",
        loaderFile: "bark_loader.py",
        paddingSeconds: -1,
      }),
    ).toThrow(/non-negative/);
  });

  it("takes a plain checkpoint for the safetensors format", () => {
    const checkpoint = parseOne({
      engine: "bark",
      format: "safetensors",
      weightsFile: "model.safetensors",
      supportingFiles: ["config.json", "tokenizer.json"],
      paddingSeconds: 0.25,
    });
    expect(checkpoint.format).toBe("safetensors");
    expect(checkpoint.loaderFile).toBeNull();
    expect(checkpoint.supportingFiles).toEqual(["config.json", "tokenizer.json"]);

    expect(() =>
      parseOne({
        engine: "bark",
        format: "safetensors",
        weightsFile: "model.safetensors",
        paddingSeconds: 0.25,
      }),
    ).toThrow(/supportingFiles: required/);
    expect(() =>
      parseOne({
        engine: "bark",
        format: "safetensors",
        weightsFile: "model.safetensors",
        loaderFile: "bark_loader.py",
        supportingFiles: ["config.json"],
        paddingSeconds: 0.25,
      }),
    ).toThrow(/reads no loader/);
    expect(() =>
      parseOne({
        engine: "bark",
        format: "safetensors",
        weightsFile: "model.bark",
        supportingFiles: ["config.json"],
        paddingSeconds: 0.25,
      }),
    ).toThrow(/expected a \.safetensors file/);
    expect(() =>
      parseOne({
        engine: "bark",
        format: "gguf",
        weightsFile: "model.bark",
        loaderFile: "bark_loader.py",
        paddingSeconds: 0.25,
      }),
    ).toThrow(/expected bark or safetensors/);
    expect(() =>
      parseOne({ format: "safetensors", supportingFiles: ["config.json"] }),
    ).toThrow(/only the bark engine declares a format/);
  });

  it("rejects an id a file name cannot carry", () => {
    expect(() => parseOne({ id: "Acme Voice" })).toThrow(/invalid model id/);
    expect(() => parseOne({ id: "acme/voice" })).toThrow(/invalid model id/);
  });

  it("names the offending declaration when a field is missing", () => {
    expect(() => parseOne({ repoId: "" })).toThrow(/models\/acme-voice\.json/);
    expect(() => parseOne({ modelId: undefined })).toThrow(/modelId/);
  });

  it("rejects a duplicate selection id", () => {
    expect(() =>
      parseVoiceModelRegistry({
        models: [
          { ...BASE_MODEL, default: true },
          { ...BASE_MODEL, id: "acme-duplicate" },
        ],
      }),
    ).toThrow(/duplicate modelId "acme\/voice"/);
  });

  it("requires exactly one default model and at least one model", () => {
    expect(() => parseVoiceModelRegistry({ models: [] })).toThrow(/at least one model/);
    expect(() => parseVoiceModelRegistry({ models: [BASE_MODEL] })).toThrow(
      /0 models are marked default/,
    );
    expect(() =>
      parseVoiceModelRegistry({
        models: [
          { ...BASE_MODEL, default: true },
          { ...BASE_MODEL, id: "acme-two", modelId: "acme/two", default: true },
        ],
      }),
    ).toThrow(/2 models are marked default/);
  });

  it("orders the registry by card order", () => {
    const specs = parseVoiceModelRegistry({
      models: [
        { ...BASE_MODEL, default: true, order: 30 },
        { ...BASE_MODEL, id: "acme-early", modelId: "acme/early", order: 10 },
      ],
    });
    expect(specs.map((spec) => spec.id)).toEqual(["acme-early", "acme-voice"]);
  });
});
