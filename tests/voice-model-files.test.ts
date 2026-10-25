import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseVoiceModelRegistry } from "../desktop/src/voice/model-registry.js";
import { VOICE_MODEL_DOCUMENTS, VOICE_MODEL_IDS } from "../desktop/src/voice/models.generated.js";
import {
  readVoiceModelDocuments,
  renderVoiceRegistry,
} from "../scripts/generate-provider-registry.mjs";

const MODELS_DIR = join(process.cwd(), "desktop/src/voice/models");
const GENERATED_PATH = join(process.cwd(), "desktop/src/voice/models.generated.ts");
const SYNC_HINT = "run `npm run providers:sync` to regenerate models.generated.ts";

const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

describe("voice models/ files", () => {
  it("commits a barrel that matches models/*.json", () => {
    const committed = normalize(readFileSync(GENERATED_PATH, "utf8"));
    expect(normalize(renderVoiceRegistry(MODELS_DIR)), SYNC_HINT).toBe(committed);
  });

  it("names every file after the model id it declares", () => {
    for (const { file, id, document } of readVoiceModelDocuments(MODELS_DIR)) {
      expect(file).toBe(`${id}.json`);
      expect((document as { id?: string }).id).toBe(id);
    }
  });

  it("derives the id union from each declaration's modelId, in card order", () => {
    const ids = readVoiceModelDocuments(MODELS_DIR)
      .map((entry) => ({
        modelId: (entry.document as { modelId?: string }).modelId,
        order: Number((entry.document as { order?: number }).order ?? 0),
        id: entry.id,
      }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((entry) => entry.modelId);
    expect([...VOICE_MODEL_IDS]).toEqual(ids);
    expect(VOICE_MODEL_DOCUMENTS.map((entry) => entry.file)).toEqual(
      readVoiceModelDocuments(MODELS_DIR).map((entry) => entry.file),
    );
  });

  it("validates every file against the registry schema", () => {
    const documents = readVoiceModelDocuments(MODELS_DIR);
    const specs = parseVoiceModelRegistry({ models: documents.map((entry) => entry.document) });
    expect(specs.map((spec) => spec.id).sort()).toEqual(documents.map((entry) => entry.id).sort());
    expect(specs.filter((spec) => spec.default)).toHaveLength(1);
  });

  it("reports the offending file when a document is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-voice-bad-"));
    try {
      writeFileSync(join(dir, "broken.json"), "{ not json");
      expect(() => renderVoiceRegistry(dir)).toThrow(/voice models\/broken\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adding and removing a voice model", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-voice-"));
    cpSync(MODELS_DIR, dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes the barrel and the union from one JSON file alone", () => {
    const before = renderVoiceRegistry(dir);
    expect(before).not.toContain("models/acme-voice.json");

    writeFileSync(
      join(dir, "acme-voice.json"),
      JSON.stringify({
        id: "acme-voice",
        modelId: "acme/voice",
        engine: "transformers",
        order: 99,
      }),
    );
    const added = renderVoiceRegistry(dir);
    expect(added).toContain('import acme_voice from "./models/acme-voice.json";');
    expect(added).toContain('{ file: "acme-voice.json", document: acme_voice },');
    expect(added).toContain('  "acme/voice",');

    rmSync(join(dir, "acme-voice.json"));
    expect(renderVoiceRegistry(dir)).toBe(before);
  });

  it("drops the id from the union when the file is deleted", () => {
    const before = renderVoiceRegistry(dir);
    const [first] = readVoiceModelDocuments(dir);
    const selection = JSON.stringify((first!.document as { modelId: string }).modelId);
    expect(before).toContain(`  ${selection},`);

    rmSync(join(dir, first!.file));
    expect(renderVoiceRegistry(dir)).not.toContain(`  ${selection},`);
  });
});
