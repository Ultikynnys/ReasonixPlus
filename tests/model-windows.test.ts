/** Learned per-model context windows — persistence, TTL freshness, bounds, corruption. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LARGEST_WINDOW_TOKENS, SMALLEST_WINDOW_TOKENS } from "../src/context-window.js";
import {
  MODEL_WINDOW_TTL_MS,
  clampWindowTokens,
  contextTokensForLearnedModel,
  emptyModelWindows,
  learnModelWindow,
  learnedContextTokens,
  loadModelWindows,
  modelWindowsPath,
  saveModelWindows,
} from "../src/model-windows.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-windows-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("modelWindowsPath", () => {
  it("resolves under the reasonix home", () => {
    expect(modelWindowsPath("/home/u/.reasonix")).toBe(
      join("/home/u/.reasonix", "model-windows.json"),
    );
  });
});

describe("clampWindowTokens", () => {
  it("accepts a window inside the supported bounds", () => {
    expect(clampWindowTokens(32_768)).toBe(32_768);
    expect(clampWindowTokens(SMALLEST_WINDOW_TOKENS)).toBe(SMALLEST_WINDOW_TOKENS);
    expect(clampWindowTokens(LARGEST_WINDOW_TOKENS)).toBe(LARGEST_WINDOW_TOKENS);
  });

  it("rejects values no server could mean", () => {
    expect(clampWindowTokens(0)).toBeUndefined();
    expect(clampWindowTokens(-1)).toBeUndefined();
    expect(clampWindowTokens(Number.NaN)).toBeUndefined();
    expect(clampWindowTokens(SMALLEST_WINDOW_TOKENS - 1)).toBeUndefined();
    expect(clampWindowTokens(LARGEST_WINDOW_TOKENS + 1)).toBeUndefined();
  });
});

describe("learnModelWindow", () => {
  it("records a window without mutating the store it was given", () => {
    const store = emptyModelWindows();
    const next = learnModelWindow(store, "local/saluki-27b", 32_768, 1_000);
    expect(store.windows).toEqual({});
    expect(next.windows["local/saluki-27b"]).toEqual({ contextTokens: 32_768, at: 1_000 });
  });

  it("returns the store unchanged for an unusable window or blank id", () => {
    const store = emptyModelWindows();
    expect(learnModelWindow(store, "m", 10)).toBe(store);
    expect(learnModelWindow(store, "   ", 32_768)).toBe(store);
  });
});

describe("contextTokensForLearnedModel", () => {
  const store = learnModelWindow(emptyModelWindows(), "local/saluki-27b", 32_768, 1_000);

  it("returns a fresh entry", () => {
    expect(contextTokensForLearnedModel(store, "local/saluki-27b", 2_000)).toBe(32_768);
  });

  it("drops an entry once the TTL has passed", () => {
    expect(
      contextTokensForLearnedModel(store, "local/saluki-27b", 1_000 + MODEL_WINDOW_TTL_MS),
    ).toBe(undefined);
  });

  it("keeps an entry fresh across a small backwards clock jump", () => {
    expect(contextTokensForLearnedModel(store, "local/saluki-27b", 1_000 - 3_600_000)).toBe(32_768);
  });

  it("treats a far-future timestamp as stale rather than eternally fresh", () => {
    expect(
      contextTokensForLearnedModel(store, "local/saluki-27b", 1_000 - MODEL_WINDOW_TTL_MS - 1),
    ).toBe(undefined);
  });

  it("ignores an unknown model", () => {
    expect(contextTokensForLearnedModel(store, "gpt-6.1-sol", 2_000)).toBeUndefined();
  });
});

describe("loadModelWindows", () => {
  it("round-trips through disk", () => {
    const path = join(dir, "model-windows.json");
    saveModelWindows(
      learnModelWindow(emptyModelWindows(), "local/saluki-27b", 32_768, 1_000),
      path,
    );
    expect(loadModelWindows(path).windows["local/saluki-27b"]?.contextTokens).toBe(32_768);
  });

  it("returns an empty store for a missing file", () => {
    expect(loadModelWindows(join(dir, "absent.json")).windows).toEqual({});
  });

  it("returns an empty store for malformed JSON", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json", "utf8");
    expect(loadModelWindows(path).windows).toEqual({});
  });

  it("rejects an unknown store version", () => {
    const path = join(dir, "future.json");
    writeFileSync(path, JSON.stringify({ version: 2, windows: {} }), "utf8");
    expect(loadModelWindows(path).windows).toEqual({});
  });

  it("rejects an entry whose window is out of bounds", () => {
    const path = join(dir, "bounds.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, windows: { m: { contextTokens: 4, at: 1 } } }),
      "utf8",
    );
    expect(loadModelWindows(path).windows).toEqual({});
  });

  it("re-reads after another writer changes the file", () => {
    const path = join(dir, "model-windows.json");
    saveModelWindows(emptyModelWindows(), path);
    expect(learnedContextTokens("local/saluki-27b", 2_000, path)).toBeUndefined();
    saveModelWindows(
      learnModelWindow(emptyModelWindows(), "local/saluki-27b", 32_768, 1_000),
      path,
    );
    expect(learnedContextTokens("local/saluki-27b", 2_000, path)).toBe(32_768);
  });
});
