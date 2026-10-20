#!/usr/bin/env node
// Re-measures the desktop shell's hot spots from the durable diagnostics log:
// long tasks, per-type wire emission rates, and how many tabs one session
// listing fans out to. Usage: node scripts/diagnostic-trace-report.mjs [dir]

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const FANOUT_WINDOW_MS = 250;
const BUCKETS = [50, 100, 200, 500, 1000];
const LONG_TASK = "longtask";
const WIRE = "wire.emit";
const LIST_EVENTS = ["sessions.list.started", "sessions.list.completed"];

function bucketFor(durationMs) {
  for (const limit of BUCKETS) if (durationMs < limit) return `<${limit}`;
  return `${BUCKETS[BUCKETS.length - 1]}+`;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

function median(values) {
  return percentile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function* records(file) {
  const lines = createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A torn final line from a crash is not worth failing the report over.
    }
  }
}

function emptyFile(name) {
  return {
    name,
    firstTs: Number.NaN,
    lastTs: Number.NaN,
    longTasks: {
      count: 0,
      totalMs: 0,
      buckets: new Map(),
      gaps: [],
      lastStart: Number.NaN,
    },
    wire: new Map(),
    sessionsBursts: [],
    listBursts: [],
  };
}

function trackWire(file, eventType, tabId) {
  const entry = file.wire.get(eventType) ?? { count: 0, tabs: new Set() };
  entry.count += 1;
  if (tabId) entry.tabs.add(tabId);
  file.wire.set(eventType, entry);
}

/** Groups records emitted within one window of each other into a burst. */
function pushBurst(bursts, atMs, tabId) {
  const last = bursts[bursts.length - 1];
  if (last && atMs - last.at <= FANOUT_WINDOW_MS) {
    last.at = atMs;
    last.count += 1;
    last.tabs.add(tabId);
    return;
  }
  bursts.push({ at: atMs, count: 1, tabs: new Set([tabId]) });
}

function trackLongTask(file, entry) {
  const duration = typeof entry.durationMs === "number" ? entry.durationMs : 0;
  const start = typeof entry.startTimeMs === "number" ? entry.startTimeMs : Number.NaN;
  file.longTasks.count += 1;
  file.longTasks.totalMs += duration;
  const bucket = bucketFor(duration);
  file.longTasks.buckets.set(bucket, (file.longTasks.buckets.get(bucket) ?? 0) + 1);
  // startTimeMs restarts at every page load, so a gap is only comparable
  // inside one segment.
  if (Number.isFinite(start)) {
    if (Number.isFinite(file.longTasks.lastStart) && start >= file.longTasks.lastStart) {
      file.longTasks.gaps.push(start - file.longTasks.lastStart);
    }
    file.longTasks.lastStart = start;
  }
}

async function summarise(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  const files = [];
  for (const name of names) {
    const file = emptyFile(name);
    for await (const record of records(join(dir, name))) {
      const at =
        typeof record.tsUnixMs === "number" ? record.tsUnixMs : Date.parse(record.ts ?? "");
      if (Number.isFinite(at)) {
        if (!Number.isFinite(file.firstTs) || at < file.firstTs) file.firstTs = at;
        if (!Number.isFinite(file.lastTs) || at > file.lastTs) file.lastTs = at;
      }
      const details = record.details ?? {};
      if (record.event === "frontend.performance.batch" && Array.isArray(details.entries)) {
        for (const entry of details.entries)
          if (entry?.entryType === LONG_TASK) trackLongTask(file, entry);
        continue;
      }
      if (record.event === WIRE) {
        const eventType = details.eventType ?? "(none)";
        trackWire(file, eventType, details.tabId);
        if (eventType === "$sessions") {
          pushBurst(file.sessionsBursts, record.monotonicMs ?? 0, details.tabId ?? "?");
        }
        continue;
      }
      if (LIST_EVENTS.includes(record.event)) {
        pushBurst(file.listBursts, record.monotonicMs ?? 0, details.tabId ?? "?");
      }
    }
    files.push(file);
  }
  return files;
}

