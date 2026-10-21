import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { appendUsage } from "../src/telemetry/usage.js";

describe("appendUsage", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-usage-"));
    path = join(dir, "usage.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the token snapshot for a turn", () => {
    const record = appendUsage({
      session: "test",
      model: "deepseek-v4-flash",
      usage: new Usage(2_000_000, 1_000_000, 3_000_000, 1_000_000, 1_000_000),
      now: Date.UTC(2026, 8, 5, 13),
      path,
    });
    expect(record).toMatchObject({
      session: "test",
      model: "deepseek-v4-flash",
      promptTokens: 2_000_000,
      completionTokens: 1_000_000,
      cacheHitTokens: 1_000_000,
      cacheMissTokens: 1_000_000,
    });
  });

  it("tags a subagent row and keeps its attribution metadata", () => {
    const record = appendUsage({
      session: null,
      model: "deepseek-v4-flash",
      usage: new Usage(100, 10),
      path,
      kind: "subagent",
      subagent: {
        skillName: "review",
        taskPreview: "review changes",
        toolIters: 3,
        durationMs: 1200,
      },
    });
    expect(record.kind).toBe("subagent");
    expect(record.subagent).toMatchObject({ skillName: "review", toolIters: 3, durationMs: 1200 });
  });
});
