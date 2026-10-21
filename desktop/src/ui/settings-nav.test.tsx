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
});
