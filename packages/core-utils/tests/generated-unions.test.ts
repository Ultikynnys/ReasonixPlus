import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEARCH_ENGINE_NAMES, type SearchEngineID } from "../src/search-engines.generated.js";
import { PROVIDER_IDS, type ProviderID } from "../src/providers.generated.js";

const here = dirname(fileURLToPath(import.meta.url));

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type ExpectedId<Ids extends readonly string[]> = [Ids[number]] extends [never]
  ? string
  : Ids[number];

// The id type must equal exactly what its tuple implies: the literal union while
// declarations exist, and `string` when the set is empty. Both states satisfy this;
// a generator that widened unconditionally would make `Exact` false and stop this
// file compiling instead of degrading silently.
const providerIdIsExact: Exact<ProviderID, ExpectedId<typeof PROVIDER_IDS>> = true;
const engineIdIsExact: Exact<SearchEngineID, ExpectedId<typeof SEARCH_ENGINE_NAMES>> = true;

describe("generated id unions", () => {
  it("match their own id tuple", () => {
    expect(providerIdIsExact).toBe(true);
    expect(engineIdIsExact).toBe(true);
    // The shipped tree declares both sets; with every barrel empty the Exact
    // aliases above require `string` instead, which covers the empty case.
    expect(PROVIDER_IDS.length).toBeGreaterThan(0);
    expect(SEARCH_ENGINE_NAMES.length).toBeGreaterThan(0);
  });

  it("carry the empty-set fallback in both barrels", () => {
    for (const barrel of ["providers.generated.ts", "search-engines.generated.ts"]) {
      const source = readFileSync(join(here, "..", "src", barrel), "utf8");
      expect(source, `${barrel} must keep the empty-set fallback`).toContain("extends [never]");
    }
  });
});
