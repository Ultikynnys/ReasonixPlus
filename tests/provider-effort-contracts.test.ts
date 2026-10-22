import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_SPECS, modelReasoningContract, modelReasoningEfforts, parseProviderRegistry, providerDeclared, resolveReasoningEffort } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import { fetchOpencodeModels } from "../src/opencode-models.js";

describe("researched effort contracts", () => {
  const cases: [string, string, string[]][] = [
    ["deepseek", "deepseek-v4-pro", ["low", "high", "max"]],
    ["deepseek", "deepseek-reasoner", []],
    ["openai", "gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
    ["openai", "gpt-5.5", ["low", "medium", "high", "xhigh"]],
    ["openai", "gpt-4o", []],
    ["zai", "glm-5.2", ["high", "max"]],
    ["zai", "glm-5.3-flash", ["low", "high", "max"]],
    ["zai", "glm-4.7", []],
    ["opencode", "mimo-v2.6-flash-free", []],
    ["opencode", "unknown", []],
    ["synthetic", "hf:openai/gpt-oss-120b", ["low", "medium", "high"]],
    ["experiential", "fable-5", ["low", "medium", "high", "xhigh", "max"]],
    ["mimo", "mimo-v2.6-pro", []],
    ["ollama", "llama3.1:latest", []],
    ["ollama", "gpt-oss:120b", ["low", "medium", "high"]],
    ["gemini", "gemini-3.6-flash-tiered", ["low", "medium", "high"]],
    ["gemini", "claude-opus-4-6-thinking", ["low", "medium", "high"]],
    ["gemini", "gpt-oss-120b-medium", []],
  ];
  for (const [provider, model, efforts] of cases) {
    it.skipIf(!providerDeclared(provider))(`${provider}/${model} has the correct ladder`, () => {
      expect(modelReasoningEfforts(provider, model)).toEqual(efforts);
    });
  }
  it("uses documented aliases rather than generic rank ties", () => {
    if (providerDeclared("deepseek")) expect(resolveReasoningEffort("deepseek", "deepseek-v4-pro", "xhigh", ["low", "high", "max"])).toBe("high");
    if (providerDeclared("zai")) expect(resolveReasoningEffort("zai", "glm-5.2", "low", ["high", "max"])).toBe("high");
  });
  it("honors an explicit empty discovered ladder", () => {
    for (const spec of PROVIDER_SPECS) {
      if (modelReasoningContract(spec.id, "unknown").control === "effort") expect(modelReasoningEfforts(spec.id, "unknown", [])).toEqual([]);
    }
  });
  it("validates rule fields at registry load", () => {
    const spec = PROVIDER_SPECS[0];
    if (!spec) return;
    for (const rule of [
      { pattern: "[", efforts: [] },
      { pattern: ".*", efforts: ["ultra"] },
      { pattern: ".*", efforts: ["high"], control: "gemini-budget" },
      { pattern: ".*", efforts: ["high"], control: "none" },
    ]) expect(() => parseProviderRegistry({ providers: [{ ...spec, reasoningRules: [rule] }] })).toThrow();
  });
  it.skipIf(!providerDeclared("opencode"))("preserves explicit empty metadata and Zen precedence", async () => {
    const home = mkdtempSync(join(tmpdir(), "effort-discovery-"));
    try {
      const result = await fetchOpencodeModels({ homeDir: home, force: true, fetchImpl: (async () => new Response(JSON.stringify({
        opencode: { models: { empty: { reasoning_options: [] }, disabled: { reasoning: false }, shared: { reasoning_options: [{ type: "effort", values: ["high"] }] } } },
        "opencode-go": { models: { shared: { reasoning_options: [{ type: "effort", values: ["low"] }] } } },
      }))) as typeof fetch });
      expect(result.reasoningEfforts.opencode).toMatchObject({ empty: [], disabled: [], shared: ["high"] });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
