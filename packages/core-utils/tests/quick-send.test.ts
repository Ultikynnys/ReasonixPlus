import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_QUICK_SENDS,
  QUICK_SEND_SHORTHAND_MAX_LENGTH,
  type QuickSend,
  allQuickSends,
  createQuickSendId,
  enforceQuickSendShorthand,
  isQuickSend,
  resolveActiveQuickSend,
} from "../src/index.js";

describe("quick send shorthand enforcement", () => {
  it("enforces a maximum character length of 20", () => {
    expect(QUICK_SEND_SHORTHAND_MAX_LENGTH).toBe(20);
  });

  it("trims and clamps shorthand text to 20 chars", () => {
    expect(enforceQuickSendShorthand("  proceed  ")).toBe("proceed");
    expect(enforceQuickSendShorthand("commit and push all changes")).toBe("commit and push all ");
    expect(enforceQuickSendShorthand("12345678901234567890extra")).toBe("12345678901234567890");
    expect(enforceQuickSendShorthand("")).toBe("");
  });

  it("enforces shorthand length in allQuickSends and resolveActiveQuickSend", () => {
    const custom = {
      id: "custom-1",
      label: "Deploy to production immediately",
      message: "deploy production",
      shorthand: "Deploy to production immediately",
    };
    const sends = allQuickSends([custom]);
    const found = sends.find((s) => s.id === "custom-1");
    expect(found).toBeDefined();
    expect(found!.shorthand).toBe("Deploy to production");
    expect(found!.shorthand.length).toBeLessThanOrEqual(20);

    const active = resolveActiveQuickSend("custom-1", [custom]);
    expect(active.shorthand).toBe("Deploy to production");
    expect(active.shorthand.length).toBeLessThanOrEqual(20);
  });

  it("falls back to clamped label if shorthand is empty in allQuickSends", () => {
    const custom = {
      id: "custom-2",
      label: "Run test suite and check exit",
      message: "run tests",
      shorthand: "",
    };
    const sends = allQuickSends([custom]);
    const found = sends.find((s) => s.id === "custom-2");
    expect(found!.shorthand).toBe("Run test suite and c");
  });

  it("de-duplicates by id so a custom cannot shadow a built-in", () => {
    const hijack = {
      id: "proceed",
      label: "Hijack",
      message: "not the real proceed",
      shorthand: "hijack",
    };
    const sends = allQuickSends([hijack]);
    const proceed = sends.filter((s) => s.id === "proceed");
    expect(proceed).toHaveLength(1);
    expect(proceed[0]!.message).toBe("proceed");
  });
});

describe("createQuickSendId", () => {
  /** Two adds inside one millisecond — what a fast second click produces. */
  const freeze = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-27T00:00:00.000Z"));
  };
  const seed = (id: string): QuickSend => ({ id, message: "m", shorthand: "s" });

  it("keeps the plain timestamp id when it is free", () => {
    freeze();
    try {
      expect(createQuickSendId([seed("proceed")])).toBe(`custom-${Date.now()}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suffixes a taken id instead of reusing it", () => {
    freeze();
    try {
      const base = `custom-${Date.now()}`;
      expect(createQuickSendId([seed(base)])).toBe(`${base}-1`);
      expect(createQuickSendId([seed(base), seed(`${base}-1`)])).toBe(`${base}-2`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("yields same-millisecond ids that both survive allQuickSends dedupe", () => {
    freeze();
    try {
      const first: QuickSend = { id: createQuickSendId([]), message: "first", shorthand: "one" };
      const second: QuickSend = {
        id: createQuickSendId([first]),
        message: "second",
        shorthand: "two",
      };
      expect(second.id).not.toBe(first.id);
      const ids = allQuickSends([first, second]).map((q) => q.id);
      expect(ids).toContain(first.id);
      expect(ids).toContain(second.id);
      expect(ids).toHaveLength(BUILTIN_QUICK_SENDS.length + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("createQuickSendId", () => {
  const custom = (id: string, shorthand: string) => ({ id, message: shorthand, shorthand });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps a free id from the clock", () => {
    expect(createQuickSendId([])).toBe(`custom-${Date.now()}`);
  });

  it("walks the suffix past every id taken inside one millisecond", () => {
    const first = createQuickSendId([]);
    const second = createQuickSendId([custom(first, "alpha")]);
    const third = createQuickSendId([custom(first, "alpha"), custom(second, "beta")]);

    expect(second).toBe(`${first}-1`);
    expect(third).toBe(`${first}-2`);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("keeps same-millisecond adds distinct after allQuickSends de-dupes", () => {
    const customs: { id: string; message: string; shorthand: string }[] = [];
    for (let i = 0; i < 5; i += 1) {
      customs.push(custom(createQuickSendId(customs), `send ${i}`));
    }

    const merged = allQuickSends(customs);
    expect(merged.map((q) => q.id)).toEqual(expect.arrayContaining(customs.map((q) => q.id)));
    expect(merged).toHaveLength(BUILTIN_QUICK_SENDS.length + customs.length);
  });
});
