import { describe, expect, it } from "vitest";
import {
  CACTUS_MAX_SECONDS,
  CACTUS_SAMPLE_RATE,
  type CactusModule,
  CactusSpeechEngine,
  type CactusModuleFactory,
} from "./whistle-engine";

interface TranscribeCall {
  samples: number;
  pcm: number[];
  language: string | null;
  keywords: string | null;
  wordTimestamps: number;
}

function makeFakeModule(overrides?: {
  loadResult?: number;
  models?: number;
  transcribeResult?: number;
  lastError?: string;
  outJson?: string;
}) {
  const buffer = new ArrayBuffer(1 << 22);
  const HEAPU8 = new Uint8Array(buffer);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const calls = { load: [] as Array<[number, bigint]>, transcribe: [] as TranscribeCall[] };
  let bump = 16;

  const module: CactusModule = {
    HEAPU8,
    _malloc(size: number) {
      const ptr = bump;
      bump = (bump + size + 7) & ~7;
      return ptr;
    },
    _free() {},
    UTF8ToString(ptr: number) {
      let end = ptr;
      while (HEAPU8[end] !== 0) end++;
      return decoder.decode(HEAPU8.subarray(ptr, end));
    },
    _needle_load(ptr: number, length: bigint) {
      calls.load.push([ptr, length]);
      return overrides?.loadResult ?? 0;
    },
    _needle_models() {
      return overrides?.models ?? 2; // NEEDLE_SPEECH
    },
    _needle_last_error() {
      const message = overrides?.lastError ?? "";
      const bytes = encoder.encode(`${message}\0`);
      const ptr = this._malloc(bytes.length);
      HEAPU8.set(bytes, ptr);
      return ptr;
    },
    _needle_transcribe(
      pcmPtr: number,
      samples: number,
      languagePtr: number,
      keywordsPtr: number,
      wordTimestamps: number,
      outPtr: number,
    ) {
      const pcm = Array.from(new Float32Array(buffer, pcmPtr, samples));
      calls.transcribe.push({
        samples,
        pcm,
        language: languagePtr ? this.UTF8ToString(languagePtr) : null,
        keywords: keywordsPtr ? this.UTF8ToString(keywordsPtr) : null,
        wordTimestamps,
      });
      const json =
        overrides?.outJson ??
        JSON.stringify({ text: "hello world", language: "en", ttft_ms: 12.5, decode_tps: 900 });
      HEAPU8.set(encoder.encode(`${json}\0`), outPtr);
      return overrides?.transcribeResult ?? 4;
    },
  };
  return { module, calls };
}

function engineWith(overrides?: Parameters<typeof makeFakeModule>[0]) {
  const { module, calls } = makeFakeModule(overrides);
  const factory: CactusModuleFactory = async () => module;
  return { engine: new CactusSpeechEngine(factory), module, calls };
}

describe("CactusSpeechEngine", () => {
  it("loads the .cact archive and confirms a speech model", async () => {
    const { engine, calls } = engineWith();
    await engine.loadModel(new Uint8Array([1, 2, 3, 4]));
    expect(engine.isModelLoaded).toBe(true);
    expect(calls.load).toHaveLength(1);
    expect(calls.load[0]![1]).toBe(4n);
  });

  it("is idempotent when loadModel is called twice", async () => {
    const { engine, calls } = engineWith();
    await engine.loadModel(new Uint8Array([1, 2, 3]));
    await engine.loadModel(new Uint8Array([1, 2, 3]));
    expect(calls.load).toHaveLength(1);
  });

  it("throws when the archive holds no speech model", async () => {
    const { engine } = engineWith({ models: 1 }); // NEEDLE_TEXT only
    await expect(engine.loadModel(new Uint8Array([1]))).rejects.toThrow(/does not contain a speech/);
  });

  it("surfaces needle_last_error when load fails", async () => {
    const { engine } = engineWith({ loadResult: -1, lastError: "bad archive" });
    await expect(engine.loadModel(new Uint8Array([1]))).rejects.toThrow(/bad archive/);
    expect(engine.isModelLoaded).toBe(false);
  });

  it("transcribes PCM, forwarding language and keywords, and parses JSON", async () => {
    const { engine, calls } = engineWith();
    await engine.loadModel(new Uint8Array([1]));

    const result = await engine.transcribe(new Float32Array([0.5, 0.25, -0.75]), {
      language: "de",
      keywords: ["Siobhan", "Krzysztof"],
    });

    expect(result).toEqual({ text: "hello world", language: "en", ttftMs: 12.5, decodeTps: 900 });
    expect(calls.transcribe).toHaveLength(1);
    const call = calls.transcribe[0]!;
    expect(call.samples).toBe(3);
    expect(call.pcm).toEqual([0.5, 0.25, -0.75]);
    expect(call.language).toBe("de");
    expect(call.keywords).toBe("Siobhan\nKrzysztof");
    expect(call.wordTimestamps).toBe(0);
  });

  it("returns empty text and language for silence", async () => {
    const { engine } = engineWith({
      outJson: JSON.stringify({ text: "", language: "", ttft_ms: 0, decode_tps: 0 }),
    });
    await engine.loadModel(new Uint8Array([1]));
    const result = await engine.transcribe(new Float32Array([0, 0, 0]));
    expect(result.text).toBe("");
    expect(result.language).toBe("");
  });

  it("refuses to transcribe before the model is loaded", async () => {
    const { engine } = engineWith();
    await expect(engine.transcribe(new Float32Array([0.1]))).rejects.toThrow(/not loaded/);
  });

  it("rejects audio longer than 30 seconds", async () => {
    const { engine } = engineWith();
    await engine.loadModel(new Uint8Array([1]));
    const tooLong = new Float32Array(CACTUS_SAMPLE_RATE * (CACTUS_MAX_SECONDS + 1));
    await expect(engine.transcribe(tooLong)).rejects.toThrow(/at most 30 seconds/);
  });

  it("surfaces needle_last_error when transcription fails", async () => {
    const { engine } = engineWith({ transcribeResult: -1, lastError: "decode failed" });
    await engine.loadModel(new Uint8Array([1]));
    await expect(engine.transcribe(new Float32Array([0.5]))).rejects.toThrow(/decode failed/);
  });

  it("resolves the wasm beside the JS under the configured base path", async () => {
    let seen: string | undefined;
    const { module } = makeFakeModule();
    const factory: CactusModuleFactory = async (options) => {
      seen = options.locateFile("needle.wasm");
      return module;
    };
    const engine = new CactusSpeechEngine(factory);
    await engine.loadModel(new Uint8Array([1]));
    expect(seen).toBe("/needle/needle.wasm");
  });
});
