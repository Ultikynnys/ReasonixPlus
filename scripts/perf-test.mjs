#!/usr/bin/env node
// Full-speed suite: same run as `npm test`, with the scale/perf probes enabled
// (see tests/support/perf-gate.ts). Extra args pass straight through to vitest.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Spawn the CLI directly: `npx` would need a shell, and a shell re-splits argv.
const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
if (!existsSync(vitest)) {
  console.error(`vitest not found at ${vitest}. Run npm install first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [vitest, "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, REASONIX_PERF: "1" },
});
process.exit(result.status ?? 1);
