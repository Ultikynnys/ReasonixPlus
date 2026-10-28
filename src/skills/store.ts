/** Standalone skill store: one directory per skill under `~/.reasonix/skills`, each holding
 *  a SKILL.md. Installation is global; a chat's enablement lives in its session meta. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { addGlobalPathAllowed, removeGlobalPathAllowed } from "../config.js";
import {
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
  isFile,
  readSkillDeclaration,
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
  /** Set when SKILL.md exists but cannot be read; the card still renders so it can be removed. */
  error?: string;
}

export interface SkillLookupOptions {
  homeDir?: string;
  configPath?: string;
  /** Restrict the scan to these ids, so an unrelated broken skill never reaches a prompt. */
  only?: readonly string[];
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
  const states: SkillState[] = [];
  for (const id of skillIds(root, opts.only)) {
    const dir = join(root, id);
    if (!isDirectory(dir)) continue;
    const path = join(dir, SKILL_ENTRY_FILE);
    if (!isFile(path)) continue;
    const declared = readSkillDeclaration(dir, id);
    states.push({
      id,
      dir,
      path,
      name: declared?.name ?? id,
      description: declared?.description ?? "",
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

/** Skill directories inside a fetched tree: the tree itself when it holds a SKILL.md,
 *  otherwise one directory per skill under `skills/`. */
function skillDirsIn(tree: string): string[] {
  if (isFile(join(tree, SKILL_ENTRY_FILE))) return [tree];
  const collection = join(tree, DEFAULT_SKILLS_DIR);
  if (!isDirectory(collection)) return [];
  try {
    return readdirSync(collection)
      .sort()
      .map((entry) => join(collection, entry))
      .filter((dir) => isDirectory(dir) && isFile(join(dir, SKILL_ENTRY_FILE)));
  } catch {
    return [];
  }
}

/** Install one skill (a directory or repo holding SKILL.md) or a whole `skills/` tree.
 *  All or nothing: a collision or an unreadable entry leaves the store untouched. */
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
      throw new Error(
        `no ${SKILL_ENTRY_FILE} in ${normalized.label} (expected one at the root, or one per directory under ${DEFAULT_SKILLS_DIR}/)`,
      );
    }
    const targets = dirs.map((dir) => {
      const fallback = dir === staging ? sourceName(normalized) : basename(dir);
      const declared = readSkillDeclaration(dir, storeSlug(fallback) || "skill");
      if (!declared) throw new Error(`${join(dir, SKILL_ENTRY_FILE)} cannot be read`);
      return { dir, id: storeSlug(declared.name) || storeSlug(fallback) || "skill" };
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
    return { ids: targets.map((target) => target.id) };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    for (const dir of moved) rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Remove one skill: its files and the read grant that let the agent open them. */
export function uninstallSkill(
  id: string,
  opts: { homeDir?: string; configPath?: string } = {},
): void {
  const dir = join(skillsRoot(opts.homeDir), id);
  if (!isSafeStoreId(id) || !existsSync(dir)) throw new Error(`${id} is not installed`);
  rmSync(dir, { recursive: true, force: true });
  removeGlobalPathAllowed(dir, opts.configPath);
}