function printLongTasks(files) {
  const withTasks = files.filter((file) => file.longTasks.count > 0);
  console.log("## Long tasks (frontend.performance.batch, entryType=longtask)");
  if (withTasks.length === 0) {
    console.log("  none recorded");
    return;
  }
  console.log("| log file | count | total | wall span | share | median gap | p90 gap |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  const buckets = new Map();
  for (const file of withTasks) {
    const span = Number.isFinite(file.firstTs) ? file.lastTs - file.firstTs : 0;
    const gaps = file.longTasks.gaps;
    console.log(
      `| ${file.name} | ${file.longTasks.count} | ${seconds(file.longTasks.totalMs)} | ${seconds(span)} | ` +
        `${span > 0 ? ((file.longTasks.totalMs / span) * 100).toFixed(1) : "?"}% | ` +
        `${median(gaps).toFixed(0)}ms | ${percentile(
          [...gaps].sort((a, b) => a - b),
          0.9,
        ).toFixed(0)}ms |`,
    );
    for (const [bucket, count] of file.longTasks.buckets)
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + count);
  }
  const order = [...BUCKETS.map((limit) => `<${limit}`), `${BUCKETS[BUCKETS.length - 1]}+`];
  console.log("");
  console.log("| duration | count |");
  console.log("| --- | --- |");
  for (const bucket of order)
    if (buckets.has(bucket)) console.log(`| ${bucket} ms | ${buckets.get(bucket)} |`);
}

function printWire(files) {
  console.log("");
  console.log("## Wire emissions (daemon wire.emit, per type)");
  const totals = new Map();
  const spans = [];
  for (const file of files) {
    const span = Number.isFinite(file.firstTs) ? file.lastTs - file.firstTs : 0;
    if (span > 0 && file.wire.size > 0) spans.push(span);
    for (const [eventType, entry] of file.wire) {
      const merged = totals.get(eventType) ?? { count: 0, tabs: new Set() };
      merged.count += entry.count;
      for (const tab of entry.tabs) merged.tabs.add(tab);
      totals.set(eventType, merged);
    }
  }
  if (totals.size === 0) {
    console.log("  none recorded");
    return;
  }
  const span = spans.length > 0 ? Math.max(...spans) : 0;
  console.log("| event type | count | per minute | tabs addressed |");
  console.log("| --- | --- | --- | --- |");
  for (const [eventType, entry] of [...totals].sort((a, b) => b[1].count - a[1].count)) {
    const perMinute = span > 0 ? ((entry.count / span) * 60_000).toFixed(1) : "?";
    console.log(`| ${eventType} | ${entry.count} | ${perMinute} | ${entry.tabs.size} |`);
  }
}

function printBursts(files, label, key) {
  const bursts = files.flatMap((file) => file[key]);
  console.log("");
  console.log(`## ${label} (clustered within ${FANOUT_WINDOW_MS} ms)`);
  if (bursts.length === 0) {
    console.log("  none recorded");
    return;
  }
  const fanout = bursts.map((burst) => burst.count);
  const widest = bursts.reduce(
    (best, burst) => (burst.count > best.count ? burst : best),
    bursts[0],
  );
  console.log(`  bursts: ${bursts.length}`);
  console.log(`  median events per burst: ${median(fanout)}`);
  console.log(`  widest burst: ${widest.count} events across ${widest.tabs.size} tabs`);
}

const dir = process.argv[2] ?? join(homedir(), ".reasonix", "diagnostics");
const files = await summarise(dir);
const totalRecords = files.reduce((sum, file) => sum + file.longTasks.count, 0);
console.log(`diagnostics: ${dir}`);
console.log(`files: ${files.length}, long-task entries: ${totalRecords}`);
console.log("");
printLongTasks(files);
printWire(files);
printBursts(files, "Session-list fan-out ($sessions bursts)", "sessionsBursts");
printBursts(files, "Session listings per command (sessions.list bursts)", "listBursts");
