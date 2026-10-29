/** Discoverable plugin skills: one `SKILL.md` entry per workflow, summarized from its
 *  frontmatter for the prompt index the agent reads. */

import { readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { toPosixPath } from "@reasonix/core-utils/path-utils";
import {
  SKILL_ENTRY_FILE,
  type SkillDeclaration,
  isDirectory,
  readSkillDeclaration,
} from "../skills/skill.js";
import type { PluginManifest } from "./manifest.js";

export { SKILL_ENTRY_FILE, SKILL_SUMMARY_MAX_CHARS, skillSummary } from "../skills/skill.js";

export interface PluginSkill extends SkillDeclaration {
  /** SKILL.md path relative to the plugin directory, forward-slashed. */
  relPath: string;
  /** Absolute directory the skill was found under: a collection holding one directory per
   *  skill, or the parent of a single declared skill directory. */
  skillsRoot: string;
}

/** Index every skill the manifest's declared paths reach, sorted by id. A declared path is
 *  read both ways, as a collection holding one directory per skill and as a single skill
 *  directory, because real manifests ship both; duplicate names collapse on the first found. */
export function indexPluginSkills(
  rootDir: string,
  manifest: Pick<PluginManifest, "skillsDirs">,
  opts: { maxSkills?: number } = {},
): PluginSkill[] {
  const skills: PluginSkill[] = [];
  const seen = new Set<string>();
  const capped = () => opts.maxSkills !== undefined && skills.length >= opts.maxSkills;
  const add = (declared: SkillDeclaration, skillDir: string, skillsRoot: string): void => {
    if (capped() || seen.has(declared.name)) return;
    seen.add(declared.name);
    skills.push({
      ...declared,
      relPath: toPosixPath(relative(rootDir, join(skillDir, SKILL_ENTRY_FILE))),
      skillsRoot,
    });
  };

  for (const dir of manifest.skillsDirs) {
    const base = join(rootDir, dir);
    if (!isDirectory(base)) continue;
    const own = readSkillDeclaration(base, basename(base));
    // A declared path that is the plugin root itself stays its own root: stepping to the
    // parent would point the prompt at the plugins store instead of this plugin.
    if (own) add(own, base, base === rootDir ? rootDir : dirname(base));
    let entries: string[];
    try {
      entries = readdirSync(base).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (capped()) return skills;
      const skillDir = join(base, entry);
      if (!isDirectory(skillDir)) continue;
      const declared = readSkillDeclaration(skillDir, entry);
      if (declared) add(declared, skillDir, base);
    }
  }
  return skills;
}
