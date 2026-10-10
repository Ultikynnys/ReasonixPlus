import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveReasoningEffort, supportedReasoningEfforts } from "../src/config.js";
import { writeOpencodeModelsCache } from "../src/opencode-models.js";

describe("reasoning-effort resolution", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-effort-"));
    vi.stubEnv("USERPROFILE", home); // Windows
    vi.stubEnv("HOME", home); // Unix
    // os.homedir() is cached per-process on some platforms: override via spy.
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it("falls back to the static per-provider sets with no synced catalog", () => {
    expect(supportedReasoningEfforts("deepseek-v4-flash")).toEqual(["low", "high", "max"]);
    expect(supportedReasoningEfforts("gpt-6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(supportedReasoningEfforts("glm-5.2")).toEqual(["low", "high", "max"]);
    expect(supportedReasoningEfforts("big-pickle")).toEqual(["low", "medium", "high"]);
    expect(supportedReasoningEfforts("ollama/llama3.1:latest")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("prefers the synced per-model values (any provider) over the static set", () => {
    writeOpencodeModelsCache(
      {
        models: [],
        freeModels: [],
        visionModels: [],
        goModels: [],
        reasoningEfforts: {
          zai: { "glm-5.2": ["high", "max"], "glm-4.7": [] },
          deepseek: { "deepseek-v4-flash": ["low", "high", "max"] },
          opencode: { "big-pickle": [] },
        },
        checkedAt: Date.now(),
      },
      home,
    );

    expect(supportedReasoningEfforts("glm-5.2")).toEqual(["high", "max"]);
    // toggle/budget-only model -> no effort ladder.
    expect(supportedReasoningEfforts("glm-4.7")).toEqual([]);
    expect(supportedReasoningEfforts("big-pickle")).toEqual([]);
  });

  it("clamps the request to the model's set, omitting it when there is none", () => {
    // deepseek rejects "medium" -> clamp to the nearest, "high".
    expect(effectiveReasoningEffort("deepseek-v4-flash", "medium")).toBe("high");
    expect(effectiveReasoningEffort("deepseek-v4-flash", "low")).toBe("low");
    expect(effectiveReasoningEffort("gpt-6-luna", "xhigh")).toBe("xhigh");
    expect(effectiveReasoningEffort("gpt-6-luna", undefined)).toBeUndefined();

    writeOpencodeModelsCache(
      {
        models: [],
        freeModels: [],
        visionModels: [],
        goModels: [],
        reasoningEfforts: { opencode: { "big-pickle": [] } },
        checkedAt: Date.now(),
      },
      home,
    );
    expect(effectiveReasoningEffort("big-pickle", "high")).toBeUndefined();
  });
});
