/** Sidebar nav is generated from PAGE_META, so a page whose label or description
 *  key is missing from the dictionary renders its raw `settings.page…` path. */

import { describe, expect, it } from "vitest";
import { type TKey, t } from "../i18n";
import { PAGE_ENTRIES, PAGE_META } from "./settings";

describe("settings nav", () => {
  it("translates every page label and description, subcategories included", () => {
    for (const { id } of PAGE_ENTRIES) {
      const suffix = `${id[0]!.toUpperCase()}${id.slice(1)}`;
      for (const kind of ["Label", "Desc"]) {
        const key = `settings.page${suffix}${kind}` as TKey;
        expect(t(key), `${id} is missing ${key}`).not.toBe(key);
      }
    }
  });

  it("lists every page once, and a child only under its parent", () => {
    const ids = PAGE_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size, `a page is listed twice: ${ids.join(", ")}`).toBe(ids.length);

    const topLevel = new Set(PAGE_META.map((entry) => entry.id));
    for (const entry of PAGE_META) {
      for (const child of entry.children ?? []) {
        expect(topLevel.has(child), `${child} is both a child and a top-level row`).toBe(false);
        expect(
          PAGE_ENTRIES.some((candidate) => candidate.id === child),
          `${child} is not reachable in the nav`,
        ).toBe(true);
      }
    }
  });

  it("gives a group more than one child, so nesting is worth the guide line", () => {
    const group = PAGE_META.find((entry) => (entry.children?.length ?? 0) > 0);
    expect(group, "no group in the nav").toBeTruthy();
    expect(group?.children?.length).toBeGreaterThan(1);
  });
});
