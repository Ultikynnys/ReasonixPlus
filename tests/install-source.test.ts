import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeInstallSource } from "../src/install/source.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "reasonix-install-source-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("normalizeInstallSource", () => {
  it("expands a GitHub shorthand to a clone URL", () => {
    expect(normalizeInstallSource("nowork-studio/notfair-plugin")).toEqual({
      kind: "git",
      url: "https://github.com/nowork-studio/notfair-plugin.git",
      label: "https://github.com/nowork-studio/notfair-plugin",
    });
  });

  it("keeps a git URL and trims the .git suffix from its label", () => {
    const source = normalizeInstallSource("https://github.com/acme/plugin.git");
    expect(source.kind).toBe("git");
    expect(source.label).toBe("https://github.com/acme/plugin");
  });

  it("resolves an existing directory to a local copy", () => {
    expect(normalizeInstallSource(work)).toEqual({ kind: "local", path: work, label: work });
  });

  it("refuses input that is neither", () => {
    expect(() => normalizeInstallSource("not a source")).toThrow(/not a git URL/);
  });

  it("says a file is not a directory instead of guessing a git URL", () => {
    const file = join(work, "not-a-source.txt");
    writeFileSync(file, "x", "utf8");
    expect(() => normalizeInstallSource(file)).toThrow(/not a directory/);
  });

  it("refuses an empty source", () => {
    expect(() => normalizeInstallSource("   ")).toThrow(/enter a git URL/);
  });
});
