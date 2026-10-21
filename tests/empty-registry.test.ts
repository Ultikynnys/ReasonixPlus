import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_OFFICIAL_MODELS } from "../packages/core-utils/src/models.js";
import {
  PROVIDER_MODEL_PRECEDENCE,
  PROVIDER_SPECS,
  ROUTABLE_PROVIDER_SPECS,
  parseProviderRegistry,
  providerDefaultEndpoint,
  providerSpec,
  providerVisionSpec,
  requireProviderSpec,
} from "../packages/core-utils/src/provider-registry.js";
import {
  SEARCH_ENGINE_SPECS,
  parseSearchRegistry,
  requireSearchEngineSpec,
  searchEngineSpec,
} from "../packages/core-utils/src/search-registry.js";
import { renderRegistry, renderSearchRegistry } from "../scripts/generate-provider-registry.mjs";

const emptyDir = (): string => mkdtempSync(join(tmpdir(), "reasonix-empty-registry-"));

describe("optional registries", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("parses an empty provider document into no specs", () => {
    expect(parseProviderRegistry({ providers: [] })).toEqual([]);
  });

  it("parses an empty engine document into no specs", () => {
    expect(parseSearchRegistry({ engines: [] })).toEqual([]);
  });

  it("renders a valid provider barrel from an empty directory", () => {
    const dir = emptyDir();
    dirs.push(dir);
    const text = renderRegistry(dir);
    expect(text).toMatch(/PROVIDER_DOCUMENTS[\s\S]*?=\s*\[\s*\]/);
    expect(text).toMatch(/PROVIDER_IDS\s*=\s*\[\s*\]\s*as const/);
    // The id type is still declared, so an empty set narrows it instead of breaking the import.
    expect(text).toContain("ProviderID");
  });

  it("renders a valid engine barrel from an empty directory", () => {
    const dir = emptyDir();
    dirs.push(dir);
    const text = renderSearchRegistry(dir);
    expect(text).toMatch(/SEARCH_ENGINE_DOCUMENTS[\s\S]*?=\s*\[\s*\]/);
    expect(text).toMatch(/SEARCH_ENGINE_NAMES\s*=\s*\[\s*\]\s*as const/);
    expect(text).toContain("SearchEngineID");
  });

  it("answers an absent id without throwing", () => {
    expect(providerSpec("nope")).toBeUndefined();
    expect(() => requireProviderSpec("nope")).toThrow(/nope/);
    expect(providerDefaultEndpoint("nope")).toBeUndefined();
    expect(() => providerVisionSpec("nope" as never)).not.toThrow();
    expect(searchEngineSpec("nope")).toBeUndefined();
    expect(() => requireSearchEngineSpec("nope")).toThrow(/nope/);
  });

  it("keeps the shipped registries non-empty", () => {
    // The optional-data support must not silently ship an empty registry.
    expect(PROVIDER_SPECS.length).toBeGreaterThan(0);
    expect(ROUTABLE_PROVIDER_SPECS.length).toBeGreaterThan(0);
    expect(PROVIDER_MODEL_PRECEDENCE.length).toBeGreaterThan(0);
    expect(SUPPORTED_OFFICIAL_MODELS.length).toBeGreaterThan(0);
    expect(SEARCH_ENGINE_SPECS.length).toBeGreaterThan(0);
  });
});

describe("zero-data boot", () => {
  afterEach(() => {
    vi.doUnmock("../packages/core-utils/src/providers.generated.js");
    vi.doUnmock("../packages/core-utils/src/search-engines.generated.js");
    vi.resetModules();
  });

  it("boots with no providers and no engines, resolving no endpoint", async () => {
    vi.resetModules();
    vi.doMock("../packages/core-utils/src/providers.generated.js", async () => ({
      ...(await vi.importActual<Record<string, unknown>>(
        "../packages/core-utils/src/providers.generated.js",
      )),
      PROVIDER_DOCUMENTS: [],
      PROVIDER_IDS: [],
    }));
    vi.doMock("../packages/core-utils/src/search-engines.generated.js", async () => ({
      ...(await vi.importActual<Record<string, unknown>>(
        "../packages/core-utils/src/search-engines.generated.js",
      )),
      SEARCH_ENGINE_DOCUMENTS: [],
      SEARCH_ENGINE_NAMES: [],
    }));

    const registry = await import("../packages/core-utils/src/provider-registry.js");
    const models = await import("../packages/core-utils/src/models.js");
    const search = await import("../packages/core-utils/src/search-registry.js");
    const config = await import("../src/config.js");

    expect(registry.PROVIDER_SPECS).toEqual([]);
    expect(registry.ROUTABLE_PROVIDER_SPECS).toEqual([]);
    expect(registry.PROVIDER_MODEL_PRECEDENCE).toEqual([]);
    expect(registry.providerSpec("deepseek")).toBeUndefined();
    expect(registry.providerDeclared("deepseek")).toBe(false);
    expect(models.SUPPORTED_OFFICIAL_MODELS).toEqual([]);
    expect(models.KNOWN_MODELS).toEqual([]);
    expect(search.SEARCH_ENGINE_SPECS).toEqual([]);
    expect(search.SEARCH_ENGINE_IDS).toEqual([]);
    expect(search.searchEngineDeclared("bing")).toBe(false);

    // The daemon loads and degrades instead of throwing.
    expect(config.providerForModel("deepseek-v4.1-flash")).toEqual("");
    expect(config.loadEndpointForModel("deepseek-v4.1-flash")).toEqual({
      baseUrl: undefined,
      apiKey: undefined,
    });
    expect(config.loadCatalogEndpoint("deepseek")).toEqual({
      baseUrl: undefined,
      apiKey: undefined,
    });
    expect(config.loadProviderApiKeys()).toEqual({});
    // Store paths stay addressable with no declarations, so a stale write cannot throw either.
    expect(registry.providerSettingPath("deepseek", "apiKey")).toBe("deepseek.apiKey");
  });
});
