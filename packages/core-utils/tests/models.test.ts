import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_MODELS,
  GEMINI_MODELS,
  GPT56_MODELS,
  KNOWN_MODELS,
  MIMO_MODELS,
  MODEL_DISPLAY_NAMES,
  OPENAI_MODELS,
  OPENCODE_MODELS,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  modelAcceptsAudioVideo,
  modelAcceptsImages,
  modelDisplayName,
  parseModelRef,
  qualifyModelRef,
  stripProviderQualifier,
} from "../src/models.js";
import { requireProviderSpec } from "../src/provider-registry.js";

describe("modelAcceptsImages", () => {
  it("accepts OpenAI models including GPT-6 family and GPT-5.6 family", () => {
    expect(modelAcceptsImages("gpt-6-astra")).toBe(true);
    expect(modelAcceptsImages("gpt-6-sol")).toBe(true);
    expect(modelAcceptsImages("gpt-6-luna")).toBe(true);
    expect(modelAcceptsImages("gpt-5.6-sol")).toBe(true);
    expect(modelAcceptsImages("gpt-5.6-terra")).toBe(true);
    expect(modelAcceptsImages("gpt-5.6-luna")).toBe(true);
  });

  it("accepts Ollama-hosted DeepSeek V4.1 Flash copies regardless of the runtime probe", () => {
    expect(modelAcceptsImages("ollama/deepseek-v4.1-flash")).toBe(true);
    expect(modelAcceptsImages("ollama/deepseek-v4.1-flash:cloud")).toBe(true);
    expect(modelAcceptsImages("ollama/deepseek-v4.1-flash:q4_K_M")).toBe(true);
    // Probe-set membership still applies to non-DeepSeek ids.
    expect(modelAcceptsImages("ollama/llava", new Set(["ollama/llava"]))).toBe(true);
    // The static override never marks a text-only model vision.
    expect(modelAcceptsImages("ollama/deepseek-v4-pro")).toBe(false);
    expect(modelAcceptsImages("ollama/llama3.1:latest")).toBe(false);
  });

  it("accepts DeepSeek, Z.AI, and OpenCode vision models", () => {
    expect(modelAcceptsImages("deepseek-flash")).toBe(true);
    expect(modelAcceptsImages("deepseek-v4-flash")).toBe(true);
    expect(modelAcceptsImages("deepseek-v4-flash-vision-exp")).toBe(true);
    expect(modelAcceptsImages("glm-5.3-flash")).toBe(true);
    expect(modelAcceptsImages("glm-4.6v")).toBe(true);
    expect(modelAcceptsImages("glm-5.3")).toBe(false);
    expect(modelAcceptsImages("mimo-v2.5-free")).toBe(true);
    expect(modelAcceptsImages("muse-spark-1.3-contributor-free")).toBe(true);
    expect(modelAcceptsImages("big-pickle")).toBe(false);
  });

  it("accepts MiMo's V2.6 multimodal models and rejects its text-only ids", () => {
    expect(modelAcceptsImages("mimo-v2.6-pro")).toBe(true);
    expect(modelAcceptsImages("mimo-v2.6-flash")).toBe(true);
    expect(modelAcceptsImages("mimo-v2.5-pro")).toBe(false);
    expect(modelAcceptsImages("mimo-v2.5")).toBe(false);
  });

  it("accepts every Antigravity model exposed by the unified gateway", () => {
    for (const model of ANTIGRAVITY_MODELS) {
      expect(modelAcceptsImages(model)).toBe(true);
    }
  });

  it("recognizes live Antigravity model ids and rejects internal chat/tab IDs", async () => {
    const { isAntigravityModel } = await import("../src/models.js");
    expect(isAntigravityModel("gemini-3.7-flash")).toBe(true);
    expect(isAntigravityModel("gemini-3.7-flash-tiered")).toBe(true);
    expect(isAntigravityModel("gemini-3.8-flash")).toBe(true);
    expect(isAntigravityModel("gemini-3.8-flash-tiered")).toBe(true);
    expect(isAntigravityModel("claude-sonnet-4-6")).toBe(true);
    expect(isAntigravityModel("gpt-oss-120b-medium")).toBe(true);
    expect(isAntigravityModel("chat_20706")).toBe(false);
    expect(isAntigravityModel("tab_flash_lite_preview")).toBe(false);
  });

  it("rejects text-only DeepSeek, Ollama, and unknown ids", () => {
    expect(modelAcceptsImages("deepseek-v4-pro")).toBe(false);
    expect(modelAcceptsImages("ollama/llama3.1:latest")).toBe(false);
    expect(modelAcceptsImages("made-up")).toBe(false);
  });

  it("rejects null / undefined", () => {
    expect(modelAcceptsImages(null)).toBe(false);
    expect(modelAcceptsImages(undefined)).toBe(false);
  });

  it("accepts an Ollama model confirmed vision-capable", () => {
    const vision = new Set(["ollama/llava", "ollama/qwen2.5-vl"]);
    expect(modelAcceptsImages("ollama/llava", vision)).toBe(true);
    expect(modelAcceptsImages("ollama/qwen2.5-vl", vision)).toBe(true);
  });

  it("rejects an Ollama model not in the vision set", () => {
    const vision = new Set(["ollama/llava"]);
    expect(modelAcceptsImages("ollama/llama3.1:latest", vision)).toBe(false);
  });

  it("treats Ollama models as non-vision when the set is omitted", () => {
    expect(modelAcceptsImages("ollama/llava")).toBe(false);
    expect(modelAcceptsImages("ollama/llava", undefined)).toBe(false);
    expect(modelAcceptsImages("ollama/llava", null)).toBe(false);
  });

  it("ignores the Ollama vision set for non-Ollama ids", () => {
    const vision = new Set(["ollama/llava", "gpt-5.6-sol"]);
    expect(modelAcceptsImages("gpt-5.6-sol", vision)).toBe(true);
    expect(modelAcceptsImages("deepseek-v4-flash-vision-exp", vision)).toBe(true);
  });
});

