import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
  resolveContextTokens,
} from "../src/telemetry/stats.js";

describe("resolveContextTokens", () => {
  it("uses the per-model table when no override is set", () => {
    expect(resolveContextTokens("deepseek-v4-flash")).toBe(
      DEEPSEEK_CONTEXT_TOKENS["deepseek-v4-flash"],
    );
    expect(resolveContextTokens("gpt-6-astra")).toBe(1_000_000);
    expect(resolveContextTokens("gpt-6-sol")).toBe(1_000_000);
    expect(resolveContextTokens("gpt-6-luna")).toBe(1_000_000);
    expect(resolveContextTokens("gpt-5.6-sol")).toBe(300_000);
    expect(resolveContextTokens("gemini-3.8-flash-tiered")).toBe(1_000_000);
    expect(resolveContextTokens("gemini-3.7-flash")).toBe(1_000_000);
  });

  it("falls back to DEFAULT_CONTEXT_TOKENS for unknown models", () => {
    expect(resolveContextTokens("some-future-model")).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("honors an override above the model's default window, up to the API ceiling", () => {
    // An explicit override is the source of truth; the table only supplies
    // the default when no override is set.
    expect(resolveContextTokens("deepseek-v4-flash", 750_000)).toBe(750_000);
    expect(resolveContextTokens("deepseek-v4-flash", 1_000_000)).toBe(1_000_000);
    expect(resolveContextTokens("gpt-5.6-sol", 900_000)).toBe(900_000);
  });

  it("an override below the max stays in effect (floored to the config range)", () => {
    expect(resolveContextTokens("deepseek-v4-flash", 300_000)).toBe(300_000);
    expect(resolveContextTokens("deepseek-v4-flash", 250_000)).toBe(250_000);
    expect(resolveContextTokens("deepseek-v4-flash", 100_000)).toBe(MIN_CONTEXT_TOKENS);
  });

  it("an override also applies to unknown models up to the API ceiling (the table is only the no-override fallback)", () => {
    expect(resolveContextTokens("some-future-model", 900_000)).toBe(900_000);
  });

  it("clamps to the config range floor and the API ceiling", () => {
    expect(resolveContextTokens("deepseek-v4-flash", 100)).toBe(MIN_CONTEXT_TOKENS);
    expect(resolveContextTokens("some-future-model", 2_000_000)).toBe(MAX_CONTEXT_TOKENS);
  });

  it("floors fractional overrides and ignores non-finite ones", () => {
    expect(resolveContextTokens("deepseek-v4-flash", 350_000.9)).toBe(350_000);
    expect(resolveContextTokens("some-future-model", 350_000.9)).toBe(350_000);
    expect(resolveContextTokens("deepseek-v4-flash", Number.NaN)).toBe(1_000_000);
    expect(resolveContextTokens("deepseek-v4-flash", Number.POSITIVE_INFINITY)).toBe(1_000_000);
  });
});
