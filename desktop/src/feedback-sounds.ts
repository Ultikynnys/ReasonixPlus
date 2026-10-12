/**
 * Feedback sound cues, played from real CC0 audio files — no in-code synthesis.
 *
 * Assets are vendored by desktop/scripts/fetch-feedback-sounds.mjs into
 * desktop/public/sounds/ and served root-absolute. See
 * desktop/public/sounds/README.md for the source (Kenney Interface Sounds) and
 * the CC0 1.0 license.
 *
 * Cue → file:
 *  - planComplete  : confirmation_002.ogg — fuller positive confirm
 *  - taskComplete  : confirmation_001.ogg — crisp short confirm
 *  - inputRequired : question_001.ogg     — needs your attention
 *  - guardTriggered: error_001.ogg        — something went wrong
 */

import type { FeedbackCueId } from "@reasonix/core-utils";

/** Vendored cue files, served from desktop/public/sounds/. Keep this in sync
 *  with the FILES list in desktop/scripts/fetch-feedback-sounds.mjs and the
 *  file table in desktop/public/sounds/README.md. */
export const FEEDBACK_SOUND_SOURCES: Record<FeedbackCueId, string> = {
  planComplete: "/sounds/confirmation_002.ogg",
  guardTriggered: "/sounds/error_001.ogg",
  inputRequired: "/sounds/question_001.ogg",
  taskComplete: "/sounds/confirmation_001.ogg",
};

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  // Node/test environments (and exotic webviews) have no window: degrade to a
  // no-op player instead of throwing into the event path.
  if (typeof window === "undefined") return null;
  const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Decoded cue buffers, keyed by cue. Filled lazily by `ensureCuesLoaded`. */
const buffers = new Map<FeedbackCueId, AudioBuffer>();
let loadStarted = false;

/** Fetch + decode every cue once. Best-effort: a fetch/decode failure leaves
 *  that one cue silent instead of throwing into the caller. */
function ensureCuesLoaded(): void {
  if (loadStarted) return;
  const ac = audioContext();
  if (!ac) return;
  loadStarted = true;
  for (const [cue, url] of Object.entries(FEEDBACK_SOUND_SOURCES) as [FeedbackCueId, string][]) {
    void fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`cue fetch failed: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => ac.decodeAudioData(bytes))
      .then((decoded) => {
        buffers.set(cue, decoded);
      })
      .catch(() => {
        /* leave this cue silent */
      });
  }
}

/** The playback surface callers depend on; tests inject a stub. `play` reports
 *  false when the browser API is unavailable, the cue hasn't decoded yet, or the
 *  volume is zero — so callers can tell a delivered cue from a dropped one. */
export type FeedbackSoundPlayer = {
  play: (cue: FeedbackCueId, volume: number) => boolean;
};

export function createFeedbackSoundPlayer(): FeedbackSoundPlayer {
  return {
    play(cue, volume) {
      // A cue must never throw into the event path: a closed context, a rejected
      // resume, or an un-decoded buffer all degrade to a silent no-op.
      try {
        const ac = audioContext();
        if (!ac || ac.state === "closed") return false;
        ensureCuesLoaded();
        if (!(volume > 0)) return false;
        const buffer = buffers.get(cue);
        if (!buffer) return false;
        if (ac.state === "suspended") void ac.resume();
        if (ac.state !== "running") return false;

        const gain = ac.createGain();
        gain.gain.value = Math.min(Math.max(volume, 0), 1);
        gain.connect(ac.destination);
        const source = ac.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.start();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Shared player — the module-level AudioContext is process-wide, so every tab
 *  reuses one instance instead of allocating its own. */
export const feedbackSounds: FeedbackSoundPlayer = createFeedbackSoundPlayer();

let primed = false;

/** Warm the cue cache and resume the (lazily created) AudioContext on the first
 *  user gesture so autoplay policies don't silence cues fired before any
 *  interaction. One process-wide listener; safe to call repeatedly. */
export function primeFeedbackSounds(): void {
  if (primed || typeof window === "undefined") return;
  primed = true;
  ensureCuesLoaded();
  const unlock = () => {
    const ac = audioContext();
    if (ac && ac.state === "suspended") void ac.resume();
  };
  window.addEventListener("pointerdown", unlock, { once: true, passive: true });
  window.addEventListener("keydown", unlock, { once: true });
}
