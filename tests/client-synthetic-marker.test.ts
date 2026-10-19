import { describe, expect, it } from "vitest";
import { stripTranscriptMarkers } from "../src/client.js";
import { makeFakeClient } from "./support/fake-client.js";

describe("synthetic user-record marker", () => {
  it("strips the marker at the wire boundary and keeps message content", async () => {
    const { client, captured } = makeFakeClient([{ content: "ok" }]);
    await client.chat({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "mid-turn steer", synthetic: true },
        { role: "user", content: "real prompt" },
      ],
    });
    expect(captured).toHaveLength(1);
    for (const message of captured[0]!.messages) {
      expect("synthetic" in message).toBe(false);
    }
    expect(captured[0]!.messages.map((m) => m.content)).toEqual(["mid-turn steer", "real prompt"]);
  });

  it("strips the transcript stamp at the wire boundary", async () => {
    const { client, captured } = makeFakeClient([{ content: "ok" }]);
    await client.chat({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "when was this asked", ts: 1_700_000_000_000 },
        { role: "assistant", content: "just now", ts: 1_700_000_001_000 },
      ],
    });
    expect(captured).toHaveLength(1);
    for (const message of captured[0]!.messages) {
      expect("ts" in message).toBe(false);
    }
    expect(captured[0]!.messages.map((m) => m.content)).toEqual([
      "when was this asked",
      "just now",
    ]);
  });

  it("leaves marker-free messages untouched (fast path)", () => {
    const messages = [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
    ];
    const out = stripTranscriptMarkers(messages);
    expect(out).toEqual(messages);
    expect(out).not.toBe(messages);
  });

  it("strips the marker while preserving other message fields", () => {
    const out = stripTranscriptMarkers([
      { role: "user", content: "nudge", name: "nudge-name", synthetic: true },
    ]);
    expect(out).toEqual([{ role: "user", content: "nudge", name: "nudge-name" }]);
  });
});
