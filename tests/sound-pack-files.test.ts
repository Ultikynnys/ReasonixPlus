import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEEDBACK_CUE_IDS } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOUND_PACK_DOCUMENTS, SOUND_PACK_NAMES } from "../desktop/src/sound-packs.generated.js";
import {
  readSoundPackDocuments,
  renderSoundPackRegistry,
} from "../scripts/generate-provider-registry.mjs";

const PACKS_DIR = join(process.cwd(), "desktop/public/sound-packs");
const GENERATED_PATH = join(process.cwd(), "desktop/src/sound-packs.generated.ts");
const SYNC_HINT = "run `npm run providers:sync` to regenerate sound-packs.generated.ts";

const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

type Manifest = {
  id?: string;
  order?: number;
  default?: boolean;
  sounds?: Record<string, string>;
};

const manifestOf = (document: unknown): Manifest => document as Manifest;

describe("sound-packs/ folders", () => {
  it("commits a barrel that matches the pack folders", () => {
    const committed = normalize(readFileSync(GENERATED_PATH, "utf8"));
    expect(normalize(renderSoundPackRegistry(PACKS_DIR)), SYNC_HINT).toBe(committed);
  });

  it("names every manifest after its folder", () => {
    for (const { dir, document } of readSoundPackDocuments(PACKS_DIR)) {
      expect(dir).toBe(manifestOf(document).id);
    }
  });

  it("derives the id union from each folder, in card order", () => {
    const ids = readSoundPackDocuments(PACKS_DIR)
      .map((entry) => ({
        order: Number(manifestOf(entry.document).order ?? 0),
        dir: entry.dir,
      }))
      .sort((a, b) => a.order - b.order || a.dir.localeCompare(b.dir))
      .map((entry) => entry.dir);
    expect([...SOUND_PACK_NAMES]).toEqual(ids);
    expect(SOUND_PACK_DOCUMENTS.map((entry) => entry.dir)).toEqual(
      readSoundPackDocuments(PACKS_DIR).map((entry) => entry.dir),
    );
  });

  it("only names cues the wire protocol declares", () => {
    const cueIds = new Set<string>(FEEDBACK_CUE_IDS);
    for (const { dir, document } of readSoundPackDocuments(PACKS_DIR)) {
      for (const cue of Object.keys(manifestOf(document).sounds ?? {})) {
        expect(cueIds.has(cue), `sound-packs/${dir} declares unknown cue "${cue}"`).toBe(true);
      }
    }
  });

  it("reserves the id the desktop declares itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-packs-reserved-"));
    try {
      mkdirSync(join(dir, "nothing"));
      writeFileSync(
        join(dir, "nothing", "pack.json"),
        JSON.stringify({ id: "nothing", sounds: {} }),
      );
      expect(() => renderSoundPackRegistry(dir)).toThrow(
        /reserved for the pack the desktop declares/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a manifest naming an audio file the folder does not hold", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-packs-bad-"));
    try {
      mkdirSync(join(dir, "broken"));
      writeFileSync(
        join(dir, "broken", "pack.json"),
        JSON.stringify({ id: "broken", sounds: { inputRequired: "missing.ogg" } }),
      );
      expect(() => renderSoundPackRegistry(dir)).toThrow(/names missing file "missing\.ogg"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a manifest whose id does not match its folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-packs-mismatch-"));
    try {
      mkdirSync(join(dir, "wrong"));
      writeFileSync(join(dir, "wrong", "pack.json"), JSON.stringify({ id: "other", sounds: {} }));
      expect(() => renderSoundPackRegistry(dir)).toThrow(/"id" must equal the folder name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adding and removing a sound pack", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-packs-"));
    cpSync(PACKS_DIR, dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes the barrel and the union from one folder alone", () => {
    const before = renderSoundPackRegistry(dir);
    expect(before).not.toContain("sound-packs/acme");

    mkdirSync(join(dir, "acme"));
    cpSync(join(PACKS_DIR, "default", "question_001.ogg"), join(dir, "acme", "question_001.ogg"));
    writeFileSync(
      join(dir, "acme", "pack.json"),
      JSON.stringify({
        id: "acme",
        label: "Acme",
        order: 99,
        sounds: { inputRequired: "question_001.ogg" },
      }),
    );
    const added = renderSoundPackRegistry(dir);
    expect(added).toContain('dir: "acme"');
    expect(added).toContain('  "acme",');

    rmSync(join(dir, "acme"), { recursive: true, force: true });
    expect(renderSoundPackRegistry(dir)).toBe(before);
  });

  it("drops the id from the union when the folder is deleted", () => {
    const before = renderSoundPackRegistry(dir);
    expect(before).toContain('  "halo",');

    rmSync(join(dir, "halo"), { recursive: true, force: true });
    expect(renderSoundPackRegistry(dir)).not.toContain('  "halo",');
  });
});
