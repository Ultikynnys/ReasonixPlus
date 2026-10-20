/** Scale fixtures for the worst case: many workspaces, many sessions, thousands of
 *  messages. Deterministic, so a budget measured once is comparable with the next. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedMessage, LoadedSegment } from "../../desktop/src/protocol.js";
import type { ChatMessage } from "../../src/types.js";

export interface ScaleSpec {
  workspaces: number;
  sessionsPerWorkspace: number;
  messagesPerSession: number;
}

/** The shape the user asked about: 10 workspaces x 100 sessions x 2000 messages. */
export const SCALE_WORST_CASE: ScaleSpec = {
  workspaces: 10,
  sessionsPerWorkspace: 100,
  messagesPerSession: 2000,
};

export interface ScaleSession {
  workspace: string;
  name: string;
  meta: Record<string, unknown>;
  records: ChatMessage[];
}

const WORDS = "the quick brown fox jumps over a lazy dog while reading source files".split(" ");

/** Deterministic filler prose of exactly `chars` characters. */
export function prose(chars: number, seed = 0): string {
  let out = "";
  let at = seed;
  while (out.length < chars) {
    at = (at * 31 + 17) % WORDS.length;
    out += `${WORDS[at]} `;
  }
  return out.slice(0, chars);
}

/** One assistant record's tool call: a read_file with a per-turn unique path. */
function toolCall(turn: number) {
  return {
    id: `call-${turn}`,
    type: "function" as const,
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: `src/module-${turn}.ts` }),
    },
  };
}

/** Transcript records for one session, in the daemon's on-disk shape
 *  (`messages.jsonl`): one user prompt, then one assistant record carrying
 *  reasoning + prose + a tool call, then that call's result. */
export function sessionRecords(messages: number, seed = 0): ChatMessage[] {
  const records: ChatMessage[] = [];
  let turn = 0;
  while (records.length < messages) {
    turn += 1;
    const ts = 1_700_000_000_000 + turn * 1_000;
    records.push({ role: "user", content: prose(180, seed + turn), ts });
    if (records.length >= messages) break;
    records.push({
      role: "assistant",
      content: prose(1200, seed + turn + 1),
      reasoning_content: prose(900, seed + turn + 2),
      tool_calls: [toolCall(turn)],
      ts: ts + 1,
    });
    if (records.length >= messages) break;
    records.push({
      role: "tool",
      tool_call_id: `call-${turn}`,
      content: prose(6000, seed + turn + 3),
      ts: ts + 2,
    });
  }
  return records;
}

/** The `$session_loaded` projection of those records. Mirrors
 *  `buildLoadedMessages` (src/cli/commands/desktop.ts): turn N is the Nth user
 *  record, and a tool result lands on the call that produced it. */
export function wireSession(messages: number, seed = 0): LoadedMessage[] {
  const out: LoadedMessage[] = [];
  let turn = 0;
  let pendingAssistant = -1;
  for (const rec of sessionRecords(messages, seed)) {
    if (rec.role === "user") {
      turn += 1;
      pendingAssistant = -1;
      out.push({ kind: "user", text: String(rec.content ?? ""), ts: rec.ts });
      continue;
    }
    if (rec.role === "assistant") {
      const segments: LoadedSegment[] = [];
      if (rec.reasoning_content) segments.push({ kind: "reasoning", text: rec.reasoning_content });
      if (typeof rec.content === "string" && rec.content) {
        segments.push({ kind: "text", text: rec.content });
      }
      for (const call of rec.tool_calls ?? []) {
        segments.push({
          kind: "tool",
          callId: call.id ?? `call-${turn}`,
          name: call.function.name,
          args: call.function.arguments,
        });
      }
      out.push({ kind: "assistant", turn, segments, pending: false, ts: rec.ts });
      pendingAssistant = out.length - 1;
      continue;
    }
    const host = pendingAssistant >= 0 ? out[pendingAssistant] : undefined;
    if (!host || host.kind !== "assistant") continue;
    const segment = host.segments.find((s) => s.kind === "tool" && s.callId === rec.tool_call_id);
    if (segment && segment.kind === "tool") {
      segment.result = String(rec.content ?? "");
      segment.ok = true;
    }
  }
  return out;
}

/** The wire projection sized in wire messages, not raw records: one turn is
 *  three records (prompt, answer, tool result) and two wire messages. */
export function wireSessionOfSize(wireMessages: number, seed = 0): LoadedMessage[] {
  const raw = Math.ceil((wireMessages * 3) / 2);
  return wireSession(raw, seed).slice(0, wireMessages);
}

/** Streams a whole store one session at a time. Never materializes the store:
 *  10 x 100 x 2000 messages is ~4 GB of transcripts if held at once. */
export function* scaleStore(spec: ScaleSpec = SCALE_WORST_CASE): Generator<ScaleSession> {
  let minted = 0;
  for (let w = 0; w < spec.workspaces; w++) {
    const workspace = `C:\\perf\\workspace-${w}`;
    for (let s = 0; s < spec.sessionsPerWorkspace; s++) {
      minted += 1;
      const name = `desktop-${String(minted).padStart(4, "0")}-${w}-${s}`;
      yield {
        workspace,
        name,
        meta: {
          workspace,
          createdAt: 1_700_000_000_000 + minted,
          updatedAt: 1_700_000_000_000 + minted * 1_000,
          summary: `session ${minted}`,
        },
        records: sessionRecords(spec.messagesPerSession, minted),
      };
    }
  }
}

/** Writes a store in the daemon's on-disk layout:
 *  `<root>/<session>/messages.jsonl` plus `meta.json`. Returns the session count
 *  and the bytes written, which is the cold-scan cost of that store. */
export function writeScaleStore(
  root: string,
  spec: ScaleSpec = SCALE_WORST_CASE,
): { sessions: number; bytes: number } {
  let sessions = 0;
  let bytes = 0;
  mkdirSync(root, { recursive: true });
  for (const session of scaleStore(spec)) {
    const dir = join(root, session.name);
    mkdirSync(dir, { recursive: true });
    const body = `${session.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    writeFileSync(join(dir, "messages.jsonl"), body, "utf8");
    writeFileSync(join(dir, "meta.json"), JSON.stringify(session.meta), "utf8");
    sessions += 1;
    bytes += body.length;
  }
  return { sessions, bytes };
}
