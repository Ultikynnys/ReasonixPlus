import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerDeclared } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { writeConfig } from "../src/config.js";
import { SessionStats, billingContextForModel } from "../src/telemetry/stats.js";

describe("Usage.cacheHitRatio", () => {
  it("computes hit ratio", () => {
    const u = new Usage(0, 0, 0, 80, 20);
    expect(u.cacheHitRatio).toBe(0.8);
  });
  it("is zero on empty", () => {
    expect(new Usage().cacheHitRatio).toBe(0);
  });

  it("falls back cache miss tokens from prompt minus cache hit when the API omits miss", () => {
    const u = Usage.fromApi({
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_cache_hit_tokens: 800,
    });
    expect(u.promptCacheHitTokens).toBe(800);
    expect(u.promptCacheMissTokens).toBe(200);
  });

  it("maps Ollama native usage fields into prompt and completion tokens", () => {
    const u = Usage.fromApi({
      prompt_eval_count: 1234,
      eval_count: 56,
    });
    expect(u.promptTokens).toBe(1234);
    expect(u.completionTokens).toBe(56);
    expect(u.totalTokens).toBe(1290);
    expect(u.promptCacheHitTokens).toBe(0);
    expect(u.promptCacheMissTokens).toBe(1234);
  });
});

describe("SessionStats", () => {
  it("aggregates turns and cache hit ratio", () => {
    const stats = new SessionStats();
    stats.record(1, "deepseek-chat", new Usage(1000, 100, 1100, 800, 200));
    const s = stats.summary();
    expect(s.turns).toBe(1);
    expect(s.cacheHitRatio).toBe(0.8);
  });

  it("accumulates across turns", () => {
    const stats = new SessionStats();
    stats.record(1, "deepseek-chat", new Usage(100, 10, 110, 80, 20));
    stats.record(2, "deepseek-chat", new Usage(200, 20, 220, 160, 40));
    expect(stats.turns.length).toBe(2);
    expect(stats.aggregateCacheHitRatio).toBeCloseTo(240 / 300);
  });

  it("summary.lastPromptTokens tracks the most recent turn only", () => {
    const stats = new SessionStats();
    expect(stats.summary().lastPromptTokens).toBe(0);
    stats.record(1, "deepseek-chat", new Usage(5_000, 100, 5_100, 4_000, 1_000));
    expect(stats.summary().lastPromptTokens).toBe(5_000);
    stats.record(2, "deepseek-chat", new Usage(42_000, 200, 42_200, 40_000, 2_000));
    expect(stats.summary().lastPromptTokens).toBe(42_000);
  });

  it("reset clears live and carryover totals for a new session", () => {
    const stats = new SessionStats();
    stats.seedCarryover({
      turnCount: 3,
      cacheHitTokens: 1000,
      cacheMissTokens: 100,
      lastPromptTokens: 1100,
    });
    stats.record(4, "deepseek-chat", new Usage(1000, 100, 1100, 800, 200));
    stats.reset();
    expect(stats.turns).toHaveLength(0);
    expect(stats.summary()).toMatchObject({
      turns: 0,
      cacheHitRatio: 0,
      lastPromptTokens: 0,
    });
  });
});

describe("SessionStats — resume carryover", () => {
  it("seedCarryover carries the turn count into the summary", () => {
    const s = new SessionStats();
    s.seedCarryover({ turnCount: 3 });
    s.record(4, "deepseek-chat", new Usage(1000, 100, 0, 800, 200));
    expect(s.summary().turns).toBe(4);
  });

  it("seedCarryover ignores undefined / zero / negative inputs", () => {
    const s = new SessionStats();
    s.seedCarryover({ turnCount: 0 });
    s.seedCarryover({ turnCount: -1 });
    expect(s.summary().turns).toBe(0);
  });
});

