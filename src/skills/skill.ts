/** One `SKILL.md` workflow file: the entry a prompt index advertises and the agent reads
 *  on demand. Shared by standalone skills and the ones a plugin ships. */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../frontmatter.js";

export const SKILL_ENTRY_FILE = "SKILL.md";
/** Where a skills collection lives when nothing declares another path. */
export const DEFAULT_SKILLS_DIR = "skills";
/** Cap on one skill's prompt summary. */
export const SKILL_SUMMARY_MAX_CHARS = 140;
/** Only the head of SKILL.md is scanned: frontmatter never follows a long preamble. */
const FRONTMATTER_SCAN_CHARS = 8_000;

/** The facts a skill declares about itself, before any store adds location detail. */
export interface SkillDeclaration {
  /** Frontmatter `name`, else the directory name. */
  name: string;
  /** First sentence of the frontmatter description, capped. */
  description: string;
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

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Read one skill directory's SKILL.md. `null` when the directory holds no entry file or
 *  it cannot be read: a broken skill is skipped, never fatal to its siblings. */
export function readSkillDeclaration(entryDir: string, id: string): SkillDeclaration | null {
  const entryFile = join(entryDir, SKILL_ENTRY_FILE);
  if (!isFile(entryFile)) return null;
  let head: string;
  try {
    head = readFileSync(entryFile, "utf8").slice(0, FRONTMATTER_SCAN_CHARS);
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(head);
  return {
    name: (data.name ?? "").trim() || id,
    description: skillSummary((data.description ?? "").trim() || firstBodyLine(body)),
  };
}
