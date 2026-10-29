import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FEEDBACK_CUE_IDS } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import {
  type FeedbackSoundPlayer,
  createFeedbackSoundPlayer,
  feedbackSounds,
  preloadSoundPack,
  primeFeedbackSounds,
} from "./feedback-sounds";
import { BUILTIN_SOUND_PACKS, NOTHING_SOUND_PACK_ID, packSoundSources } from "./sound-packs";

/** A WebAudio-less environment (vitest node) must degrade to a no-op player:
 *  play() reports false and priming never throws. */
describe("feedback sound player without WebAudio", () => {
  it("reports play() as not-delivered when no AudioContext exists", () => {
    const player: FeedbackSoundPlayer = createFeedbackSoundPlayer();
    expect(player.play("planComplete", 0.5)).toBe(false);
  });

  it("never throws on prime or preload", () => {
    expect(() => primeFeedbackSounds()).not.toThrow();
    for (const pack of BUILTIN_SOUND_PACKS) {
      expect(() => preloadSoundPack(pack.id)).not.toThrow();
    }
  });

  it("accepts every cue of every pack without throwing", () => {
    for (const pack of BUILTIN_SOUND_PACKS) {
      for (const id of FEEDBACK_CUE_IDS) {
        expect(() => feedbackSounds.play(id, 1, pack.id)).not.toThrow();
      }
    }
  });

  it("drops a zero-volume cue", () => {
    expect(feedbackSounds.play("taskComplete", 0)).toBe(false);
  });

  it("drops an unknown pack instead of throwing", () => {
    expect(feedbackSounds.play("taskComplete", 1, "no-such-pack")).toBe(false);
  });

  it("plays nothing for the pack that declares no audio", () => {
    expect(feedbackSounds.play("taskComplete", 1, NOTHING_SOUND_PACK_ID)).toBe(false);
  });
});

/** Every cue of every folder pack must resolve to a real Ogg on disk — guards
 *  against a manifest naming a file the folder does not ship. */
describe("sound pack assets", () => {
  it("resolves every cue of every folder pack to a vendored OGG file that exists", () => {
    for (const pack of BUILTIN_SOUND_PACKS.filter((declared) => declared.basePath !== "")) {
      const sources = packSoundSources(pack.id);
      expect(sources, `pack ${pack.id} plays no cues`).not.toHaveLength(0);
      for (const [cue, url] of sources) {
        const file = fileURLToPath(new URL(`../public${url}`, import.meta.url));
        const bytes = readFileSync(file);
        // An OGG page begins with the "OggS" capture pattern.
        expect(bytes.subarray(0, 4).toString("latin1"), `${pack.id}/${cue} at ${url}`).toBe("OggS");
      }
    }
  });
});
