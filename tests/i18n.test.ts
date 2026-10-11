/** i18n resolution: the English dictionary is the schema, and every key must
 *  resolve through t() (a missing string echoes its path into the UI). */

import { describe, expect, it } from "vitest";
import { EN } from "../src/i18n/EN.js";
import { t } from "../src/i18n/index.js";
import type { TranslationSchema } from "../src/i18n/types.js";

function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(path);
    else out.push(...flattenKeys(v, path));
  }
  return out;
}

describe("t() resolution", () => {
  it("resolves compaction strings with parameter substitution", () => {
    const compacted = t("loop.compacted", { method: "summary", before: "1,000", after: "400" });
    expect(compacted).toContain("summary");
    expect(compacted).toContain("1,000");
    expect(compacted).toContain("400");
    expect(compacted).not.toContain("{method}");

    const recovery = t("loop.compactedRecovery", { before: "9,000", after: "500" });
    expect(recovery).toContain("9,000");
    expect(recovery).toContain("500");
    expect(recovery).not.toContain("{before}");
  });

  it("echoes the path for unknown keys instead of throwing", () => {
    expect(t("loop.noSuchKey")).toBe("loop.noSuchKey");
    expect(t("nope.deeply.missing")).toBe("nope.deeply.missing");
  });

  it("every dictionary key resolves through t()", () => {
    const keys = flattenKeys(EN);
    expect(keys.length).toBeGreaterThan(100);
    const unresolved = keys.filter((k) => t(k) === k);
    expect(unresolved).toEqual([]);
  });

  it("EN satisfies the TranslationSchema shape", () => {
    // Type-level contract, checked at compile time; this guards the runtime
    // import so the two can never drift silently.
    const schema: TranslationSchema = EN;
    expect(schema.loop.compacted).toContain("{method}");
  });
});
