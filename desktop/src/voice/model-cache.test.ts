// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  anyVoiceModelDownloaded,
  cacheRequestBelongsToModel,
  deleteVoiceModelCache,
  getActiveVoiceModelId,
  isVoiceModelDownloaded,
  markVoiceModelDownloaded,
  setActiveVoiceModelId,
} from "./model-cache";
import { DEFAULT_VOICE_MODEL_ID, VOICE_MODELS, isVoiceModelAvailable } from "./model-registry";

const WHISPER = VOICE_MODELS.filter((model) => model.engine === "transformers");
const CACTUS = VOICE_MODELS.filter((model) => model.engine === "cactus");
const OTHER = WHISPER.find((model) => model.modelId !== DEFAULT_VOICE_MODEL_ID) ?? WHISPER[0]!;
/** A declared model whose engine this build ships no loader for, when one exists. */
const INERT = VOICE_MODELS.find((model) => !isVoiceModelAvailable(model));

describe("Voice model selection", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to the declared default model", () => {
    expect(getActiveVoiceModelId()).toBe(DEFAULT_VOICE_MODEL_ID);
  });

  it("persists the selected model across reads", () => {
    setActiveVoiceModelId(OTHER.modelId);
    expect(getActiveVoiceModelId()).toBe(OTHER.modelId);
    expect(localStorage.getItem("reasonix.voiceModel")).toBe(OTHER.modelId);
  });

  it("ignores a stored id that no declaration provides", () => {
    localStorage.setItem("reasonix.voiceModel", "retired-model");
    expect(getActiveVoiceModelId()).toBe(DEFAULT_VOICE_MODEL_ID);
  });

  it.skipIf(!INERT)("ignores a stored id whose engine this build does not load", () => {
    localStorage.setItem("reasonix.voiceModel", INERT!.modelId);
    expect(getActiveVoiceModelId()).toBe(DEFAULT_VOICE_MODEL_ID);
  });
});

describe("Voice model download cache", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses one cache-request identity rule for the repo and the selection id", () => {
    expect(
      cacheRequestBelongsToModel(
        new Request(`https://huggingface.co/${OTHER.repoId}/resolve/main/encoder_model.onnx`),
        OTHER,
      ),
    ).toBe(true);
    expect(
      cacheRequestBelongsToModel(
        new Request(`https://cache.invalid/${OTHER.modelId}/decoder_model.onnx`),
        OTHER,
      ),
    ).toBe(true);
    expect(
      cacheRequestBelongsToModel(
        new Request("https://cache.invalid/another-model/encoder_model.onnx"),
        OTHER,
      ),
    ).toBe(false);
  });

  it("tracks and clears a downloaded model without a local archive", async () => {
    expect(await isVoiceModelDownloaded(OTHER.modelId)).toBe(false);

    markVoiceModelDownloaded(OTHER.modelId, true);
    expect(await isVoiceModelDownloaded(OTHER.modelId)).toBe(true);

    setActiveVoiceModelId(OTHER.modelId);
    await deleteVoiceModelCache(OTHER.modelId);
    expect(await isVoiceModelDownloaded(OTHER.modelId)).toBe(false);
    expect(getActiveVoiceModelId()).toBe(DEFAULT_VOICE_MODEL_ID);
  });

  it.skipIf(!INERT)("never reports an engine this build does not load as downloaded", async () => {
    const inert = INERT!;
    markVoiceModelDownloaded(inert.modelId, true);
    expect(await isVoiceModelDownloaded(inert.modelId)).toBe(false);

    setActiveVoiceModelId(inert.modelId);
    await deleteVoiceModelCache(inert.modelId);
    expect(getActiveVoiceModelId()).toBe(DEFAULT_VOICE_MODEL_ID);
  });

  it("reports whether any model is present locally", async () => {
    expect(await anyVoiceModelDownloaded()).toBe(false);

    const model = CACTUS[0] ?? OTHER;
    markVoiceModelDownloaded(model.modelId, true);
    expect(await anyVoiceModelDownloaded()).toBe(true);
  });
});
