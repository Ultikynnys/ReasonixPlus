/** Purpose-built wall-clock wait tool — replaces adhoc `ping` / `timeout /t` / `Start-Sleep` sleeps with real time accounting. */

import { sleep } from "@reasonix/core-utils";
import type { ToolRegistry } from "../tools.js";
import { mergeSignals } from "./jobs.js";

/** Hard ceiling. A wait longer than this should be a job + `wait_for_job`, not a sleep. */
export const WAIT_MAX_MS = 300_000;
/** Default when the model omits `ms` — long enough to outlive a save, short enough to stay responsive. */
export const WAIT_DEFAULT_MS = 5_000;

export interface WaitToolOptions {
  /** Injectable clock — tests pin this instead of sleeping for real. */
  now?: () => number;
  /** Injectable sleeper — tests substitute a no-op. Default: the shared core-utils sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function clampMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return WAIT_DEFAULT_MS;
  return Math.min(Math.round(n), WAIT_MAX_MS);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD HH:MM:SS UTC` — timezone-independent, sorts lexicographically. */
export function formatUtc(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** Local wall clock in the harness host's timezone, e.g. `2026-05-14 09:23:05 (UTC+02:00)`. */
export function formatLocal(epochMs: number): string {
  const d = new Date(epochMs);
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${local} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`;
}

/** Registers the `wait` tool: a real mid-turn sleep with full time accounting
 *  (requested vs actual, elapsed, UTC + local clocks). The only sanctioned pause;
 *  shell sleep hacks (`ping -n`, `timeout /t`, `Start-Sleep`) are banned. */
export function registerWaitTool(registry: ToolRegistry, opts: WaitToolOptions = {}): ToolRegistry {
  const now = opts.now ?? (() => Date.now());
  const sleepImpl = opts.sleep ?? sleep;
  registry.register({
    name: "wait",
    description:
      "Pause mid-turn for N milliseconds (max 300000), then get a full time report: requested vs actual wait, elapsed, and the wall-clock time (UTC + local) before and after. Costs one tool call and no shell process.\n\nUse this only for a genuine time-based pause with no completion signal to wait on: an editor save, a file lock, a debounce, or a backoff between retries, with intervals that grow rather than repeat. This is the ONLY sanctioned way to pause: do NOT fake a sleep with shell commands (`ping -n`, `timeout /t`, `Start-Sleep`, `sleep N`); they gate on user confirmation, burn a process, and report no time information.\n\nFor waiting on a PROCESS instead of the clock, use `wait_for_job`: that wakes on exit/output, which is always better than a fixed sleep.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        ms: {
          type: "integer",
          description:
            "Milliseconds to pause. 1..300000 (values are clamped, never rejected). Default 5000.",
        },
      },
    },
    fn: async (args: { ms?: number }, ctx) => {
      const rawMs = typeof args?.ms === "number" ? args.ms : Number(args?.ms);
      const requestedMs = clampMs(rawMs);
      const startedAt = now();
      // Both signals matter: cancelSignal is Ctrl+K / desktop Stop on this call,
      // signal is the turn-level Esc / Stop — without it a mid-turn stop leaves
      // the timer running through teardown.
      const signal = mergeSignals(ctx?.signal, ctx?.cancelSignal);
      let cancelled = false;
      try {
        await sleepImpl(requestedMs, signal);
      } catch {
        cancelled = true;
      }
      const endedAt = now();
      const waitedMs = Math.max(0, endedAt - startedAt);
      return JSON.stringify({
        requestedMs,
        waitedMs,
        clamped: Number.isFinite(rawMs) && rawMs > WAIT_MAX_MS,
        ...(cancelled
          ? { cancelledByUser: true, note: "wait was interrupted before it finished" }
          : {}),
        timeBefore: { utc: formatUtc(startedAt), local: formatLocal(startedAt) },
        timeAfter: { utc: formatUtc(endedAt), local: formatLocal(endedAt) },
        elapsed: `${(waitedMs / 1000).toFixed(1)}s`,
      });
    },
  });
  return registry;
}
