/**
 * Feedback sound cues, synthesized with WebAudio — no asset files, so the
 * bundle and installer stay unchanged and cues work on a cold start.
 *
 * Each cue is a tiny earcon distinct in pitch contour and rhythm:
 *  - planComplete : rising major arpeggio (C5 E5 G5 C6) — progress/celebration
 *  - guardTriggered : low dissonant minor-2nd buzz — something went wrong
 *  - inputRequired : gentle two-note ping-pong (A5 → E5) — needs your attention
 *  - taskComplete : pleasant resolved triad (E5 G5 C6) — job done
 */

import type { FeedbackCueId } from "@reasonix/core-utils";

type CueSpec = {
  /** [frequency Hz, startOffset s, duration s] notes; sine oscillators with
   *  exponential decay envelopes. */
  notes: [freq: number, at: number, forSec: number][];
  /** Extra gain shaping: guard buzz uses a square-ish sawtooth and tremolo. */
  wave?: OscillatorType;
};

const CUES: Record<FeedbackCueId, CueSpec> = {
  planComplete: {
    notes: [
      [523.25, 0, 0.12],
      [659.25, 0.09, 0.12],
      [783.99, 0.18, 0.12],
      [1046.5, 0.27, 0.22],
    ],
  },
  guardTriggered: {
    wave: "sawtooth",
    notes: [
      [196, 0, 0.16],
      [208, 0.16, 0.16],
      [196, 0.32, 0.28],
    ],
  },
  inputRequired: {
    notes: [
      [880, 0, 0.12],
      [659.25, 0.13, 0.2],
    ],
  },
  taskComplete: {
    notes: [
      [659.25, 0, 0.14],
      [783.99, 0.11, 0.14],
      [1046.5, 0.22, 0.3],
    ],
  },
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

/** The synth surface callers depend on; tests inject a stub. `play` reports
 *  false when the browser API is unavailable or the context isn't running, so
 *  callers can tell a delivered cue from a dropped one. */
export type FeedbackSoundPlayer = {
  play: (cue: FeedbackCueId, volume: number) => boolean;
};

export function createFeedbackSoundPlayer(): FeedbackSoundPlayer {
  return {
    play(cue, volume) {
      // A cue must never throw into the event path: an exotic webview, a closed
      // context, or a rejected resume all degrade to a silent no-op.
      try {
        const ac = audioContext();
        if (!ac || ac.state === "closed") return false;
        if (ac.state === "suspended") void ac.resume();
        if (ac.state !== "running") return false;
        if (!(volume > 0)) return false;

        const spec = CUES[cue];
        const now = ac.currentTime + 0.01;
        const master = ac.createGain();
        master.gain.value = Math.min(Math.max(volume, 0), 1);
        master.connect(ac.destination);

        for (const [freq, at, dur] of spec.notes) {
          const osc = ac.createOscillator();
          osc.type = spec.wave ?? "sine";
          osc.frequency.value = freq;
          const gain = ac.createGain();
          // Exponential decay envelope: fast attack, smooth tail so notes don't click.
          gain.gain.setValueAtTime(0.0001, now + at);
          gain.gain.exponentialRampToValueAtTime(1, now + at + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
          osc.connect(gain);
          gain.connect(master);
          osc.start(now + at);
          osc.stop(now + at + dur + 0.05);
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Shared player — the module-level AudioContext is process-wide, so every
 *  tab reuses one instance instead of allocating its own. */
export const feedbackSounds: FeedbackSoundPlayer = createFeedbackSoundPlayer();

let primed = false;

/** Resume the (lazily created) AudioContext on the first user gesture so
 *  autoplay policies don't silence cues fired before any interaction. One
 *  process-wide listener; safe to call repeatedly. */
export function primeFeedbackSounds(): void {
  if (primed || typeof window === "undefined") return;
  primed = true;
  const unlock = () => {
    const ac = audioContext();
    if (ac && ac.state === "suspended") void ac.resume();
  };
  window.addEventListener("pointerdown", unlock, { once: true, passive: true });
  window.addEventListener("keydown", unlock, { once: true });
}
