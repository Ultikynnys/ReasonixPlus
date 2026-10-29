import { describe, expect, it } from "vitest";
import en from "./en.json";
import { t } from "./index";

/** Flattened string count after the provider/engine copy moved into declarations. */
const EXPECTED_LEAVES = 1097;

function leaves(value: unknown): number {
  if (typeof value === "string") return 1;
  if (value && typeof value === "object") {
    return Object.values(value).reduce<number>((total, child) => total + leaves(child), 0);
  }
  return 0;
}

describe("i18n bundle", () => {
  it("keeps every key after the move to JSON", () => {
    expect(
      leaves(en),
      "key count changed: update EXPECTED_LEAVES if that was intentional, otherwise a key was lost",
    ).toBe(EXPECTED_LEAVES);
  });

  it("resolves real copy instead of echoing the key", () => {
    for (const key of [
      "settings.noProvidersDeclared",
      "settings.noSearchEnginesDeclared",
      "settings.searchSection",
    ] as const) {
      const text = t(key);
      expect(text, `${key} must resolve`).not.toBe(key);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("has no empty translation values", () => {
    const empties: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        if (value.trim() === "") empties.push(path);
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          walk(child, path ? `${path}.${key}` : key);
        }
      }
    };
    walk(en, "");
    expect(empties).toEqual([]);
  });
});