describe("KNOWN_MODELS", () => {
  it("offers DeepSeek's official line including the vision model", () => {
    expect(KNOWN_MODELS).toContain("deepseek-flash");
    expect(KNOWN_MODELS).toContain("deepseek-v4-flash");
    expect(KNOWN_MODELS).toContain("deepseek-v4-pro");
    expect(KNOWN_MODELS).toContain("deepseek-v4-flash-vision-exp");
  });

  it("offers the OpenAI models including GPT-6 family and the GPT-5.6 family", () => {
    expect(KNOWN_MODELS).toContain("gpt-6.1-sol");
    expect(KNOWN_MODELS).toContain("gpt-6-astra");
    expect(KNOWN_MODELS).toContain("gpt-6-sol");
    expect(KNOWN_MODELS).toContain("gpt-6-luna");
    expect(KNOWN_MODELS).toContain("gpt-5.6-sol");
    expect(KNOWN_MODELS).toContain("gpt-5.6-terra");
    expect(KNOWN_MODELS).toContain("gpt-5.6-luna");
    expect(OPENAI_MODELS).toContain("gpt-6.1-sol");
    expect(OPENAI_MODELS).toContain("gpt-6-astra");
    expect(OPENAI_MODELS).toContain("gpt-6-sol");
    expect(OPENAI_MODELS).toContain("gpt-6-luna");
  });

  it("offers every Gemini model available through Antigravity", () => {
    expect(GEMINI_MODELS.length).toBeGreaterThan(0);
    for (const model of GEMINI_MODELS) expect(KNOWN_MODELS).toContain(model);
  });

  it("offers free OpenCode models", () => {
    expect(KNOWN_MODELS).toContain("big-pickle");
    expect(KNOWN_MODELS).toContain("nemotron-3-ultra-free");
    expect(KNOWN_MODELS).toContain("mimo-v2.5-free");
  });

  it("is exactly the combined built-in provider catalog", () => {
    expect(KNOWN_MODELS).toEqual([
      ...SUPPORTED_OFFICIAL_MODELS,
      ...GPT56_MODELS,
      ...ZAI_MODELS,
      ...MIMO_MODELS,
      ...OPENCODE_MODELS,
      ...ANTIGRAVITY_MODELS,
      // Synthetic is last in display order, so its catalog closes the list.
      ...requireProviderSpec("synthetic").models,
    ]);
  });
});

