import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_SPECS, ROUTABLE_PROVIDER_SPECS, specForProvider } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPERIENTIAL_CHAT_URL,
  DEFAULT_GEMINI_CHAT_URL,
  DEFAULT_MIMO_CHAT_URL,
  DEFAULT_OLLAMA_CHAT_URL,
  DEFAULT_OPENCODE_CHAT_URL,
  DEFAULT_OPENCODE_GO_CHAT_URL,
  DEFAULT_ZAI_CHAT_URL,
  anyProviderConfigured,
  loadEndpointForModel,
  loadProviderApiKeys,
  modelUsableFor,
  providerForModel,
  writeConfig,
} from "../src/config.js";
import { CATALOG_PROVIDER_IDS, isCatalogProvider } from "../src/provider-models.js";

/** Every environment variable a provider's credentials can come from. */
const PROVIDER_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_API_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ZAI_API_KEY",
  "ZAI_BASE_URL",
  "MIMO_API_KEY",
  "MIMO_BASE_URL",
  "OPENCODE_API_KEY",
  "OPENCODE_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "EXPERIENTIAL_API_KEY",
  "EXPLABS_API_KEY",
  "EXPERIENTIAL_BASE_URL",
  "SYNTHETIC_API_KEY",
  "SYNTHETIC_BASE_URL",
  "SYN_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
];

describe("provider configuration", () => {
  let dir: string;
  let path: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-providers-"));
    path = join(dir, "config.json");
    for (const key of PROVIDER_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.clear();
  });

  it("routes every provider's own catalog ids back to it", () => {
    for (const spec of ROUTABLE_PROVIDER_SPECS) {
      for (const id of spec.models.slice(0, 3)) {
        expect(providerForModel(id, path)).toBe(spec.providerId);
      }
    }
  });

  it("resolves each provider's declared default endpoint", () => {
    writeConfig({}, path);
    expect(DEFAULT_ZAI_CHAT_URL).toBe(specForProvider("zai").endpoint.default);
    expect(DEFAULT_MIMO_CHAT_URL).toBe(specForProvider("mimo").endpoint.default);
    expect(DEFAULT_OLLAMA_CHAT_URL).toBe(specForProvider("ollama").endpoint.default);
    expect(DEFAULT_GEMINI_CHAT_URL).toBe(specForProvider("gemini").endpoint.default);
    expect(DEFAULT_OPENCODE_CHAT_URL).toBe(
      specForProvider("opencode").endpoint.tiers.zen ??
        specForProvider("opencode").endpoint.default,
    );
    expect(DEFAULT_OPENCODE_GO_CHAT_URL).toBe(specForProvider("opencode").endpoint.tiers.go);
    const experiential = PROVIDER_SPECS.find((spec) => spec.id === "experiential");
    if (experiential) expect(DEFAULT_EXPERIENTIAL_CHAT_URL).toBe(experiential.endpoint.default);

    expect(loadEndpointForModel("glm-5.3", path)).toEqual({
      baseUrl: DEFAULT_ZAI_CHAT_URL,
      apiKey: undefined,
    });
    expect(loadEndpointForModel("gemini-3.6-flash-low", path)).toEqual({
      baseUrl: DEFAULT_GEMINI_CHAT_URL,
      apiKey: undefined,
    });
  });

  it("gives a custom base URL its own key and never the stale env key", () => {
    process.env.ZAI_API_KEY = "env-key";
    writeConfig({ zaiBaseUrl: "https://proxy.test/v1", zaiApiKey: "cfg-key" }, path);
    expect(loadEndpointForModel("glm-5.3", path)).toEqual({
      baseUrl: "https://proxy.test/v1",
      apiKey: "cfg-key",
    });
  });

  it("routes OpenCode subscription ids to the Go tier", () => {
    writeConfig({}, path);
    expect(loadEndpointForModel("kimi-k3", path)).toEqual({
      baseUrl: DEFAULT_OPENCODE_GO_CHAT_URL,
      apiKey: "public",
    });
    expect(loadEndpointForModel("big-pickle", path)).toEqual({
      baseUrl: DEFAULT_OPENCODE_CHAT_URL,
      apiKey: "public",
    });
  });

  it("follows the declared setup gates for anyProviderConfigured", () => {
    writeConfig({}, path);
    expect(anyProviderConfigured(path)).toBe(false);

    writeConfig({ zaiApiKey: "zk" }, path);
    expect(anyProviderConfigured(path)).toBe(true);

    writeConfig({ mimoBaseUrl: "https://mimo.test/v1" }, path);
    expect(anyProviderConfigured(path)).toBe(true);

    writeConfig(
      {
        antigravityOAuth: { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 60_000 },
      },
      path,
    );
    expect(anyProviderConfigured(path)).toBe(true);
  });

  it("keeps modelUsableFor aligned with each provider's credentials", () => {
    writeConfig({}, path);
    expect(modelUsableFor("deepseek-flash", path)).toBe(false);
    expect(modelUsableFor("glm-5.3", path)).toBe(false);
    // OpenCode falls back to free public models with no credential at all.
    expect(modelUsableFor("big-pickle", path)).toBe(true);

    writeConfig({ zaiApiKey: "zk" }, path);
    expect(modelUsableFor("glm-5.3", path)).toBe(true);

    writeConfig({ ollamaBaseUrl: "http://localhost:11434/v1" }, path);
    expect(modelUsableFor("ollama/deepseek-v4.1-flash", path)).toBe(true);
  });

  it("masks exactly the providers that declare an API key field", () => {
    writeConfig({ zaiApiKey: "zk-1234567890" }, path);
    const keys = loadProviderApiKeys(path);
    const declared = PROVIDER_SPECS.filter((spec) => spec.credentials.apiKeySetting)
      .map((spec) => spec.id)
      .sort();
    expect(Object.keys(keys).sort()).toEqual(declared);
    expect(keys.zai).toBe("zk-1234567890");
  });

  it("routes Synthetic aliases and hf: ids to its OpenAI-compatible endpoint", () => {
    writeConfig({}, path);
    expect(providerForModel("syn:large:text", path)).toBe("synthetic");
    expect(providerForModel("hf:deepseek-ai/DeepSeek-V4.1-Flash", path)).toBe("synthetic");
    expect(loadEndpointForModel("syn:large:text", path)).toEqual({
      baseUrl: "https://api.synthetic.new/openai/v1",
      apiKey: undefined,
    });
    expect(modelUsableFor("syn:large:text", path)).toBe(false);
    process.env.SYNTHETIC_API_KEY = "syn-key";
    expect(loadEndpointForModel("syn:large:text", path)).toEqual({
      baseUrl: "https://api.synthetic.new/openai/v1",
      apiKey: "syn-key",
    });
    expect(modelUsableFor("syn:large:text", path)).toBe(true);
  });

  it("derives the discovery catalog ids from the registry", () => {
    const declared = PROVIDER_SPECS.filter((spec) => spec.discovery.strategy === "models-endpoint")
      .map((spec) => spec.id)
      .sort();
    expect([...CATALOG_PROVIDER_IDS].sort()).toEqual(declared);
    expect(isCatalogProvider("openai")).toBe(true);
    expect(isCatalogProvider("ollama")).toBe(false);
  });
});
