/** Heal provider "request body too large" / image-count-cap rejections and
 *  enforce a send-time image retention window. */

import { downscaleDataUrl } from "../image-format.js";
import type { ChatMessage, UserContentPart } from "../types.js";

/** Ollama's daemon rejects an oversized body with Go's http.MaxBytesError text;
 *  some proxies answer 413. "Too many images in request: 67 > 64" (an
 *  Anthropic-style per-request count cap relayed by OpenCode) is also healable. */
const PAYLOAD_TOO_LARGE_RE =
  /request body too large|body size exceeds|payload too large|entity too large|too many images/i;

/** Image retention window for outgoing requests: only the newest N image_url
 *  parts are sent, older ones become placeholder text. Screenshots accumulate
 *  fast, and providers reject requests above a per-request image count. */
export const KEEP_LAST_IMAGES = 4;

export function isPayloadTooLargeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return PAYLOAD_TOO_LARGE_RE.test(err.message ?? "");
}

/** Level 1: every image part is downscaled to a 1024 px longest side (JPEG).
 *  Level 2: only the globally newest image part survives, downscaled to
 *  768 px — without dropping older images the payload may never fit at all. */
export type ShrinkLevel = 1 | 2;

const LEVEL_MAX_SIDE: Record<ShrinkLevel, number> = { 1: 1024, 2: 768 };

export interface ShrinkImagesResult {
  changed: boolean;
  shrunk: number;
  dropped: number;
}

/** Key for one image part's position, stable across the drop and rewrite passes. */
function positionKey(messageIndex: number, partIndex: number): string {
  return `${messageIndex}:${partIndex}`;
}

/** Positions of every image_url part, in conversation order. Plain-string
 *  content never carries image parts and is skipped. */
function collectImagePartPositions(messages: readonly ChatMessage[]): Array<{
  messageIndex: number;
  partIndex: number;
}> {
  const positions: Array<{ messageIndex: number; partIndex: number }> = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const content = messages[mi]!.content;
    if (!Array.isArray(content)) continue;
    for (let pi = 0; pi < content.length; pi++) {
      if (content[pi]!.type === "image_url") positions.push({ messageIndex: mi, partIndex: pi });
    }
  }
  return positions;
}

/** Keys of the image parts to drop so only the newest `keepNewest` survive. */
function dropKeysFor(messages: readonly ChatMessage[], keepNewest: number): Set<string> {
  const positions = collectImagePartPositions(messages);
  const cutoff = positions.length - keepNewest;
  if (cutoff <= 0) return new Set();
  return new Set(positions.slice(0, cutoff).map((p) => positionKey(p.messageIndex, p.partIndex)));
}

/** Replace image_url parts at `dropKeys` with `note`. Copy-on-write by default
 *  (untouched messages keep their identity, stable prompt-cache prefix);
 *  `inPlace` mutates content arrays for the log-shrink heal that rewrites the log. */
function withImagePartsDropped(
  messages: ChatMessage[],
  dropKeys: ReadonlySet<string>,
  note: string,
  inPlace = false,
): { messages: ChatMessage[]; dropped: number } {
  if (dropKeys.size === 0) return { messages, dropped: 0 };
  let dropped = 0;
  const out = messages.map((msg, mi) => {
    if (!Array.isArray(msg.content)) return msg;
    let changed = false;
    const next = msg.content.map((part, pi) => {
      if (part.type === "image_url" && dropKeys.has(positionKey(mi, pi))) {
        dropped++;
        changed = true;
        return { type: "text", text: note } as UserContentPart;
      }
      return part;
    });
    if (!changed) return msg;
    if (inPlace) {
      msg.content = next;
      return msg;
    }
    return { ...msg, content: next };
  });
  return { messages: inPlace ? messages : out, dropped };
}

/** Downscale every surviving image_url part in place; returns the count shrunk. */
async function downscaleImagePartsInPlace(
  messages: ChatMessage[],
  maxSide: number,
): Promise<number> {
  let shrunk = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    if (!msg.content.some((p) => p.type === "image_url")) continue;
    const next: UserContentPart[] = [];
    let changed = false;
    for (const part of msg.content) {
      if (part.type !== "image_url") {
        next.push(part);
        continue;
      }
      const url = await downscaleDataUrl(part.image_url.url, maxSide);
      if (url) {
        next.push({ type: "image_url", image_url: { url, detail: "low" } });
        shrunk++;
        changed = true;
      } else {
        next.push(part);
      }
    }
    if (changed) msg.content = next;
  }
  return shrunk;
}

const SHRINK_DROP_NOTE = "[image removed: request payload too large]";
const PRUNED_IMAGE_NOTE = "[image pruned to stay within the provider's image limit]";

/** Replace image_url parts with downscaled re-encodes, in place (the log-shrink
 *  heal relies on the mutation). At level 2 all but the globally newest image
 *  part become a placeholder text part. String-content messages are skipped. */
export async function shrinkImagePartsForRetry(
  messages: ChatMessage[],
  level: ShrinkLevel,
): Promise<ShrinkImagesResult> {
  const dropKeys = level >= 2 ? dropKeysFor(messages, 1) : new Set<string>();
  const { dropped } = withImagePartsDropped(messages, dropKeys, SHRINK_DROP_NOTE, true);
  const shrunk = await downscaleImagePartsInPlace(messages, LEVEL_MAX_SIDE[level]);
  return { changed: shrunk > 0 || dropped > 0, shrunk, dropped };
}

/** Send-time retention: returns a COPY where only the newest `keep` image_url
 *  parts survive, older ones become a placeholder text part. The on-disk log is
 *  untouched; `keep <= 0` disables the window. */
export function pruneOldImageParts(
  messages: ChatMessage[],
  keep: number = KEEP_LAST_IMAGES,
): ChatMessage[] {
  if (keep <= 0) return [...messages];
  return withImagePartsDropped(messages, dropKeysFor(messages, keep), PRUNED_IMAGE_NOTE).messages;
}