describe("modelAcceptsAudioVideo", () => {
  it("accepts the MiMo V2.6 family and rejects everything else", () => {
    expect(modelAcceptsAudioVideo("mimo-v2.6-pro")).toBe(true);
    expect(modelAcceptsAudioVideo("mimo-v2.6-pro-ultraspeed")).toBe(true);
    expect(modelAcceptsAudioVideo("mimo-v2.5")).toBe(false);
    expect(modelAcceptsAudioVideo("gpt-6-sol")).toBe(false);
    expect(modelAcceptsAudioVideo(undefined)).toBe(false);
  });
});

describe("modelDisplayName", () => {
  it("maps gemini-pro-agent to gemini-3.5-pro", () => {
    expect(modelDisplayName("gemini-pro-agent")).toBe("gemini-3.5-pro");
    expect(MODEL_DISPLAY_NAMES["gemini-pro-agent"]).toBe("gemini-3.5-pro");
  });

  it("falls back to the raw model ID when unmapped", () => {
    expect(modelDisplayName("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(modelDisplayName("gemini-3.7-flash-tiered")).toBe("gemini-3.7-flash-tiered");
    expect(modelDisplayName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("handles null, undefined, and empty string gracefully", () => {
    expect(modelDisplayName(null)).toBe("");
    expect(modelDisplayName(undefined)).toBe("");
    expect(modelDisplayName("")).toBe("");
  });
});

describe("parseModelRef", () => {
  it("parses a provider-qualified reference", () => {
    expect(parseModelRef("opencode/mimo-v2.6-pro")).toEqual({
      provider: "opencode",
      id: "mimo-v2.6-pro",
    });
    expect(parseModelRef("ollama/llama3.1:latest")).toEqual({
      provider: "ollama",
      id: "llama3.1:latest",
    });
  });

  it("treats a bare id as unqualified", () => {
    expect(parseModelRef("mimo-v2.6-pro")).toEqual({ provider: null, id: "mimo-v2.6-pro" });
  });

  it("keeps an unrecognized prefix as part of the id", () => {
    expect(parseModelRef("foo/bar")).toEqual({ provider: null, id: "foo/bar" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseModelRef("  mimo/mimo-v2.6-pro ")).toEqual({
      provider: "mimo",
      id: "mimo-v2.6-pro",
    });
  });
});

describe("qualifyModelRef", () => {
  it("prefixes the wire id with the provider", () => {
    expect(qualifyModelRef("opencode", "mimo-v2.6-pro")).toBe("opencode/mimo-v2.6-pro");
  });

  it("rewrites an existing qualifier instead of stacking", () => {
    expect(qualifyModelRef("mimo", "opencode/mimo-v2.6-pro")).toBe("mimo/mimo-v2.6-pro");
  });
});

describe("stripProviderQualifier", () => {
  it("strips a recognized provider prefix", () => {
    expect(stripProviderQualifier("opencode/mimo-v2.6-pro")).toBe("mimo-v2.6-pro");
    expect(stripProviderQualifier("ollama/deepseek-v4.1-flash:cloud")).toBe(
      "deepseek-v4.1-flash:cloud",
    );
  });

  it("leaves bare ids and unrecognized prefixes untouched", () => {
    expect(stripProviderQualifier("mimo-v2.6-pro")).toBe("mimo-v2.6-pro");
    expect(stripProviderQualifier("foo/bar")).toBe("foo/bar");
  });
});

describe("capability predicates on qualified references", () => {
  it("modelAcceptsImages matches catalog membership of the wire id", () => {
    expect(modelAcceptsImages("opencode/mimo-v2.6-pro")).toBe(true);
    expect(modelAcceptsImages("opencode/mimo-v2.5-free")).toBe(true);
    expect(modelAcceptsImages("mimo/mimo-v2.6-pro")).toBe(true);
    expect(modelAcceptsImages("opencode/big-pickle")).toBe(false);
  });

  it("modelAcceptsAudioVideo matches the wire id", () => {
    expect(modelAcceptsAudioVideo("opencode/mimo-v2.6-pro")).toBe(true);
    expect(modelAcceptsAudioVideo("opencode/mimo-v2.5")).toBe(false);
  });

  it("keeps ollama vision probe sets keyed on the full prefixed id", () => {
    const vision = new Set(["ollama/llava"]);
    expect(modelAcceptsImages("ollama/llava", vision)).toBe(true);
    expect(modelAcceptsImages("ollama/llava")).toBe(false);
  });
});
