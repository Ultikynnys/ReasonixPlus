import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One skill directory: `SKILL.md` with the frontmatter both stores read. */
export function writeSkillDir(
  dir: string,
  opts: { name?: string; description?: string; body?: string } = {},
): void {
  const name = opts.name ?? "skill";
  const description = opts.description ?? `Use this to ${name}.`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${opts.body ?? ""}\n`,
    "utf8",
  );
}

/** A `skills/<id>/SKILL.md` tree, the layout a repository ships and both stores discover. */
export function writeSkillsTree(dir: string, ids: readonly string[]): void {
  for (const id of ids) writeSkillDir(join(dir, "skills", id), { name: id });
}
