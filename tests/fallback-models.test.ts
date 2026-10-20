import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFallbackModels, readConfig, saveFallbackModels } from "../src/config.js";

/** Backup models are a PRIORITY-ORDERED list: unlike the sorted allow-lists, the
 *  order the user saved is the order failover tries, so nothing here may reorder. */
describe("fallbackModels — ordered backup-model list for quota failover", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-fallback-models-"));
    path = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sanitizes fallbackModels[] like the other string-array fields", () => {
    writeFileSync(path, JSON.stringify({ fallbackModels: ["a", { x: 1 }, "b"] }));
    expect(readConfig(path).fallbackModels).toEqual(["a", "b"]);
  });

  it("defaults to [] when unset — no failover out of the box", () => {
    writeFileSync(path, JSON.stringify({}));
    expect(loadFallbackModels(path)).toEqual([]);
  });

  it("keeps the configured order and trims blanks", () => {
    writeFileSync(path, JSON.stringify({ fallbackModels: [" glm-4.6 ", "  ", "gpt-5.6-sol"] }));
    expect(loadFallbackModels(path)).toEqual(["glm-4.6", "gpt-5.6-sol"]);
  });

  it("dedupes in place instead of sorting — priority order must survive", () => {
    writeFileSync(path, JSON.stringify({ fallbackModels: ["c", "a", "c", "b", "a"] }));
    expect(loadFallbackModels(path)).toEqual(["c", "a", "b"]);
  });

  it("saveFallbackModels persists the exact order given", () => {
    writeFileSync(path, JSON.stringify({}));
    saveFallbackModels(["ollama/qwen3", "deepseek-v4-flash"], path);
    expect(loadFallbackModels(path)).toEqual(["ollama/qwen3", "deepseek-v4-flash"]);
    // Round-trips in the same order — this list is never canonicalized.
    expect(readConfig(path).fallbackModels).toEqual(["ollama/qwen3", "deepseek-v4-flash"]);
  });

  it("saveFallbackModels drops duplicates and blanks but never reorders", () => {
    writeFileSync(path, JSON.stringify({}));
    saveFallbackModels(["b", " a ", "b", "", "a"], path);
    expect(loadFallbackModels(path)).toEqual(["b", "a"]);
  });

  it("clearing the list removes the field entirely — failover off", () => {
    writeFileSync(path, JSON.stringify({ fallbackModels: ["a"] }));
    saveFallbackModels([], path);
    expect(loadFallbackModels(path)).toEqual([]);
    expect(readConfig(path).fallbackModels).toBeUndefined();
  });
});
