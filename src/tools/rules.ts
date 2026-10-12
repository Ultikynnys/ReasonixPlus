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

function fmtRule(r: ScopedRule): string {
  const match = r.match === "regex" ? " (regex)" : "";
  return `- [${r.scope}] ${r.mode}/${r.effect} ${r.kind}${match}: ${r.pattern}`;
}

function describeRule(r: ScopedRule): string {
  return `${r.scope} ${r.kind}/${r.effect} "${r.pattern}"`;
}

interface RuleArgs {
  kind?: unknown;
  effect?: unknown;
  pattern?: unknown;
  scope?: unknown;
  match?: unknown;
  mode?: unknown;
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
        kind: {
          type: "string",
          enum: [...KINDS],
          description: "'shell' matches the command text; 'path' matches a directory prefix.",
        },
        effect: {
          type: "string",
          enum: [...EFFECTS],
          description:
            "'allow' runs without asking; 'ask' always confirms; 'deny' refuses outright; 'ignore' is stored but not enforced.",
        },
        pattern: {
          type: "string",
          description:
            "For kind='shell': a command pattern like 'git *' (or a regex with match='regex'). For kind='path': a directory prefix.",
        },
        scope: {
          type: "string",
          enum: [...SCOPES],
          description: "'workspace' = this project only; 'global' = every project.",
        },
        match: {
          type: "string",
          enum: [...MATCHES],
          description:
            "Omit for glob-style pattern matching; 'regex' enables regex matching (kind='shell' only).",
        },
      },
      required: ["kind", "effect", "pattern", "scope"],
    },
    fn: async (args: {
      kind: RuleKind;
      effect: RuleEffect;
      pattern: string;
      scope: RuleScope;
      match?: "pattern" | "regex";
    }) => {
      const built = buildRule("remember_rule", args, ruleModeInForce(configPath));
      if ("error" in built) return built.error;
      const rule = built.rule;
      try {
        const added = addRule(rule, opts.rootDir, configPath);
        if (!added) {
          return `Already present: ${describeRule(rule)} (nothing changed).`;
        }
        fire();
        return [
          `✓ RULE SAVED (${args.scope} ${args.kind}/${args.effect}): ${rule.pattern}`,
          "Enforced from the next run_command or path check onward; visible in Settings → Rules.",
        ].join("\n");
      } catch (err) {
        return JSON.stringify({ error: `remember_rule failed: ${(err as Error).message}` });
      }
    },
  });

  registry.register({
    name: "forget_rule",
    description:
      "Delete one permission rule by its exact fields as shown by list_rules. Use when a remembered rule has become wrong or the user asks to remove one. Returns 'No matching rule' when nothing matches.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...KINDS],
          description: "'shell' or 'path', as list_rules showed.",
        },
        effect: {
          type: "string",
          enum: [...EFFECTS],
          description: "'allow', 'ask', 'deny' or 'ignore', as list_rules showed.",
        },
        pattern: {
          type: "string",
          description: "The rule's pattern exactly as list_rules displayed it.",
        },
        scope: {
          type: "string",
          enum: [...SCOPES],
          description: "'workspace' or 'global', as list_rules showed.",
        },
        match: {
          type: "string",
          enum: [...MATCHES],
          description: "Pass 'regex' only when list_rules marked the rule as (regex).",
        },
        mode: {
          type: "string",
          enum: [...MODES],
          description:
            "Rule set to search; defaults to the mode in force. Pass the mode list_rules displayed when it differs.",
        },
      },
      required: ["kind", "effect", "pattern", "scope"],
    },
    fn: async (args: {
      kind: RuleKind;
      effect: RuleEffect;
      pattern: string;
      scope: RuleScope;
      match?: "pattern" | "regex";
      mode?: RuleMode;
    }) => {
      const built = buildRule("forget_rule", args, ruleModeInForce(configPath));
      if ("error" in built) return built.error;
      const rule = built.rule;
      try {
        const removed = removeRule(rule, opts.rootDir, configPath);
        if (!removed) {
          return `No matching rule: ${describeRule(rule)}. Call list_rules and retry with the exact fields.`;
        }
        fire();
        return `✓ RULE REMOVED (${args.scope} ${args.kind}/${args.effect}): ${rule.pattern}`;
      } catch (err) {
        return JSON.stringify({ error: `forget_rule failed: ${(err as Error).message}` });
      }
    },
  });

  return registry;
}
