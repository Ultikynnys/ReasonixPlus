/** Skills are playbooks: `run_skill` returns the body for the caller to follow in its own
 *  loop. Isolated work is `spawn_subagent({task, tools})`, a separate tool. */

import { SkillStore, type SkillToolArgs, parseSkillDraft, persistSkillDraft } from "../skills.js";
import type { ToolRegistry } from "../tools.js";

/** Fired after a successful `install_skill` write — host wires this to push a fresh `$skills` event so the desktop sidebar updates without a tab reload. */
export type SkillInstalledHook = (info: {
  name: string;
  path: string;
  scope: "project" | "global";
}) => void;

export interface SkillToolsOptions {
  /** Override `$HOME` — tests set this to a tmpdir. */
  homeDir?: string;
  projectRoot?: string;
  customSkillPaths?: readonly string[];
  /** Hide built-in skills (test-only knob; production callers leave off). */
  disableBuiltins?: boolean;
  /** Called synchronously after `install_skill` successfully writes a new skill file. */
  onSkillInstalled?: SkillInstalledHook;
}

export function registerSkillTools(
  registry: ToolRegistry,
  opts: SkillToolsOptions = {},
): ToolRegistry {
  const store = new SkillStore({
    homeDir: opts.homeDir,
    projectRoot: opts.projectRoot,
    customSkillPaths: opts.customSkillPaths,
    disableBuiltins: opts.disableBuiltins,
  });
  const onSkillInstalled = opts.onSkillInstalled;
  const hasProjectScope = store.hasProjectScope();

  registry.register({
    name: "run_skill",
    description:
      "Read a playbook from the Skills index pinned in the system prompt and follow it in THIS loop: the body comes back as the tool result. Pass `name` as the bare skill identifier, exactly as the index lists it. For work you want done in isolation, do not look for a skill: call `spawn_subagent({ task, tools })` with the whole instruction in `task`.",
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Skill identifier as it appears in the pinned Skills index, case-sensitive (e.g. 'test').",
        },
        arguments: {
          type: "string",
          description:
            "Free-form arguments the skill should act on, appended to the body as an 'Arguments:' line; the skill's own instructions decide how to consume them.",
        },
      },
      required: ["name"],
    },
    fn: async (args: { name?: unknown; arguments?: unknown }) => {
      const raw = typeof args.name === "string" ? args.name.trim() : "";
      if (!raw) {
        return JSON.stringify({ error: "run_skill requires a 'name' argument" });
      }
      // The index lists plain identifiers; a model that decorates the value still gets
      // its first identifier-shaped token, so a stray label is not an error round-trip.
      const tokens = raw
        .replace(/\[[^\]]*\]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      const name = tokens.find((t) => /^[a-zA-Z0-9]/.test(t)) ?? "";
      if (!name) {
        return JSON.stringify({
          error: "run_skill requires a 'name' argument",
          hint: `'${raw}' is just a marker, not a skill name`,
        });
      }
      const skill = store.read(name);
      if (!skill) {
        const available = store
          .list()
          .map((s) => s.name)
          .join(", ");
        return JSON.stringify({
          error: `unknown skill: ${JSON.stringify(name)}`,
          available: available || "(none, user has not defined any skills)",
        });
      }
      const rawArgs = typeof args.arguments === "string" ? args.arguments.trim() : "";

      const header = [
        `# Skill: ${skill.name}`,
        skill.description ? `> ${skill.description}` : "",
        `(scope: ${skill.scope} · ${skill.path})`,
      ]
        .filter(Boolean)
        .join("\n");
      const argsBlock = rawArgs ? `\n\nArguments: ${rawArgs}` : "";
      return `${header}\n\n${skill.body}${argsBlock}`;
    },
  });

  const installScopeDesc = hasProjectScope
    ? "'project' (default) writes to <repo>/.reasonix/skills/, scoped to this workspace only; 'global' writes to ~/.reasonix/skills/, available in every project."
    : "'global' (only option here, no project workspace) writes to ~/.reasonix/skills/.";

  registry.register({
    name: "install_skill",
    description:
      "Author and save a new skill: a reusable playbook future turns invoke via `run_skill`. Runnable immediately (same turn); appears in the pinned Skills index on the next new session or launch. Skill bodies become prompts for future turns, so write what you'd want your future self to follow.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Identifier: letters/digits/_/-/., 1-64 chars, starts alnum. Becomes the filename.",
        },
        description: {
          type: "string",
          description:
            "≤120 char one-liner shown in the pinned Skills index: future agents read this to decide whether to invoke.",
        },
        body: {
          type: "string",
          description:
            "Markdown playbook the model reads when it invokes this skill: the rules to follow in its own loop.",
        },
        scope: {
          type: "string",
          enum: ["project", "global"],
          description: installScopeDesc,
        },
      },
      required: ["name", "description", "body"],
    },
    fn: async (args: SkillToolArgs) => {
      const draft = parseSkillDraft({
        name: args.name,
        description: args.description,
        body: args.body,
      });
      if ("error" in draft) return JSON.stringify({ error: draft.error });

      const scopeRaw = typeof args.scope === "string" ? args.scope.trim() : "";
      let scope: "project" | "global";
      if (scopeRaw === "global") scope = "global";
      else if (scopeRaw === "project") scope = "project";
      else scope = hasProjectScope ? "project" : "global";
      if (scope === "project" && !hasProjectScope) {
        return JSON.stringify({
          error:
            "install_skill: scope='project' requires a workspace: open a project, or use scope='global'",
        });
      }

      const result = persistSkillDraft(store, draft, scope);
      if ("error" in result) {
        return JSON.stringify({ error: result.error });
      }

      try {
        onSkillInstalled?.({ name: draft.name, path: result.path, scope });
      } catch {
        // host hook failure must not undo a successful write
      }

      return JSON.stringify({
        ok: true,
        name: draft.name,
        scope,
        path: result.path,
        note: "Skill is callable right now via run_skill({ name }). It will appear in the pinned Skills index after the next new session or launch.",
      });
    },
  });

  return registry;
}
