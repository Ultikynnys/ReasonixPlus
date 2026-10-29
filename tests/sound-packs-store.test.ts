import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSoundPack,
  listSoundPacks,
  removeSoundPack,
  soundPacksRoot,
} from "../src/sound-packs/store.js";

/** Minimal WebAudio-free fixture: the store only checks the extension and existence. The
 *  content is the source path, so a test can tell which file was copied. */
function audio(name: string, content = name): string {
  const file = join(sourceDir, name);
  writeFileSync(file, content);
  return file;
}

let home: string;
let sourceDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "reasonix-pack-home-"));
  sourceDir = mkdtempSync(join(tmpdir(), "reasonix-pack-src-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
});

describe("user sound packs", () => {
  it("lists nothing before a pack is created", () => {
    expect(soundPacksRoot(home)).toBe(join(home, ".reasonix", "sound-packs"));
    expect(listSoundPacks({ homeDir: home })).toEqual([]);
  });

  it("creates a folder with the manifest and a copy of every picked file", () => {
    const created = createSoundPack(
      {
        label: "Night Shift",
        sounds: {
          inputRequired: audio("question.ogg"),
          taskComplete: audio("done.ogg"),
        },
      },
      { homeDir: home },
    );

    expect(created.id).toBe("night-shift");
    expect(created.label).toBe("Night Shift");
    expect(created.sounds.inputRequired).toBe(
      join(soundPacksRoot(home), "night-shift", "question.ogg"),
    );
    expect(created.sounds.planComplete).toBeUndefined();

    const onDisk = readdirSync(join(soundPacksRoot(home), "night-shift")).sort();
    expect(onDisk).toEqual(["done.ogg", "pack.json", "question.ogg"]);
    const manifest = JSON.parse(
      readFileSync(join(soundPacksRoot(home), "night-shift", "pack.json"), "utf8"),
    );
    expect(manifest).toEqual({
      id: "night-shift",
      label: "Night Shift",
      sounds: { inputRequired: "question.ogg", taskComplete: "done.ogg" },
    });

    // The audio is a copy: deleting the source leaves the pack playable.
    rmSync(sourceDir, { recursive: true, force: true });
    expect(listSoundPacks({ homeDir: home })[0]?.sounds.taskComplete).toBe(
      join(soundPacksRoot(home), "night-shift", "done.ogg"),
    );
  });

  it("copies a file used by two cues once", () => {
    const created = createSoundPack(
      {
        label: "Shared",
        sounds: { inputRequired: audio("tone.ogg"), taskComplete: audio("tone.ogg") },
      },
      { homeDir: home },
    );
    expect(created.sounds.inputRequired).toBe(created.sounds.taskComplete);
    expect(readdirSync(join(soundPacksRoot(home), "shared"))).toEqual(["pack.json", "tone.ogg"]);
  });

  it("keeps two different files that share a base name apart", () => {
    const first = audio("done.ogg", "first");
    mkdirSync(join(sourceDir, "other"), { recursive: true });
    const second = join(sourceDir, "other", "done.ogg");
    writeFileSync(second, "second");

    const created = createSoundPack(
      { label: "Clash", sounds: { taskComplete: first, planComplete: second } },
      { homeDir: home },
    );

    const dir = join(soundPacksRoot(home), "clash");
    expect(created.sounds.taskComplete).toBe(join(dir, "done.ogg"));
    expect(created.sounds.planComplete).toBe(join(dir, "done-2.ogg"));
    // Each cue plays the audio the user picked, not the first file that shared its name.
    expect(readFileSync(join(dir, "done.ogg"), "utf8")).toBe("first");
    expect(readFileSync(join(dir, "done-2.ogg"), "utf8")).toBe("second");
  });

  it("bounds a long name to a folder name any filesystem accepts", () => {
    const created = createSoundPack(
      { label: "A".repeat(80), sounds: { taskComplete: audio("a.ogg") } },
      { homeDir: home },
    );
    expect(created.id).toBe("a".repeat(48));
    expect(listSoundPacks({ homeDir: home }).map((pack) => pack.id)).toEqual([created.id]);
  });

  it("derives the id from the name and refuses a duplicate", () => {
    createSoundPack(
      { label: "My Pack!", sounds: { taskComplete: audio("a.ogg") } },
      { homeDir: home },
    );
    expect(listSoundPacks({ homeDir: home }).map((pack) => pack.id)).toEqual(["my-pack"]);
    expect(() =>
      createSoundPack(
        { label: "my  pack", sounds: { taskComplete: audio("b.ogg") } },
        { homeDir: home },
      ),
    ).toThrow(/already exists/);
  });

  it("refuses ids the app owns, including the caller's shipped packs", () => {
    expect(() =>
      createSoundPack(
        { label: "Nothing", sounds: { taskComplete: audio("a.ogg") } },
        { homeDir: home },
      ),
    ).toThrow(/ships with the app/);
    expect(() =>
      createSoundPack(
        { label: "Halo", sounds: { taskComplete: audio("a.ogg") }, reserved: ["halo"] },
        { homeDir: home },
      ),
    ).toThrow(/ships with the app/);
    expect(listSoundPacks({ homeDir: home })).toEqual([]);
  });

  it("rejects an empty name, a non-audio pick, a missing file and an empty pack", () => {
    const good = audio("a.ogg");
    expect(() =>
      createSoundPack({ label: "   ", sounds: { taskComplete: good } }, { homeDir: home }),
    ).toThrow(/needs a name/);
    expect(() =>
      createSoundPack(
        { label: "X", sounds: { taskComplete: join(sourceDir, "notes.txt") } },
        { homeDir: home },
      ),
    ).toThrow(/not one of/);
    expect(() =>
      createSoundPack(
        { label: "X", sounds: { taskComplete: join(sourceDir, "missing.ogg") } },
        { homeDir: home },
      ),
    ).toThrow(/no audio file/);
    expect(() => createSoundPack({ label: "X", sounds: {} }, { homeDir: home })).toThrow(
      /at least one cue/,
    );
    expect(listSoundPacks({ homeDir: home })).toEqual([]);
  });

  it("removes a pack and its files", () => {
    createSoundPack({ label: "Temp", sounds: { taskComplete: audio("a.ogg") } }, { homeDir: home });
    removeSoundPack("temp", { homeDir: home });
    expect(listSoundPacks({ homeDir: home })).toEqual([]);
    expect(() => removeSoundPack("temp", { homeDir: home })).toThrow(/no sound pack/);
  });

  it("refuses to remove the app's own pack or to leave the store", () => {
    expect(() => removeSoundPack("nothing", { homeDir: home })).toThrow(/cannot be removed/);
    expect(() => removeSoundPack("../../etc", { homeDir: home })).toThrow(/is not a pack/);
  });

  it("keeps a folder whose manifest is unreadable, so it can be removed", () => {
    const dir = join(soundPacksRoot(home), "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pack.json"), "{ not json");

    const listed = listSoundPacks({ homeDir: home });
    expect(listed).toEqual([{ id: "broken", label: "broken", sounds: {} }]);
    removeSoundPack("broken", { homeDir: home });
    expect(listSoundPacks({ homeDir: home })).toEqual([]);
  });

  it("ignores a manifest that points outside its own folder", () => {
    const dir = join(soundPacksRoot(home), "sneaky");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "pack.json"),
      JSON.stringify({
        id: "sneaky",
        label: "Sneaky",
        sounds: { taskComplete: "../../secret.ogg" },
      }),
    );
    expect(listSoundPacks({ homeDir: home })[0]?.sounds).toEqual({});
  });
});
