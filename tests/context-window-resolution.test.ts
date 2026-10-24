/** Window resolution: a server-owned window outranks everything, otherwise per-model,
 *  learned, configured, table. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeConfig } from "../src/config.js";
import { emptyModelWindows, learnModelWindow, saveModelWindows } from "../src/model-windows.js";
import { DEFAULT_CONTEXT_TOKENS, resolveContextTokens } from "../src/telemetry/stats.js";

let dir: string;
let cfgPath: string;
let windowsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-window-"));
  cfgPath = join(dir, "config.json");
  windowsPath = join(dir, "model-windows.json");
  writeConfig({}, cfgPath);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function resolved(model: string, configured?: number, now = 2_000): number {
  return resolveContextTokens(model, configured, { path: cfgPath, windowsPath, now });
}

function learn(model: string, tokens: number): void {
  saveModelWindows(learnModelWindow(emptyModelWindows(), model, tokens, 1_000), windowsPath);
}

function setServerWindow(tokens: number): void {
  writeConfig({ providerSettings: { local: { contextTokens: String(tokens) } } }, cfgPath);
}

describe("a server-owned window (llama.cpp)", () => {
  // The provider declares a 32768 default and an 8192 output reserve.
  it("reserves room for the response inside the provider default", () => {
    expect(resolved("local/saluki-27b")).toBe(24_576);
  });

  it("ignores the global override, which cannot raise a serving window", () => {
    expect(resolved("local/saluki-27b", 600_000)).toBe(24_576);
  });

  it("subtracts the reserve from a configured server window", () => {
    setServerWindow(16_384);
    expect(resolved("local/saluki-27b")).toBe(8_192);
  });

  it("prefers the window the server itself reported", () => {
    learn("local/saluki-27b", 65_536);
    expect(resolved("local/saluki-27b")).toBe(57_344);
  });

  it("lets a reported window correct a stale setting", () => {
    setServerWindow(32_768);
    learn("local/saluki-27b", 16_384);
    expect(resolved("local/saluki-27b")).toBe(8_192);
  });

  it("falls back to the provider default when the setting cannot fit the reserve", () => {
    setServerWindow(8_192);
    expect(resolved("local/saluki-27b")).toBe(24_576);
  });

  it("leaves the per-model map to providers without a server window", () => {
    writeConfig(
      {
        modelContextTokens: { "local/saluki-27b": 4_096 },
        providerSettings: { local: { contextTokens: "16384" } },
      },
      cfgPath,
    );
    expect(resolved("local/saluki-27b")).toBe(8_192);
  });
});

describe("every other provider", () => {
  it("honors a per-model window below the 128K cloud floor", () => {
    writeConfig({ modelContextTokens: { "some-future-model": 32_768 } }, cfgPath);
    expect(resolved("some-future-model")).toBe(32_768);
  });

  it("matches a per-model window written without a registered provider qualifier", () => {
    writeConfig({ modelContextTokens: { "edge-model": 16_384 } }, cfgPath);
    expect(resolved("openai/edge-model")).toBe(16_384);
  });

  it("honors a window learned from the server's own refusal", () => {
    learn("some-future-model", 32_768);
    expect(resolved("some-future-model", 600_000)).toBe(32_768);
  });

  it("ignores a learned window for a model the table already places", () => {
    learn("deepseek-v4-pro", 8_192);
    expect(resolved("deepseek-v4-pro", 600_000)).toBe(600_000);
  });

  it("ignores a learned window once it is stale", () => {
    learn("some-future-model", 32_768);
    expect(resolved("some-future-model", 600_000, 1_000 + 36 * 60 * 60_000)).toBe(600_000);
  });

  it("keeps the configured override for a model with no window of its own", () => {
    expect(resolved("some-future-model", 600_000)).toBe(600_000);
  });

  it("keeps the Ollama small-window behaviour", () => {
    expect(resolved("ollama/llama3", 8_192)).toBe(8_192);
  });

  it("leaves a model with no override on its table window", () => {
    expect(resolved("deepseek-v4-pro")).toBe(300_000);
  });

  it("falls back to the safe default when nothing is configured", () => {
    expect(resolved("some-future-model")).toBe(DEFAULT_CONTEXT_TOKENS);
  });
});
