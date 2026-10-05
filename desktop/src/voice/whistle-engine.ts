/**
 * Cactus `needle` engine wrapper.
 *
 * Runs the Whistle speech-to-text `.cact` model, which the Transformers.js /
 * ONNX path cannot load. The engine is a process-global singleton: it is
 * loaded once and cannot unload weights, so exactly one Whistle archive is
 * loaded per page.
 *
 * The browser build (desktop/public/needle/) is an Emscripten module whose
 * factory is exposed as the global `createNeedle`. See desktop/public/needle/
 * README.md for the pinned export surface.
 */

export interface CactusTranscribeResult {
  text: string;
  language: string;
  ttftMs: number;
  decodeTps: number;
  words?: Array<{ word: string; start: number; end: number; probability: number }>;
}

export interface CactusTranscribeOptions {
  /** Force a language code (en, de, fr, es, it, nl, pl). Omit to detect it. */
  language?: string;
  /** Words/phrases to bias the search toward. */
  keywords?: readonly string[];
  /** Ask for per-word timestamps aligned from the decoder attention. */
  wordTimestamps?: boolean;
}

/** `NEEDLE_TEXT | NEEDLE_SPEECH` flags returned by `needle_models()`. */
const NEEDLE_SPEECH = 2;

/** 16 kHz mono, up to 30 s in one pass. */
export const CACTUS_SAMPLE_RATE = 16000;
export const CACTUS_MAX_SECONDS = 30;

/** Generous JSON output buffer (transcripts are capped at 320 tokens). */
const OUT_CAPACITY = 1 << 20;

const DEFAULT_BASE_PATH = "/needle/";

/**
 * The subset of the resolved Emscripten `Module` we use. Names are the
 * `_`-prefixed C exports confirmed from the vendored build.
 */
export interface CactusModule {
  readonly HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  UTF8ToString(ptr: number): string;
  // `needle_load`'s length is `unsigned long long` (i64); the Emscripten
  // WASM_BIGINT build requires a BigInt here, not a number.
  _needle_load(cactPtr: number, length: bigint): number;
  _needle_models(): number;
  _needle_last_error(): number;
  _needle_transcribe(
    pcmPtr: number,
    samples: number,
    languagePtr: number,
    keywordsPtr: number,
    wordTimestamps: number,
    outPtr: number,
    outCapacity: number,
  ): number;
}

export type CactusModuleFactory = (options: {
  locateFile: (path: string) => string;
}) => Promise<CactusModule>;

function loadClassicScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Cactus engine requires a DOM (no document available)."));
      return;
    }
    const existing = document.querySelector(`script[data-needle-engine="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.dataset.needleEngine = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load Cactus engine script ${src}.`));
    document.head.appendChild(el);
  });
}

async function defaultModuleFactory(options: {
  locateFile: (path: string) => string;
}): Promise<CactusModule> {
  const globalScope = globalThis as unknown as { createNeedle?: CactusModuleFactory };
  if (typeof document !== "undefined" && !globalScope.createNeedle) {
    await loadClassicScript(`${DEFAULT_BASE_PATH}needle.js`);
  }
  if (typeof globalScope.createNeedle !== "function") {
    throw new Error("Cactus needle engine failed to initialize (createNeedle is undefined).");
  }
  return globalScope.createNeedle(options);
}

function writeBytes(module: CactusModule, bytes: Uint8Array): number {
  const ptr = module._malloc(bytes.length);
  if (!ptr) throw new Error("Cactus engine is out of memory.");
  module.HEAPU8.set(bytes, ptr);
  return ptr;
}

function writeCString(module: CactusModule, value: string): number {
  const bytes = new TextEncoder().encode(value);
  const ptr = module._malloc(bytes.length + 1);
  if (!ptr) throw new Error("Cactus engine is out of memory.");
  module.HEAPU8.set(bytes, ptr);
  module.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}

function writeFloats(module: CactusModule, floats: Float32Array): number {
  const ptr = module._malloc(floats.length * 4);
  if (!ptr) throw new Error("Cactus engine is out of memory.");
  const view = new Float32Array(module.HEAPU8.buffer, ptr, floats.length);
  view.set(floats);
  return ptr;
}

