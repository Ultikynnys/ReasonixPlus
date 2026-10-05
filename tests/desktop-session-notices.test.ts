import type { LoadedMessage, PersistedNotice } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import { mergeNoticesIntoLoaded } from "../src/cli/commands/desktop.js";

describe("mergeNoticesIntoLoaded — persisted annotation cards", () => {
  const base: LoadedMessage[] = [
    { kind: "user", text: "hi" },
    { kind: "assistant", turn: 1, segments: [{ kind: "text", text: "hello" }], pending: false },
    { kind: "user", text: "again" },
    { kind: "assistant", turn: 2, segments: [{ kind: "text", text: "world" }], pending: false },
  ];

  it("returns the transcript unchanged when there are no persisted cards", () => {
    expect(mergeNoticesIntoLoaded(base, [])).toBe(base);
  });

  it("slots a notice at the START of its turn's group, above that turn's reply", () => {
    const notices: PersistedNotice[] = [
      { id: "n1", kind: "notice", text: "Mode: AUTO", severity: "info", turn: 2 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices);
    expect(out.map((m) => m.kind)).toEqual(["user", "assistant", "user", "notice", "assistant"]);
    expect(out[3]).toMatchObject({ kind: "notice", id: "n1", text: "Mode: AUTO", turn: 2 });
  });

  it("keeps a turn's notices in append order, right after its user message", () => {
    const notices: PersistedNotice[] = [
      { id: "n1", kind: "notice", text: "one", severity: "info", turn: 1 },
      { id: "n2", kind: "notice", text: "two", severity: "warning", turn: 1 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices);
    expect(out.map((m) => (m.kind === "notice" ? m.text : m.kind))).toEqual([
      "user",
      "one",
      "two",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("drops a turn-0 notice at the very start of the transcript", () => {
    const notices: PersistedNotice[] = [
      { id: "n0", kind: "notice", text: "boot", severity: "info", turn: 0 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices);
    expect(out[0]).toMatchObject({ kind: "notice", id: "n0" });
  });

  it("re-attaches a warning segment to its turn's assistant card (no extra card)", () => {
    const notices: PersistedNotice[] = [
      { id: "w1", kind: "warning", text: "degeneration", severity: "high", turn: 1 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices);
    const assistant = out[1];
    expect(out).toHaveLength(base.length);
    expect(assistant?.kind === "assistant" ? assistant.segments.at(-1) : undefined).toMatchObject({
      kind: "warning",
      id: "w1",
      severity: "high",
    });
    // The caller's array is never mutated.
    expect(base[1]?.kind === "assistant" && base[1].segments).toHaveLength(1);
  });

  it("falls back to the tail when a notice's turn has no loaded home", () => {
    const notices: PersistedNotice[] = [
      { id: "n9", kind: "notice", text: "orphan", severity: "error", turn: 9 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices);
    expect(out.at(-1)).toMatchObject({ kind: "notice", id: "n9" });
  });
});
