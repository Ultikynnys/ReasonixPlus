import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogScope, fetchProviderModels } from "../src/provider-models.js";
import { reasonixHome } from "../src/reasonix-home.js";
const dirs: string[] = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), "provider-models-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("provider model discovery", () => {
  it("prefers fetched models and preserves a successful empty catalog", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    const result = await fetchProviderModels({
      provider: "deepseek",
      baseUrl: "https://test/v1",
      apiKey: "secret",
      fallback: ["old"],
      homeDir: home(),
      fetchImpl,
    });
    expect(result).toMatchObject({ models: [], source: "live" });
  });
  it("deduplicates requests and isolates endpoint and credential caches", async () => {
    const homeDir = home();
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "new" }] })));
    const options = {
      provider: "openai" as const,
      baseUrl: "https://test/v1",
      apiKey: "key",
      fallback: ["old"],
      homeDir,
      fetchImpl,
    };
    await Promise.all([fetchProviderModels(options), fetchProviderModels(options)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await fetchProviderModels(options)).toMatchObject({ models: ["new"], source: "cache" });
    await fetchProviderModels({ ...options, apiKey: "other" });
    await fetchProviderModels({ ...options, baseUrl: "https://other/v1" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("falls back honestly on auth failure and never sends OAuth as an API key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    const options = {
      provider: "openai" as const,
      baseUrl: "https://test/v1",
      fallback: ["old"],
      homeDir: home(),
      fetchImpl,
    };
    expect(await fetchProviderModels(options)).toMatchObject({
      source: "fallback",
      models: ["old"],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await fetchProviderModels({ ...options, apiKey: "key" })).toMatchObject({
      source: "fallback",
      error: "Model discovery returned HTTP 401",
    });
  });
  it("drops excluded ids (MiMo speech models) and bakes it into the cache", async () => {
    const homeDir = home();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "mimo-v2.6-pro" }, { id: "mimo-v2.5-asr" }, { id: "mimo-v2.5-tts" }],
        }),
      ),
    );
    const options = {
      provider: "mimo" as const,
      baseUrl: "https://test/v1",
      apiKey: "key",
      fallback: ["mimo-v2.6-pro"],
      exclude: new Set(["mimo-v2.5-asr", "mimo-v2.5-tts"]),
      homeDir,
      fetchImpl,
    };
    expect(await fetchProviderModels(options)).toMatchObject({
      models: ["mimo-v2.6-pro"],
      source: "live",
    });
    // A later cached read stays clean — the exclusion is applied before caching.
    expect(await fetchProviderModels(options)).toMatchObject({
      models: ["mimo-v2.6-pro"],
      source: "cache",
    });
  });

  it("reads the Experiential Labs gateway /v1/models contract", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "qwen3.8-27b" }, { id: "fable-5" }] })),
      );
    expect(
      await fetchProviderModels({
        provider: "experiential",
        baseUrl: "https://api.experientiallabs.ai/v1",
        apiKey: "xpl-key",
        fallback: ["qwen3.8-27b"],
        homeDir: home(),
        fetchImpl,
      }),
    ).toMatchObject({ models: ["fable-5", "qwen3.8-27b"], source: "live" });
  });

  it("reads the declared input modality into vision ids", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "openai/gpt-4o", architecture: { input_modalities: ["text", "image"] } },
            { id: "deepseek/deepseek-v4-flash", architecture: { input_modalities: ["text"] } },
            { id: "no-architecture" },
          ],
        }),
      ),
    );

    const result = await fetchProviderModels({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "or-key",
      fallback: [],
      homeDir: home(),
      fetchImpl,
    });

    expect(result.models).toEqual([
      "deepseek/deepseek-v4-flash",
      "no-architecture",
      "openai/gpt-4o",
    ]);
    expect(result.visionModels).toEqual(["openai/gpt-4o"]);
  });

  it("reports no vision ids when the provider declares no modality field", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] })));

    const result = await fetchProviderModels({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "ds-key",
      fallback: [],
      homeDir: home(),
      fetchImpl,
    });

    expect(result).toMatchObject({ source: "live", visionModels: [] });
  });

  it("keeps vision ids across a cache read and tolerates a cache written before the field", async () => {
    const homeDir = home();
    const baseUrl = "https://openrouter.ai/api/v1";
    const apiKey = "or-key";
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "openai/gpt-4o", architecture: { input_modalities: ["image"] } }],
        }),
      ),
    );
    const options = {
      provider: "openrouter" as const,
      baseUrl,
      apiKey,
      fallback: [],
      homeDir,
      fetchImpl,
    };

    await fetchProviderModels(options);
    expect(await fetchProviderModels(options)).toMatchObject({
      source: "cache",
      visionModels: ["openai/gpt-4o"],
    });

    // An older cache has no vision ids: it must still load, contributing none.
    const path = join(
      reasonixHome(homeDir),
      "provider-models",
      `${catalogScope("openrouter", baseUrl, apiKey)}.json`,
    );
    writeFileSync(path, JSON.stringify({ models: ["openai/gpt-4o"], checkedAt: Date.now() }));
    expect(await fetchProviderModels(options)).toMatchObject({
      source: "cache",
      models: ["openai/gpt-4o"],
      visionModels: [],
    });
  });
});
