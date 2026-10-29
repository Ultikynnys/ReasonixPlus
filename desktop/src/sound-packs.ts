/** Sound pack specs. The shipped packs come from the manifests the generator reads out of
 *  desktop/public/sound-packs/, a folder holding `pack.json` plus the audio it names; the
 *  user's own packs arrive from the daemon and are merged in by `user-sound-packs.ts`.
 *
 *  A shipped pack's audio is served root-absolute from its folder, so a manifest entry
 *  `question_001.ogg` inside `default/` plays from /sound-packs/default/question_001.ogg.
 *
 *  One pack is not a folder: `Nothing` is declared here, plays no audio, and is the
 *  default selection, so a fresh install is silent until a real pack is chosen. It is one
 *  of the built-ins, so nothing can remove it. */

import {
  FEEDBACK_CUE_IDS,
  type FeedbackCueId,
  NOTHING_SOUND_PACK_ID,
} from "@reasonix/core-utils";
import { SOUND_PACK_DOCUMENTS, SOUND_PACK_NAMES } from "./sound-packs.generated";

export { NOTHING_SOUND_PACK_ID };

/** Folder the shipped packs are served from, relative to the webview root. */
const SOUND_PACK_ROOT = "/sound-packs";

export interface SoundPackSpec {
  id: string;
  label: string;
  description: string;
  /** Root-absolute URL folder this pack's audio is served from; empty for a pack whose
   *  cues already carry resolved URLs (the implicit pack and the user's own). */
  basePath: string;
  /** The cues this pack ships a file or URL for. A cue absent here plays nothing. */
  sounds: Partial<Record<FeedbackCueId, string>>;
  /** True only for a pack the user created, i.e. one the Sound page may delete. */
  removable: boolean;
}

/** The pack that plays nothing at all: no folder, no files, no cues. */
const NOTHING_SOUND_PACK: SoundPackSpec = {
  id: NOTHING_SOUND_PACK_ID,
  label: "Nothing",
  description: "No sounds at all. Notifications still fire; every cue stays silent.",
  basePath: "",
  sounds: {},
  removable: false,
};

type ManifestShape = {
  label?: unknown;
  description?: unknown;
  sounds?: unknown;
};

function manifestOf(document: unknown): ManifestShape {
  return document && typeof document === "object" ? (document as ManifestShape) : {};
}

/** The manifest's declared cues, filtered to the cue ids the protocol knows so a
 *  stale name in a hand-edited pack.json can never reach the player. */
function declaredSounds(manifest: ManifestShape): Partial<Record<FeedbackCueId, string>> {
  const raw = manifest.sounds && typeof manifest.sounds === "object" ? manifest.sounds : {};
  const sounds: Partial<Record<FeedbackCueId, string>> = {};
  for (const cue of FEEDBACK_CUE_IDS) {
    const file = (raw as Record<string, unknown>)[cue];
    if (typeof file === "string" && file.length > 0) sounds[cue] = file;
  }
  return sounds;
}

/** Pack ids in card order, so a manifest's `order` decides the card sequence. */
const CARD_ORDER = new Map<string, number>(
  (SOUND_PACK_NAMES as readonly string[]).map((id, index) => [id, index]),
);

/** The packs that ship with the app, the implicit one first: it is the default selection
 *  and the way back to silence once a real pack is chosen. */
export const BUILTIN_SOUND_PACKS: readonly SoundPackSpec[] = [
  NOTHING_SOUND_PACK,
  ...SOUND_PACK_DOCUMENTS.map(({ dir, document }) => {
    const manifest = manifestOf(document);
    return {
      id: dir,
      label: typeof manifest.label === "string" && manifest.label ? manifest.label : dir,
      description: typeof manifest.description === "string" ? manifest.description : "",
      basePath: `${SOUND_PACK_ROOT}/${dir}`,
      sounds: declaredSounds(manifest),
      removable: false,
    };
  }).sort((a, b) => (CARD_ORDER.get(a.id) ?? 0) - (CARD_ORDER.get(b.id) ?? 0)),
];

/** What a fresh install selects: silence. */
export const DEFAULT_SOUND_PACK_ID: string = NOTHING_SOUND_PACK_ID;

/** The catalog the player and the resolver read: the built-ins until a tab reports its
 *  settings, then the merged list. One writer (the app) keeps it equal to what the Sound
 *  page renders, so a cue plays through the pack the user sees selected. */
let catalog: readonly SoundPackSpec[] = BUILTIN_SOUND_PACKS;

export function setSoundPackCatalog(packs: readonly SoundPackSpec[]): void {
  catalog = packs.length > 0 ? packs : BUILTIN_SOUND_PACKS;
}

export function soundPack(
  id: string | null | undefined,
  packs: readonly SoundPackSpec[] = catalog,
): SoundPackSpec | undefined {
  return id ? packs.find((pack) => pack.id === id) : undefined;
}

/** A persisted selection, or the silent pack when it names a pack that no longer
 *  exists (a folder or pack removed since the selection was saved). */
export function resolveSoundPackId(
  id: string | null | undefined,
  packs: readonly SoundPackSpec[] = catalog,
): string {
  return soundPack(id, packs)?.id ?? DEFAULT_SOUND_PACK_ID;
}

/** The cue to URL pairs one pack plays: exactly the cues it declares. The implicit pack
 *  declares none, so it plays nothing. A pack with no `basePath` already holds resolved URLs. */
export function packSoundSources(
  packId: string | null | undefined,
  packs: readonly SoundPackSpec[] = catalog,
): [FeedbackCueId, string][] {
  const pack = soundPack(resolveSoundPackId(packId, packs), packs);
  const sources: [FeedbackCueId, string][] = [];
  for (const cue of FEEDBACK_CUE_IDS) {
    const file = pack?.sounds[cue];
    if (pack && file) sources.push([cue, pack.basePath ? `${pack.basePath}/${file}` : file]);
  }
  return sources;
}
