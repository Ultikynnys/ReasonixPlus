#!/usr/bin/env node
// No-op when run from the published tarball (no desktop/package.json shipped) —
// only the git checkout has workspace deps to install.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("desktop/package.json")) process.exit(0);

// The release workflow installs desktop deps itself, with scripts enabled, so
// it sets this to skip the redundant second install that would otherwise run.
if (process.env.REASONIX_SKIP_DESKTOP_POSTINSTALL === "1") {
  console.log("REASONIX_SKIP_DESKTOP_POSTINSTALL=1 set; skipping desktop install");
  process.exit(0);
}

execSync("npm --prefix desktop ci --ignore-scripts", { stdio: "inherit" });
