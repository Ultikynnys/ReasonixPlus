import { describe, expect, it } from "vitest";
import { NOTHING_SOUND_PACK_ID, packSoundSources, resolveSoundPackId } from "./sound-packs";
import { mergeSoundPacks } from "./user-sound-packs";

/** Stand-in for the asset protocol, which the test environment has no bridge for. */
const toSrc = (path: string) => `asset://localhost/${encodeURIComponent(path)}`;

const userPack = {
  id: "night-shift",
  label: "Night Shift",
  description: "Quiet lines for late work.",
  sounds: { taskComplete: "/home/u/.reasonix/sound-packs/night-shift/done.ogg" },
};

describe("sound pack catalog", () => {
  it("lists the shipped packs when the user has none", () => {
    expect(mergeSoundPacks(undefined).map((pack) => pack.id)).toEqual([
      NOTHING_SOUND_PACK_ID,
      "default",
      "halo",
    ]);
    expect(mergeSoundPacks(null).map((pack) => pack.id)).toEqual([
      NOTHING_SOUND_PACK_ID,
      "default",
      "halo",
    ]);
  });

  it("appends a user pack after the shipped ones, with its audio as an asset URL", () => {
    const packs = mergeSoundPacks([userPack], toSrc);
    expect(packs.map((pack) => pack.id)).toEqual([
      NOTHING_SOUND_PACK_ID,
      "default",
      "halo",
      "night-shift",
    ]);
    const added = packs.at(-1)!;
    expect(added.label).toBe("Night Shift");
    expect(added.description).toBe("Quiet lines for late work.");
    expect(added.removable).toBe(true);
    expect(added.sounds.taskComplete).toBe(toSrc(userPack.sounds.taskComplete));

    // The merged catalog is what the player resolves a pack and its cues through.
    expect(resolveSoundPackId("night-shift", packs)).toBe("night-shift");
    expect(packSoundSources("night-shift", packs)).toEqual([
      ["taskComplete", toSrc(userPack.sounds.taskComplete)],
    ]);
  });

  it("keeps every shipped pack unremovable", () => {
    for (const pack of mergeSoundPacks([userPack], toSrc)) {
      if (pack.id === userPack.id) continue;
      expect(pack.removable, `${pack.id} must not be removable`).toBe(false);
    }
  });

  it("never lets a user pack shadow a shipped id", () => {
    const packs = mergeSoundPacks(
      [{ id: "halo", label: "Fake Halo", sounds: { taskComplete: "/tmp/x.ogg" } }],
      toSrc,
    );
    const halos = packs.filter((pack) => pack.id === "halo");
    expect(halos).toHaveLength(1);
    expect(halos[0]?.label).toBe("Halo");
    expect(halos[0]?.removable).toBe(false);
  });

  it("leaves out a cue the daemon reported no file for", () => {
    const packs = mergeSoundPacks([{ ...userPack, sounds: {} }], toSrc);
    expect(packs.at(-1)?.sounds).toEqual({});
    expect(packSoundSources("night-shift", packs)).toEqual([]);
  });
});
