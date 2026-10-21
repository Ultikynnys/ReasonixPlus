import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProviderRegistry } from "../packages/core-utils/src/provider-registry.js";
import { PROVIDER_IDS } from "../packages/core-utils/src/providers.generated.js";
import { SEARCH_ENGINE_NAMES } from "../packages/core-utils/src/search-engines.generated.js";
import { parseSearchRegistry } from "../packages/core-utils/src/search-registry.js";
import {
  readProviderDocuments,
  readSearchEngineDocuments,
  renderRegistry,
  renderSearchRegistry,
} from "../scripts/generate-provider-registry.mjs";

const PROVIDERS_DIR = join(process.cwd(), "packages/core-utils/src/providers");
const GENERATED_PATH = join(process.cwd(), "packages/core-utils/src/providers.generated.ts");
const SYNC_HINT = "run `npm run providers:sync` to regenerate providers.generated.ts";
const SEARCH_DIR = join(process.cwd(), "packages/core-utils/src/search-engines");
const SEARCH_GENERATED_PATH = join(
  process.cwd(),
  "packages/core-utils/src/search-engines.generated.ts",
);
const SEARCH_SYNC_HINT = "run `npm run providers:sync` to regenerate search-engines.generated.ts";

const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

describe("providers/ files", () => {
  it("commits a barrel that matches providers/*.json", () => {
    const committed = normalize(readFileSync(GENERATED_PATH, "utf8"));
    expect(normalize(renderRegistry(PROVIDERS_DIR)), SYNC_HINT).toBe(committed);
  });

  it("names every file after the provider id it declares", () => {
    for (const { file, id, document } of readProviderDocuments(PROVIDERS_DIR)) {
      expect(file).toBe(`${id}.json`);
      expect(document.id).toBe(id);
    }
  });

  it("declares unique catalog and routing ids", () => {
    const entries = readProviderDocuments(PROVIDERS_DIR);
    const ids = entries.map((entry) => entry.document.id);
    expect(new Set(ids).size).toBe(ids.length);
    const routable = entries
      .map((entry) => entry.document.providerId)
      .filter((providerId) => providerId !== null);
    expect(new Set(routable).size).toBe(routable.length);
    expect([...routable].sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it("validates each file against the registry schema", () => {
    for (const { file, document } of readProviderDocuments(PROVIDERS_DIR)) {
      const [spec] = parseProviderRegistry({ providers: [document] });
      expect(spec?.id, file).toBe(document.id);
    }
  });

  it("reports the offending file when a document is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-providers-bad-"));
    try {
      writeFileSync(join(dir, "broken.json"), "{ not json");
      expect(() => renderRegistry(dir)).toThrow(/providers\/broken\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adding and removing a provider", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-providers-"));
    cpSync(PROVIDERS_DIR, dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes the barrel from one JSON file alone", () => {
    const before = renderRegistry(dir);
    expect(before).not.toContain("providers/acme.json");

    writeFileSync(
      join(dir, "acme.json"),
      JSON.stringify({ id: "acme", providerId: "acme", order: 20 }),
    );
    const added = renderRegistry(dir);
    expect(added).toContain('import acme from "./providers/acme.json";');
    expect(added).toContain('{ file: "acme.json", document: acme },');
    expect(added).toContain('  "acme",');

    rmSync(join(dir, "acme.json"));
    expect(renderRegistry(dir)).toBe(before);
  });

  it("drops the id from the union when the file is deleted", () => {
    const before = renderRegistry(dir);
    expect(before).toContain('  "ollama",');
    rmSync(join(dir, "ollama.json"));
    expect(renderRegistry(dir)).not.toContain('  "ollama",');
  });
});

describe("search-engines/ files", () => {
  it("commits a barrel that matches search-engines/*.json", () => {
    const committed = normalize(readFileSync(SEARCH_GENERATED_PATH, "utf8"));
    expect(normalize(renderSearchRegistry(SEARCH_DIR)), SEARCH_SYNC_HINT).toBe(committed);
  });

  it("names every file after the engine id it declares", () => {
    for (const { file, id, document } of readSearchEngineDocuments(SEARCH_DIR)) {
      expect(file).toBe(`${id}.json`);
      expect((document as { id?: string }).id).toBe(id);
    }
  });

  it("derives the id union in picker order", () => {
    const ids = readSearchEngineDocuments(SEARCH_DIR)
      .map((entry) => ({
        id: entry.id,
        order: Number((entry.document as { order?: number }).order ?? 0),
      }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((entry) => entry.id);
    expect([...SEARCH_ENGINE_NAMES]).toEqual(ids);
  });

  it("validates every file against the registry schema", () => {
    // As one registry, not file by file: an engine may extend a sibling's error copy,
    // which a single document cannot resolve.
    const documents = readSearchEngineDocuments(SEARCH_DIR);
    const specs = parseSearchRegistry({ engines: documents.map((entry) => entry.document) });
    expect(specs.map((spec) => spec.id).sort()).toEqual(documents.map((entry) => entry.id).sort());
  });

  it("reports the offending file when a document is not valid JSON", () => {
    const scratch = mkdtempSync(join(tmpdir(), "reasonix-search-bad-"));
    try {
      writeFileSync(join(scratch, "broken.json"), "{ not json");
      expect(() => renderSearchRegistry(scratch)).toThrow(/search-engines\/broken\.json/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("adding and removing a search engine", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-search-"));
    cpSync(SEARCH_DIR, dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes the barrel from one JSON file alone", () => {
    const before = renderSearchRegistry(dir);
    expect(before).not.toContain("search-engines/acme-search.json");
    writeFileSync(
      join(dir, "acme-search.json"),
      JSON.stringify({
        id: "acme-search",
        labelKey: "settings.webSearchEngineAcme",
        order: 99,
        kind: "keyless",
        strategy: "bing-html",
      }),
    );
    const added = renderSearchRegistry(dir);
    expect(added).toContain('import acme_search from "./search-engines/acme-search.json";');
    expect(added).toContain('  "acme-search",');
    rmSync(join(dir, "acme-search.json"));
    expect(renderSearchRegistry(dir)).toBe(before);
  });

  it("drops the id from the union when the file is deleted", () => {
    const before = renderSearchRegistry(dir);
    expect(before).toContain('  "tavily",');
    rmSync(join(dir, "tavily.json"));
    expect(renderSearchRegistry(dir)).not.toContain('  "tavily",');
  });
});
