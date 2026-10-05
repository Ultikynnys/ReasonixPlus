// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

interface EngineText {
  text: string;
  language: string;
  ttftMs: number;
  decodeTps: number;
}

const { loadModel, engineTranscribe, engineState, downloadWhistleWeights, getCachedWhistleWeights } =
  vi.hoisted(() => ({
    engineState: { loaded: false },
    loadModel: vi.fn(async (_bytes: Uint8Array): Promise<void> => {}),
    engineTranscribe: vi.fn(
      async (_pcm: Float32Array): Promise<EngineText> => ({
        text: "hello there",
        language: "en",
        ttftMs: 1,
        decodeTps: 2,
      }),
    ),
    downloadWhistleWeights: vi.fn(async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3])),
    getCachedWhistleWeights: vi.fn(
      async (): Promise<Uint8Array | null> => new Uint8Array([4, 5, 6]),
    ),
  }));

vi.mock("./whistle-engine", () => ({
  CACTUS_SAMPLE_RATE: 16000,
  CACTUS_MAX_SECONDS: 30,
  cactusSpeechEngine: {
    loadModel,
    transcribe: engineTranscribe,
    get isModelLoaded() {
      return engineState.loaded;
    },
  },
}));

vi.mock("./whistle-weights", () => ({
  downloadWhistleWeights,
  getCachedWhistleWeights,
  isWhistleWeightsCached: vi.fn(async () => false),
  deleteWhistleWeights: vi.fn(async () => {}),
}));

import { speechTranscriber } from "./transcriber";

describe("LocalSpeechTranscriber (Cactus / Whistle)", () => {
  beforeEach(() => {
    localStorage.clear();
    engineState.loaded = false;
    loadModel.mockClear();
    engineTranscribe.mockClear();
    downloadWhistleWeights.mockClear();
    getCachedWhistleWeights.mockClear();
    speechTranscriber.setModel("whisper-tiny.en");
    speechTranscriber.setModel("whistle");
  });

  it("transcribes through the Cactus engine, loading cached weights", async () => {
    const result = await speechTranscriber.transcribe(new Float32Array(16000));
    expect(result.text).toBe("hello there");
    expect(getCachedWhistleWeights).toHaveBeenCalledTimes(1);
    expect(loadModel).toHaveBeenCalledTimes(1);
    // A sub-30 s recording is a single window: exactly one engine call, whole buffer.
    expect(engineTranscribe).toHaveBeenCalledTimes(1);
    expect(engineTranscribe.mock.calls[0]![0].length).toBe(16000);
  });

  it("transcribes a recording of exactly 30 s in a single engine call", async () => {
    await speechTranscriber.transcribe(new Float32Array(16000 * 30));
    expect(engineTranscribe).toHaveBeenCalledTimes(1);
    expect(engineTranscribe.mock.calls[0]![0].length).toBe(16000 * 30);
  });

  it("cuts audio longer than 30 s into sequential windows and joins the transcripts", async () => {
    // 61 s of audio exceeds the engine's 30 s per-call limit → 30 s, 30 s, 1 s.
    const result = await speechTranscriber.transcribe(new Float32Array(16000 * 61));
    expect(engineTranscribe).toHaveBeenCalledTimes(3);
    const sizes = engineTranscribe.mock.calls.map(([pcm]) => pcm.length);
    expect(sizes).toEqual([16000 * 30, 16000 * 30, 16000 * 1]);
    expect(result.text).toBe("hello there hello there hello there");
  });

  it("appends a shorter final window after a full 30 s window", async () => {
    // 30.5 s → a full 30 s window followed by a 0.5 s remainder.
    const result = await speechTranscriber.transcribe(new Float32Array(16000 * 30 + 8000));
    expect(engineTranscribe).toHaveBeenCalledTimes(2);
    const sizes = engineTranscribe.mock.calls.map(([pcm]) => pcm.length);
    expect(sizes).toEqual([16000 * 30, 8000]);
    expect(result.text).toBe("hello there hello there");
  });

  it("does not emit an empty trailing window at an exact 30 s multiple", async () => {
    await speechTranscriber.transcribe(new Float32Array(16000 * 60));
    expect(engineTranscribe).toHaveBeenCalledTimes(2);
    const sizes = engineTranscribe.mock.calls.map(([pcm]) => pcm.length);
    expect(sizes).toEqual([16000 * 30, 16000 * 30]);
  });

  it("reports that the model must be downloaded when no weights are cached", async () => {
    getCachedWhistleWeights.mockResolvedValueOnce(null);
    await expect(speechTranscriber.transcribe(new Float32Array(16000))).rejects.toThrow(
      /not downloaded/,
    );
  });

  it("returns a friendly error when the engine finds no speech", async () => {
    engineTranscribe.mockResolvedValueOnce({
      text: "   ",
      language: "",
      ttftMs: 0,
      decodeTps: 0,
    });
    await expect(speechTranscriber.transcribe(new Float32Array(16000))).rejects.toThrow(
      /No speech was recognized/,
    );
  });

  it("downloads weights and loads them when the model is active", async () => {
    await speechTranscriber.downloadModel("whistle");
    expect(downloadWhistleWeights).toHaveBeenCalledTimes(1);
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("reasonix.voiceModel.downloaded.whistle")).toBe("true");
  });

  it("refuses getPipeline for a Cactus model", async () => {
    await expect(speechTranscriber.getPipeline("whistle")).rejects.toThrow(/Cactus engine/);
  });
});
