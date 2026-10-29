import { describe, expect, it } from "vitest";
import { DEFAULT_FEEDBACK_AUDIO, resolveFeedbackCueAudio } from "../src/index.js";

describe("feedback cue audio", () => {
  it("resolves an absent cue to the shared default", () => {
    expect(resolveFeedbackCueAudio(undefined)).toEqual(DEFAULT_FEEDBACK_AUDIO);
  });

  it("keeps a switched-on cue's own volume", () => {
    expect(resolveFeedbackCueAudio({ enabled: true, volume: 0.8 })).toEqual({
      enabled: true,
      volume: 0.8,
    });
  });

  it("fills a missing volume from the default", () => {
    // Persisted JSON may omit `volume` (hand-edited or older config).
    expect(resolveFeedbackCueAudio({ enabled: true })).toEqual({
      enabled: true,
      volume: DEFAULT_FEEDBACK_AUDIO.volume,
    });
  });

  it("treats a non-boolean switch as the default rather than as on", () => {
    // A hand-edited config can hold any JSON: only a real boolean decides, so junk can
    // never switch a cue (and its notification) on.
    const junk = { enabled: "yes" } as unknown as { enabled: boolean };
    expect(resolveFeedbackCueAudio(junk).enabled).toBe(DEFAULT_FEEDBACK_AUDIO.enabled);
  });
});
