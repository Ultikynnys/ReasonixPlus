/** Which scopes already carry an approval rule for a given target, so an approval prompt
 *  can drop the "add to <scope> rules" action for a scope that is already covered. */

import { pathIsUnder } from "@reasonix/core-utils/path-utils";
import {
  type RuleKind,
  type RuleScope,
  defaultConfigPath,
  ruleModeInForce,
  rulePatternsByScope,
} from "../../config.js";
import { matchesAnyRulePattern } from "./parse.js";

/** Scopes whose rules — of the kind and mode in force — already match `target`. `target`
 *  is a shell command for `kind: "shell"`, or the directory a path rule would persist for
 *  `kind: "path"`. An empty result means the prompt may still offer both scopes. */
export function coveredRuleScopes(
  kind: RuleKind,
  target: string,
  rootDir: string,
  path: string = defaultConfigPath(),
): RuleScope[] {
  if (!target) return [];
  const activeMode = ruleModeInForce(path);
  const active = rulePatternsByScope(activeMode, kind, rootDir, path);
  // Allow lists are always stored as Follow/allow, so they stay in force in every mode.
  const allow =
    activeMode === "follow" ? active : rulePatternsByScope("follow", kind, rootDir, path);
  const covers = (patterns: readonly string[]): boolean =>
    kind === "shell"
      ? matchesAnyRulePattern(target, patterns)
      : patterns.some((prefix) => pathIsUnder(target, prefix));
  const scopes: RuleScope[] = [];
  for (const scope of ["workspace", "global"] as const) {
    const patterns = [...allow[scope].allow, ...active[scope].ask, ...active[scope].deny];
    if (covers(patterns)) scopes.push(scope);
  }
  return scopes;
}
