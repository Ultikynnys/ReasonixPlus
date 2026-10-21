#!/usr/bin/env node
/**
 * Deletion drill: park provider and engine JSON files, re-sync the generated barrels,
 * and typecheck. Declaration files are optional, so the tree must build without them.
 *
 * Per-id mode parks one file at a time; `--empty` parks every file at once and asks
 * whether the project still builds with no declarations at all.
 *
 * Restores every parked file on every exit path, including Ctrl-C, and always leaves
 * the barrels synced. Do not run this while another session is editing declarations.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_DIR = join(ROOT, "packages/core-utils/src/providers");
const ENGINE_DIR = join(ROOT, "packages/core-utils/src/search-engines");
const SYNC = ["run", "providers:sync"];

const PROJECTS = {
  core: ["--prefix", "packages/core-utils", "run", "typecheck"],
  daemon: ["run", "typecheck"],
  desktop: ["--prefix", "desktop", "run", "typecheck"],
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).split(",") : fallback;
};
const projectNames = flag(
  "projects",
  args.includes("--empty") ? ["core", "daemon", "desktop"] : ["core", "daemon"],
).filter((name) => name in PROJECTS);
const onlyIds = flag("ids", null);

if (projectNames.length === 0) {
  console.error(`deletion-drill: unknown --projects; use any of ${Object.keys(PROJECTS).join(",")}`);
  process.exit(2);
}

const parked = [];

function restoreParked() {
  for (const entry of parked.splice(0)) {
    try {
      renameSync(entry.parked, entry.original);
    } catch {
      // Already restored, or the staging copy is gone: the original is intact either way.
    }
  }
}

process.on("exit", restoreParked);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restoreParked();
    process.exit(130);
  });
}

function npm(argv) {
  const result = spawnSync("npm", argv, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 900_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const firstError = output.split(/\r?\n/).find((line) => /error TS\d+/.test(line)) ?? "";
  return { ok: result.status === 0, firstError: firstError.trim() };
}

function declarations() {
  const found = [];
  for (const [kind, dir] of [
    ["provider", PROVIDER_DIR],
    ["engine", ENGINE_DIR],
  ]) {
    for (const file of readdirSync(dir).sort()) {
      if (file.endsWith(".json")) {
        found.push({ kind, id: file.slice(0, -".json".length), path: join(dir, file) });
      }
    }
  }
  return found;
}

function report(rows) {
  if (args.includes("--json")) {
    console.log(JSON.stringify({ projects: projectNames, rows }, null, 2));
    return;
  }
  for (const row of rows) {
    const verdict = row.ok ? "ok  " : "FAIL";
    const detail = row.ok ? "" : `  ${row.error}`;
    console.log(`${verdict} ${row.kind.padEnd(8)} ${row.id.padEnd(13)} ${row.project}${detail}`);
  }
  const failed = rows.filter((row) => !row.ok);
  if (rows.length > 0 && rows.every((row) => row.kind === "all")) {
    console.log(
      `\n${rows.length - failed.length}/${rows.length} projects build with no declarations at all`,
    );
    return;
  }
  const ids = new Set(failed.map((row) => `${row.kind}:${row.id}`));
  console.log(
    `\n${rows.length - failed.length}/${rows.length} checks pass; ${ids.size} declaration(s) break the build`,
  );
}

function parkAll(entries, staging) {
  for (const entry of entries) {
    const parkedPath = join(staging, `${entry.kind}-${entry.id}.json`);
    renameSync(entry.path, parkedPath);
    parked.push({ original: entry.path, parked: parkedPath });
  }
}

function main() {
  const subjects = declarations().filter((entry) => !onlyIds || onlyIds.includes(entry.id));
  if (subjects.length === 0) {
    console.error("deletion-drill: no declarations matched");
    return 2;
  }
  const staging = mkdtempSync(join(tmpdir(), "reasonix-deletion-drill-"));
  const rows = [];
  try {
    if (args.includes("--empty")) {
      parkAll(subjects, staging);
      const synced = npm(SYNC);
      if (!synced.ok) {
        throw new Error(`providers:sync failed with no declarations: ${synced.firstError}`);
      }
      for (const project of projectNames) {
        const result = npm(PROJECTS[project]);
        rows.push({ kind: "all", id: "empty", project, ok: result.ok, error: result.firstError });
      }
    } else {
      for (const entry of subjects) {
        parkAll([entry], staging);
        const synced = npm(SYNC);
        if (!synced.ok) {
          throw new Error(`providers:sync failed without ${entry.id}: ${synced.firstError}`);
        }
        for (const project of projectNames) {
          const result = npm(PROJECTS[project]);
          rows.push({
            kind: entry.kind,
            id: entry.id,
            project,
            ok: result.ok,
            error: result.firstError,
          });
        }
        restoreParked();
        npm(SYNC);
      }
    }
  } finally {
    restoreParked();
    // The drill's whole job is leaving the tree usable: a silent failure here would
    // restore the files while leaving the barrels out of step with them.
    const restored = npm(SYNC);
    if (!restored.ok) {
      console.error(
        `deletion-drill: providers:sync failed while restoring (${restored.firstError}); run it manually`,
      );
    }
    rmSync(staging, { recursive: true, force: true });
  }
  report(rows);
  return rows.every((row) => row.ok) ? 0 : 1;
}

process.exit(main());
