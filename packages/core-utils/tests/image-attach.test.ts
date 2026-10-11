import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_MEDIA_BYTES,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  imageMimeForExtension,
  isSupportedAudioVideoPath,
  isSupportedImagePath,
  mediaKindForPath,
  mediaMimeForExtension,
  scanImageMentions,
  stripMentionTokens,
} from "../src/image-attach.js";

describe("image-attach shared helpers", () => {
  it("accepts exactly the raster formats the daemon reads", () => {
    expect(SUPPORTED_IMAGE_EXTENSIONS).toEqual(["png", "jpg", "jpeg", "webp"]);
  });

  it("maps supported extensions to their MIME types, case-insensitively", () => {
    expect(imageMimeForExtension("png")).toBe("image/png");
    expect(imageMimeForExtension("JPG")).toBe("image/jpeg");
    expect(imageMimeForExtension("jpeg")).toBe("image/jpeg");
    expect(imageMimeForExtension("webp")).toBe("image/webp");
    expect(imageMimeForExtension("gif")).toBeUndefined();
    expect(imageMimeForExtension("svg")).toBeUndefined();
  });

  it("isSupportedImagePath matches by the final extension, case-insensitively", () => {
    expect(isSupportedImagePath("C:\\Users\\me\\Pictures\\shot.png")).toBe(true);
    expect(isSupportedImagePath("/workspace/assets/photo.JPEG")).toBe(true);
    expect(isSupportedImagePath("assets/webp/image.webp")).toBe(true);
    expect(isSupportedImagePath("assets/anim.gif")).toBe(false);
    expect(isSupportedImagePath("assets/logo.svg")).toBe(false);
    expect(isSupportedImagePath("notes.md")).toBe(false);
    expect(isSupportedImagePath("no-extension")).toBe(false);
    expect(isSupportedImagePath("")).toBe(false);
  });

  it("caps a single attachment at 15 MB", () => {
    expect(MAX_IMAGE_BYTES).toBe(15 * 1024 * 1024);
  });
});

describe("scanImageMentions", () => {
  const id = (p: string) => p;

  it("finds @path mentions of supported images in document order", () => {
    const text = "look at @shots/chart.png and then @shots/logo.webp for scale";
    expect(scanImageMentions(text, id)).toEqual([
      { token: "@shots/chart.png", path: "shots/chart.png", index: 8 },
      { token: "@shots/logo.webp", path: "shots/logo.webp", index: 34 },
    ]);
  });

  it("skips non-image and missing-mention tokens", () => {
    const text = "@notes.md and @shots/anim.gif stay, but @a.png goes";
    expect(scanImageMentions(text, id)).toEqual([{ token: "@a.png", path: "a.png", index: 40 }]);
  });

  it("applies the resolver before dedupe", () => {
    const abs = (p: string) => `/ws/${p}`;
    const text = "@shots/a.png @shots/a.png";
    expect(scanImageMentions(text, abs)).toEqual([
      { token: "@shots/a.png", path: "/ws/shots/a.png", index: 0 },
    ]);
  });

  it("strips trailing sentence-terminator dots", () => {
    expect(scanImageMentions("see @a.png.", id)).toEqual([
      { token: "@a.png.", path: "a.png", index: 4 },
    ]);
  });

  it("rejects @ embedded in emails or social handles", () => {
    expect(scanImageMentions("mail me@a.png.com", id)).toEqual([]);
  });

  it("matches Windows drive-letter paths", () => {
    expect(scanImageMentions("explain @C:\\shots\\chart.png now", id)).toEqual([
      { token: "@C:\\shots\\chart.png", path: "C:\\shots\\chart.png", index: 8 },
    ]);
  });
});

describe("stripMentionTokens", () => {
  it("removes tokens at the given indices, high-to-low safe", () => {
    const text = "see @a.png then @b.webp";
    expect(
      stripMentionTokens(text, [
        { token: "@b.webp", index: 16 },
        { token: "@a.png", index: 4 },
      ]),
    ).toBe("see  then ");
  });

  it("returns the text unchanged for an empty list", () => {
    expect(stripMentionTokens("hello", [])).toBe("hello");
  });
});

describe("audio/video media helpers", () => {
  it("classifies supported audio/video extensions into a kind", () => {
    expect(mediaKindForPath("clip.mp3")).toBe("audio");
    expect(mediaKindForPath("C:\\a\\b.WAV")).toBe("audio");
    expect(mediaKindForPath("movie.MP4")).toBe("video");
    expect(mediaKindForPath("clip.mov")).toBe("video");
    expect(mediaKindForPath("notes.md")).toBeUndefined();
    expect(mediaKindForPath("photo.png")).toBeUndefined();
    expect(mediaKindForPath("")).toBeUndefined();
  });

  it("isSupportedAudioVideoPath is true only for media extensions", () => {
    expect(isSupportedAudioVideoPath("a.flac")).toBe(true);
    expect(isSupportedAudioVideoPath("a.avi")).toBe(true);
    expect(isSupportedAudioVideoPath("a.png")).toBe(false);
  });

  it("maps media extensions to their MIME types", () => {
    expect(mediaMimeForExtension("mp3")).toBe("audio/mpeg");
    expect(mediaMimeForExtension("M4A")).toBe("audio/mp4");
    expect(mediaMimeForExtension("mp4")).toBe("video/mp4");
    expect(mediaMimeForExtension("wmv")).toBe("video/x-ms-wmv");
    expect(mediaMimeForExtension("png")).toBeUndefined();
  });

  it("declares the MiMo accept-lists and a 50 MB cap", () => {
    expect(SUPPORTED_AUDIO_EXTENSIONS).toEqual(["mp3", "wav", "flac", "m4a", "ogg"]);
    expect(SUPPORTED_VIDEO_EXTENSIONS).toEqual(["mp4", "mov", "avi", "wmv"]);
    expect(MAX_MEDIA_BYTES).toBe(50 * 1024 * 1024);
  });
});
