import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CapabilityAnswer,
  capabilityAnswer,
  capabilityPrefill,
  sessionSetupMeta,
  skillPrefill,
} from "../src/cli/commands/desktop.js";
import {
  ensureSessionDir,
  loadSessionMeta,
  patchSessionMeta,
  sessionDir,
  sessionSubagentsEnabled,
} from "../src/memory/session.js";

const configured = ["ghidra", "blender", "playwright"];

/** A capability answer over `configured`, with everything else off by default. */
function answer(overrides: Partial<CapabilityAnswer> = {}): CapabilityAnswer {
  return {
    configuredServers: configured,
    servers: [],
    plugins: [],
    skills: [],
    subagents: false,
    ...overrides,
  };
}

describe("capabilityPrefill", () => {
  const specs = [
    { name: "ghidra", disabled: true },
    { name: "playwright", builtin: true },
    { name: "blender" },
  ];

  it("offers the Settings default when the chat pins no capability set (New chat)", () => {
    expect(capabilityPrefill(specs)).toEqual([
      { name: "ghidra", enabled: false, builtin: false },
      { name: "playwright", enabled: true, builtin: true },
      { name: "blender", enabled: true, builtin: false },
    ]);
  });

  it("replays the source session's frozen set instead of the Settings default (Duplicate)", () => {
    // ghidra is off in Settings but on in the source chat; playwright is the reverse.
    const rows = capabilityPrefill(specs, {
      mcp: { disabledServers: ["playwright"] },
      subagents: true,
    });
    expect(rows).toEqual([
      { name: "ghidra", enabled: true, builtin: false },
      { name: "playwright", enabled: false, builtin: true },
      { name: "blender", enabled: true, builtin: false },
    ]);
  });

  it("reads an empty frozen set as every server enabled, never as the default", () => {
    const rows = capabilityPrefill(specs, { mcp: {}, subagents: false });
    expect(rows.map((row) => row.enabled)).toEqual([true, true, true]);
  });

  it("round-trips: confirming the pre-fill freezes the set the pre-fill came from", () => {
    const seed = { mcp: { disabledServers: ["blender"] }, subagents: true };
    const rows = capabilityPrefill(specs, seed);
    const frozen = sessionSetupMeta(
      answer({
        configuredServers: rows.map((row) => row.name),
        servers: rows.filter((row) => row.enabled).map((row) => row.name),
        subagents: seed.subagents,
      }),
    );
    expect(frozen).toEqual({
      mcp: { disabledServers: ["blender"] },
      subagents: true,
      plugins: [],
      skills: [],
    });
  });
});

describe("skillPrefill", () => {
  const installed = [
    { id: "churn-analysis", description: "Predicts churn." },
    { id: "seo-audit", description: "" },
  ];

  it("offers every installed skill on for a new chat", () => {
    expect(skillPrefill(installed)).toEqual([
      { id: "churn-analysis", description: "Predicts churn.", enabled: true },
      { id: "seo-audit", enabled: true },
    ]);
  });

  it("carries the install source, so the picker can offer one switch per repository", () => {
    const rows = skillPrefill([
      { id: "llmquant-risk", description: "Risk.", source: "https://github.com/LLMQuant/skills" },
    ]);
    expect(rows).toEqual([
      {
        id: "llmquant-risk",
        description: "Risk.",
        source: "https://github.com/LLMQuant/skills",
        enabled: true,
      },
    ]);
  });

  it("pins a duplicate to its source session's frozen set", () => {
    const rows = skillPrefill(installed, { skills: ["seo-audit"], subagents: false });
    expect(rows.map((row) => row.enabled)).toEqual([false, true]);
  });

  it("leaves every skill off when the source chat picked none", () => {
    const rows = skillPrefill(installed, { skills: [], subagents: false });
    expect(rows.map((row) => row.enabled)).toEqual([false, false]);
  });
});

