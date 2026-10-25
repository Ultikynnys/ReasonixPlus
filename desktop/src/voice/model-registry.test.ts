import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_MODEL_ID,
  VOICE_ENGINES,
  VOICE_MODELS,
  getVoiceModelOption,
  isVoiceModelAvailable,
  parseVoiceModel,
  parseVoiceModelRegistry,
  voiceModelSpec,
} from "./model-registry";
import { VOICE_MODEL_DOCUMENTS, VOICE_MODEL_IDS } from "./models.generated";

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
      expect(Boolean(archive?.configFile), model.id).toBe(model.configFile !== null);
    }
  });

  it("keeps the bark family inert while this build has no MLX loader", () => {
    expect(VOICE_ENGINES.bark.requirementKey).not.toBeNull();

    const bark = VOICE_MODELS.filter((model) => model.engine === "bark");
    expect(bark.length).toBeGreaterThan(0);
    for (const model of bark) {
      expect(isVoiceModelAvailable(model), model.id).toBe(false);
    }

    for (const engine of ["transformers", "cactus"] as const) {
      expect(VOICE_ENGINES[engine].requirementKey, engine).toBeNull();
      for (const model of VOICE_MODELS.filter((entry) => entry.engine === engine)) {
        expect(isVoiceModelAvailable(model), model.id).toBe(true);
      }
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

  it("requires a .bark archive and a config file for the bark engine", () => {
    const bark = parseOne({
      engine: "bark",
      weightsFile: "model.bark",
      configFile: "mlx/config.json",
    });
    expect(bark.weightsFile).toBe("model.bark");
    expect(bark.configFile).toBe("mlx/config.json");
    expect(isVoiceModelAvailable(bark)).toBe(false);

    expect(() => parseOne({ engine: "bark" })).toThrow(/weightsFile: required/);
    expect(() => parseOne({ engine: "bark", weightsFile: "model.bark" })).toThrow(
      /configFile: required/,
    );
    expect(() => parseOne({ engine: "bark", weightsFile: "model.cact" })).toThrow(
      /expected a \.bark archive/,
    );
    expect(() => parseOne({ configFile: "mlx/config.json" })).toThrow(/reads no config file/);
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

  it("rejects a model whose engine this build does not load as the default", () => {
    expect(() =>
      parseVoiceModelRegistry({
        models: [
          {
            ...BASE_MODEL,
            id: "acme-bark",
            modelId: "acme/bark",
            engine: "bark",
            weightsFile: "model.bark",
            configFile: "mlx/config.json",
            default: true,
          },
        ],
      }),
    ).toThrow(/which this build does not load/);
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
