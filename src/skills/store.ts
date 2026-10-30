/** Standalone skill store: one directory per skill under `~/.reasonix/skills`, each holding
 *  a SKILL.md. Installation is global; a chat's enablement lives in its session meta. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  type ReasonixConfig,
  type SkillRecord,
  addGlobalPathAllowed,
  readConfig,
  removeGlobalPathAllowed,
  writeConfig,
} from "../config.js";
import {
  INSTALL_SKIP_DIRS,
  type InstallCopy,
  type InstallSource,
  copyInstallSource,
  isSafeStoreId,
  normalizeInstallSource,
  storeSlug,
} from "../install/source.js";
import { reasonixHome } from "../reasonix-home.js";
import {
  DEFAULT_SKILLS_DIR,
  SKILL_ENTRY_FILE,
  type SkillDeclaration,
  isDirectory,
  isSkillDir,
  readSkillDeclaration,
  readSkillEntry,
} from "./skill.js";

export function skillsRoot(homeDir?: string): string {
  return join(reasonixHome(homeDir), "skills");
}

/** One installed standalone skill: what it declares, plus where it lives. */
export interface SkillState extends SkillDeclaration {
  /** Directory name under the skills root — the id a session freezes. */
  id: string;
  dir: string;
  /** Absolute path to its SKILL.md. */
  path: string;
  /** Which install brought it in, when the store recorded one. Settings groups the skills
   *  of one source by it, so a repository of twenty skills reads as one row. */
  source?: string;
  /** Set when SKILL.md exists but cannot be read; the card still renders so it can be removed. */
  error?: string;
}

export interface SkillLookupOptions {
  homeDir?: string;
  configPath?: string;
  /** Config already loaded by a caller that is mid-write (install/uninstall). */
  cfg?: ReasonixConfig;
  /** Restrict the scan to these ids, so an unrelated broken skill never reaches a prompt. */
  only?: readonly string[];
}

/** Provenance records, keyed by store id. A hand-edited or unreadable config simply means no
 *  record, which costs the inventory a group, never a skill. */
function skillRecords(opts: SkillLookupOptions): Record<string, SkillRecord> {
  const cfg = opts.cfg ?? readConfig(opts.configPath);
  return cfg.skills ?? {};
}

/** Ids present on disk, sorted. `only` is filtered rather than trusted: the ids arrive
 *  from a session meta, which is a file a user can edit. */
function skillIds(root: string, only?: readonly string[]): string[] {
  if (only) return [...new Set(only)].filter(isSafeStoreId).sort();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root).filter(isSafeStoreId).sort();
  } catch {
    return [];
  }
}

/** Every standalone skill on disk, sorted by id. A directory without a SKILL.md is not a
 *  skill and is skipped; one whose SKILL.md cannot be read is listed with its error. */
export function listSkills(opts: SkillLookupOptions = {}): SkillState[] {
  const root = skillsRoot(opts.homeDir);
  const records = skillRecords(opts);
  const states: SkillState[] = [];
  for (const id of skillIds(root, opts.only)) {
    const dir = join(root, id);
    if (!isSkillDir(dir)) continue;
    const path = join(dir, SKILL_ENTRY_FILE);
    const declared = readSkillDeclaration(dir, id);
    const source = records[id]?.source?.trim();
    states.push({
      id,
      dir,
      path,
      name: declared?.name ?? id,
      description: declared?.description ?? "",
      ...(source ? { source } : {}),
      ...(declared ? {} : { error: `unreadable ${SKILL_ENTRY_FILE}` }),
    });
  }
  return states;
}

/** Standalone skills a chat's frozen id list resolves to, in id order. Unknown ids drop
 *  out here, so uninstalling one costs the chat its index entry, not its prompt. */
export function skillsById(ids: readonly string[], opts: SkillLookupOptions = {}): SkillState[] {
  return ids.length > 0 ? listSkills({ ...opts, only: ids }) : [];
}

export interface SkillInstallOptions {
  homeDir?: string;
  configPath?: string;
  /** Injectable transfer step so tests never shell out to git. */
  copy?: InstallCopy;
}

export interface InstalledSkills {
  /** Store ids the install landed, in tree order. */
  ids: string[];
}

/** The name an install source advertises, used as the fallback id for a skill that
 *  declares none: the local directory name, or the repository name. */
function sourceName(source: InstallSource): string {
  if (source.kind === "local") return basename(source.path);
  const tail = source.label.replace(/\/+$/, "").split("/").pop() ?? source.label;
  return tail.replace(/\.git$/i, "");
}

/** A path inside a fetched tree, always slash-separated: the source label may be a URL, so
 *  a platform separator would read as a mangled link in a failure message. */
