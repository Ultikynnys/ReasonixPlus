/** Learned per-model context windows — persistence, TTL freshness, bounds, corruption. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LARGEST_WINDOW_TOKENS, SMALLEST_WINDOW_TOKENS } from "../src/context-window.js";
import {
  MODEL_WINDOW_TTL_MS,
  clampWindowTokens,
  contextTokensForLearnedModel,
  emptyModelWindows,
  forgetModelWindow,
  learnModelWindow,
  learnedContextTokens,
  loadModelWindows,
  modelWindowsPath,
  recordModelWindow,
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

describe("recordModelWindow", () => {
  it("writes a window the caller stated", () => {
    const path = join(dir, "w.json");
    recordModelWindow("local/saluki-27b", 131_072, { path, now: 1_000 });
    expect(loadModelWindows(path).windows["local/saluki-27b"]).toEqual({
      contextTokens: 131_072,
      at: 1_000,
    });
  });

  it("leaves a fresh entry alone when the value has not changed", () => {
    const path = join(dir, "w.json");
    recordModelWindow("local/saluki-27b", 131_072, { path, now: 1_000 });
    recordModelWindow("local/saluki-27b", 131_072, { path, now: 2_000 });
    expect(JSON.parse(readFileSync(path, "utf8")).windows["local/saluki-27b"].at).toBe(1_000);
  });

  it("refreshes a stale entry even at the same value", () => {
    const path = join(dir, "w.json");
    recordModelWindow("local/saluki-27b", 131_072, { path, now: 1_000 });
    recordModelWindow("local/saluki-27b", 131_072, { path, now: 10_000 + MODEL_WINDOW_TTL_MS });
    expect(JSON.parse(readFileSync(path, "utf8")).windows["local/saluki-27b"].at).toBe(
      10_000 + MODEL_WINDOW_TTL_MS,
    );
  });

  it("overwrites a window that no longer matches the server", () => {
    const path = join(dir, "w.json");
    recordModelWindow("local/saluki-27b", 131_072, { path, now: 1_000 });
    recordModelWindow("local/saluki-27b", 262_144, { path, now: 2_000 });
    expect(learnedContextTokens("local/saluki-27b", 3_000, path)).toBe(262_144);
  });

  it("ignores a value no server could have meant", () => {
    const path = join(dir, "absent.json");
    recordModelWindow("local/saluki-27b", 3, { path });
    recordModelWindow("  ", 131_072, { path });
    expect(loadModelWindows(path).windows).toEqual({});
  });

  it("does not throw when the store cannot be written", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "", "utf8");
    expect(() =>
      recordModelWindow("local/saluki-27b", 131_072, {
        path: join(blocker, "model-windows.json"),
      }),
    ).not.toThrow();
  });
});

describe("forgetModelWindow", () => {
  it("drops an entry so resolution falls back", () => {
    const path = join(dir, "w.json");
    recordModelWindow("local/saluki-27b", 131_072, { path, now: 1_000 });
    forgetModelWindow("local/saluki-27b", { path });
    expect(loadModelWindows(path).windows).toEqual({});
  });

  it("leaves other models alone", () => {
    const path = join(dir, "w.json");
    recordModelWindow("local/saluki-27b", 131_072, { path, now: 1_000 });
    recordModelWindow("local/other", 65_536, { path, now: 1_000 });
    forgetModelWindow("local/saluki-27b", { path });
    expect(Object.keys(loadModelWindows(path).windows)).toEqual(["local/other"]);
  });

  it("is a no-op for a model with no entry", () => {
    const path = join(dir, "w.json");
    recordModelWindow("local/saluki-27b", 131_072, { path, now: 1_000 });
    forgetModelWindow("local/absent", { path });
    expect(Object.keys(loadModelWindows(path).windows)).toEqual(["local/saluki-27b"]);
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
