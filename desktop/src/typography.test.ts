import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE_TEXT_PX,
  TEXT_SIZE_RANGE,
  clampTextSizePx,
  isTextSizePx,
  readStoredTextSize,
  storeTextSize,
} from "./typography";

const FONT_SIZE_KEY = "reasonix.fontSize";
const LEGACY_KEY = "reasonix.fontScale";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}

describe("text size persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the base size inside the slider's range", () => {
    expect(isTextSizePx(BASE_TEXT_PX)).toBe(true);
    expect(BASE_TEXT_PX).toBeGreaterThanOrEqual(TEXT_SIZE_RANGE.min);
    expect(BASE_TEXT_PX).toBeLessThanOrEqual(TEXT_SIZE_RANGE.max);
  });

  it("accepts only whole pixels inside the range", () => {
    expect(isTextSizePx(TEXT_SIZE_RANGE.min)).toBe(true);
    expect(isTextSizePx(TEXT_SIZE_RANGE.max)).toBe(true);
    expect(isTextSizePx(TEXT_SIZE_RANGE.min - 1)).toBe(false);
    expect(isTextSizePx(TEXT_SIZE_RANGE.max + 1)).toBe(false);
    expect(isTextSizePx(14.5)).toBe(false);
    expect(isTextSizePx("14")).toBe(false);
    expect(isTextSizePx(Number.NaN)).toBe(false);
  });

  it("rounds and clamps a slider value", () => {
    expect(clampTextSizePx(TEXT_SIZE_RANGE.min - 1)).toBe(TEXT_SIZE_RANGE.min);
    expect(clampTextSizePx(TEXT_SIZE_RANGE.max + 1)).toBe(TEXT_SIZE_RANGE.max);
    expect(clampTextSizePx(14.4)).toBe(14);
    expect(clampTextSizePx(14.6)).toBe(15);
    expect(clampTextSizePx(Number.NaN)).toBe(BASE_TEXT_PX);
    expect(clampTextSizePx(Number.POSITIVE_INFINITY)).toBe(BASE_TEXT_PX);
  });

  it("falls back to the base when nothing is stored", () => {
    expect(readStoredTextSize()).toBe(BASE_TEXT_PX);
  });

  it("reads the stored size", () => {
    localStorage.setItem(FONT_SIZE_KEY, "16");
    expect(readStoredTextSize()).toBe(16);
  });

  it("migrates the retired small, medium and large steps", () => {
    for (const [step, px] of [
      ["small", 12],
      ["medium", 14],
      ["large", 16],
    ] as const) {
      localStorage.clear();
      localStorage.setItem(LEGACY_KEY, step);
      expect(readStoredTextSize()).toBe(px);
    }
  });

  it("prefers a valid stored size over the legacy step", () => {
    localStorage.setItem(FONT_SIZE_KEY, "18");
    localStorage.setItem(LEGACY_KEY, "large");
    expect(readStoredTextSize()).toBe(18);
  });

  it("falls back to the legacy step when the stored size is unusable", () => {
    localStorage.setItem(FONT_SIZE_KEY, "25");
    localStorage.setItem(LEGACY_KEY, "small");
    expect(readStoredTextSize()).toBe(12);
  });

  it("does not mistake an object prototype key for a legacy step", () => {
    for (const key of ["constructor", "toString", "__proto__"]) {
      localStorage.clear();
      localStorage.setItem(LEGACY_KEY, key);
      expect(readStoredTextSize()).toBe(BASE_TEXT_PX);
    }
  });

  it("stores a clamped size", () => {
    storeTextSize(16);
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe("16");
    storeTextSize(99);
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe(String(TEXT_SIZE_RANGE.max));
    storeTextSize(Number.NaN);
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe(String(BASE_TEXT_PX));
  });

  it("keeps the stylesheet's root fallback on the module's base", () => {
    const testPath = expect.getState().testPath;
    expect(testPath, "vitest must report the running test file").toBeTruthy();
    const css = readFileSync(resolve(dirname(testPath ?? ""), "styles.css"), "utf8");
    const rule = /(?:^|\n)html\s*\{([^}]*)\}/.exec(css);
    expect(rule, "styles.css has no html rule").not.toBeNull();
    expect(rule?.[1] ?? "").toContain(`font-size: ${BASE_TEXT_PX}px`);
  });
});
