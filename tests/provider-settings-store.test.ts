import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_SPECS, parseProviderSettingsPatch, providerDeclared } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anyProviderConfigured,
  bridgeEndpointEnv,
  loadEndpointForModel,
  loadProviderApiKeys,
  loadProviderSetting,
  readConfig,
  saveProviderSetting,
  saveProviderSettings,
  setProviderSetting,
} from "../src/config.js";

/** Env names that shadow the store; cleared so the persisted value is the only source. */
const PROVIDER_ENV = new Set(
  PROVIDER_SPECS.flatMap((spec) => spec.settings.flatMap((setting) => setting.env)),
);
const SECRET_SETTINGS = PROVIDER_SPECS.flatMap((spec) =>
  spec.settings
    .filter((setting) => setting.kind === "secret")
    .map((setting) => ({ providerId: spec.id, setting })),
);

describe("provider settings store", () => {
  let dir: string;
  let path: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-provider-store-"));
    path = join(dir, "config.json");
    for (const name of PROVIDER_ENV) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    saved.clear();
  });

  /** A config file as an older version of Reasonix wrote it. */
  function writeLegacy(extra: Record<string, unknown> = {}): void {
    writeFileSync(
      path,
      JSON.stringify({
        apiKey: "ds-key",
        baseUrl: "https://deepseek.example/v1",
        openaiApiKey: "oa-key",
        zaiApiKey: "zai-key",
        zaiBaseUrl: "https://zai.example/v1",
        opencodeApiKey: "oc-key",
        opencodeBaseUrl: "https://oc.example/v1",
        mimoApiKey: "mimo-key",
        mimoBaseUrl: "https://mimo.example/v1",
        mimoKeyName: "reasonix-fixed",
        experientialApiKey: "xpl-key",
        experientialBaseUrl: "https://xpl.example/v1",
        syntheticApiKey: "syn-key",
        syntheticBaseUrl: "https://syn.example/v1",
        ollamaApiKey: "ol-key",
        ollamaBaseUrl: "http://localhost:11434/v1",
        ...extra,
      }),
    );
  }

  it.skipIf(
    ["deepseek", "openai", "zai", "opencode", "mimo", "experiential", "synthetic", "ollama"].some(
      (id) => !providerDeclared(id),
    ),
  )("migrates every legacy field into the declared store", () => {
    writeLegacy();
    expect(readConfig(path).providerSettings).toEqual({
      deepseek: { apiKey: "ds-key", baseUrl: "https://deepseek.example/v1" },
      // The legacy top-level baseUrl fed both DeepSeek and OpenAI, which each
      // declare it as their migration source.
      openai: { apiKey: "oa-key", baseUrl: "https://deepseek.example/v1" },
      zai: { apiKey: "zai-key", baseUrl: "https://zai.example/v1" },
      opencode: { apiKey: "oc-key", baseUrl: "https://oc.example/v1" },
      mimo: {
        apiKey: "mimo-key",
        baseUrl: "https://mimo.example/v1",
        keyName: "reasonix-fixed",
      },
      experiential: { apiKey: "xpl-key", baseUrl: "https://xpl.example/v1" },
      synthetic: { apiKey: "syn-key", baseUrl: "https://syn.example/v1" },
      ollama: { apiKey: "ol-key", baseUrl: "http://localhost:11434/v1" },
    });
  });

  it("resolves the endpoint and credential from the migrated store", () => {
    writeLegacy();
    expect(loadEndpointForModel("deepseek-chat", path)).toEqual({
      baseUrl: "https://deepseek.example/v1",
      apiKey: "ds-key",
    });
  });

  it("drops the migrated fields from the file on the next write", () => {
    writeLegacy();
    saveProviderSetting("zai", "apiKey", "new-key", path);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("zaiApiKey");
    expect(raw).not.toHaveProperty("apiKey");
    expect(raw).not.toHaveProperty("mimoKeyName");
    expect(raw.providerSettings).toMatchObject({ zai: { apiKey: "new-key" } });
  });

  it("lets the store win over a stale legacy field", () => {
    writeLegacy({ providerSettings: { zai: { apiKey: "store-key" } } });
    expect(loadProviderSetting("zai", "apiKey", path)).toBe("store-key");
  });

  it("counts a migrated provider as configured", () => {
    expect(anyProviderConfigured(path)).toBe(false);
    writeLegacy({ zaiApiKey: "zai-key" });
    expect(anyProviderConfigured(path)).toBe(true);
  });

  it("round-trips a declared setting and clears it when empty", () => {
    saveProviderSetting("synthetic", "apiKey", "  s1  ", path);
    expect(loadProviderSetting("synthetic", "apiKey", path)).toBe("s1");
    saveProviderSetting("synthetic", "apiKey", "", path);
    expect(loadProviderSetting("synthetic", "apiKey", path)).toBeUndefined();
    expect(readConfig(path).providerSettings?.synthetic).toBeUndefined();
  });

  it("replaces and clears a startup-bridged DeepSeek credential", () => {
    saveProviderSetting("deepseek", "apiKey", "old-key", path);
    bridgeEndpointEnv(path);
    expect(process.env.DEEPSEEK_API_KEY).toBe("old-key");

    for (const value of ["  replacement-key  ", ""]) {
      saveProviderSetting("deepseek", "apiKey", value, path);
      expect(loadEndpointForModel("deepseek-chat", path).apiKey).toBe(value.trim() || undefined);
      expect(process.env.DEEPSEEK_API_KEY).toBe(value.trim() || undefined);
    }
  });

  it.each(SECRET_SETTINGS)("replaces and clears $providerId secrets", ({ providerId, setting }) => {
    for (const name of setting.env) process.env[name] = "old-key";
    for (const value of ["  replacement-key  ", "", "second-key", null]) {
      saveProviderSetting(providerId, setting.key, value, path);
      const expected = value?.trim() || undefined;
      expect(loadProviderSetting(providerId, setting.key, path)).toBe(expected);
      for (const name of setting.env) expect(process.env[name]).toBe(expected);
      expect(loadProviderApiKeys(path)[providerId]).toBe(expected);
    }
  });

  it("validates a whole batch before changing config or environment", () => {
    const entry = SECRET_SETTINGS[0];
    if (!entry) return;
    const { providerId, setting } = entry;
    saveProviderSetting(providerId, setting.key, "old-key", path);
    const before = readFileSync(path, "utf8");
    expect(() =>
      saveProviderSettings(
        [
          { providerId, key: setting.key, value: "new-key" },
          { providerId, key: "undeclared-setting", value: "invalid" },
        ],
        path,
      ),
    ).toThrow(/declares no setting/);
    expect(readFileSync(path, "utf8")).toBe(before);
    for (const name of setting.env) expect(process.env[name]).toBe("old-key");
  });

  it("does not synchronize non-secret settings into the environment", () => {
    for (const spec of PROVIDER_SPECS) {
      for (const setting of spec.settings.filter(
        (entry) => entry.kind !== "secret" && !entry.editable,
      )) {
        for (const name of setting.env) process.env[name] = "environment-value";
        saveProviderSetting(spec.id, setting.key, "stored-value", path);
        expect(loadProviderSetting(spec.id, setting.key, path)).toBe("stored-value");
        for (const name of setting.env) expect(process.env[name]).toBe("environment-value");
      }
    }
  });

  it("refuses undeclared keys and unknown providers", () => {
    expect(() => saveProviderSetting("zai", "nope", "v", path)).toThrow(
      /declares no setting "nope"/,
    );
    expect(() => saveProviderSetting("nope", "apiKey", "v", path)).toThrow(
      /unknown provider "nope"/,
    );
  });

  it("round-trips a settings patch from the wire into the store", () => {
    const { writes, rejected } = parseProviderSettingsPatch({
      synthetic: { apiKey: "syn-key" },
      zai: { apiKey: "zai-key" },
      nope: { apiKey: "x" },
      mimo: { notAKey: "x" },
    });
    // Only declared provider ids and declared setting keys survive.
    expect(rejected).toEqual(["nope", "mimo.notAKey"]);
    expect(writes).toEqual([
      { providerId: "synthetic", key: "apiKey", value: "syn-key" },
      { providerId: "zai", key: "apiKey", value: "zai-key" },
    ]);
  });

  it("applies a whole patch to one in-memory config", () => {
    const cfg = readConfig(path);
    setProviderSetting(cfg, "zai", "apiKey", "k");
    setProviderSetting(cfg, "zai", "apiKey", "");
    expect(cfg.providerSettings).toBeUndefined();
  });
});
