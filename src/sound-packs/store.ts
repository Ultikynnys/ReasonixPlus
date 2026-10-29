/** Sound packs a user creates from Settings > Sound: one folder per pack under
 *  `<reasonix home>/sound-packs/`, holding `pack.json` plus the audio it names. */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import {
  FEEDBACK_CUE_IDS,
  type FeedbackCueId,
  RESERVED_SOUND_PACK_IDS,
  SOUND_PACK_AUDIO_EXTENSIONS,
  type UserSoundPack,
} from "@reasonix/core-utils";
import { isSafeStoreId, storeSlug } from "../install/source.js";
import { reasonixHome } from "../reasonix-home.js";

const MANIFEST_FILE = "pack.json";
/** Folder-name budget: long enough for a readable id, short enough for any filesystem. */
const MAX_PACK_ID_LENGTH = 48;

export interface SoundPackStoreOptions {
  /** Home directory override; tests point it at a temp dir. */
  homeDir?: string;
}

/** Root of the user's own packs. */
export function soundPacksRoot(homeDir?: string): string {
  return join(reasonixHome(homeDir), "sound-packs");
}

/** A manifest as `pack.json` stores it: cue to file name inside the pack folder. */
interface PackManifest {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  sounds?: unknown;
}

/** A bare file name: no separators, no traversal, nothing that would escape the folder. */
function isPlainFileName(name: string): boolean {
  return name.length > 0 && name === basename(name) && !name.includes("..");
}

/** True when the path carries an extension the webview can decode. */
function isAudioPath(path: string): boolean {
  return SOUND_PACK_AUDIO_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(`.${ext}`));
}

/** The name a picked file keeps inside the pack folder, reduced to characters that cannot
 *  confuse a path or a shell. */
function storedFileName(source: string): string {
  const name = basename(source).replace(/[^A-Za-z0-9._-]+/g, "_");
  return name.startsWith(".") ? `sound${extname(name) || name}` : name;
}

/** A name no other file in this pack took. Two different sources can share a base name, and
 *  the second must not be mistaken for the first: it gets a numeric suffix instead. */
function uniqueFileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** One folder as the daemon reports it. A folder whose manifest cannot be read is still
 *  listed, with no cue audio, so the card exists and can be removed. */
function readPack(dir: string, id: string): UserSoundPack {
  let manifest: PackManifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as PackManifest;
  } catch {
    /* listed below without audio, so a broken folder stays removable */
  }
  const declared =
    manifest.sounds && typeof manifest.sounds === "object"
      ? (manifest.sounds as Record<string, unknown>)
      : {};
  const sounds: Partial<Record<FeedbackCueId, string>> = {};
  for (const cue of FEEDBACK_CUE_IDS) {
    const file = declared[cue];
    if (typeof file !== "string" || !isPlainFileName(file)) continue;
    const path = join(dir, file);
    if (existsSync(path)) sounds[cue] = path;
  }
  const label = typeof manifest.label === "string" && manifest.label ? manifest.label : id;
  const description =
    typeof manifest.description === "string" && manifest.description
      ? manifest.description
      : undefined;
  return { id, label, ...(description ? { description } : {}), sounds };
}

/** Every pack the user created, sorted by id. */
export function listSoundPacks(opts: SoundPackStoreOptions = {}): UserSoundPack[] {
  const root = soundPacksRoot(opts.homeDir);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root).filter(isSafeStoreId).sort();
  } catch {
    return [];
  }
  return entries
    .filter((id) => {
      try {
        return statSync(join(root, id)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((id) => readPack(join(root, id), id));
}

export interface CreateSoundPackInput {
  label: string;
  description?: string;
  /** The audio the user picked per cue: absolute paths to their own files. */
  sounds: Partial<Record<FeedbackCueId, string>>;
  /** Ids the caller's UI already shows as packs (the shipped folder packs), which this
   *  store cannot read: a created pack must not shadow one. */
  reserved?: readonly string[];
}

/** Create a pack folder from picked audio. Nothing is written unless every pick checks
 *  out, and a failure part-way removes the folder rather than leaving a broken card. */
export function createSoundPack(
  input: CreateSoundPackInput,
  opts: SoundPackStoreOptions = {},
): UserSoundPack {
  const label = input.label.trim();
  if (!label) throw new Error("a pack needs a name");
  // Bounded so a long name cannot build a path the filesystem refuses.
  const id = (storeSlug(label) || "pack").slice(0, MAX_PACK_ID_LENGTH).replace(/-+$/, "");
  if (!isSafeStoreId(id)) throw new Error(`"${label}" does not produce a usable pack name`);
  if (RESERVED_SOUND_PACK_IDS.includes(id) || input.reserved?.includes(id)) {
    throw new Error(`"${label}" would replace a pack that ships with the app`);
  }
  const root = soundPacksRoot(opts.homeDir);
  const dir = join(root, id);
  if (existsSync(dir)) throw new Error(`a pack named "${label}" already exists`);

  const picks: [FeedbackCueId, string][] = [];
  for (const cue of FEEDBACK_CUE_IDS) {
    const picked = input.sounds[cue];
    if (!picked) continue;
    if (!isAudioPath(picked)) {
      throw new Error(
        `${basename(picked)} is not one of ${SOUND_PACK_AUDIO_EXTENSIONS.join(", ")}`,
      );
    }
    if (!existsSync(picked) || !statSync(picked).isFile()) {
      throw new Error(`no audio file at ${picked}`);
    }
    picks.push([cue, picked]);
  }
  if (picks.length === 0) throw new Error("choose a sound for at least one cue");

  const files: Partial<Record<FeedbackCueId, string>> = {};
  mkdirSync(dir, { recursive: true });
  try {
    // One copy per distinct source, so two cues may point at the same file.
    const stored = new Map<string, string>();
    const taken = new Set<string>([MANIFEST_FILE]);
    for (const [cue, picked] of picks) {
      let name = stored.get(picked);
      if (!name) {
        name = uniqueFileName(storedFileName(picked), taken);
        taken.add(name);
        copyFileSync(picked, join(dir, name));
        stored.set(picked, name);
      }
      files[cue] = name;
    }
    const manifest = {
      id,
      label,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      sounds: files,
    };
    writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return readPack(dir, id);
}

/** Delete one user-created pack. The packs that ship with the app live in the bundle, so
 *  they are never in this store and cannot be reached from here. */
export function removeSoundPack(id: string, opts: SoundPackStoreOptions = {}): void {
  if (!isSafeStoreId(id)) throw new Error(`${id} is not a pack`);
  if (RESERVED_SOUND_PACK_IDS.includes(id)) {
    throw new Error(`"${id}" ships with the app and cannot be removed`);
  }
  const dir = join(soundPacksRoot(opts.homeDir), id);
  if (!existsSync(dir)) throw new Error(`no sound pack named "${id}"`);
  rmSync(dir, { recursive: true, force: true });
}
