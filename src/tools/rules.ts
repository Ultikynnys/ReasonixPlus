/** Model-facing access to the same permission rules the Settings Rules tab edits. */

import {
  type RuleEffect,
  type RuleKind,
  type RuleMode,
  type RuleScope,
  type ScopedRule,
  addRule,
  loadRules,
  removeRule,
  ruleModeInForce,
} from "../config.js";
import type { ToolRegistry } from "../tools.js";
import type { JSONSchema } from "../types.js";

export interface RulesToolsOptions {
  /** Workspace root — the target of scope='workspace' rules. */
  rootDir: string;
  /** Override the default config.json lookup (tests). */
  configPath?: string;
  /** Fired after a successful add or remove so hosts can refresh their settings view. */
  onRulesChanged?: () => void;
}

const KINDS: readonly RuleKind[] = ["shell", "path"];
const EFFECTS: readonly RuleEffect[] = ["allow", "ask", "deny", "ignore"];
const SCOPES: readonly RuleScope[] = ["workspace", "global"];
const MATCHES: readonly string[] = ["pattern", "regex"];
const MODES: readonly RuleMode[] = ["follow", "never-ask"];

type RuleToolField = "kind" | "effect" | "pattern" | "scope" | "match" | "mode";

/** Enum source for BOTH the JSON schemas and the runtime validation — one list per field. */
const FIELD_ENUMS: Record<Exclude<RuleToolField, "pattern">, readonly string[]> = {
  kind: KINDS,
  effect: EFFECTS,
  scope: SCOPES,
  match: MATCHES,
  mode: MODES,
};

/** Both write tools take the same four required fields. */
const WRITE_REQUIRED = ["kind", "effect", "pattern", "scope"];

/** One field's JSON-schema fragment; `pattern` is a free string, the rest are enums. */
function fieldSchema(field: Exclude<RuleToolField, "pattern">, description: string): JSONSchema {
  return { type: "string", enum: [...FIELD_ENUMS[field]], description };
}

const patternSchema = (description: string): JSONSchema => ({
  type: "string",
  description,
});

function fmtRule(r: ScopedRule): string {
  const match = r.match === "regex" ? " (regex)" : "";
  return `- [${r.scope}] ${r.mode}/${r.effect} ${r.kind}${match}: ${r.pattern}`;
}

function describeRule(r: ScopedRule): string {
  return `${r.scope} ${r.kind}/${r.effect} "${r.pattern}"`;
}

const banner = (verb: string, r: ScopedRule): string =>
  `✓ RULE ${verb} (${r.scope} ${r.kind}/${r.effect}): ${r.pattern}`;

interface RuleArgs {
  kind?: unknown;
  effect?: unknown;
  pattern?: unknown;
  scope?: unknown;
  match?: unknown;
  mode?: unknown;
}

interface WriteRuleArgs extends RuleArgs {
  kind: RuleKind;
  effect: RuleEffect;
  pattern: string;
  scope: RuleScope;
  match?: "pattern" | "regex";
}

interface ForgetRuleArgs extends WriteRuleArgs {
  mode?: RuleMode;
}

function invalidField(
  tool: string,
  value: unknown,
  allowed: readonly string[],
  field: string,
): string | null {
  // typeof guard, not String() coercion: String(["shell"]) === "shell" would let a
  // malformed array arg pass validation and persist a corrupted rule.
  if (typeof value !== "string" || !allowed.includes(value)) {
    return `${tool}: ${field} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`;
  }
  return null;
}

/** Validate the enum fields and build the stored rule. Returns the JSON error
 *  payload to return verbatim, or the rule ready for addRule/removeRule. */
function buildRule(
  tool: string,
  args: RuleArgs,
  fallbackMode: RuleMode,
): { error: string } | { rule: ScopedRule } {
  const bad =
    invalidField(tool, args.kind, KINDS, "kind") ??
    invalidField(tool, args.effect, EFFECTS, "effect") ??
    invalidField(tool, args.scope, SCOPES, "scope") ??
    (args.match !== undefined ? invalidField(tool, args.match, MATCHES, "match") : null) ??
    (args.mode !== undefined ? invalidField(tool, args.mode, MODES, "mode") : null);
  if (bad) return { error: JSON.stringify({ error: bad }) };
  if (typeof args.pattern !== "string") {
    return { error: JSON.stringify({ error: `${tool}: pattern must be a string` }) };
  }
  const trimmed = args.pattern.trim();
  if (!trimmed) return { error: JSON.stringify({ error: `${tool}: pattern is empty` }) };
  return {
    rule: {
      mode: (args.mode as RuleMode | undefined) ?? fallbackMode,
      effect: args.effect as RuleEffect,
      kind: args.kind as RuleKind,
      scope: args.scope as RuleScope,
      pattern: trimmed,
      ...(args.match === "regex" ? { match: "regex" as const } : {}),
    },
  };
}

