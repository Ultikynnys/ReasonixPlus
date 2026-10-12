import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type FeedbackSoundPlayer,
  FEEDBACK_SOUND_SOURCES,
  createFeedbackSoundPlayer,
  feedbackSounds,
  primeFeedbackSounds,
} from "./feedback-sounds";

/** A WebAudio-less environment (vitest node) must degrade to a no-op player:
 *  play() reports false and priming never throws. */
describe("feedback sound player without WebAudio", () => {
  it("reports play() as not-delivered when no AudioContext exists", () => {
    const player: FeedbackSoundPlayer = createFeedbackSoundPlayer();
    expect(player.play("planComplete", 0.5)).toBe(false);
  });

  it("never throws on prime", () => {
    expect(() => primeFeedbackSounds()).not.toThrow();
  });

  it("accepts every cue id without throwing", () => {
    const ids = ["planComplete", "guardTriggered", "inputRequired", "taskComplete"] as const;
    for (const id of ids) {
      expect(() => feedbackSounds.play(id, 1)).not.toThrow();
    }
  });

  it("drops a zero-volume cue", () => {
    expect(feedbackSounds.play("taskComplete", 0)).toBe(false);
  });
});

/** Every cue must resolve to a real vendored OGG on disk — guards against the
 *  player referencing a file the fetch script never wrote. */
describe("feedback cue assets", () => {
  it("maps every cue to a vendored OGG file that exists", () => {
    const entries = Object.entries(FEEDBACK_SOUND_SOURCES);
    expect(entries).toHaveLength(4);
    for (const [, src] of entries) {
      const name = src.split("/").pop();
      const file = fileURLToPath(new URL(`../public/sounds/${name}`, import.meta.url));
      const bytes = readFileSync(file);
      // An OGG page begins with the "OggS" capture pattern.
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("OggS");
    }
  });
});
