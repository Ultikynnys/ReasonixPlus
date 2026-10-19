import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEventRecord } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteSession,
  ensureSessionDir,
  loadSessionEvents,
  sessionUiEventsPath,
  writeSessionEvents,
} from "../src/memory/session.js";

const planVerdict: SessionEventRecord = {
  id: "plan-3",
  type: "plan",
  ts: 1_700_000_000_000,
  turn: 2,
  outcome: "approve",
  label: "Ship the Events tab",
};

const foldDone: SessionEventRecord = {
  id: "compaction-notice-9",
  type: "compaction",
  ts: 1_700_000_060_000,
  turn: 2,
  outcome: "auto",
  label: "folded 42 messages",
};

describe("per-session Events sidecar", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-ui-events-"));
    vi.stubEnv("USERPROFILE", tmp); // Windows
    vi.stubEnv("HOME", tmp); // Unix
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("lives in the session's own folder, apart from the kernel's event log", () => {
    const path = sessionUiEventsPath("events-demo").replace(/\\/g, "/");
    expect(path).toContain("sessions/events-demo/ui-events.json");
    expect(path.startsWith(tmp.replace(/\\/g, "/"))).toBe(true);
  });

  it("round-trips the recorded verdicts for a session", () => {
    ensureSessionDir("events-demo");
    writeSessionEvents("events-demo", [planVerdict, foldDone]);
    expect(loadSessionEvents("events-demo")).toEqual([planVerdict, foldDone]);
  });

  it("keeps the options a choice was picked from", () => {
    const choice: SessionEventRecord = {
      id: "choice-4",
      type: "choice",
      ts: 1_700_000_030_000,
      turn: 2,
      outcome: "pick",
      label: "Verify it myself",
      detail: "What next?",
      options: ["Stop here", "Verify it myself"],
    };
    ensureSessionDir("events-demo");
    writeSessionEvents("events-demo", [choice]);
    expect(loadSessionEvents("events-demo")).toEqual([choice]);
  });

  it("replaces the whole list on the next sync, so a settle updates its row", () => {
    ensureSessionDir("events-demo");
    writeSessionEvents("events-demo", [foldDone]);
    writeSessionEvents("events-demo", [{ ...foldDone, label: "folded 60 messages" }]);
    const events = loadSessionEvents("events-demo");
    expect(events).toHaveLength(1);
    expect(events[0]?.label).toBe("folded 60 messages");
  });

  it("reads an absent sidecar as no events, for sessions older than the tab", () => {
    ensureSessionDir("legacy");
    expect(loadSessionEvents("legacy")).toEqual([]);
    expect(existsSync(sessionUiEventsPath("legacy"))).toBe(false);
  });

  it("ignores a malformed sidecar instead of throwing into the session load", () => {
    const dir = ensureSessionDir("broken");
    writeFileSync(join(dir, "ui-events.json"), "{ not json");
    expect(loadSessionEvents("broken")).toEqual([]);
  });

  it("keeps the readable rows when one entry is malformed", () => {
    const dir = ensureSessionDir("wrong-shape");
    writeFileSync(
      join(dir, "ui-events.json"),
      JSON.stringify([planVerdict, { nope: true }, { ...foldDone, label: 7 }]),
    );
    // One unreadable row must not cost the session every other row.
    expect(loadSessionEvents("wrong-shape")).toEqual([planVerdict]);
  });

  it("drops a row whose options are not text", () => {
    const dir = ensureSessionDir("bad-options");
    writeFileSync(
      join(dir, "ui-events.json"),
      JSON.stringify([planVerdict, { ...foldDone, options: ["ok", 7] }]),
    );
    expect(loadSessionEvents("bad-options")).toEqual([planVerdict]);
  });

  it("keeps a plan's body and checklist", () => {
    const plan: SessionEventRecord = {
      id: "plan-7",
      type: "plan",
      ts: 1_700_000_090_000,
      turn: 3,
      outcome: "approve",
      label: "QuickSend polish",
      body: "## QuickSend polish\n\nCloses four gaps.",
      steps: ["Route strings through i18n", "Collision-proof ids"],
    };
    ensureSessionDir("events-demo");
    writeSessionEvents("events-demo", [plan]);
    expect(loadSessionEvents("events-demo")).toEqual([plan]);
  });

  it("drops a row whose steps are not text", () => {
    const dir = ensureSessionDir("bad-steps");
    writeFileSync(
      join(dir, "ui-events.json"),
      JSON.stringify([planVerdict, { ...planVerdict, id: "x", steps: ["ok", 7] }]),
    );
    expect(loadSessionEvents("bad-steps")).toEqual([planVerdict]);
  });

  it("keeps the card an event jumps to", () => {
    const anchored: SessionEventRecord = { ...planVerdict, anchor: "call:call-7" };
    ensureSessionDir("events-anchor");
    writeSessionEvents("events-anchor", [anchored]);
    expect(loadSessionEvents("events-anchor")).toEqual([anchored]);
  });

  it("drops a row whose anchor is not text", () => {
    const dir = ensureSessionDir("bad-anchor");
    writeFileSync(
      join(dir, "ui-events.json"),
      JSON.stringify([planVerdict, { ...planVerdict, id: "x", anchor: 42 }]),
    );
    expect(loadSessionEvents("bad-anchor")).toEqual([planVerdict]);
  });

  it("writes JSON the next load can parse", () => {
    ensureSessionDir("events-demo");
    writeSessionEvents("events-demo", [planVerdict]);
    const raw = readFileSync(sessionUiEventsPath("events-demo"), "utf8");
    expect(JSON.parse(raw)).toEqual([planVerdict]);
  });

  it("goes away with the session's folder", () => {
    ensureSessionDir("events-demo");
    writeSessionEvents("events-demo", [planVerdict]);
    expect(deleteSession("events-demo")).toBe(true);
    expect(existsSync(sessionUiEventsPath("events-demo"))).toBe(false);
  });
});
