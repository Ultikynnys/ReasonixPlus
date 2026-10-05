/**
 * Download and cache the Whistle `.cact` weights (the Cactus speech model).
 *
 * The weights are ~16.9 MB and live on Hugging Face. They are fetched once and
 * stored in the Cache API so transcription never touches the network again.
 */

/** The minimal shape needed to locate a Cactus model's weights. */
export interface CactusWeightsRef {
  id: string;
  repoId: string;
  weightsFile?: string;
}

export interface WhistleDownloadProgress {
  loaded: number;
  total: number;
  /** 0..100, or 0 when the server does not send a content-length. */
  progress: number;
}

const WEIGHTS_CACHE = "cactus-needle-weights";
const DEFAULT_WEIGHTS_FILE = "whistle.cact";

/** The Hugging Face URL of a Cactus model's `.cact` weights. */
export function whistleWeightsUrl(model: CactusWeightsRef): string {
  const file = model.weightsFile ?? DEFAULT_WEIGHTS_FILE;
  return `https://huggingface.co/${model.repoId}/resolve/main/${file}`;
}

function concatChunks(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Streams the Whistle weights with progress reporting and caches them.
 * Returns the raw `.cact` bytes.
 */
export async function downloadWhistleWeights(
  model: CactusWeightsRef,
  onProgress?: (progress: WhistleDownloadProgress) => void,
): Promise<Uint8Array> {
  const url = whistleWeightsUrl(model);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Whistle weights (HTTP ${response.status}).`);
  }

  const total = Number(response.headers.get("content-length") ?? 0) || 0;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const report = () => {
    onProgress?.({
      loaded,
      total,
      progress: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
    });
  };

  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        report();
      }
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    chunks.push(buffer);
    loaded = buffer.length;
    report();
  }

  const bytes = concatChunks(chunks);
  if (bytes.length === 0) {
    throw new Error("Downloaded Whistle weights are empty.");
  }

  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(WEIGHTS_CACHE);
      await cache.put(
        url,
        new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }),
      );
    } catch (err) {
      console.warn("Failed to cache Whistle weights:", err);
    }
  }

  return bytes;
}

/** Returns the cached `.cact` bytes, or null when not present. */
export async function getCachedWhistleWeights(
  model: CactusWeightsRef,
): Promise<Uint8Array | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(WEIGHTS_CACHE);
    const cached = await cache.match(whistleWeightsUrl(model));
    if (!cached) return null;
    return new Uint8Array(await cached.arrayBuffer());
  } catch {
    return null;
  }
}

/** True when the Whistle weights are present in the local cache. */
export async function isWhistleWeightsCached(model: CactusWeightsRef): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(WEIGHTS_CACHE);
    return Boolean(await cache.match(whistleWeightsUrl(model)));
  } catch {
    return false;
  }
}

/** Removes the cached Whistle weights. */
export async function deleteWhistleWeights(model: CactusWeightsRef): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(WEIGHTS_CACHE);
    await cache.delete(whistleWeightsUrl(model));
  } catch (err) {
    console.warn("Failed to delete Whistle weights:", err);
  }
}