describe("capabilityAnswer", () => {
  it("reads the four sections off a confirm message", () => {
    expect(
      capabilityAnswer(["api"], {
        enabled: ["api"],
        plugins: ["notfair"],
        skills: ["churn-analysis"],
        subagents: true,
      }),
    ).toEqual({
      configuredServers: ["api"],
      servers: ["api"],
      plugins: ["notfair"],
      skills: ["churn-analysis"],
      subagents: true,
    });
  });

  it("treats a missing or malformed list as agreeing to none of that kind", () => {
    const guarded = capabilityAnswer(["api"], {
      enabled: "api",
      plugins: [1, "notfair"],
      skills: {},
    });
    expect(guarded).toEqual({
      configuredServers: ["api"],
      servers: [],
      plugins: ["notfair"],
      skills: [],
      subagents: false,
    });
  });
});

describe("sessionSetupMeta", () => {
  it("records every configured server the user did not enable as disabled", () => {
    expect(sessionSetupMeta(answer({ servers: ["playwright"], subagents: true }))).toEqual({
      mcp: { disabledServers: ["blender", "ghidra"] },
      subagents: true,
      plugins: [],
      skills: [],
    });
  });

  it("freezes no disable entry when the whole server list is confirmed", () => {
    expect(sessionSetupMeta(answer({ servers: configured }))).toEqual({
      mcp: {},
      subagents: false,
      plugins: [],
      skills: [],
    });
  });

  it("freezes nothing when no server is configured", () => {
    expect(sessionSetupMeta(answer({ configuredServers: [] }))).toEqual({
      mcp: {},
      subagents: false,
      plugins: [],
      skills: [],
    });
  });

  it("ignores an enabled name the workspace does not configure", () => {
    expect(sessionSetupMeta(answer({ servers: ["nope"] })).mcp).toEqual({
      disabledServers: ["blender", "ghidra", "playwright"],
    });
  });

  it("de-duplicates and sorts the disabled list", () => {
    expect(sessionSetupMeta(answer({ configuredServers: ["b", "a", "b"] })).mcp).toEqual({
      disabledServers: ["a", "b"],
    });
  });

  it("coerces anything but a literal true to a disabled subagent flag", () => {
    const coerced = sessionSetupMeta(answer({ subagents: undefined as unknown as boolean }));
    expect(coerced.subagents).toBe(false);
  });

  it("de-duplicates the plugin and skill lists it freezes", () => {
    const frozen = sessionSetupMeta(
      answer({ plugins: ["notfair", "notfair"], skills: ["a", "a", "b"] }),
    );
    expect(frozen.plugins).toEqual(["notfair"]);
    expect(frozen.skills).toEqual(["a", "b"]);
  });
});

describe("session-start freeze round trip", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-session-setup-"));
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("lands every capability in the session meta so a resume reads them back", () => {
    // The store resolves its directory per call, so the stub must be in force before
    // the first write. Assert it: a stray real-home write is the failure to avoid.
    expect(sessionDir("gated-chat").startsWith(home)).toBe(true);
    ensureSessionDir("gated-chat");
    patchSessionMeta(
      "gated-chat",
      sessionSetupMeta(
        answer({
          servers: ["ghidra"],
          plugins: ["notfair"],
          skills: ["churn-analysis"],
          subagents: true,
        }),
      ),
    );

    const meta = loadSessionMeta("gated-chat");
    expect(meta.mcp).toEqual({ disabledServers: ["blender", "playwright"] });
    expect(meta.plugins).toEqual(["notfair"]);
    expect(meta.skills).toEqual(["churn-analysis"]);
    expect(sessionSubagentsEnabled(meta)).toBe(true);
  });

  it("reads a confirm that left subagents off as disabled, never as inherited", () => {
    ensureSessionDir("plain-chat");
    patchSessionMeta("plain-chat", sessionSetupMeta(answer({ servers: configured })));

    const meta = loadSessionMeta("plain-chat");
    expect(sessionSubagentsEnabled(meta)).toBe(false);
    expect(meta.mcp).toEqual({});
    // A chat that answered the picker with nothing is an answer, not a legacy meta.
    expect(meta.plugins).toEqual([]);
    expect(meta.skills).toEqual([]);
  });
});
