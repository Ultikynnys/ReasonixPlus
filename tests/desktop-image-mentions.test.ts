import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractImageMentions, resolveUserImages } from "../src/cli/commands/desktop.js";

describe("extractImageMentions — auto-parse @image mentions (OpenAI models)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-img-mentions-"));
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "shot.png"), "png-bytes");
    writeFileSync(join(root, "notes.md"), "# notes");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("saves clipboard image attachments to a workspace path for model tools", async () => {
    const png = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer("image/png");
    const images = await resolveUserImages(
      [{ source: "clipboard", dataUrl: `data:image/png;base64,${png.toString("base64")}` }],
      root,
    );
    expect(images).toHaveLength(1);
    expect(images[0]!.path).toBeDefined();
    expect(images[0]!.path!.startsWith(join(root, ".reasonix", "attachments"))).toBe(true);
    expect(readFileSync(images[0]!.path!)).toEqual(
      Buffer.from(images[0]!.url.slice(images[0]!.url.indexOf(",") + 1), "base64"),
    );
  });

  it("converts an existing image mention into a file attachment and strips the token", async () => {
    const r = await extractImageMentions("what does @assets/shot.png show", root);
    expect(r.text).toBe("what does  show");
    expect(r.attachments).toEqual([{ source: "file", path: join(root, "assets", "shot.png") }]);
  });

  it("leaves non-image and missing mentions in the text untouched", async () => {
    const r = await extractImageMentions("see @notes.md and @assets/missing.png", root);
    expect(r.text).toBe("see @notes.md and @assets/missing.png");
    expect(r.attachments).toEqual([]);
  });

  it("does not attach unsupported formats (gif/svg)", async () => {
    writeFileSync(join(root, "anim.gif"), "gif-bytes");
    const r = await extractImageMentions("play @anim.gif", root);
    expect(r.text).toBe("play @anim.gif");
    expect(r.attachments).toEqual([]);
  });

  it("deduplicates repeated mentions of the same image", async () => {
    const r = await extractImageMentions("@assets/shot.png and @assets/shot.png", root);
    expect(r.attachments).toHaveLength(1);
  });

  it("strips a trailing sentence-terminator dot before matching", async () => {
    const r = await extractImageMentions("look at @assets/shot.png.", root);
    expect(r.attachments).toHaveLength(1);
  });
});