export function registerRulesTools(registry: ToolRegistry, opts: RulesToolsOptions): ToolRegistry {
  const configPath = opts.configPath;
  const fire = (): void => {
    // A listener failure must not read back as a failed rule write.
    try {
      opts.onRulesChanged?.();
    } catch {
      /* settings refresh is best-effort */
    }
  };

  /** Shared write path for remember_rule/forget_rule: validate, apply, notify.
   *  `ok: false` means the store was left unchanged (duplicate add / absent rule). */
  async function applyRuleChange(
    tool: string,
    args: RuleArgs,
    apply: (rule: ScopedRule) => boolean,
  ): Promise<{ error: string } | { ok: boolean; rule: ScopedRule }> {
    const built = buildRule(tool, args, ruleModeInForce(configPath));
    if ("error" in built) return { error: built.error };
    try {
      const ok = apply(built.rule);
      if (ok) fire();
      return { ok, rule: built.rule };
    } catch (err) {
      return { error: JSON.stringify({ error: `${tool} failed: ${(err as Error).message}` }) };
    }
  }

  registry.register({
    name: "list_rules",
    description:
      "List every permission rule in force: this workspace's rules plus global ones (legacy allow lists included). The lines show the exact fields remember_rule/forget_rule take. Read-only.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: { type: "object", properties: {} },
    fn: async () => {
      const rules = loadRules(opts.rootDir, configPath);
      if (rules.length === 0) {
        return "No permission rules are in force. Default behavior applies: the edit gate decides what confirms.";
      }
      return ["Rules in force (workspace + global):", ...rules.map(fmtRule)].join("\n");
    },
  });

  registry.register({
    name: "remember_rule",
    description:
      "Save a permission rule in the same store the Settings Rules tab edits: auto-approve ('allow'), always confirm ('ask'), refuse ('deny') or store unenforced ('ignore') for a shell command pattern or a directory path, scoped to this workspace or global. Takes effect on the next command or path check; no restart. Use for durable user decisions like 'never prompt for npm test again', not for one-off approvals.",
    parameters: {
      type: "object",
      properties: {
        kind: fieldSchema(
          "kind",
          "'shell' matches the command text; 'path' matches a directory prefix.",
        ),
        effect: fieldSchema(
          "effect",
          "'allow' runs without asking; 'ask' always confirms; 'deny' refuses outright; 'ignore' is stored but not enforced.",
        ),
        pattern: patternSchema(
          "For kind='shell': a command pattern like 'git *' (or a regex with match='regex'). For kind='path': a directory prefix.",
        ),
        scope: fieldSchema("scope", "'workspace' = this project only; 'global' = every project."),
        match: fieldSchema(
          "match",
          "Omit for glob-style pattern matching; 'regex' enables regex matching (kind='shell' only).",
        ),
      },
      required: WRITE_REQUIRED,
    },
    fn: async (args: WriteRuleArgs) => {
      const applied = await applyRuleChange("remember_rule", args, (rule) =>
        addRule(rule, opts.rootDir, configPath),
      );
      if ("error" in applied) return applied.error;
      if (!applied.ok) {
        return `Already present: ${describeRule(applied.rule)} (nothing changed).`;
      }
      return [
        banner("SAVED", applied.rule),
        "Enforced from the next run_command or path check onward; visible in Settings → Rules.",
      ].join("\n");
    },
  });

  registry.register({
    name: "forget_rule",
    description:
      "Delete one permission rule by its exact fields as shown by list_rules. Use when a remembered rule has become wrong or the user asks to remove one. Returns 'No matching rule' when nothing matches.",
    parameters: {
      type: "object",
      properties: {
        kind: fieldSchema("kind", "'shell' or 'path', as list_rules showed."),
        effect: fieldSchema("effect", "'allow', 'ask', 'deny' or 'ignore', as list_rules showed."),
        pattern: patternSchema("The rule's pattern exactly as list_rules displayed it."),
        scope: fieldSchema("scope", "'workspace' or 'global', as list_rules showed."),
        match: fieldSchema(
          "match",
          "Pass 'regex' only when list_rules marked the rule as (regex).",
        ),
        mode: fieldSchema(
          "mode",
          "Rule set to search; defaults to the mode in force. Pass the mode list_rules displayed when it differs.",
        ),
      },
      required: WRITE_REQUIRED,
    },
    fn: async (args: ForgetRuleArgs) => {
      const applied = await applyRuleChange("forget_rule", args, (rule) =>
        removeRule(rule, opts.rootDir, configPath),
      );
      if ("error" in applied) return applied.error;
      if (!applied.ok) {
        return `No matching rule: ${describeRule(applied.rule)}. Call list_rules and retry with the exact fields.`;
      }
      return banner("REMOVED", applied.rule);
    },
  });

  return registry;
}
