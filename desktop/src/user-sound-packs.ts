/** Merges the packs that ship with the app with the ones the user created.
 *
 *  A shipped pack carries file names inside its bundle folder, so the player resolves them
 *  against `basePath`. A user pack arrives from the daemon as absolute paths to that pack's
 *  own folder, which the webview may only reach through the asset protocol: this module
 *  turns them into loadable URLs once, so everything downstream sees one catalog. */

import { convertFileSrc } from "@tauri-apps/api/core";
import { FEEDBACK_CUE_IDS, type FeedbackCueId, type UserSoundPack } from "@reasonix/core-utils";
import { BUILTIN_SOUND_PACKS, type SoundPackSpec } from "./sound-packs";

/** An absolute path as a URL the webview may load. A shell without the asset protocol (the
 *  browser dev bridge) has no such bridge, so the path passes through unchanged instead of
 *  throwing on a cue. */
function defaultToSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

/** The built-in cards followed by the user's own, in card order. `toSrc` is injectable for
 *  tests, which have no asset protocol. */
export function mergeSoundPacks(
  user: readonly UserSoundPack[] | null | undefined,
  toSrc: (path: string) => string = defaultToSrc,
): SoundPackSpec[] {
  const packs: SoundPackSpec[] = [...BUILTIN_SOUND_PACKS];
  const taken = new Set(packs.map((pack) => pack.id));
  for (const pack of user ?? []) {
    // A pack folder someone copied in by hand under a shipped id would draw a second card
    // with the same key; the shipped pack wins and the folder stays on disk to be deleted.
    if (taken.has(pack.id)) continue;
    taken.add(pack.id);
    const sounds: Partial<Record<FeedbackCueId, string>> = {};
    for (const cue of FEEDBACK_CUE_IDS) {
      const path = pack.sounds[cue];
      if (path) sounds[cue] = toSrc(path);
    }
    packs.push({
      id: pack.id,
      label: pack.label,
      description: pack.description ?? "",
      basePath: "",
      sounds,
      removable: true,
    });
  }
  return packs;
}
