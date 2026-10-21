import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchEngineDeclared } from "@reasonix/core-utils";

/** Declared once, so both migration tests key off the same answer. */
const BRAVE_DECLARED = searchEngineDeclared("brave");
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSearchApiKey,
  loadSearchApiKeys,
  loadSearchSetting,
  readConfig,
  saveSearchSetting,
  webSearchEndpoint,
} from "../src/config.js";

/** Engine env names cleared so the persisted value is the only source. */
const ENGINE_ENV = [
  "METASO_API_KEY",
  "BAIDU_API_KEY",
  "QIANFAN_API_KEY",
  "TAVILY_API_KEY",
  "PERPLEXITY_API_KEY",
  "EXA_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "BRAVE_API_KEY",
];

describe("search settings store", () => {
  let dir: string;
  let path: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-search-store-"));
    path = join(dir, "config.json");
    for (const name of ENGINE_ENV) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  /** A config file as an older version of Reasonix wrote it. */
  function writeLegacy(extra: Record<string, unknown> = {}): void {
    writeFileSync(
      path,
      JSON.stringify({
        webSearchEngine: "tavily",
        webSearchEndpoint: "http://localhost:9999",
        metasoApiKey: "metaso-key",
        baiduApiKey: "baidu-key",
        tavilyApiKey: "tavily-key",
        perplexityApiKey: "pplx-key",
        exaApiKey: "exa-key",
        braveApiKey: "brave-key",
        ...extra,
      }),
    );
  }

  it("migrates every legacy engine field into the search store", () => {
    writeLegacy();
    const cfg = readConfig(path);
    // Derived: an engine whose file is deleted simply stops migrating.
    const expected: Record<string, Record<string, string>> = {
      searxng: { endpoint: "http://localhost:9999" },
      metaso: { apiKey: "metaso-key" },
      baidu: { apiKey: "baidu-key" },
      tavily: { apiKey: "tavily-key" },
      perplexity: { apiKey: "pplx-key" },
      exa: { apiKey: "exa-key" },
    };
    if (BRAVE_DECLARED) expected.brave = { apiKey: "brave-key" };
    expect(cfg.searchSettings).toEqual(expected);
    // The selected engine stays a single field, not a per-engine credential.
    expect(cfg.webSearchEngine).toBe("tavily");
  });

  it("resolves keys and the SearXNG endpoint through the registry", () => {
    writeLegacy();
    expect(loadSearchApiKey("tavily", path)).toBe("tavily-key");
    expect(loadSearchApiKey("metaso", path)).toBe("metaso-key");
    expect(webSearchEndpoint(path)).toBe("http://localhost:9999");
    const keys = loadSearchApiKeys(path);
    expect(keys.tavily).toBe("tavily-key");
    if (BRAVE_DECLARED) expect(keys.brave).toBe("brave-key");
    // A keyless engine reports no key at all.
    expect("bing" in keys).toBe(false);
  });

  it("drops the migrated fields from the file on the next write", () => {
    writeLegacy();
    saveSearchSetting("tavily", "apiKey", "new-key", path);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("tavilyApiKey");
    expect(raw).not.toHaveProperty("metasoApiKey");
    expect(raw).not.toHaveProperty("webSearchEndpoint");
    expect(raw.searchSettings).toMatchObject({ tavily: { apiKey: "new-key" } });
  });

  it("shares one variable with the model provider instead of duplicating it", () => {
    // A Z.AI key saved on the Models tab is the web-search key too.
    writeLegacy({ zaiApiKey: "zai-shared" });
    expect(loadSearchSetting("zai", "apiKey", path)).toBe("zai-shared");
    expect(loadSearchApiKey("zai", path)).toBe("zai-shared");
    expect(readConfig(path).searchSettings?.zai).toBeUndefined();
    // Writing through the engine surface lands in the provider entry, never a copy.
    saveSearchSetting("zai", "apiKey", "rotated", path);
    const cfg = readConfig(path);
    expect(cfg.providerSettings?.zai?.apiKey).toBe("rotated");
    expect(cfg.searchSettings?.zai).toBeUndefined();
  });

  it("clears a setting with an empty value", () => {
    saveSearchSetting("exa", "apiKey", "  exa-1  ", path);
    expect(loadSearchSetting("exa", "apiKey", path)).toBe("exa-1");
    saveSearchSetting("exa", "apiKey", "", path);
    expect(loadSearchSetting("exa", "apiKey", path)).toBeUndefined();
    expect(readConfig(path).searchSettings?.exa).toBeUndefined();
  });

  it("prefers a declared env override over the store", () => {
    writeLegacy({ tavilyApiKey: "stored" });
    process.env.TAVILY_API_KEY = "from-env";
    expect(loadSearchApiKey("tavily", path)).toBe("from-env");
  });

  it("refuses an unknown engine and an undeclared setting", () => {
    expect(() => saveSearchSetting("nope", "apiKey", "v", path)).toThrow(/unknown engine "nope"/);
    expect(() => saveSearchSetting("tavily", "endpoint", "v", path)).toThrow(
      /declares no setting "endpoint"/,
    );
  });
});
