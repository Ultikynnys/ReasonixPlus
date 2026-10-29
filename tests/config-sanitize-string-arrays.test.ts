import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

describe("readConfig — string[] field sanitization", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-readconfig-"));
    path = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops object / null / number items from mcp[]", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcp: [
          "fs=npx -y @modelcontextprotocol/server-filesystem /tmp",
          { name: "github", command: "npx", args: ["-y"] },
          null,
          42,
          "local=https://127.0.0.1:9000/sse",
        ],
      }),
    );
    const cfg = readConfig(path);
    expect(cfg.mcp).toEqual([
      "fs=npx -y @modelcontextprotocol/server-filesystem /tmp",
      "local=https://127.0.0.1:9000/sse",
    ]);
  });

  it("drops mcp field entirely when it's not an array", () => {
    writeFileSync(path, JSON.stringify({ mcp: "fs=npx -y pkg" }));
    const cfg = readConfig(path);
    expect(cfg.mcp).toBeUndefined();
  });

  it("sanitizes mcpDisabled[] the same way", () => {
    writeFileSync(path, JSON.stringify({ mcpDisabled: ["fs", { x: 1 }, "remote"] }));
    const cfg = readConfig(path);
    expect(cfg.mcpDisabled).toEqual(["fs", "remote"]);
  });

  it("sanitizes pluginsDisabled[] the same way", () => {
    writeFileSync(path, JSON.stringify({ pluginsDisabled: ["notfair", null, 3, "skills-pack"] }));
    const cfg = readConfig(path);
    expect(cfg.pluginsDisabled).toEqual(["notfair", "skills-pack"]);
  });

  it("sanitizes recentWorkspaces[]", () => {
    writeFileSync(path, JSON.stringify({ recentWorkspaces: ["/a", 7, "/b"] }));
    const cfg = readConfig(path);
    expect(cfg.recentWorkspaces).toEqual(["/a", "/b"]);
  });

  it("leaves all-string arrays untouched", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcp: ["a=b", "c=d"],
        mcpDisabled: ["a"],
        recentWorkspaces: ["/a"],
      }),
    );
    const cfg = readConfig(path);
    expect(cfg.mcp).toEqual(["a=b", "c=d"]);
    expect(cfg.mcpDisabled).toEqual(["a"]);
    expect(cfg.recentWorkspaces).toEqual(["/a"]);
  });

  it("returns empty config when top-level is not an object", () => {
    writeFileSync(path, JSON.stringify(["not", "an", "object"]));
    expect(readConfig(path)).toEqual({});
  });
});
