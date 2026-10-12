/** Payload-too-large heal: detection regex + in-place log image shrink,
 *  plus the send-time image retention window. */

import { describe, expect, it } from "vitest";
import {
  KEEP_LAST_IMAGES,
  isPayloadTooLargeError,
  pruneOldImageParts,
  shrinkImagePartsForRetry,
} from "../src/loop/image-retry.js";
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

  it("matches the Anthropic-style image count cap relayed by OpenCode", () => {
    expect(
      isPayloadTooLargeError(
        new Error(
          "Upstream request failed: [invalid_request_error] Too many images in request: 67 > 64. Check parameters and tool schema.",
        ),
      ),
    ).toBe(true);
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

  it("level 2 keeps the globally newest image across messages, not one per message", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [imgPart(1), textPart("a")] },
      { role: "assistant", content: "b" },
      { role: "user", content: [textPart("c"), imgPart(2), imgPart(3)] },
    ];
    const res = await shrinkImagePartsForRetry(messages, 2);
    expect(res.dropped).toBe(2);
    // The survivor's data URL here is not decodable, so downscale leaves it
    // untouched — assert it stays an image part rather than counting shrinks.
    expect(res.shrunk).toBe(0);
    const first = messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(first[0]!.type).toBe("text");
    expect(first[0]!.text).toMatch(/image removed/);
    expect(first[1]!.type).toBe("text");
    const last = messages[2]!.content as Array<{ type: string; text?: string }>;
    expect(last[1]!.type).toBe("text");
    expect(last[1]!.text).toMatch(/image removed/);
    expect(last[2]!.type).toBe("image_url");
  });
});

describe("pruneOldImageParts (send-time retention window)", () => {
  function msgWithImages(role: ChatMessage["role"], ...urls: string[]): ChatMessage {
    return {
      role,
      content: urls.map((url) => ({
        type: "image_url" as const,
        image_url: { url, detail: "low" as const },
      })),
    };
  }

  it("keeps only the newest KEEP_LAST_IMAGES image parts across messages", () => {
    const messages: ChatMessage[] = [
      msgWithImages("user", "img-1", "img-2"),
      { role: "assistant", content: "hi" },
      msgWithImages("user", "img-3", "img-4", "img-5"),
      msgWithImages("user", "img-6"),
    ];
    const pruned = pruneOldImageParts(messages, KEEP_LAST_IMAGES);
    const sent = pruned
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === "image_url");
    expect(sent).toHaveLength(4);
    expect(sent.map((p) => (p as { image_url: { url: string } }).image_url.url)).toEqual([
      "img-3",
      "img-4",
      "img-5",
      "img-6",
    ]);
  });

  it("replaces pruned parts with a text note, preserving surrounding parts", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          textPart("before"),
          imgPart(1),
          textPart("middle"),
          imgPart(2),
          textPart("after"),
        ],
      },
    ];
    const pruned = pruneOldImageParts(messages, 1);
    const content = pruned[0]!.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(5);
    expect(content[0]!.text).toBe("before");
    expect(content[1]!.type).toBe("text");
    expect(content[1]!.text).toMatch(/image pruned/);
    expect(content[3]!.type).toBe("image_url");
    expect(content[4]!.text).toBe("after");
  });

  it("does not mutate the input messages", () => {
    const messages: ChatMessage[] = [msgWithImages("user", "img-1", "img-2", "img-3")];
    const snapshot = JSON.stringify(messages);
    pruneOldImageParts(messages, 1);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("returns the input unchanged when under the window or keep <= 0", () => {
    const under = [msgWithImages("user", "img-1", "img-2")];
    const underPruned = pruneOldImageParts(under, 4);
    expect(underPruned).toBe(under);

    const over = [msgWithImages("user", "img-1", "img-2")];
    const disabled = pruneOldImageParts(over, 0);
    expect(disabled).not.toBe(over);
    expect(disabled[0]!.content).toEqual(over[0]!.content);
  });

  it("defaults the window to KEEP_LAST_IMAGES when no keep is passed", () => {
    const messages = [msgWithImages("user", ...Array.from({ length: 6 }, (_, i) => `img-${i}`))];
    const sent = pruneOldImageParts(messages)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === "image_url");
    expect(sent).toHaveLength(KEEP_LAST_IMAGES);
  });

  it("reduces an image-only message to a single placeholder, still a valid user message", () => {
    const messages: ChatMessage[] = [
      msgWithImages("user", "img-1"),
      msgWithImages("user", "img-2"),
      msgWithImages("user", "img-3"),
    ];
    const pruned = pruneOldImageParts(messages, 1);
    const first = pruned[0]!.content as Array<{ type: string; text?: string }>;
    expect(first).toHaveLength(1);
    expect(first[0]!.type).toBe("text");
    expect(first[0]!.text).toMatch(/image pruned/);
    // The newest image survives untouched, in its own message.
    const last = pruned[2]!.content as Array<{ type: string }>;
    expect(last[0]!.type).toBe("image_url");
  });

  it("returns the identical array when there are no image parts at all", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: [textPart("text only")] },
    ];
    expect(pruneOldImageParts(messages)).toBe(messages);
  });

  it("leaves non-image media parts (MiMo audio/video) untouched", () => {
    const messages: ChatMessage[] = [
      msgWithImages("user", "img-1"),
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: "data:audio/wav;base64,AAAA" } },
          { type: "video_url", video_url: { url: "data:video/mp4;base64,BBBB" } },
        ],
      },
      msgWithImages("user", "img-2"),
    ];
    const pruned = pruneOldImageParts(messages, 1);
    const media = pruned[1]!.content as Array<{ type: string }>;
    expect(media.map((p) => p.type)).toEqual(["input_audio", "video_url"]);
  });
});
