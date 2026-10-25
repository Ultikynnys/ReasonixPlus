/**
 * Voice model selection and download cache: which model is active, and which
 * model files already sit in the local cache.
 */

import {
  DEFAULT_VOICE_MODEL_ID,
  VOICE_MODELS,
  type VoiceModelId,
  type VoiceModelOption,
  getVoiceModelOption,
  isVoiceModelAvailable,
  voiceModelSpec,
} from "./model-registry";
import { deleteWhistleWeights, isWhistleWeightsCached } from "./whistle-weights";

const STORAGE_KEY_ACTIVE = "reasonix.voiceModel";
const STORAGE_PREFIX_DOWNLOADED = "reasonix.voiceModel.downloaded.";
const VOICE_MODEL_CACHE = "transformers-cache";

export function cacheRequestBelongsToModel(request: Request, model: VoiceModelOption): boolean {
  return request.url.includes(model.repoId) || request.url.includes(model.modelId);
}

async function voiceModelCacheKeys(): Promise<readonly Request[]> {
  const cache = await caches.open(VOICE_MODEL_CACHE);
  return cache.keys();
}

export function getActiveVoiceModelId(): VoiceModelId {
  if (typeof localStorage === "undefined") {
    return DEFAULT_VOICE_MODEL_ID;
  }
  const stored = localStorage.getItem(STORAGE_KEY_ACTIVE);
  const spec = stored ? voiceModelSpec(stored) : undefined;
  // A stored id only holds while this build can run it; an inert engine falls back.
  if (stored && spec && isVoiceModelAvailable(spec)) {
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
  // An engine this build does not load has no cache, so nothing is ever present.
  if (!isVoiceModelAvailable(opt)) return false;

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
  for (const model of VOICE_MODELS) {
    if (await isVoiceModelDownloaded(model.modelId)) return true;
  }
  return false;
}

export async function deleteVoiceModelCache(id: VoiceModelId): Promise<void> {
  const opt = getVoiceModelOption(id);
  markVoiceModelDownloaded(id, false);
  if (!isVoiceModelAvailable(opt)) return;

  if (opt.engine === "cactus") {
    await deleteWhistleWeights(opt);
    if (getActiveVoiceModelId() === id) {
      setActiveVoiceModelId(DEFAULT_VOICE_MODEL_ID);
    }
    return;
  }

  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(VOICE_MODEL_CACHE);
      const keys = await voiceModelCacheKeys();
      for (const req of keys) {
        if (cacheRequestBelongsToModel(req, opt)) await cache.delete(req);
      }
    } catch {
      // Cache eviction is best-effort.
    }
  }

  // If the deleted model was active, switch back to default bundled model:
  if (getActiveVoiceModelId() === id) {
    setActiveVoiceModelId(DEFAULT_VOICE_MODEL_ID);
  }
}
