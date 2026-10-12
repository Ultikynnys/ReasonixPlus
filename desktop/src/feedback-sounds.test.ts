import { describe, expect, it } from "vitest";
import {
  type FeedbackSoundPlayer,
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
