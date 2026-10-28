/** Discoverable plugin skills: one `<skills>/<id>/SKILL.md` entry per workflow, summarized
 *  from its frontmatter for the prompt index the agent reads. */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { toPosixPath } from "@reasonix/core-utils/path-utils";
import { parseFrontmatter } from "../frontmatter.js";
import type { PluginManifest } from "./manifest.js";

export const SKILL_ENTRY_FILE = "SKILL.md";
/** Cap on one skill's prompt summary. */
export const SKILL_SUMMARY_MAX_CHARS = 140;
/** Only the head of SKILL.md is scanned: frontmatter never follows a long preamble. */
const FRONTMATTER_SCAN_CHARS = 8_000;

export interface PluginSkill {
  /** Frontmatter `name`, else the skill directory name. */
  name: string;
  /** First sentence of the frontmatter description, capped. */
  description: string;
  /** SKILL.md path relative to the plugin directory, forward-slashed. */
  relPath: string;
  /** Absolute directory holding one subdirectory per skill. */
  skillsRoot: string;
}

/** Collapse a description to one prompt line: first sentence, whitespace-normalized, capped. */
export function skillSummary(description: string, maxChars = SKILL_SUMMARY_MAX_CHARS): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const sentenceEnd = collapsed.indexOf(". ");
  const first = sentenceEnd >= 20 ? collapsed.slice(0, sentenceEnd + 1) : collapsed;
  if (first.length <= maxChars) return first;
  const cut = first.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > maxChars / 2 ? space : maxChars).trimEnd()}...`;
}

/** A SKILL.md without frontmatter still gets a summary: its first prose line. */
function firstBodyLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
    return trimmed;
  }
  return "";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readSkill(
  rootDir: string,
  skillsRoot: string,
  entryDir: string,
  id: string,
): PluginSkill | null {
  const entryFile = join(entryDir, SKILL_ENTRY_FILE);
  if (!isFile(entryFile)) return null;
  let head: string;
  try {
    head = readFileSync(entryFile, "utf8").slice(0, FRONTMATTER_SCAN_CHARS);
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(head);
  const name = (data.name ?? "").trim() || id;
  return {
    name,
    description: skillSummary((data.description ?? "").trim() || firstBodyLine(body)),
    relPath: toPosixPath(relative(rootDir, entryFile)),
    skillsRoot,
  };
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
      const skill = readSkill(rootDir, base, skillDir, entry);
      if (!skill || seen.has(skill.name)) continue;
      seen.add(skill.name);
      skills.push(skill);
    }
  }
  return skills;
}
