import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BARK_RUNTIME,
  voiceRuntimeDirName,
  voiceRuntimeSpecId,
} from "../desktop/src/voice/runtimes/index.js";

const ROOT = process.cwd();
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;

interface BundleConfig {
  bundle?: { resources?: Record<string, string> };
}

const tauriConfig = readJson("desktop/src-tauri/tauri.conf.json") as BundleConfig;
const windowsConfig = readJson("desktop/src-tauri/tauri.windows.conf.json") as BundleConfig;
const desktopPackage = readJson("desktop/package.json") as {
  version: string;
  dependencies?: Record<string, string>;
};

const RUNTIME_TERMS = /python|torch|constriction|\buv\b/;

describe("voice runtime isolation", () => {
  it("never lists a runtime artifact as an installer resource", () => {
    const resources = {
      ...(tauriConfig.bundle?.resources ?? {}),
      ...(windowsConfig.bundle?.resources ?? {}),
    };
    const entries = Object.entries(resources).map(([from, to]) => `${from}->${to}`);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.toLowerCase()).not.toMatch(RUNTIME_TERMS);
    }
  });

  it("keeps the runtime out of the app dependency list", () => {
    const dependencies = Object.keys(desktopPackage.dependencies ?? {});
    expect(dependencies.length).toBeGreaterThan(0);
    for (const dependency of dependencies) {
      expect(dependency.toLowerCase()).not.toMatch(RUNTIME_TERMS);
    }
  });

  it("never fetches a runtime in a bundle script", () => {
    const scripts = readdirSync(join(ROOT, "desktop/scripts")).filter(
      (name) => name.startsWith("bundle-") && name.endsWith(".mjs"),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const source = readFileSync(join(ROOT, "desktop/scripts", script), "utf8").toLowerCase();
      expect(source, script).not.toMatch(RUNTIME_TERMS);
    }
  });

  it("names the runtime directory without the app version", () => {
    const dir = voiceRuntimeDirName(BARK_RUNTIME);
    expect(dir).toMatch(/^bark-torch-[0-9a-f]{16}$/);
    expect(dir).not.toContain(desktopPackage.version);
  });

  it("keys the runtime to what it installs, not to how it is displayed", () => {
    const id = voiceRuntimeSpecId(BARK_RUNTIME);
    expect(voiceRuntimeSpecId({ ...BARK_RUNTIME, estimatedBytes: 1 })).toBe(id);
    expect(
      voiceRuntimeSpecId({
        ...BARK_RUNTIME,
        requirements: [...BARK_RUNTIME.requirements].reverse(),
      }),
    ).toBe(id);
    expect(
      voiceRuntimeSpecId({
        ...BARK_RUNTIME,
        requirements: [...BARK_RUNTIME.requirements, "extra==1.0.0"],
      }),
    ).not.toBe(id);
    expect(voiceRuntimeSpecId({ ...BARK_RUNTIME, python: "3.13" })).not.toBe(id);
  });

  it("pins every requirement to a version", () => {
    expect(BARK_RUNTIME.requirements.length).toBeGreaterThan(0);
    for (const requirement of BARK_RUNTIME.requirements) {
      expect(requirement).toMatch(/[<>=]=/);
    }
  });
});
