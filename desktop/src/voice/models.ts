/**
 * Voice processing model registry and cache helpers.
 */

import { deleteWhistleWeights, isWhistleWeightsCached } from "./whistle-weights";

/** Which runtime loads and runs a voice model. */
export type VoiceEngine = "transformers" | "cactus";

export type VoiceModelId =
  | "whisper-tiny.en"
  | "Xenova/whisper-base.en"
  | "Xenova/whisper-small.en"
  | "whistle";

export interface VoiceModelOption {
  id: VoiceModelId;
  /** The runtime that loads and runs this model. */
  engine: VoiceEngine;
  name: string;
  shortName: string;
  size: string;
  /** Parameter-count label. Omitted for models that do not publish one. */
  parameters?: string;
  /** Short badge label shown on the settings card. */
  badge?: string;
  description: string;
  /**
   * The Hugging Face repo the model is fetched from. For `transformers`
   * models this is an ONNX repo consumed by the ASR pipeline; for `cactus`
   * models it holds the `.cact` weights file.
   */
  repoId: string;
  /** Cactus models only: the `.cact` file name within `repoId`. */
  weightsFile?: string;
}

export const DEFAULT_VOICE_MODEL_ID: VoiceModelId = "whisper-tiny.en";

export const VOICE_MODELS: ReadonlyArray<VoiceModelOption> = [
  {
    id: "whisper-tiny.en",
    engine: "transformers",
    name: "Whisper Tiny (English)",
    shortName: "Tiny",
    badge: "Balanced",
    size: "~40 MB",
    parameters: "39M",
    description: "Fastest transcription with lowest resource usage.",
    repoId: "onnx-community/whisper-tiny.en",
  },
  {
    id: "Xenova/whisper-base.en",
    engine: "transformers",
    name: "Whisper Base (English)",
    shortName: "Base",
    badge: "Balanced",
    size: "~75 MB",
    parameters: "74M",
    description: "Noticeably higher accuracy for daily speech with moderate speed.",
    repoId: "onnx-community/whisper-base.en",
  },
  {
    id: "Xenova/whisper-small.en",
    engine: "transformers",
    name: "Whisper Small (English)",
    shortName: "Small",
    badge: "High Accuracy",
    size: "~250 MB",
    parameters: "244M",
    description: "High accuracy speech recognition for accents, jargon, and noisy audio.",
    repoId: "onnx-community/whisper-small.en",
  },
  {
    id: "whistle",
    engine: "cactus",
    name: "Whistle (Multilingual)",
    shortName: "Whistle",
    badge: "Multilingual",
    size: "~17 MB",
    description:
      "Tiny multilingual speech recognition (en, de, fr, es, it, nl, pl) on the Cactus engine. No GPU required.",
    repoId: "Cactus-Compute/whistle",
    weightsFile: "whistle.cact",
  },
];

const STORAGE_KEY_ACTIVE = "reasonix.voiceModel";
const STORAGE_PREFIX_DOWNLOADED = "reasonix.voiceModel.downloaded.";
const VOICE_MODEL_CACHE = "transformers-cache";

export function cacheRequestBelongsToModel(request: Request, model: VoiceModelOption): boolean {
  return request.url.includes(model.repoId) || request.url.includes(model.id);
}

async function voiceModelCacheKeys(): Promise<readonly Request[]> {
  const cache = await caches.open(VOICE_MODEL_CACHE);
  return cache.keys();
}

export function getVoiceModelOption(id: string): VoiceModelOption {
  const found = VOICE_MODELS.find((m) => m.id === id);
  return found ?? VOICE_MODELS[0]!;
}

export function getActiveVoiceModelId(): VoiceModelId {
  if (typeof localStorage === "undefined") {
    return DEFAULT_VOICE_MODEL_ID;
  }
  const stored = localStorage.getItem(STORAGE_KEY_ACTIVE);
  if (stored && VOICE_MODELS.some((m) => m.id === stored)) {
    return stored as VoiceModelId;
  }
  return DEFAULT_VOICE_MODEL_ID;
}

export function setActiveVoiceModelId(id: VoiceModelId): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY_ACTIVE, id);
}

export function markVoiceModelDownloaded(id: VoiceModelId, downloaded = true): void {
  if (typeof localStorage === "undefined") return;
  const key = `${STORAGE_PREFIX_DOWNLOADED}${id}`;
  if (downloaded) {
    localStorage.setItem(key, "true");
  } else {
    localStorage.removeItem(key);
  }
}

export async function isVoiceModelDownloaded(id: VoiceModelId): Promise<boolean> {
  const opt = getVoiceModelOption(id);

  if (opt.engine === "cactus") {
    if (await isWhistleWeightsCached(opt)) {
      markVoiceModelDownloaded(id, true);
      return true;
    }
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(`${STORAGE_PREFIX_DOWNLOADED}${id}`) === "true";
    }
    return false;
  }

  // Check Web Cache API if available:
  if (typeof caches !== "undefined") {
    try {
      const keys = await voiceModelCacheKeys();
      const hasEncoder = keys.some(
        (req) => cacheRequestBelongsToModel(req, opt) && req.url.includes("encoder_model"),
      );
      const hasDecoder = keys.some(
        (req) => cacheRequestBelongsToModel(req, opt) && req.url.includes("decoder_model"),
      );
      if (hasEncoder && hasDecoder) {
        markVoiceModelDownloaded(id, true);
        return true;
      }
    } catch {
      // Ignore cache API errors and fallback to localStorage flag.
    }
  }

  if (typeof localStorage !== "undefined") {
    return localStorage.getItem(`${STORAGE_PREFIX_DOWNLOADED}${id}`) === "true";
  }

  return false;
}

/** True when at least one voice model is present in the local cache. */
export async function anyVoiceModelDownloaded(): Promise<boolean> {
  for (const m of VOICE_MODELS) {
    if (await isVoiceModelDownloaded(m.id)) return true;
  }
  return false;
}

export async function deleteVoiceModelCache(id: VoiceModelId): Promise<void> {
  const opt = getVoiceModelOption(id);

  if (opt.engine === "cactus") {
    markVoiceModelDownloaded(id, false);
    await deleteWhistleWeights(opt);
    if (getActiveVoiceModelId() === id) {
      setActiveVoiceModelId(DEFAULT_VOICE_MODEL_ID);
    }
    return;
  }

  markVoiceModelDownloaded(id, false);

  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(VOICE_MODEL_CACHE);
      const keys = await voiceModelCacheKeys();
      for (const req of keys) {
        if (cacheRequestBelongsToModel(req, opt)) await cache.delete(req);
      }
    } catch (e) {
      console.warn("Failed to delete voice model cache:", e);
    }
  }

  // If the deleted model was active, switch back to default bundled model:
  if (getActiveVoiceModelId() === id) {
    setActiveVoiceModelId(DEFAULT_VOICE_MODEL_ID);
  }
}
