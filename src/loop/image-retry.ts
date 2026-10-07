/** Heal provider "request body too large": shrink log images and retry. */

import { downscaleDataUrl } from "../image-format.js";
import type { ChatMessage, UserContentPart } from "../types.js";

/** Ollama's daemon rejects an oversized body with Go's http.MaxBytesError text
 *  regardless of HTTP status framing; some proxies answer 413 instead. */
const PAYLOAD_TOO_LARGE_RE =
  /request body too large|body size exceeds|payload too large|entity too large/i;

export function isPayloadTooLargeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return PAYLOAD_TOO_LARGE_RE.test(err.message ?? "");
}

/** Level 1: every image part is downscaled to a 1024 px longest side (JPEG).
 *  Level 2: only the newest image part survives, downscaled to 768 px —
 *  without dropping older images the payload may never fit at all. */
export type ShrinkLevel = 1 | 2;

const LEVEL_MAX_SIDE: Record<ShrinkLevel, number> = { 1: 1024, 2: 768 };

export interface ShrinkImagesResult {
  changed: boolean;
  shrunk: number;
  dropped: number;
}

/** Replace image_url parts in the message array with downscaled re-encodes, in
 *  place. At level 2 all but the newest image part become a placeholder text
 *  part. Messages whose content is a plain string are skipped. */
export async function shrinkImagePartsForRetry(
  messages: ChatMessage[],
  level: ShrinkLevel,
): Promise<ShrinkImagesResult> {
  const maxSide = LEVEL_MAX_SIDE[level];
  const keepOnlyLast = level >= 2;
  let shrunk = 0;
  let dropped = 0;

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    const indexes: number[] = [];
    for (let i = 0; i < msg.content.length; i++) {
      if (msg.content[i]!.type === "image_url") indexes.push(i);
    }
    if (indexes.length === 0) continue;

    const dropSet = new Set(keepOnlyLast ? indexes.slice(0, -1) : []);
    dropped += dropSet.size;

    const next: UserContentPart[] = [];
    for (let i = 0; i < msg.content.length; i++) {
      const part = msg.content[i]!;
      if (part.type !== "image_url") {
        next.push(part);
        continue;
      }
      if (dropSet.has(i)) {
        next.push({ type: "text", text: "[image removed: request payload too large]" });
        continue;
      }
      const shrunkUrl = await downscaleDataUrl(part.image_url.url, maxSide);
      if (shrunkUrl) {
        next.push({ type: "image_url", image_url: { url: shrunkUrl, detail: "low" } });
        shrunk++;
      } else {
        next.push(part);
      }
    }
    msg.content = next;
  }
  return { changed: shrunk > 0 || dropped > 0, shrunk, dropped };
}
