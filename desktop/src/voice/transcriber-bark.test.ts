// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const BARK_MODEL = "underdog/bark-3.0";

const { barkRuntimeStatus, installBarkRuntime, fetchBarkModel, transcribeWithBark } = vi.hoisted(
  () => ({
    barkRuntimeStatus: vi.fn(async () => ({ installed: true, dir: "/voice/runtimes/b", bytes: 10 })),
    installBarkRuntime: vi.fn(async () => ({
      installed: true,
      dir: "/voice/runtimes/b",
      bytes: 10,
    })),
    fetchBarkModel: vi.fn(async () => ({
      engine: "bark",
      repoId: "ConwayResearch/Underdog-Bark-3.0",
      revision: "85db2ad18ab4",
      files: [{ name: "model.bark", bytes: 12 }],
      bytes: 12,
    })),
    transcribeWithBark: vi.fn(async () => "hello from bark"),
  }),
);

vi.mock("./bark-engine", () => ({
  BARK_SAMPLE_RATE: 16000,
  barkRuntimeStatus,
  installBarkRuntime,
  fetchBarkModel,
  transcribeWithBark,
  removeBarkModel: vi.fn(async () => {}),
  installedBarkModels: vi.fn(async () => []),
}));

vi.mock("./whistle-engine", () => ({
  CACTUS_SAMPLE_RATE: 16000,
  CACTUS_MAX_SECONDS: 30,
  cactusSpeechEngine: {
    loadModel: vi.fn(async () => {}),
    transcribe: vi.fn(async () => ({ text: "", language: "en", ttftMs: 0, decodeTps: 0 })),
    isModelLoaded: false,
  },
}));

vi.mock("./whistle-weights", () => ({
  downloadWhistleWeights: vi.fn(async () => new Uint8Array()),
  getCachedWhistleWeights: vi.fn(async () => null),
  isWhistleWeightsCached: vi.fn(async () => false),
  deleteWhistleWeights: vi.fn(async () => {}),
}));

import { speechTranscriber } from "./transcriber";

describe("LocalSpeechTranscriber (Bark)", () => {
  beforeEach(() => {
    localStorage.clear();
    barkRuntimeStatus.mockClear();
    installBarkRuntime.mockClear();
    fetchBarkModel.mockClear();
    transcribeWithBark.mockClear();
    speechTranscriber.setModel(BARK_MODEL);
  });

  it("installs the runtime before fetching the weights", async () => {
    barkRuntimeStatus.mockResolvedValueOnce({ installed: false, dir: "/r", bytes: 0 });

    await speechTranscriber.downloadModel(BARK_MODEL);

    expect(installBarkRuntime).toHaveBeenCalledTimes(1);
    expect(fetchBarkModel).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`reasonix.voiceModel.downloaded.${BARK_MODEL}`)).toBe("true");
  });

  it("reuses an installed runtime instead of reinstalling it", async () => {
    await speechTranscriber.downloadModel(BARK_MODEL);

    expect(installBarkRuntime).not.toHaveBeenCalled();
    expect(fetchBarkModel).toHaveBeenCalledTimes(1);
    expect(barkRuntimeStatus).toHaveBeenCalledTimes(1);
  });

  it("transcribes through the host engine instead of a pipeline", async () => {
    const result = await speechTranscriber.transcribe(new Float32Array(16000));

    expect(result.text).toBe("hello from bark");
    expect(transcribeWithBark).toHaveBeenCalledTimes(1);
  });

  it("reports an empty transcript rather than returning blank text", async () => {
    transcribeWithBark.mockResolvedValueOnce("");

    await expect(speechTranscriber.transcribe(new Float32Array(16000))).rejects.toThrow(
      /No speech was recognized/,
    );
  });

  it("refuses a Transformers.js pipeline for a Bark model", async () => {
    await expect(speechTranscriber.getPipeline(BARK_MODEL)).rejects.toThrow(
      /Transformers\.js pipeline/,
    );
  });
});
