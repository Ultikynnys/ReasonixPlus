/** Session creation and deletion at the reported scale: 10 sessions x 2000 messages. */

// Measured separately because they are different code paths in the daemon.
//   create = appendSessionMessage() per record, which is what a live turn does.
//   delete = deleteSession() (folder rm + index drop) and deleteSessions() (batch).
// The ablation appends JSONL directly: the same volume with no metadata tax.
//
// Recorded on Windows x64 (Node 24) for 10 sessions x 2000 messages.
//   BEFORE  create  55,994 ms  (2.800 ms/record)   delete x10  11 ms
//   AFTER   create   8,681 ms  (0.434 ms/record)   delete x10  10 ms
//           bare append floor: 0.394 ms/record
//
// Creation used to pay 2.4 ms/record of overhead because every record re-read
// meta.json twice and rewrote it. What remains is the sync append itself, so
// create is within 10% of its own floor; only batching the writes (a durability
// tradeoff) goes lower. Deletion was already fast and stays so.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/types.js";

const home = mkdtempSync(join(tmpdir(), "reasonix-session-ops-"));
vi.stubEnv("USERPROFILE", home);
vi.stubEnv("HOME", home);

const store = await import("../src/memory/session.js");
const { appendJsonlLine } = await import("../src/core/jsonl.js");

const SESSIONS = 10;
const MESSAGES = 2000;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A record shaped like a real turn's, sized so 2000 of them is about the 4.7 MB a
 *  2000-message session actually occupies on disk. */
function record(i: number): ChatMessage {
  const body = `line ${i} of a coding turn. `.repeat(24);
  return i % 4 === 3
    ? { role: "tool", tool_call_id: `call-${i}`, content: body }
    : {
        role: i % 2 === 0 ? "user" : "assistant",
        content: body,
      };
}

const records = Array.from({ length: MESSAGES }, (_, i) => record(i));

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function nameFor(i: number): string {
  return `scale-ops-${process.pid}-${i}`;
}

describe("session create/delete at 10 x 2000", () => {
  it("creates 10 sessions of 2000 messages each", () => {
    const started = performance.now();
    for (let s = 0; s < SESSIONS; s++) {
      for (const message of records) store.appendSessionMessage(nameFor(s), message);
    }
    const totalMs = performance.now() - started;

    const bytes = statSync(store.sessionMessagesPath(nameFor(0))).size;
    const perMessageMs = totalMs / (SESSIONS * MESSAGES);
    console.log(
      `create ${SESSIONS} x ${MESSAGES}: ${totalMs.toFixed(0)} ms total, ` +
        `${perMessageMs.toFixed(3)} ms/message, ${(bytes / 1e6).toFixed(2)} MB per session`,
    );

    // The per-record metadata read-modify-write cost 56 s here; the ceiling sits
    // well above the current 8.7 s so a slow machine passes but a relapse does not.
    expect(totalMs).toBeLessThan(25_000);
    expect(bytes).toBeGreaterThan(1_000_000);
  }, 180_000);

  it("appends the same volume as bare JSONL, for the metadata tax", () => {
    const bare = `bare-ops-${process.pid}`;
    store.ensureSessionDir(bare);
    const path = store.sessionMessagesPath(bare);
    const started = performance.now();
    for (let s = 0; s < SESSIONS; s++) {
      for (const message of records) appendJsonlLine(path, message);
    }
    const totalMs = performance.now() - started;
    console.log(
      `bare append ${SESSIONS * MESSAGES} records: ${totalMs.toFixed(0)} ms total, ` +
        `${(totalMs / (SESSIONS * MESSAGES)).toFixed(3)} ms/record`,
    );
    store.deleteSession(bare);
    expect(totalMs).toBeLessThan(60_000);
  }, 180_000);

  it("deletes 10 sessions one by one", () => {
    const times: number[] = [];
    for (let s = 0; s < SESSIONS; s++) {
      const started = performance.now();
      expect(store.deleteSession(nameFor(s))).toBe(true);
      times.push(performance.now() - started);
    }
    console.log(
      `delete ${SESSIONS} one-by-one: ${times.reduce((a, b) => a + b, 0).toFixed(0)} ms total, ` +
        `${median(times).toFixed(2)} ms median`,
    );
    expect(Math.max(...times)).toBeLessThan(5_000);
  }, 120_000);

  it("deletes 10 sessions through the chunked batch form", async () => {
    for (let s = 0; s < SESSIONS; s++) {
      for (const message of records.slice(0, 50)) store.appendSessionMessage(nameFor(s), message);
    }
    const names = Array.from({ length: SESSIONS }, (_, s) => nameFor(s));
    const started = performance.now();
    const settled = await store.deleteSessions(names);
    const totalMs = performance.now() - started;
    console.log(`delete ${SESSIONS} via deleteSessions: ${totalMs.toFixed(0)} ms total`);
    expect(settled.every((r) => r.removed)).toBe(true);
    expect(totalMs).toBeLessThan(5_000);
  }, 120_000);
});
