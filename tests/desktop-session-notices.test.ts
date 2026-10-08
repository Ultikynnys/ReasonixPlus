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

  it("rebases a card whose absolute turn exceeds the reconstructed user count", () => {
    // Live turns are absolute kernel ordinals; after a fold the transcript is
    // renumbered from 1, so turn 5 lands on the 2nd (last) surviving user.
    const notices: PersistedNotice[] = [
      { id: "n5", kind: "notice", text: "recent", severity: "success", turn: 5 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices, 5);
    expect(out.map((m) => (m.kind === "notice" ? m.text : m.kind))).toEqual([
      "user",
      "assistant",
      "user",
      "recent",
      "assistant",
    ]);
    const placed = out.find((m) => m.kind === "notice");
    expect(placed && placed.kind === "notice" ? placed.turn : undefined).toBe(2);
  });

  it("drops a card for a turn that was folded away (rebased to <= 0)", () => {
    const notices: PersistedNotice[] = [
      { id: "n3", kind: "notice", text: "gone", severity: "info", turn: 3 },
      { id: "n5", kind: "notice", text: "kept", severity: "info", turn: 5 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices, 5);
    const texts = out
      .filter((m) => m.kind === "notice")
      .map((m) => (m.kind === "notice" ? m.text : ""));
    expect(texts).toEqual(["kept"]);
  });

  it("does not rebase when the transcript already numbers every turn", () => {
    const notices: PersistedNotice[] = [
      { id: "n2", kind: "notice", text: "in-range", severity: "info", turn: 2 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices, 2);
    expect(out.at(-2)).toMatchObject({ kind: "notice", text: "in-range", turn: 2 });
  });

  it("drops an exact duplicate card for the same turn", () => {
    const notices: PersistedNotice[] = [
      { id: "a", kind: "notice", text: "Task complete", severity: "success", turn: 2 },
      { id: "b", kind: "notice", text: "Task complete", severity: "success", turn: 2 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices, 2);
    const dupes = out.filter((m) => m.kind === "notice" && m.text === "Task complete");
    expect(dupes).toHaveLength(1);
  });

  it("rebases a warning's absolute turn onto its reconstructed assistant card", () => {
    const notices: PersistedNotice[] = [
      { id: "w5", kind: "warning", text: "degeneration", severity: "high", turn: 5 },
    ];
    const out = mergeNoticesIntoLoaded(base, notices, 5);
    expect(out).toHaveLength(base.length);
    const assistant = out[3];
    expect(assistant?.kind === "assistant" ? assistant.segments.at(-1) : undefined).toMatchObject({
      kind: "warning",
      id: "w5",
    });
  });
});
