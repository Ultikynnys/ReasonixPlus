import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProviderRegistry } from "../packages/core-utils/src/provider-registry.js";
import { PROVIDER_IDS } from "../packages/core-utils/src/providers.generated.js";
import { readProviderDocuments, renderRegistry } from "../scripts/generate-provider-registry.mjs";

const PROVIDERS_DIR = join(process.cwd(), "packages/core-utils/src/providers");
const GENERATED_PATH = join(process.cwd(), "packages/core-utils/src/providers.generated.ts");
const SYNC_HINT = "run `npm run providers:sync` to regenerate providers.generated.ts";

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