function treeRelative(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
}

/** That path under the source's own label. */
function treePath(label: string, path: string): string {
  const rel = treeRelative(path);
  return rel ? `${label.replace(/[\\/]+$/, "")}/${rel}` : label;
}

/** How many levels below the source root an install scans for skill directories when the
 *  tree declares no `skills/` collection: a folder whose own children are skills, and one
 *  level under it. The shallowest depth holding skills wins, so it never mixes containers. */
const COLLECTION_SCAN_DEPTH = 2;
/** How deep below the source root a diagnostic scan looks: one level past the install scan,
 *  so a skill that was not installed is still named. */
const HINT_SCAN_DEPTH = COLLECTION_SCAN_DEPTH + 1;
/** How many findings one failure message names before it stops being readable. */
const HINT_LIMIT = 3;
const ENTRY_LOOKALIKE = /^skill\.md/i;

/** A directory the copy leaves behind, so neither the install nor a failure message reads
 *  into it: build output, dependencies and VCS history. */
function droppedByCopy(entry: string): boolean {
  return INSTALL_SKIP_DIRS.has(entry);
}

/** A dot-directory of the source's own: never one of the install's skill containers, because
 *  a project root keeps junk in dozens of them. A failure message still reads into one, since
 *  `.agents/skills` and `.claude/skills` hold exactly the skills a user came looking for. */
function sourceDotDir(entry: string): boolean {
  return entry.startsWith(".");
}

/** Entry names of `dir`, sorted, or none when it cannot be read: an unreadable directory
 *  costs a scan the places it would have looked, never the whole install. */
function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Every child of `dir` that is itself a skill, sorted. */
function childSkillDirs(dir: string): string[] {
  return readDirNames(dir)
    .map((entry) => join(dir, entry))
    .filter(isSkillDir);
}

/** Every child of `dir` the scan may step through: not something the copy dropped, and not a
 *  skill, whose own subdirectories are that skill's files rather than further skills. */
function scannableChildren(dir: string): string[] {
  return readDirNames(dir)
    .filter((entry) => !droppedByCopy(entry) && !sourceDotDir(entry))
    .map((entry) => join(dir, entry))
    .filter((path) => !isSkillDir(path));
}

/** Skills in the shallowest level below `tree` that holds any, sorted. A tree that ships
 *  several containers installs the first level's worth and never mixes what sits deeper. */
function skillDirsBeneath(tree: string): string[] {
  let level = [tree];
  for (let depth = 1; depth <= COLLECTION_SCAN_DEPTH; depth++) {
    const skills = level.flatMap(childSkillDirs).sort();
    if (skills.length > 0) return skills;
    level = level.flatMap(scannableChildren);
  }
  return [];
}

/** Skill directories inside a fetched tree: the tree itself when it is one skill; otherwise
 *  every skill of the first container that holds any, so a `skills/` collection wins over
 *  loose folders and a folder of skills installs all of them whatever its name. */
function skillDirsIn(tree: string): string[] {
  if (isSkillDir(tree)) return [tree];
  const declared = childSkillDirs(join(tree, DEFAULT_SKILLS_DIR));
  return declared.length > 0 ? declared : skillDirsBeneath(tree);
}

