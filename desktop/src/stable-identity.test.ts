import { describe, expect, it } from "vitest";
import { keepStable, sameNumberMap, sameStringList, sameStringSet } from "./stable-identity";

describe("sameNumberMap", () => {
  it("treats equal contents as unchanged even when the maps differ", () => {
    expect(sameNumberMap(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
  });

  it("notices a moved value, a new key and a dropped key", () => {
    const base = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(
      sameNumberMap(
        base,
        new Map([
          ["a", 1],
          ["b", 3],
        ]),
      ),
    ).toBe(false);
    expect(
      sameNumberMap(
        base,
        new Map([
          ["a", 1],
          ["b", 2],
          ["c", 0],
        ]),
      ),
    ).toBe(false);
    expect(sameNumberMap(base, new Map([["a", 1]]))).toBe(false);
  });

  it("does not confuse a zero rate with a missing row", () => {
    expect(sameNumberMap(new Map([["a", 0]]), new Map())).toBe(false);
  });
});

describe("sameStringSet", () => {
  it("treats equal membership as unchanged even when the sets differ", () => {
    expect(sameStringSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
  });

  it("notices a session starting or finishing", () => {
    expect(sameStringSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
    expect(sameStringSet(new Set(["a", "b"]), new Set(["a"]))).toBe(false);
  });
});

describe("sameStringList", () => {
  it("compares names positionally", () => {
    expect(sameStringList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameStringList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameStringList(["a"], ["a", "b"])).toBe(false);
    expect(sameStringList([], [])).toBe(true);
  });
});

describe("keepStable", () => {
  it("returns the previous value when the contents did not move", () => {
    const previous = new Set(["a"]);
    expect(keepStable(previous, new Set(["a"]), sameStringSet)).toBe(previous);
  });

  it("returns the new value when they differ or nothing was cached yet", () => {
    const previous = new Set(["a"]);
    const next = new Set(["a", "b"]);
    expect(keepStable(previous, next, sameStringSet)).toBe(next);
    expect(keepStable(undefined, next, sameStringSet)).toBe(next);
  });
});
