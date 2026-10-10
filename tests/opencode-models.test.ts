import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENCODE_MODELS_CACHE_TTL_MS,
  fetchOpencodeModels,
  isDiscoveredOpencodeModel,
  isOpencodeGoModel,
  loadOpencodeModelsCache,
  opencodeModelsCachePath,
  writeOpencodeModelsCache,
} from "../src/opencode-models.js";

const TEST_DIR = join(process.cwd(), ".tmp-test-opencode-models");

describe("opencode-models", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("extracts free models and vision models keyless", async () => {
    const fakeData = {
      opencode: {
        models: {
          "new-free-model": {
            id: "new-free-model",
            name: "New Free Model",
            attachment: true,
            cost: { input: 0, output: 0 },
          },
          "paid-model": {
            id: "paid-model",
            name: "Paid Model",
            attachment: false,
            cost: { input: 1.5, output: 2.0 },
          },
        },
      },
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    const snapshot = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
      credentialed: false,
    });

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.models).toContain("new-free-model");
    expect(snapshot.visionModels).toContain("new-free-model");
    expect(snapshot.models).not.toContain("paid-model");
    // Also contains static baseline models
    expect(snapshot.models).toContain("big-pickle");
  });

  it("includes paid Zen and Go models when credentialed", async () => {
    const fakeData = {
      opencode: {
        models: {
          "paid-zen": { cost: { input: 1.5, output: 2.0 } },
        },
      },
      "opencode-go": {
        models: {
          "go-only": { cost: { input: 0.5, output: 1 } },
          "go-free": { cost: { input: 0, output: 0 } },
        },
      },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    const snapshot = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
      credentialed: true,
    });

    expect(snapshot.models).toContain("paid-zen");
    expect(snapshot.models).toContain("go-only");
    expect(snapshot.models).toContain("go-free");

    // Go-only ids route to the Go endpoint; Zen ids do not.
    expect(isOpencodeGoModel("go-only", TEST_DIR)).toBe(true);
    expect(isOpencodeGoModel("paid-zen", TEST_DIR)).toBe(false);
    // Overlaps prefer Zen: a Zen id that also exists in Go is not Go-routed.
    expect(isOpencodeGoModel("paid-zen", TEST_DIR)).toBe(false);
  });

  it("drops paid models for a keyless caller but keeps them cached for a credentialed one", async () => {
    const fakeData = {
      opencode: { models: { "paid-zen": { cost: { input: 1 } } } },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    const keyless = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
      credentialed: false,
    });
    expect(keyless.models).not.toContain("paid-zen");

    // A later credentialed read reuses the same cache without another fetch.
    const credentialed = await fetchOpencodeModels({ homeDir: TEST_DIR, credentialed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(credentialed.models).toContain("paid-zen");
  });

  it("serves from cache when within TTL and force is false", async () => {
    writeOpencodeModelsCache(
      {
        models: ["cached-model"],
        freeModels: ["cached-model"],
        visionModels: ["cached-model"],
        goModels: [],
        checkedAt: Date.now() - 1000,
      },
      TEST_DIR,
    );

    const fetchImpl = vi.fn();
    const snapshot = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: false,
      credentialed: false,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshot.models).toContain("cached-model");
  });

  it("bypasses cache when force is true", async () => {
    writeOpencodeModelsCache(
      {
        models: ["old-cached-model"],
        freeModels: ["old-cached-model"],
        visionModels: [],
        goModels: [],
        checkedAt: Date.now() - 1000,
      },
      TEST_DIR,
    );

    const fakeData = {
      opencode: {
        models: {
          "refreshed-free-model": {
            id: "refreshed-free-model",
            cost: { input: 0, output: 0 },
          },
        },
      },
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    const snapshot = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
      credentialed: false,
    });

    expect(fetchImpl).toHaveBeenCalled();
    expect(snapshot.models).toContain("refreshed-free-model");
  });

  it("normalizes the pre-Go cache schema so an upgrade stays warm", () => {
    const path = opencodeModelsCachePath(TEST_DIR);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ models: ["legacy-model"], visionModels: [], checkedAt: Date.now() }),
      "utf8",
    );
    const cached = loadOpencodeModelsCache(TEST_DIR);
    expect(cached?.models).toContain("legacy-model");
    expect(cached?.freeModels).toContain("legacy-model");
    expect(cached?.goModels).toEqual([]);
  });

  it("logs loudly to stderr on fetch failure and reports error in snapshot (AntiSilentFallback)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("Network unreachable"));

    const snapshot = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
      credentialed: false,
    });

    expect(stderrSpy).toHaveBeenCalled();
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("reasonix: failed to fetch models.dev");
    expect(snapshot.error).toContain("Network unreachable");
    // Still includes baseline models
    expect(snapshot.models).toContain("big-pickle");
  });

  it("isDiscoveredOpencodeModel checks static catalog and cached discovery", () => {
    expect(isDiscoveredOpencodeModel("big-pickle", TEST_DIR)).toBe(true);
    // Static Go ids are recognized too.
    expect(isDiscoveredOpencodeModel("glm-5.3", TEST_DIR)).toBe(true);
    expect(isDiscoveredOpencodeModel("unknown-model", TEST_DIR)).toBe(false);

    writeOpencodeModelsCache(
      {
        models: ["custom-discovered-model"],
        freeModels: ["custom-discovered-model"],
        visionModels: [],
        goModels: [],
        checkedAt: Date.now(),
      },
      TEST_DIR,
    );

    expect(isDiscoveredOpencodeModel("custom-discovered-model", TEST_DIR)).toBe(true);
  });

  it("uses the documented cache TTL", () => {
    expect(OPENCODE_MODELS_CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});
