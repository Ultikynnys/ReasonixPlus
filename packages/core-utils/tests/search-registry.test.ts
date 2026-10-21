import { describe, expect, it } from "vitest";
import {
  SEARCH_ENGINE_IDS,
  SEARCH_ENGINE_SPECS,
  SEARCH_FALLBACK_ENGINES,
  parseSearchRegistry,
  parseSearchSettingsPatch,
  requireSearchEngineSpec,
  searchEngineDeclared,
  searchEngineSpec,
  searchSettingStorePath,
  searchSharedCredential,
} from "../src/search-registry.js";

describe("search engine registry", () => {
  it("parses every declared engine in picker order", () => {
    // Declared engines only: deleting an engine JSON shrinks the list instead of failing.
    const declared = [
      "bing",
      "bing-intl",
      "searxng",
      "metaso",
      "baidu",
      "tavily",
      "perplexity",
      "exa",
      "brave",
      "ollama",
      "zai",
    ].filter((id) => searchEngineDeclared(id));
    expect(SEARCH_ENGINE_IDS).toEqual(declared);
    expect(SEARCH_ENGINE_SPECS.map((spec) => spec.order)).toEqual(
      [...SEARCH_ENGINE_SPECS.map((spec) => spec.order)].sort((a, b) => a - b),
    );
  });

  it("derives the keyless fallback list from the declarations", () => {
    expect(SEARCH_FALLBACK_ENGINES).toEqual(["bing", "bing-intl"]);
  });

  it("declares no settings on a keyless engine", () => {
    expect(requireSearchEngineSpec("bing").settings).toEqual([]);
    expect(requireSearchEngineSpec("bing").kind).toBe("keyless");
  });

  it("declares display copy for every engine", () => {
    for (const spec of SEARCH_ENGINE_SPECS) {
      // Copy lives in the declaration, so each engine carries its own text.
      expect(spec.label, spec.id).toBeTruthy();
      expect(spec.description ?? "", spec.id).toBeTruthy();
    }
  });

  it("points a shared engine at the model provider's own store path", () => {
    const zai = requireSearchEngineSpec("zai");
    expect(searchSharedCredential(zai)).toEqual({ provider: "zai", key: "apiKey" });
    // The same variable the Models tab writes — never a second one.
    expect(searchSettingStorePath(zai, "apiKey")).toBe("zai.apiKey");
    expect(zai.settings).toEqual([]);
    const ollama = requireSearchEngineSpec("ollama");
    expect(searchSettingStorePath(ollama, "apiKey")).toBe("ollama.apiKey");
  });

  it("keeps its own store path for an engine that owns its key", () => {
    const tavily = requireSearchEngineSpec("tavily");
    expect(searchSharedCredential(tavily)).toBeNull();
    expect(searchSettingStorePath(tavily, "apiKey")).toBe("tavily.apiKey");
    expect(searchSettingStorePath(tavily, "endpoint")).toBeNull();
  });

  it("gives SearXNG its endpoint setting", () => {
    const searxng = requireSearchEngineSpec("searxng");
    expect(searxng.kind).toBe("endpoint");
    expect(searxng.settings).toEqual([
      expect.objectContaining({
        key: "endpoint",
        kind: "url",
        configKey: "webSearchEndpoint",
        placeholder: "http://localhost:8080",
      }),
    ]);
  });

  it("accepts a synthetic engine document without code changes", () => {
    const [spec] = parseSearchRegistry({
      engines: [
        {
          id: "acme-search",
          label: "Acme Search",
          order: 1,
          kind: "api-key",
          strategy: "tavily",
          settings: [
            {
              key: "apiKey",
              kind: "secret",
              env: ["ACME_SEARCH_KEY"],
              configKey: null,
              label: "Acme API key",
            },
          ],
        },
      ],
    });
    expect(spec?.id).toBe("acme-search");
    // A description is optional: an engine without one renders title-only.
    expect(spec?.description).toBeNull();
    expect(spec?.fallback).toBe(false);
    expect(spec?.settings[0]?.env).toEqual(["ACME_SEARCH_KEY"]);
  });

  it("rejects a share whose provider does not declare the setting", () => {
    expect(() =>
      parseSearchRegistry({
        engines: [
          {
            id: "acme-shared",
            label: "Acme Shared",
            order: 1,
            kind: "shared",
            strategy: "zai",
            sharedCredential: { provider: "zai", key: "notASetting" },
          },
        ],
      }),
    ).toThrow(/declares no setting "notASetting"/);
  });

  it("refuses to write a shared credential through the search surface", () => {
    const { writes, rejected } = parseSearchSettingsPatch({
      tavily: { apiKey: "tv-key" },
      zai: { apiKey: "zai-key" },
      nope: { apiKey: "x" },
      ...(searchEngineSpec("brave") ? { brave: { notAKey: "x" } } : {}),
    });
    expect(rejected).toEqual([
      "zai.apiKey",
      "nope",
      ...(searchEngineSpec("brave") ? ["brave.notAKey"] : []),
    ]);
    expect(writes).toEqual([{ engineId: "tavily", key: "apiKey", value: "tv-key" }]);
  });

  it("answers an unknown id without throwing", () => {
    expect(searchEngineSpec("nope")).toBeUndefined();
    expect(() => requireSearchEngineSpec("nope")).toThrow(/no engine declares "nope"/);
  });
});