/** Whether `dir` sits strictly below `base`, the source root a diagnostic is relative to. */
function isBelow(base: string, dir: string): boolean {
  const rel = relative(base, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The widest folder the install would accept as a source for `skillDir`: naming it turns a
 *  failure into one instruction that installs the skill's siblings too, instead of one skill
 *  per line. Reads the same rule the install does, so the advice cannot drift from it. */
function installableSource(base: string, skillDir: string): string {
  let source = skillDir;
  for (let dir = dirname(skillDir); isBelow(base, dir); dir = dirname(dir)) {
    if (skillDirsIn(dir).includes(skillDir)) source = dir;
  }
  return source;
}

/** What a fetched tree holds instead of a usable entry file: a mistyped name, or a skill
 *  deeper than the install scan reaches. Naming it turns "not there" into an instruction. */
function missingEntryHints(dir: string, base: string, depth = 0): string[] {
  if (depth > HINT_SCAN_DEPTH) return [];
  const hints: string[] = [];
  const at = (path: string): string => treeRelative(relative(base, path));
  for (const entry of readDirNames(dir)) {
    const path = join(dir, entry);
    if (isDirectory(path)) {
      if (!droppedByCopy(entry)) hints.push(...missingEntryHints(path, base, depth + 1));
      continue;
    }
    if (entry === SKILL_ENTRY_FILE) {
      if (depth > 0) {
        hints.push(`${at(path)} (nested; point the source at ${at(installableSource(base, dir))})`);
      }
      continue;
    }
    if (ENTRY_LOOKALIKE.test(entry)) hints.push(`${at(path)} (rename it to ${SKILL_ENTRY_FILE})`);
  }
  return hints.slice(0, HINT_LIMIT);
}

/** Install one skill (a directory or repo holding SKILL.md) or every skill a folder of
 *  skill directories holds, a `skills/` collection included. All or nothing: a collision or
 *  an unreadable entry leaves the store untouched. */
export async function installSkills(
  source: string,
  opts: SkillInstallOptions = {},
): Promise<InstalledSkills> {
  const normalized = normalizeInstallSource(source);
  const root = skillsRoot(opts.homeDir);
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, ".staging-"));
  const moved: string[] = [];
  try {
    await (opts.copy ?? copyInstallSource)(normalized, staging);
    const dirs = skillDirsIn(staging);
    if (dirs.length === 0) {
      const hints = missingEntryHints(staging, staging);
      throw new Error(
        hints.length > 0
          ? `no ${SKILL_ENTRY_FILE} in ${normalized.label}; found ${hints.join(", ")}`
          : `no ${SKILL_ENTRY_FILE} in ${normalized.label} (expected one at the root, or one per skill directory below it)`,
      );
    }
    const targets = dirs.map((dir) => {
      const fallback = dir === staging ? sourceName(normalized) : basename(dir);
      const fallbackId = storeSlug(fallback) || "skill";
      const entryPath = treePath(normalized.label, relative(staging, join(dir, SKILL_ENTRY_FILE)));
      const entry = readSkillEntry(dir, fallbackId);
      if (!entry) throw new Error(`${entryPath} cannot be read`);
      if (entry.empty) throw new Error(`${entryPath} is empty; write what the skill does`);
      return { dir, id: storeSlug(entry.declaration.name) || fallbackId };
    });
    const ids = new Set<string>();
    for (const target of targets) {
      const existing = join(root, target.id);
      if (ids.has(target.id)) throw new Error(`${target.id} appears twice in ${normalized.label}`);
      if (existsSync(existing)) throw new Error(`${target.id} is already installed at ${existing}`);
      ids.add(target.id);
    }
    for (const target of targets) {
      const dest = join(root, target.id);
      renameSync(target.dir, dest);
      moved.push(dest);
    }
    for (const dest of moved) addGlobalPathAllowed(dest, opts.configPath);
    recordInstalls(
      targets.map((target) => target.id),
      normalized.label,
      opts.configPath,
    );
    return { ids: targets.map((target) => target.id) };
  } catch (err) {
    for (const dir of moved) rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Record which install delivered each id, in one config write. Settings reads it back to
 *  group a collection, so the eighteen skills of one repository share a single row. */
function recordInstalls(
  ids: readonly string[],
  source: string,
  configPath: string | undefined,
): void {
  if (ids.length === 0) return;
  const cfg = readConfig(configPath);
  const installedAt = Date.now();
  const records: Record<string, SkillRecord> = { ...(cfg.skills ?? {}) };
  for (const id of ids) records[id] = { source, installedAt };
  cfg.skills = records;
  writeConfig(cfg, configPath);
}

/** Drop the provenance of removed ids, in one config write. */
function forgetInstalls(ids: readonly string[], configPath: string | undefined): void {
  const cfg = readConfig(configPath);
  const records = cfg.skills;
  if (!records) return;
  let changed = false;
  for (const id of ids) {
    if (!records[id]) continue;
    delete records[id];
    changed = true;
  }
  if (!changed) return;
  cfg.skills = Object.keys(records).length > 0 ? records : undefined;
  writeConfig(cfg, configPath);
}

/** Remove several skills at once: every id is checked before the first file is touched, so a
 *  refusal leaves the store whole. Files, records and read grants all go. */
export function uninstallSkills(
  ids: readonly string[],
  opts: { homeDir?: string; configPath?: string } = {},
): string[] {
  const root = skillsRoot(opts.homeDir);
  const wanted = [...new Set(ids)];
  for (const id of wanted) {
    if (!isSafeStoreId(id) || !existsSync(join(root, id))) {
      throw new Error(`${id} is not installed`);
    }
  }
  for (const id of wanted) rmSync(join(root, id), { recursive: true, force: true });
  try {
    forgetInstalls(wanted, opts.configPath);
  } finally {
    for (const id of wanted) removeGlobalPathAllowed(join(root, id), opts.configPath);
  }
  return wanted;
}

/** Remove one skill: its files, its record and the read grant that let the agent open them. */
export function uninstallSkill(
  id: string,
  opts: { homeDir?: string; configPath?: string } = {},
): void {
  uninstallSkills([id], opts);
}
