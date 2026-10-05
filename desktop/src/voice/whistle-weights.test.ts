import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CactusWeightsRef,
  deleteWhistleWeights,
  downloadWhistleWeights,
  getCachedWhistleWeights,
  isWhistleWeightsCached,
  whistleWeightsUrl,
} from "./whistle-weights";

const MODEL: CactusWeightsRef = {
  id: "whistle",
  repoId: "Cactus-Compute/whistle",
  weightsFile: "whistle.cact",
};

class FakeCache {
  private store = new Map<string, Response>();
  async put(key: RequestInfo | URL, value: Response): Promise<void> {
    this.store.set(key.toString(), value);
  }
  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    return this.store.get(key.toString());
  }
  async delete(key: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(key.toString());
  }
}

class FakeCaches {
  private stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return cache;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function fakeResponse(
  chunks: Uint8Array[],
  opts?: { ok?: boolean; status?: number; total?: number },
): Response {
  const ok = opts?.ok ?? true;
  const status = opts?.status ?? 200;
  const total = opts?.total ?? chunks.reduce((n, c) => n + c.length, 0);
  let index = 0;
  return {
    ok,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-length" ? String(total) : null),
    },
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined },
      }),
    },
    arrayBuffer: async () => concat(chunks).buffer,
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("caches", new FakeCaches());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("whistle weights", () => {
  it("builds the Hugging Face resolve URL from the model", () => {
    expect(whistleWeightsUrl(MODEL)).toBe(
      "https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact",
    );
    expect(whistleWeightsUrl({ id: "x", repoId: "Org/repo" })).toBe(
      "https://huggingface.co/Org/repo/resolve/main/whistle.cact",
    );
  });

  it("streams, reports progress, caches, and returns the bytes", async () => {
    const partA = new Uint8Array([1, 2, 3]);
    const partB = new Uint8Array([4, 5]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse([partA, partB], { total: 5 })),
    );

    const seen: number[] = [];
    const bytes = await downloadWhistleWeights(MODEL, (p) => seen.push(p.progress));

    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([60, 100]);
    expect(await isWhistleWeightsCached(MODEL)).toBe(true);
    expect(Array.from((await getCachedWhistleWeights(MODEL)) ?? [])).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports zero progress when the server omits content-length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse([new Uint8Array([1, 2])], { total: 0 })),
    );
    const seen: number[] = [];
    await downloadWhistleWeights(MODEL, (p) => seen.push(p.progress));
    expect(seen).toEqual([0]);
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse([], { ok: false, status: 404 })),
    );
    await expect(downloadWhistleWeights(MODEL)).rejects.toThrow(/HTTP 404/);
  });

  it("throws when the downloaded weights are empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse([], { total: 0 })),
    );
    await expect(downloadWhistleWeights(MODEL)).rejects.toThrow(/empty/);
  });

  it("is not cached before download", async () => {
    expect(await isWhistleWeightsCached(MODEL)).toBe(false);
    expect(await getCachedWhistleWeights(MODEL)).toBeNull();
  });

  it("deletes the cached weights", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse([new Uint8Array([9, 9])], { total: 2 })),
    );
    await downloadWhistleWeights(MODEL);
    expect(await isWhistleWeightsCached(MODEL)).toBe(true);

    await deleteWhistleWeights(MODEL);
    expect(await isWhistleWeightsCached(MODEL)).toBe(false);
  });
});