describe("SessionStats — issue #364 resume cache + context carryover", () => {
  it("aggregateCacheHitRatio includes carryover so status isn't 0% on a fresh resume", () => {
    const s = new SessionStats();
    s.seedCarryover({ cacheHitTokens: 366976, cacheMissTokens: 109 });
    // No live turns yet — ratio must come from the carryover alone.
    expect(s.aggregateCacheHitRatio).toBeCloseTo(366976 / (366976 + 109), 4);
    expect(s.summary().cacheHitRatio).toBeCloseTo(366976 / (366976 + 109), 4);
  });

  it("aggregateCacheHitRatio sums carryover + live turns", () => {
    const s = new SessionStats();
    s.seedCarryover({ cacheHitTokens: 1000, cacheMissTokens: 0 });
    s.record(1, "deepseek-chat", new Usage(2000, 100, 0, 0, 2000));
    // 1000 hit (carryover) + 0 hit (live) over 1000 + 2000 = 1/3.
    expect(s.aggregateCacheHitRatio).toBeCloseTo(1000 / 3000, 4);
  });

  it("summary.lastPromptTokens falls back to carryover before any live turn", () => {
    const s = new SessionStats();
    s.seedCarryover({ lastPromptTokens: 367085 });
    expect(s.summary().lastPromptTokens).toBe(367085);
  });

  it("live turn overrides carryover lastPromptTokens", () => {
    const s = new SessionStats();
    s.seedCarryover({ lastPromptTokens: 100 });
    s.record(1, "deepseek-chat", new Usage(500, 50, 0, 400, 100));
    expect(s.summary().lastPromptTokens).toBe(500);
  });

  it("seedCarryover ignores zero / negative cache + context fields", () => {
    const s = new SessionStats();
    s.seedCarryover({ cacheHitTokens: 0, cacheMissTokens: -5, lastPromptTokens: 0 });
    expect(s.aggregateCacheHitRatio).toBe(0);
    expect(s.summary().lastPromptTokens).toBe(0);
  });

  it("cumulativeCompletionTokens sums carryover + live turns so resume doesn't reset the counter", () => {
    // Regression: #1667 persisted totalCompletionTokens but didn't seed it
    // back into stats on resume, so the first patchSessionMeta after a
    // restart overwrote the saved value with just the new turn's tally.
    const s = new SessionStats();
    s.seedCarryover({ totalCompletionTokens: 50_000 });
    expect(s.cumulativeCompletionTokens).toBe(50_000);
    s.record(1, "deepseek-chat", new Usage(2000, 500, 0, 0, 2000));
    expect(s.cumulativeCompletionTokens).toBe(50_500);
  });

  it("seedCarryover ignores zero / negative totalCompletionTokens", () => {
    const s = new SessionStats();
    s.seedCarryover({ totalCompletionTokens: 0 });
    expect(s.cumulativeCompletionTokens).toBe(0);
    s.seedCarryover({ totalCompletionTokens: -1 });
    expect(s.cumulativeCompletionTokens).toBe(0);
  });
});

describe("billingContextForModel", () => {
  it("distinguishes OpenAI OAuth quota from API-key USD billing", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-openai-billing-"));
    const path = join(dir, "config.json");
    try {
      writeConfig({ openaiApiKey: "sk-test" }, path);
      expect(billingContextForModel("gpt-5.6-sol", path)).toEqual({
        kind: "usd",
        provider: "openai",
      });
      writeConfig(
        {
          openaiOAuth: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: Date.now() + 60_000,
          },
        },
        path,
      );
      expect(billingContextForModel("gpt-5.6-sol", path)).toEqual({
        kind: "quota",
        provider: "openai",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies authenticated Ollama usage as quota", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-ollama-billing-"));
    const path = join(dir, "config.json");
    try {
      writeConfig({ ollamaApiKey: "ollama-test" }, path);
      expect(billingContextForModel("ollama/deepseek-v4-flash:0731", path)).toEqual({
        kind: "quota",
        provider: "ollama",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!providerDeclared("experiential"))(
    "resolves the native unit from the provider, never the model name",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "reasonix-billing-unit-"));
      const path = join(dir, "config.json");
      try {
        writeConfig({}, path);
        // Xiaomi MiMo bills a subscription plan → plan-window %.
        expect(billingContextForModel("mimo-v2.6-pro", path)).toEqual({
          kind: "quota",
          provider: "mimo",
        });
        // DeepSeek is the only provider whose default native unit is per-token USD.
        expect(billingContextForModel("deepseek-v4-flash", path)).toEqual({
          kind: "usd",
          provider: "deepseek",
        });
        // OpenCode never exposes a per-token dollar amount.
        expect(billingContextForModel("big-pickle", path)).toEqual({
          kind: "none",
          provider: "opencode",
        });
        // Experiential Labs bills routed tokens per-token USD.
        expect(billingContextForModel("experiential/qwen3.8-27b", path)).toEqual({
          kind: "usd",
          provider: "experiential",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
