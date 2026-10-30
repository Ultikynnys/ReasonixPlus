/** Grouping for the standalone skills a store lists: what one install delivered reads as one
 *  entry, so a repository of twenty workflows is not twenty switches. */

/** The two facts grouping needs from a skill, whatever else a surface carries. */
export interface GroupableSkill {
  /** Store id under the skills root — also the name a row falls back to. */
  id: string;
  /** Recorded install source, when the store knows it. */
  source?: string;
}

/** One row of a skill inventory: a whole install, a family of ids, or a lone skill. */
export interface SkillGroup<T extends GroupableSkill> {
  /** Stable identity for keys: the source, the shared prefix, or the lone id. */
  key: string;
  /** What the row is called: the repository, the shared prefix, or the skill id. */
  label: string;
  /** Recorded install source, when one install delivered exactly this group. */
  source?: string;
  /** True when the label came from a shared id prefix rather than a recorded install. */
  inferred: boolean;
  /** Members, in id order. */
  skills: T[];
}

const SOURCE_PROTOCOL = /^(?:https?:\/\/|ssh:\/\/|git:\/\/)/i;
/** `git@github.com:owner/repo` spells its separator as a colon. */
const SOURCE_SCP = /^git@([^:/]+):/;
const TRAILING_SLASHES = /[\\/]+$/;
const GIT_SUFFIX = /\.git$/i;

/** A source as a heading reads it: an absolute path keeps only its last segment, a git URL
 *  drops the protocol and keeps the repository path. */
export function skillSourceLabel(source: string): string {
  const trimmed = source.trim().replace(TRAILING_SLASHES, "").replace(GIT_SUFFIX, "");
  if (!trimmed) return source.trim();
  if (trimmed.includes("\\") || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    return (
      trimmed
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() ?? trimmed
    );
  }
  const path = trimmed.replace(SOURCE_SCP, "$1/").replace(SOURCE_PROTOCOL, "");
  const segments = path.split("/").filter(Boolean);
  return segments.length > 2 ? segments.slice(-2).join("/") : path;
}

/** The leading id segment a family shares: `llmquant-risk` and `llmquant-macro` both answer
 *  `llmquant`. An id without a separator is its own family, which is no family at all. */
function idPrefix(id: string): string {
  const cut = id.indexOf("-");
  return cut > 0 ? id.slice(0, cut) : "";
}

function byId<T extends GroupableSkill>(skills: readonly T[]): T[] {
  return [...skills].sort((a, b) => a.id.localeCompare(b.id));
}

/** Skills by the install that delivered them, then by the leading id segment, so the inventory
 *  of one repository is one entry and each member stays visible inside it. */
export function groupSkills<T extends GroupableSkill>(skills: readonly T[]): SkillGroup<T>[] {
  const groups: SkillGroup<T>[] = [];
  const ungrouped: T[] = [];
  const bySource = new Map<string, T[]>();
  for (const skill of skills) {
    const source = skill.source?.trim();
    if (!source) {
      ungrouped.push(skill);
      continue;
    }
    const bucket = bySource.get(source);
    if (bucket) bucket.push(skill);
    else bySource.set(source, [skill]);
  }
  for (const [source, members] of bySource) {
    if (members.length === 1) {
      ungrouped.push(...members);
      continue;
    }
    groups.push({
      key: `source:${source}`,
      label: skillSourceLabel(source),
      source,
      inferred: false,
      skills: byId(members),
    });
  }
  const families = new Map<string, T[]>();
  const lone: T[] = [];
  for (const skill of ungrouped) {
    const prefix = idPrefix(skill.id);
    if (!prefix) {
      lone.push(skill);
      continue;
    }
    const bucket = families.get(prefix);
    if (bucket) bucket.push(skill);
    else families.set(prefix, [skill]);
  }
  for (const [prefix, members] of families) {
    if (members.length === 1) {
      lone.push(...members);
      continue;
    }
    groups.push({
      key: `prefix:${prefix}`,
      label: `${prefix}-*`,
      inferred: true,
      skills: byId(members),
    });
  }
  for (const skill of lone) {
    groups.push({ key: `solo:${skill.id}`, label: skill.id, inferred: false, skills: [skill] });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return groups;
}

/** Whether a group stands for several skills. Every surface shows such a group as one entry
 *  that opens (a card, a switch), and a group of one as the skill itself, so this is the one
 *  definition of that boundary. */
export function isSkillCollection(group: SkillGroup<GroupableSkill>): boolean {
  return group.skills.length > 1;
}
