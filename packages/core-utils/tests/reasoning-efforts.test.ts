import { describe, expect, it } from "vitest";
import {
  PROVIDER_REASONING_EFFORTS,
  REASONING_EFFORT_ORDER,
  clampReasoningEffort,
  reasoningEffortsFor,
} from "../src/reasoning-efforts.js";

describe("PROVIDER_REASONING_EFFORTS", () => {
  it("declares a set for every provider and keeps values canonical", () => {
    for (const levels of Object.values(PROVIDER_REASONING_EFFORTS)) {
      for (const level of levels) expect(REASONING_EFFORT_ORDER).toContain(level);
    }
  });

  it("matches each endpoint's contract", () => {
    expect(PROVIDER_REASONING_EFFORTS.deepseek).toEqual(["low", "high", "max"]);
    expect(PROVIDER_REASONING_EFFORTS.zai).toEqual(["low", "high", "max"]);
    expect(PROVIDER_REASONING_EFFORTS.opencode).toEqual(["low", "medium", "high"]);
    expect(PROVIDER_REASONING_EFFORTS.openai).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("reasoningEffortsFor", () => {
  it("falls back to the static set when the model declares no options", () => {
    expect(reasoningEffortsFor("zai")).toEqual(["low", "high", "max"]);
    expect(reasoningEffortsFor("openai", undefined)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reasoningEffortsFor("deepseek", null)).toEqual(["low", "high", "max"]);
  });

  it("uses the model's own values (filtered) for any provider", () => {
    expect(reasoningEffortsFor("zai", ["low", "high", "max"])).toEqual(["low", "high", "max"]);
    expect(reasoningEffortsFor("zai", ["none", "minimal", "low", "high"])).toEqual(["low", "high"]);
    expect(reasoningEffortsFor("deepseek", ["low", "high", "max"])).toEqual(["low", "high", "max"]);
    expect(reasoningEffortsFor("openai", ["none", "low", "minimal", "max"])).toEqual(["low", "max"]);
  });

  it("falls back to the opencode default when the model declares none", () => {
    expect(reasoningEffortsFor("opencode", undefined)).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortsFor("opencode", null)).toEqual(["low", "medium", "high"]);
  });

  it("treats an empty list as no effort control", () => {
    expect(reasoningEffortsFor("opencode", [])).toEqual([]);
  });

  it("uses and filters the opencode model's own values", () => {
    expect(reasoningEffortsFor("opencode", ["low", "high", "max"])).toEqual(["low", "high", "max"]);
    expect(reasoningEffortsFor("opencode", ["none", "low", "minimal", "max"])).toEqual([
      "low",
      "max",
    ]);
  });
});

describe("clampReasoningEffort", () => {
  it("returns the request when supported", () => {
    expect(clampReasoningEffort(["low", "high", "max"], "high")).toBe("high");
  });

  it("picks the nearest supported level, ties to the higher one", () => {
    // medium is equidistant from low and high -> high (preserves zai's remap)
    expect(clampReasoningEffort(["low", "high", "max"], "medium")).toBe("high");
    // xhigh is equidistant from high and max -> max
    expect(clampReasoningEffort(["low", "high", "max"], "xhigh")).toBe("max");
  });

  it("returns null when nothing is supported", () => {
    expect(clampReasoningEffort([], "high")).toBeNull();
  });
});
