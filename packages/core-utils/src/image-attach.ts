/** Canonical image-attachment formats — single source of truth shared by the
 *  daemon accept-list and the frontend path / dialog filters. */

/** Raster image formats OpenAI vision accepts and the daemon will read for
 *  file-based attachments. */
export const SUPPORTED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

const IMAGE_EXT_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** MIME type for a supported image extension (case-insensitive), or undefined. */
export function imageMimeForExtension(ext: string): string | undefined {
  return IMAGE_EXT_MIME[ext.toLowerCase()];
}

/** True for paths ending in a supported raster extension (case-insensitive). */
export function isSupportedImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot <= 0 || dot === path.length - 1) return false;
  return imageMimeForExtension(path.slice(dot + 1)) !== undefined;
}

/** Largest single image the daemon will read for an attachment — keeps the
 *  session JSONL and the API request bounded (OpenAI's hard cap is ~20 MB). */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Word-boundary anchor rejects `@` embedded in emails / social handles;
 *  trailing `.` is stripped before lookup. `:` covers Windows drive-letter
 *  paths (`@C:\shots\a.png`). Lives here so the daemon's extractImageMentions
 *  and the frontend's optimistic echo scan identically. */
export const AT_MENTION_PATTERN = /(?<=^|\s)@([\p{L}\p{N}_./\\:-]+)/gu;

/** Strip sentence-ending dots from an @path capture without a regex backtracking loop. */
export function stripTrailingMentionDots(path: string): string {
  let cleaned = path;
  while (cleaned.endsWith(".")) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

/** One `@path` mention that resolved to a supported image. */
export interface ImageMention {
  /** The raw `@path` token as it appeared in the text. */
  token: string;
  /** Path resolved by the caller's resolver (absolute). */
  path: string;
  /** Character offset where the token starts. */
  index: number;
}

/** Scan text for `@path` mentions of supported images. Pure — no fs access;
 *  the caller supplies the path resolver and decides existence separately.
 *  Dedupes by resolved path and preserves document order. */
export function scanImageMentions(text: string, resolve: (path: string) => string): ImageMention[] {
  const out: ImageMention[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(AT_MENTION_PATTERN)) {
    const cleaned = stripTrailingMentionDots(m[1]!);
    if (!cleaned || !isSupportedImagePath(cleaned)) continue;
    const path = resolve(cleaned);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ token: m[0], path, index: m.index! });
  }
  return out;
}

/** Remove mention tokens from text at the given indices. Safe for any input
 *  order — strips high-to-low so earlier offsets stay valid. */
export function stripMentionTokens(
  text: string,
  mentions: ReadonlyArray<{ token: string; index: number }>,
): string {
  let out = text;
  for (const m of [...mentions].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, m.index) + out.slice(m.index + m.token.length);
  }
  return out;
}

/** Audio formats Xiaomi MiMo accepts as data-URL input. */
export const SUPPORTED_AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "m4a", "ogg"] as const;

/** Video formats Xiaomi MiMo accepts as data-URL input. */
export const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "wmv"] as const;

const AUDIO_EXT_MIME: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

const VIDEO_EXT_MIME: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
};

export type MediaKind = "audio" | "video";

/** "audio" | "video" for a supported media extension, else undefined. */
export function mediaKindForPath(path: string): MediaKind | undefined {
  const dot = path.lastIndexOf(".");
  if (dot <= 0 || dot === path.length - 1) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  if (AUDIO_EXT_MIME[ext]) return "audio";
  if (VIDEO_EXT_MIME[ext]) return "video";
  return undefined;
}

/** True for paths ending in a supported audio/video extension (case-insensitive). */
export function isSupportedAudioVideoPath(path: string): boolean {
  return mediaKindForPath(path) !== undefined;
}

/** MIME type for a supported audio/video extension (case-insensitive), or undefined. */
export function mediaMimeForExtension(ext: string): string | undefined {
  const e = ext.toLowerCase();
  return AUDIO_EXT_MIME[e] ?? VIDEO_EXT_MIME[e];
}

/** Largest single audio/video the daemon reads for an attachment — MiMo caps
 *  base64 (data-URL) input at 50 MB. */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
