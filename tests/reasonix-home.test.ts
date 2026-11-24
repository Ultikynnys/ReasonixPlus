import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reasonixHome } from "../src/reasonix-home.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reasonix-home-test-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reasonixHome", () => {
  it("uses REASONIX_HOME as the state directory", () => {
    const state = tempDir();
    vi.stubEnv("REASONIX_HOME", state);
    expect(reasonixHome()).toBe(state);
  });

  it("falls back to the platform home when no state override is set", () => {
    const home = tempDir();
    vi.stubEnv("REASONIX_HOME", "");
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    expect(reasonixHome()).toBe(join(home, ".reasonix"));
  });

  it("keeps an explicit home override as a home directory", () => {
    const home = tempDir();
    const state = tempDir();
    vi.stubEnv("REASONIX_HOME", state);
    expect(reasonixHome(home)).toBe(join(home, ".reasonix"));
  });

  it("treats an empty REASONIX_HOME as unset", () => {
    const home = tempDir();
    vi.stubEnv("REASONIX_HOME", "  ");
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    expect(reasonixHome()).toBe(join(home, ".reasonix"));
  });
});
