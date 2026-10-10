#!/usr/bin/env node
// Comment-policy gate, ported from the former tests/comment-policy.test.ts and
// run as a pre-commit hook. Scans src/tests/scripts for comment-style
// violations and exits 1 listing every offender, so a bad comment never lands.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src", "tests", "scripts"].map((r) => join(process.cwd(), r));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const FILES = ROOTS.flatMap((root) => {
  try {
    return walk(root);
  } catch {
    return [];
  }
}).map((p) => ({ path: p, rel: relative(process.cwd(), p), src: readFileSync(p, "utf8") }));

/** Return block comments as { start, lines, body } using the same scan the test used. */
function blockComments(src) {
  const out = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = line.indexOf("/*");
    const before = open === -1 ? "" : line.slice(0, open);
    if (open !== -1 && before.indexOf("//") === -1 && !/["'`]/.test(before)) {
      const startLine = i + 1;
      const buf = [line.slice(open)];
      const closeOnSame = line.indexOf("*/", open + 2);
      if (closeOnSame !== -1) {
        out.push({ start: startLine, lines: 1, body: line.slice(open, closeOnSame + 2) });
        i++;
        continue;
      }
      let j = i + 1;
      while (j < lines.length && lines[j].indexOf("*/") === -1) {
        buf.push(lines[j]);
        j++;
      }
      if (j < lines.length) buf.push(lines[j]);
      out.push({ start: startLine, lines: j - i + 1, body: buf.join("\n") });
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

const VERSION_RE = /\bv\d+\.\d+(?:\.\d+)?\b/;
const PHASE_RE = /\bPhase\s+\d+\b/i;
const BANNER_RE = /\/\/\s*[─=\-*#]{3,}/;
const INCIDENT_RE =
  /\b(user reported|screenshot showed|incident|hotfix for|fix for #?\d|introduced in v|regression from v|pre-v\d|legacy v)/i;
const BARE_TODO_RE = /(?:^|[^A-Za-z0-9_])(TODO|HACK)(?!\(#\d+\))/;
const FIXME_RE = /(?:^|[^A-Za-z0-9_])FIXME\b/;
const TRANSLATOR_NOTE_RE =
  /\b(translator(?:'s)? note|english version|chinese version|英文版|中文版)\b/i;

function commentText(line) {
  const m = line.match(/(?:^|\s)\/\/(.*)$/);
  if (m) return m[1];
  const m2 = line.match(/\/\*+(.*?)\*?\/?$/);
  if (m2) return m2[1];
  const m3 = line.match(/^\s*\*\s?(.*)$/);
  if (m3) return m3[1];
  return null;
}

function scan(pred) {
  const out = [];
  for (const { rel, src } of FILES) {
    src.split("\n").forEach((line, idx) => {
      if (pred(line)) out.push(`${rel}:${idx + 1} — ${line.trim().slice(0, 100)}`);
    });
  }
  return out;
}

function format(offenders, rule) {
  if (offenders.length === 0) return "";
  const head = `${rule} ${offenders.length} violation(s):`;
  const list = offenders
    .slice(0, 30)
    .map((o) => `  ${o}`)
    .join("\n");
  const tail = offenders.length > 30 ? `\n  … +${offenders.length - 30} more` : "";
  return `\n${head}\n${list}${tail}\n`;
}

const reports = [];
const check = (rule, offenders) => {
  if (offenders.length) reports.push(format(offenders, rule));
};

// Module-essay headers ≤ 2 lines.
{
  const offenders = [];
  for (const { rel, src } of FILES) {
    const trimmed = src.replace(/^\uFEFF/, "").trimStart();
    if (!trimmed.startsWith("/*")) continue;
    const head = blockComments(src)[0];
    if (!head) continue;
    const beforeHead = src.slice(0, src.indexOf(head.body)).trim();
    if (beforeHead.length > 0) continue;
    if (head.lines > 2) offenders.push(`${rel}:${head.start} — header is ${head.lines} lines`);
  }
  check("Module headers must be ≤ 2 lines.", offenders);
}

check(
  'No "Phase N" narrative in source comments.',
  scan((line) => PHASE_RE.test(line)),
);

// Version-number narrative.
{
  const offenders = [];
  for (const { rel, src } of FILES) {
    src.split("\n").forEach((line, idx) => {
      const c = commentText(line);
      if (c && VERSION_RE.test(c))
        offenders.push(`${rel}:${idx + 1} — ${line.trim().slice(0, 100)}`);
    });
  }
  check("No version refs in comments — put them in commit/PR text.", offenders);
}

check(
  "No incident/conversation history in comments.",
  scan((line) => {
    const c = commentText(line);
    return c ? INCIDENT_RE.test(c) : false;
  }),
);

check(
  "No section-banner separator comments.",
  scan((line) => BANNER_RE.test(line)),
);

// TODO / HACK without a (#nnn) issue anchor.
{
  const offenders = [];
  for (const { rel, src } of FILES) {
    src.split("\n").forEach((line, idx) => {
      const c = commentText(line);
      if (c && BARE_TODO_RE.test(c))
        offenders.push(`${rel}:${idx + 1} — ${line.trim().slice(0, 100)}`);
    });
  }
  check("Bare TODO/HACK is debt leakage — write `TODO(#nnn): ...`.", offenders);
}

// FIXME markers.
{
  const offenders = [];
  for (const { rel, src } of FILES) {
    src.split("\n").forEach((line, idx) => {
      const c = commentText(line);
      if (c && FIXME_RE.test(c))
        offenders.push(`${rel}:${idx + 1} — ${line.trim().slice(0, 100)}`);
    });
  }
  check("FIXME is banned — use TODO(#nnn) or fix now.", offenders);
}

// Translator-note comments.
{
  const offenders = [];
  for (const { rel, src } of FILES) {
    src.split("\n").forEach((line, idx) => {
      const c = commentText(line);
      if (c && TRANSLATOR_NOTE_RE.test(c))
        offenders.push(`${rel}:${idx + 1} — ${line.trim().slice(0, 100)}`);
    });
  }
  check("i18n strings are self-documenting — no translator notes.", offenders);
}

// Block comments > 3 lines.
{
  const offenders = [];
  for (const { rel, src } of FILES) {
    for (const b of blockComments(src)) {
      if (b.lines > 3) offenders.push(`${rel}:${b.start} — ${b.lines}-line block`);
    }
  }
  check("Block comments capped at 3 lines (one-line preferred).", offenders);
}

if (reports.length) {
  console.error(reports.join("\n"));
  process.exit(1);
}
