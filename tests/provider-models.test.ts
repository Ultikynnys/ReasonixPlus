import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProviderModels } from "../src/provider-models.js";
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
  it("reads the TypeSafe model contract", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "jev-next" }] })));
    expect(
      await fetchProviderModels({
        provider: "typesafe",
        baseUrl: "https://test/v1",
        apiKey: "key",
        fallback: ["jev-latest"],
        homeDir: home(),
        fetchImpl,
      }),
    ).toMatchObject({ models: ["jev-next"], source: "live" });
  });
});
