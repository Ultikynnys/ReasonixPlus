/** Sidebar nav is generated from PAGE_META, so a page whose label or description
 *  key is missing from the dictionary renders its raw `settings.page…` path. */

import { describe, expect, it } from "vitest";
import { type TKey, t } from "../i18n";
import { PAGE_META } from "./settings";

describe("settings nav", () => {
  it("translates every page label and description", () => {
    for (const { id } of PAGE_META) {
      const suffix = `${id[0]!.toUpperCase()}${id.slice(1)}`;
      for (const kind of ["Label", "Desc"]) {
        const key = `settings.page${suffix}${kind}` as TKey;
        expect(t(key), `${id} is missing ${key}`).not.toBe(key);
      }
    }
  });

  it("lists every page once", () => {
    const ids = PAGE_META.map((entry) => entry.id);
    expect(new Set(ids).size, `a page is listed twice: ${ids.join(", ")}`).toBe(ids.length);
  });

  it("gives a page's sections unique ids and real labels", () => {
    for (const entry of PAGE_META) {
      const sections = entry.sections ?? [];
      if (sections.length === 0) continue;
      // One section needs no index; the rows are there to move between parts.
      expect(sections.length, `${entry.id} has a single section`).toBeGreaterThan(1);

      const ids = sections.map((section) => section.id);
      expect(new Set(ids).size, `${entry.id} repeats a section id: ${ids.join(", ")}`).toBe(
        ids.length,
      );
      for (const section of sections) {
        expect(t(section.labelKey), `${entry.id}/${section.id} is missing its label`).not.toBe(
          section.labelKey,
        );
      }
    }
  });
});
