import { Script } from "node:vm";
import { ruleRegexError } from "@reasonix/core-utils";

const scripts = new Map<string, Script>();

/** Regex work we allow on top of the VM's own fixed per-call cost. */
const REGEX_BUDGET_MS = 250;

/** node:vm's watchdog handshake costs tens of ms per call and is charged
 *  against `timeout`, so a small fixed budget times out ordinary commands.
 *  Measure that overhead once and budget the regex on top of it. */
let timeoutMs: number | null = null;
function ruleRegexTimeoutMs(): number {
  if (timeoutMs !== null) return timeoutMs;
  const probe = new Script("1");
  let overhead = 0;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    probe.runInNewContext({}, { timeout: 60_000 });
    overhead = Math.max(overhead, performance.now() - started);
  }
  timeoutMs = Math.ceil(overhead * 2) + REGEX_BUDGET_MS;
  return timeoutMs;
}

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
    return script.runInNewContext({ command }, { timeout: ruleRegexTimeoutMs() }) === true;
  } catch {
    throw new Error("Command rule regex exceeded its execution limit; command refused.");
  }
}
