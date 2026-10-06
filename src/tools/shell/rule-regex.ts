import { Script } from "node:vm";
import { ruleRegexError } from "@reasonix/core-utils";

const scripts = new Map<string, Script>();

export function matchesRuleRegex(command: string, pattern: string): boolean {
  const error = ruleRegexError(pattern);
  if (error) throw new Error(error);
  let script = scripts.get(pattern);
  if (!script) {
    script = new Script(`new RegExp(${JSON.stringify(pattern)}, "i").test(command)`);
    if (scripts.size >= 128) scripts.clear();
    scripts.set(pattern, script);
  }
  try {
    // VM execution is interruptible, unlike a RegExp.test on the daemon's own context.
    return script.runInNewContext({ command }, { timeout: 25 }) === true;
  } catch {
    throw new Error("Command rule regex exceeded its execution limit; command refused.");
  }
}
