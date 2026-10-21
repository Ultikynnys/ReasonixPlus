import { describe, expect, it } from "vitest";
import {
  BROWSER_SEARCH_ENGINES,
  SEARCH_ENGINE_IDS,
  SEARCH_ENGINE_SPECS,
  parseSearchRegistry,
  parseSearchSettingsPatch,
  requireSearchEngineError,
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
      "deepseek",
      "playwright-webkit",
    ].filter((id) => searchEngineDeclared(id));
    expect(SEARCH_ENGINE_IDS).toEqual(declared);
    expect(SEARCH_ENGINE_SPECS.map((spec) => spec.order)).toEqual(
      [...SEARCH_ENGINE_SPECS.map((spec) => spec.order)].sort((a, b) => a - b),
    );
  });

  it("inherits error copy from a sibling engine, with own keys winning", () => {
    const [base, child] = parseSearchRegistry({
      engines: [
        {
          id: "base",
          label: "Base",
          order: 1,
          kind: "keyless",
          strategy: "bing-html",
          errors: { status: "base status", blocked: "base blocked" },
        },
        {
          id: "child",
          label: "Child",
          order: 2,
          kind: "keyless",
          strategy: "playwright",
          browser: "webkit",
          extends: "base",
          errors: { blocked: "child blocked" },
        },
      ],
    });
    // Inherited what it did not declare, overrode what it did.
    expect(child?.errors.rateLimit).toBeUndefined();
    expect(child?.errors.status).toBe("base status");
    expect(child?.errors.blocked).toBe("child blocked");
    expect(base?.errors.blocked).toBe("base blocked");
  });

  it("rejects a broken copy chain loudly", () => {
    const engine = (extra: Record<string, unknown>) => ({
      engines: [
        { id: "child", label: "Child", order: 1, kind: "keyless", strategy: "bing-html", ...extra },
      ],
    });
    expect(() => parseSearchRegistry(engine({ extends: "missing" }))).toThrow(
      /extends undeclared engine "missing"/,
    );
    expect(() => parseSearchRegistry(engine({ extends: "child" }))).toThrow(/cannot extend itself/);
    expect(() =>
      parseSearchRegistry({
        engines: [
          { id: "a", label: "A", order: 1, kind: "keyless", strategy: "bing-html", extends: "b" },
          { id: "b", label: "B", order: 2, kind: "keyless", strategy: "bing-html", extends: "a" },
        ],
      }),
    ).toThrow(/extends cycle/);
  });

  it("templates the playwright copy instead of hardcoding a browser name", () => {
    const webkit = requireSearchEngineSpec("playwright-webkit");
    // The transport binds these from the declared `browser`, so the copy stays reusable.
    expect(requireSearchEngineError(webkit, "notInstalled")).toContain("{Browser}");
    expect(requireSearchEngineError(webkit, "notInstalled")).toContain(
      "playwright install {browser}",
    );
    // The retry hint is the engine's own wording, not a sentence in TypeScript.
    expect(requireSearchEngineError(webkit, "mismatched")).toContain("{alternative}");
    expect(webkit.browser).toBe("webkit");
    expect(requireSearchEngineError(requireSearchEngineSpec("bing"), "blocked")).toContain("Bing");
  });
  it("declares every message template its strategy can emit", () => {
    // A transport reads these keys by name, so a missing one must fail here rather
    // than at call time with "declares no errors.<key> message".
    const keyed = [
      "cannotReach",
      "missingKey",
      "unauthorized",
      "rateLimit",
      "serverError",
      "parseError",
    ];
    const bingKeys = [
      "status",
      "rateLimit",
      "forbidden",
      "serverError",
      "cannotReach",
      "blocked",
      "noResults",
    ];
    const required: Record<string, string[]> = {
      "bing-html": bingKeys,
      "bing-intl": bingKeys,
      searxng: [
        "status",
        "rateLimit",
        "forbidden",
        "serverError",
        "cannotReach",
        "invalidEndpoint",
        "endpointMustBeHttp",
        "noResults",
      ],
      metaso: [...keyed, "dailyLimit", "apiError"],
      playwright: [
        "alternative",
        "notFound",
        "notInstalled",
        "launchFailed",
        "cannotReach",
        "timeout",
        "blocked",
        "mismatched",
      ],
    };
    const fetchKeys = [
      "fetchMissingKey",
      "fetchUnauthorized",
      "fetchRateLimit",
      "fetchServerError",
      "fetchParseError",
    ];
    for (const spec of SEARCH_ENGINE_SPECS) {
      for (const key of required[spec.strategy] ?? keyed) {
        expect(Object.keys(spec.errors), `${spec.id} declares ${key}`).toContain(key);
      }
      if (spec.fetchStrategy === "http") continue;
      for (const key of fetchKeys) {
        expect(Object.keys(spec.errors), `${spec.id} declares ${key}`).toContain(key);
      }
    }
  });

  it("declares no settings on a keyless engine", () => {
    expect(requireSearchEngineSpec("bing").settings).toEqual([]);
    expect(requireSearchEngineSpec("bing").kind).toBe("keyless");
  });

  it("pairs the playwright strategy with exactly one managed browser", () => {
    for (const spec of SEARCH_ENGINE_SPECS) {
      if (spec.strategy !== "playwright") {
        expect(spec.browser, spec.id).toBeNull();
        continue;
      }
      expect(BROWSER_SEARCH_ENGINES, spec.id).toContain(spec.browser);
    }
    // The browser is what the transport launches, so a document without one is invalid.
    expect(() =>
      parseSearchRegistry({
        engines: [{ id: "pw", label: "PW", order: 1, kind: "keyless", strategy: "playwright" }],
      }),
    ).toThrow(/browser: required for the playwright strategy/);
    expect(() =>
      parseSearchRegistry({
        engines: [
          {
            id: "bingish",
            label: "Bingish",
            order: 1,
            kind: "keyless",
            strategy: "bing-html",
            browser: "chromium",
          },
        ],
      }),
    ).toThrow(/browser: only the playwright strategy drives a browser/);
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