function parseTranscribeJson(json: string): CactusTranscribeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Cactus engine returned malformed JSON: ${json.slice(0, 200)}`);
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const result: CactusTranscribeResult = {
    text: typeof obj.text === "string" ? obj.text : "",
    language: typeof obj.language === "string" ? obj.language : "",
    ttftMs: typeof obj.ttft_ms === "number" ? obj.ttft_ms : 0,
    decodeTps: typeof obj.decode_tps === "number" ? obj.decode_tps : 0,
  };
  if (Array.isArray(obj.words)) {
    result.words = obj.words.flatMap((entry) => {
      const w = (entry ?? {}) as Record<string, unknown>;
      if (typeof w.word !== "string") return [];
      return [
        {
          word: w.word,
          start: typeof w.start === "number" ? w.start : 0,
          end: typeof w.end === "number" ? w.end : 0,
          probability: typeof w.probability === "number" ? w.probability : 0,
        },
      ];
    });
  }
  return result;
}

export class CactusSpeechEngine {
  private modulePromise: Promise<CactusModule> | null = null;
  private modelLoaded = false;

  constructor(
    private readonly moduleFactory: CactusModuleFactory = defaultModuleFactory,
    private readonly basePath: string = DEFAULT_BASE_PATH,
  ) {}

  /** True once a `.cact` speech archive has been loaded into the engine. */
  get isModelLoaded(): boolean {
    return this.modelLoaded;
  }

  private ensureModule(): Promise<CactusModule> {
    if (!this.modulePromise) {
      this.modulePromise = this.moduleFactory({
        locateFile: (path) => `${this.basePath}${path}`,
      });
    }
    return this.modulePromise;
  }

  /**
   * Loads a Whistle `.cact` archive into the engine. Idempotent: the engine
   * holds one process-global speech model, so later calls are no-ops.
   */
  async loadModel(cact: Uint8Array): Promise<void> {
    if (this.modelLoaded) return;
    if (cact.length === 0) {
      throw new Error("Cannot load an empty Cactus model archive.");
    }
    const module = await this.ensureModule();
    const ptr = writeBytes(module, cact);
    try {
      const rc = module._needle_load(ptr, BigInt(cact.length));
      if (rc < 0) {
        throw new Error(
          module.UTF8ToString(module._needle_last_error()) || "Failed to load Cactus model.",
        );
      }
      const kinds = module._needle_models();
      if ((kinds & NEEDLE_SPEECH) === 0) {
        throw new Error("The loaded Cactus archive does not contain a speech model.");
      }
      this.modelLoaded = true;
    } finally {
      module._free(ptr);
    }
  }

  /**
   * Transcribes 16 kHz mono Float32 PCM into text. Returns an empty `text`
   * for silence and steady noise rather than an invented sentence.
   */
  async transcribe(
    pcm: Float32Array,
    options: CactusTranscribeOptions = {},
  ): Promise<CactusTranscribeResult> {
    if (!this.modelLoaded) {
      throw new Error("Whistle model is not loaded.");
    }
    if (pcm.length === 0) {
      throw new Error("No microphone audio was captured.");
    }
    if (pcm.length > CACTUS_SAMPLE_RATE * CACTUS_MAX_SECONDS) {
      const seconds = pcm.length / CACTUS_SAMPLE_RATE;
      throw new Error(
        `Whistle transcribes at most ${CACTUS_MAX_SECONDS} seconds (got ${seconds.toFixed(1)} s).`,
      );
    }

    const module = await this.ensureModule();
    let languagePtr = 0;
    let keywordsPtr = 0;
    let pcmPtr = 0;
    let outPtr = 0;

    try {
      if (options.language) languagePtr = writeCString(module, options.language);
      if (options.keywords && options.keywords.length > 0) {
        keywordsPtr = writeCString(module, options.keywords.join("\n"));
      }
      pcmPtr = writeFloats(module, pcm);
      outPtr = module._malloc(OUT_CAPACITY);
      if (!outPtr) throw new Error("Cactus engine is out of memory.");

      const tokens = module._needle_transcribe(
        pcmPtr,
        pcm.length,
        languagePtr,
        keywordsPtr,
        options.wordTimestamps ? 1 : 0,
        outPtr,
        OUT_CAPACITY,
      );
      if (tokens < 0) {
        throw new Error(
          module.UTF8ToString(module._needle_last_error()) || "Cactus transcription failed.",
        );
      }
      return parseTranscribeJson(module.UTF8ToString(outPtr));
    } finally {
      if (outPtr) module._free(outPtr);
      if (pcmPtr) module._free(pcmPtr);
      if (keywordsPtr) module._free(keywordsPtr);
      if (languagePtr) module._free(languagePtr);
    }
  }
}

/** Shared engine instance used by the app's voice transcriber. */
export const cactusSpeechEngine = new CactusSpeechEngine();
