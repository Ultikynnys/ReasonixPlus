/** Feedback sound cues, played from data-driven sound packs instead of in-code
 *  synthesis.
 *
 *  A pack is a folder under desktop/public/sound-packs/ holding a `pack.json`
 *  manifest and the audio it names; desktop/src/sound-packs.ts parses those and
 *  resolves each cue to a root-absolute URL. This module only fetches and decodes
 *  them, so adding or replacing a pack never touches it. See
 *  desktop/public/sound-packs/README.md for the manifest and the licenses. */

import type { FeedbackCueId } from "@reasonix/core-utils";
import { DEFAULT_SOUND_PACK_ID, packSoundSources, resolveSoundPackId } from "./sound-packs";

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

/** Decoded cue buffers, keyed by pack and cue so two packs that reuse a file name
 *  (or the same cue) never share a buffer. */
const buffers = new Map<string, AudioBuffer>();
/** Packs already fetched, so a repeated cue does not refetch the whole pack. */
const loadedPacks = new Set<string>();

function bufferKey(packId: string, cue: FeedbackCueId): string {
  return `${packId}/${cue}`;
}

/** Decode one cue of one pack into the buffer cache. */
function decodeCue(ac: AudioContext, packId: string, cue: FeedbackCueId, url: string): Promise<void> {
  return fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`cue fetch failed: ${res.status}`);
      return res.arrayBuffer();
    })
    .then((bytes) => ac.decodeAudioData(bytes))
    .then((decoded) => {
      buffers.set(bufferKey(packId, cue), decoded);
    });
}

/** Fetch + decode every cue one pack plays, once. Best-effort: a fetch/decode failure
 *  leaves that cue silent instead of throwing into the caller, and a pack that did not
 *  load completely is retried by the next call (a moved or not-yet-written pack folder
 *  must be recoverable instead of silent for the rest of the session). */
function ensurePackLoaded(packId: string): void {
  const id = resolveSoundPackId(packId);
  if (loadedPacks.has(id)) return;
  const ac = audioContext();
  if (!ac) return;
  loadedPacks.add(id);
  const sources = packSoundSources(id);
  if (sources.length === 0) return;
  void Promise.allSettled(sources.map(([cue, url]) => decodeCue(ac, id, cue, url))).then(
    (results) => {
      if (results.some((result) => result.status === "rejected")) loadedPacks.delete(id);
    },
  );
}

/** The playback surface callers depend on; tests inject a stub. `play` reports
 *  false when the browser API is unavailable, the cue hasn't decoded yet, or the
 *  volume is zero — so callers can tell a delivered cue from a dropped one.
 *  An absent pack id plays the default pack. */
export type FeedbackSoundPlayer = {
  play: (cue: FeedbackCueId, volume: number, packId?: string) => boolean;
};

export function createFeedbackSoundPlayer(): FeedbackSoundPlayer {
  return {
    play(cue, volume, packId = DEFAULT_SOUND_PACK_ID) {
      // A cue must never throw into the event path: a closed context, a rejected
      // resume, or an un-decoded buffer all degrade to a silent no-op.
      try {
        const ac = audioContext();
        if (!ac || ac.state === "closed") return false;
        if (!(volume > 0)) return false;
        const id = resolveSoundPackId(packId);
        ensurePackLoaded(id);
        const buffer = buffers.get(bufferKey(id, cue));
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

/** Warm one pack's bytes without arming anything. The Sound page calls it for
 *  every card so an audition plays on the first click instead of arriving a click
 *  late; the app calls it when the selection changes. */
export function preloadSoundPack(packId: string): void {
  ensurePackLoaded(packId);
}

let primed = false;

/** Resume the (lazily created) AudioContext on the first user gesture so autoplay
 *  policies don't silence cues fired before any interaction. One process-wide
 *  listener; safe to call repeatedly. The pack bytes are warmed separately, by
 *  `preloadSoundPack` for whichever pack the settings select. */
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
