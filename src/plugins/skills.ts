/** Discoverable plugin skills: one `<skills>/<id>/SKILL.md` entry per workflow, summarized
 *  from its frontmatter for the prompt index the agent reads. */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
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
  /** Absolute directory holding one subdirectory per skill. */
  skillsRoot: string;
}

/** Index every skill under the manifest's declared skill roots, sorted by id. */
export function indexPluginSkills(
  rootDir: string,
  manifest: Pick<PluginManifest, "skillsDirs">,
  opts: { maxSkills?: number } = {},
): PluginSkill[] {
  const skills: PluginSkill[] = [];
  const seen = new Set<string>();
  for (const dir of manifest.skillsDirs) {
    const base = join(rootDir, dir);
    if (!isDirectory(base)) continue;
    let entries: string[];
    try {
      entries = readdirSync(base).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (opts.maxSkills !== undefined && skills.length >= opts.maxSkills) return skills;
      const skillDir = join(base, entry);
      if (!isDirectory(skillDir)) continue;
      const declared = readSkillDeclaration(skillDir, entry);
      if (!declared || seen.has(declared.name)) continue;
      seen.add(declared.name);
      skills.push({
        ...declared,
        relPath: toPosixPath(relative(rootDir, join(skillDir, SKILL_ENTRY_FILE))),
        skillsRoot: base,
      });
    }
  }
  return skills;
}
