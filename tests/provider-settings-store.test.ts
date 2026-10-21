import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderSettingsPatch, providerDeclared } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anyProviderConfigured,
  loadEndpointForModel,
  loadProviderSetting,
  readConfig,
  saveProviderSetting,
  setProviderSetting,
} from "../src/config.js";

/** Env names that shadow the store; cleared so the persisted value is the only source. */
const PROVIDER_ENV = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ZAI_API_KEY",
  "ZAI_BASE_URL",
  "OPENCODE_API_KEY",
  "OPENCODE_BASE_URL",
  "MIMO_API_KEY",
  "MIMO_BASE_URL",
  "EXPERIENTIAL_API_KEY",
  "EXPERIENTIAL_BASE_URL",
  "SYNTHETIC_API_KEY",
  "SYNTHETIC_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
];

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
