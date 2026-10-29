/** Shared "read a text file, trim it, cap it with a truncation marker" logic — every memory/prefix assembly site used to re-implement this. */

import { readFileSync } from "node:fs";

export interface CappedText {
  /** Post-truncation content (may end with a "… (truncated N chars)" marker). */
  content: string;
  /** Length before truncation. */
  originalChars: number;
  /** True iff `originalChars > maxChars`. */
  truncated: boolean;
}

/** Cap `text` at `maxChars`, appending a marker line when it's longer. */
export function truncateWithMarker(text: string, maxChars: number): CappedText {
  const originalChars = text.length;
  const truncated = originalChars > maxChars;
  const content = truncated
    ? `${text.slice(0, maxChars)}\n… (truncated ${originalChars - maxChars} chars)`
    : text;
  return { content, originalChars, truncated };
}

/** Read + trim a UTF-8 text file, capped at `maxChars`. Null when missing, unreadable, or blank after trimming. */
export function readCappedTextFile(path: string, maxChars: number): CappedText | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return truncateWithMarker(trimmed, maxChars);
}

/** Capped read that keeps the file path alongside the content. */
export interface CappedPath extends CappedText {
  path: string;
}

/** Read a capped file, carrying its path; null when missing, unreadable, or blank. */
export function readCappedFile(path: string, maxChars: number): CappedPath | null {
  const capped = readCappedTextFile(path, maxChars);
  if (!capped) return null;
  return { path, ...capped };
}

/** Longest run of consecutive backticks in `text` — the fence must be longer than this. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/** A heading + intro + code fence with the two newlines that separate it from the block before.
 *  The fence is one backtick longer than the longest run inside `content`, so interpolated text
 *  can never close it early. Nothing is escaped or stripped, so the block stays byte-deterministic. */
export function memoryBlock(heading: string, intro: string, content: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `\n\n${[heading, "", intro, "", fence, content, fence].join("\n")}`;
}

/** Splice a memory block onto a prompt prefix: the block alone is the cost the splice adds. */
export function applyMemoryBlock(
  basePrompt: string,
  heading: string,
  intro: string,
  content: string,
): string {
  return `${basePrompt}${memoryBlock(heading, intro, content)}`;
}
