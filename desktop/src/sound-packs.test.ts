import { FEEDBACK_CUE_IDS } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_SOUND_PACKS,
  DEFAULT_SOUND_PACK_ID,
  NOTHING_SOUND_PACK_ID,
  packSoundSources,
  resolveSoundPackId,
  soundPack,
} from "./sound-packs";

/** The declared folders, i.e. everything except the implicit silent pack. */
const folderPacks = BUILTIN_SOUND_PACKS.filter((pack) => pack.basePath !== "");

describe("sound pack specs", () => {
  it("lists the implicit silent pack first, then the declared folders in card order", () => {
    expect(BUILTIN_SOUND_PACKS.map((pack) => pack.id)).toEqual([
      NOTHING_SOUND_PACK_ID,
      "default",
      "halo",
    ]);
    for (const pack of BUILTIN_SOUND_PACKS) {
      expect(pack.label.length).toBeGreaterThan(0);
    }
    for (const pack of folderPacks) {
      expect(pack.basePath).toBe(`/sound-packs/${pack.id}`);
    }
  });

  it("defaults to the pack that plays nothing", () => {
    expect(DEFAULT_SOUND_PACK_ID).toBe(NOTHING_SOUND_PACK_ID);
    expect(soundPack(DEFAULT_SOUND_PACK_ID)?.sounds).toEqual({});
  });

  it("shapes the implicit pack as a card with no audio behind it", () => {
    const nothing = soundPack(NOTHING_SOUND_PACK_ID);
    expect(nothing?.basePath).toBe("");
    expect(nothing?.description.length).toBeGreaterThan(0);
    expect(packSoundSources(NOTHING_SOUND_PACK_ID)).toEqual([]);
  });

  it("resolves a cue to this pack's own file", () => {
    expect(packSoundSources("halo")).toContainEqual([
      "inputRequired",
      "/sound-packs/halo/InputRequired.ogg",
    ]);
    expect(packSoundSources("default")).toContainEqual([
      "guardTriggered",
      "/sound-packs/default/error_001.ogg",
    ]);
  });

  it("plays every cue of every folder pack, so no card can test silence", () => {
    for (const pack of folderPacks) {
      expect(packSoundSources(pack.id).map(([cue]) => cue).sort()).toEqual(
        [...FEEDBACK_CUE_IDS].sort(),
      );
    }
  });

  it("falls back to silence for an unknown or removed selection", () => {
    expect(resolveSoundPackId(undefined)).toBe(NOTHING_SOUND_PACK_ID);
    expect(resolveSoundPackId("no-such-pack")).toBe(NOTHING_SOUND_PACK_ID);
    expect(packSoundSources("no-such-pack")).toEqual([]);
    expect(packSoundSources(undefined)).toEqual([]);
  });

  it("keeps a selection that names a declared pack", () => {
    expect(resolveSoundPackId("halo")).toBe("halo");
    expect(resolveSoundPackId(NOTHING_SOUND_PACK_ID)).toBe(NOTHING_SOUND_PACK_ID);
  });
});
