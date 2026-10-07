/** Payload-too-large heal: detection regex + in-place log image shrink. */

import { describe, expect, it } from "vitest";
import { isPayloadTooLargeError, shrinkImagePartsForRetry } from "../src/loop/image-retry.js";
import type { ChatMessage } from "../src/types.js";

function imgPart(n: number) {
  // 1x1 PNG, uniquely padded per index so replacement is observable.
  const pngBase =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  return {
    type: "image_url" as const,
    image_url: { url: `data:image/png;base64,${n}${pngBase.slice(1)}`, detail: "low" as const },
  };
}

function textPart(text: string) {
  return { type: "text" as const, text };
}

describe("isPayloadTooLargeError", () => {
  it("matches Ollama's daemon body-too-large text", () => {
    expect(
      isPayloadTooLargeError(new Error('Ollama 400: {"error":"http: request body too large"}')),
    ).toBe(true);
  });

  it("matches generic payload/entity phrasing", () => {
    expect(isPayloadTooLargeError(new Error("Upstream 413: Payload Too Large"))).toBe(true);
    expect(isPayloadTooLargeError(new Error("Upstream 413: Request Entity Too Large"))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isPayloadTooLargeError(new Error("Ollama 400: model not found"))).toBe(false);
    expect(isPayloadTooLargeError(new Error("fetch failed"))).toBe(false);
    expect(isPayloadTooLargeError("not an error instance")).toBe(false);
  });
});

describe("shrinkImagePartsForRetry", () => {
  it("replaces undecodable image parts at level 1 without dropping any", async () => {
    const msg: ChatMessage = {
      role: "user",
      content: [textPart("look"), imgPart(1), imgPart(2)],
    };
    const res = await shrinkImagePartsForRetry([msg], 1);
    expect(res.dropped).toBe(0);
    expect(res.changed).toBe(false);
  });

  it("level 2 keeps only the newest image and marks older ones dropped", async () => {
    const msg: ChatMessage = {
      role: "user",
      content: [imgPart(1), textPart("between"), imgPart(2), imgPart(3)],
    };
    const res = await shrinkImagePartsForRetry([msg], 2);
    expect(res.dropped).toBe(2);
    const content = msg.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(4);
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toMatch(/image removed/);
    expect(content[1]!.type).toBe("text");
    expect(content[2]!.type).toBe("text");
    expect(content[3]!.type).toBe("image_url");
  });

  it("leaves plain-string content untouched", async () => {
    const msg: ChatMessage = { role: "user", content: "just text" };
    const res = await shrinkImagePartsForRetry([msg], 2);
    expect(res.changed).toBe(false);
    expect(msg.content).toBe("just text");
  });
});
