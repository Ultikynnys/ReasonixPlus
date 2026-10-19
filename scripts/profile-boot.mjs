#!/usr/bin/env node
/** Boot-time profiler for the desktop daemon.
 *
 * Summarizes the newest launch in `~/.reasonix/diagnostics`: the `startup.phase`
 * marks (cold start -> first `$ready`), plus per-tab bootstrap cost and when each
 * restored tab finished initializing.
 *
 *   node scripts/profile-boot.mjs [diagnostics.jsonl] [--all]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const all = args.includes("--all");
const explicit = args.find((a) => !a.startsWith("--"));
const dir = path.join(os.homedir(), ".reasonix", "diagnostics");

const files = fs
  .readdirSync(dir)
  .filter((n) => n.startsWith("reasonix-diagnostics-") && n.endsWith(".jsonl"))
  .sort();
const chosen = explicit
  ? [path.resolve(explicit)]
  : files.slice(all ? -5 : -1).map((name) => path.join(dir, name));

for (const file of chosen) {
  const recs = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  if (recs.length === 0) continue;
  const t0 = recs[0].monotonicMs;
  const at = (r) => Number((r.monotonicMs - t0).toFixed(0));

  console.log(`\n### ${path.basename(file)}`);
  console.log(`    launch ${recs[0].launchId?.slice(0, 8)}  pid ${recs[0].pid}  records ${recs.length}`);

  const phases = recs.filter((r) => r.event === "startup.phase");
  if (phases.length > 0) {
    console.log("\n  startup phases");
    let total = 0;
    for (const r of phases) {
      const d = r.durationMs ?? 0;
      total += d;
      console.log(
        `    ${String(at(r)).padStart(7)}ms  ${d.toFixed(0).padStart(7)}ms  ${r.details?.phase ?? "?"}`,
      );
    }
    console.log(`    ${" ".repeat(7)}   ${total.toFixed(0).padStart(7)}ms  (sum of phases)`);
  }

  const count = (event) => recs.filter((r) => r.event === event).length;
  const created = recs.filter((r) => r.event === "tab.created").map(at).sort((a, b) => a - b);
  const boots = recs.filter((r) => r.event === "tab.bootstrap.completed");
  if (created.length > 0) {
    const durs = boots
      .map((r) => r.details?.durationMs)
      .filter((d) => typeof d === "number")
      .sort((a, b) => a - b);
    console.log("\n  tabs");
    console.log(`    created ${created.length}  (first ${created[0]}ms, last ${created.at(-1)}ms)`);
    console.log(
      `    bootstrap completed ${boots.length}  (last ${Math.max(...boots.map(at))}ms)  ` +
        `median ${durs[Math.floor(durs.length / 2)]?.toFixed(0) ?? "-"}ms  ` +
        `total ${durs.reduce((a, b) => a + b, 0).toFixed(0)}ms`,
    );
    console.log(`    $ready ${count("tab.ready")}  $session_loaded ${count("wire.emit")} events`);
  }
}

console.log(
  "\nRun the daemon with REASONIX_PROFILE_STARTUP=1 (env) to get the stderr phase table;",
);
console.log("this script reads what the daemon already writes to the diagnostics sink.");
