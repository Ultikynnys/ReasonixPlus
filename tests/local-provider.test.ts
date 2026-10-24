import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadEndpointForModel,
  loadProviderSetting,
  modelUsableFor,
  providerForModel,
  saveProviderSetting,
} from "../src/config.js";
import { fetchProviderModels } from "../src/provider-models.js";
import { resolveContextTokens } from "../src/telemetry/stats.js";
import { makeFakeClient } from "./support/fake-client.js";

it("sends llama.cpp tool-safe defaults and strips the routing prefix", async () => {
  const { client, captured } = makeFakeClient([{ content: "done" }]);
  await client.chat({
    model: "local/saluki-27b",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 32000,
  });
  expect(captured[0]?.body).toMatchObject({
    model: "saluki-27b",
    parallel_tool_calls: false,
    max_tokens: 8192,
    chat_template_kwargs: { enable_thinking: false },
  });
  const { client: small, captured: smallCaptured } = makeFakeClient([{ content: "done" }]);
  await small.chat({
    model: "local/saluki-27b",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 256,
  });
  // A request below the reserve keeps its own budget.
  expect(smallCaptured[0]?.body.max_tokens).toBe(256);
});

it("reserves output space in the configured server context", () => {
  const path = configPath();
  vi.stubEnv("REASONIX_CONFIG", path);
  expect(resolveContextTokens("local/saluki-27b", 1000000)).toBe(24576);
  saveProviderSetting("local", "contextTokens", "16384", path);
  expect(resolveContextTokens("local/saluki-27b")).toBe(8192);
  saveProviderSetting("local", "contextTokens", "65536", path);
  expect(resolveContextTokens("local/saluki-27b")).toBe(57344);
  expect(() => saveProviderSetting("local", "contextTokens", "1024", path)).toThrow(
    /output reserve/,
  );
});

const dirs: string[] = [];
function configPath() {
  const dir = mkdtempSync(join(tmpdir(), "local-provider-"));
  dirs.push(dir);
  return join(dir, "config.json");
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("routes qualified aliases without claiming cloud model names", () => {
  const path = configPath();
  vi.stubEnv("LOCAL_BASE_URL", "");
  vi.stubEnv("LOCAL_API_KEY", "");
  expect(providerForModel("local/saluki-27b", path)).toBe("local");
  expect(loadEndpointForModel("local/saluki-27b", path)).toEqual({
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKey: undefined,
  });
});

it.each(["http://127.0.0.1:8080", "http://127.0.0.1:8080/v1/"])("normalizes %s", (url) => {
  const path = configPath();
  saveProviderSetting("local", "baseUrl", url, path);
  expect(loadProviderSetting("local", "baseUrl", path)).toBe("http://127.0.0.1:8080/v1");
});

it.each([
  "file:///tmp/model",
  "http://user:secret@localhost:8080",
  "http://localhost:8080?key=secret",
  "not-a-url",
])("rejects unsafe URL %s", (url) => {
  expect(() => saveProviderSetting("local", "baseUrl", url, configPath())).toThrow();
});

it("treats a user-declared LAN server without a key as runnable", () => {
  const path = configPath();
  saveProviderSetting("local", "baseUrl", "http://192.168.1.40:8080", path);
  expect(loadEndpointForModel("local/saluki-27b", path)).toEqual({
    baseUrl: "http://192.168.1.40:8080/v1",
    apiKey: undefined,
  });
  expect(modelUsableFor("local/saluki-27b", path)).toBe(true);
});

it("keeps the saved key on the endpoint it was entered for", () => {
  const path = configPath();
  saveProviderSetting("local", "baseUrl", "http://127.0.0.1:9090/v1", path);
  saveProviderSetting("local", "apiKey", "local-secret", path);
  expect(loadEndpointForModel("local/saluki-27b", path)).toEqual({
    baseUrl: "http://127.0.0.1:9090/v1",
    apiKey: "local-secret",
  });
  saveProviderSetting("local", "apiKey", "", path);
  expect(loadEndpointForModel("local/saluki-27b", path).apiKey).toBeUndefined();
});

it("discovers llama.cpp aliases without sending an undefined bearer token", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "saluki-27b" }] })));
  const path = configPath();
  const result = await fetchProviderModels({
    provider: "local",
    baseUrl: "http://127.0.0.1:8080/v1",
    fallback: [],
    homeDir: join(path, ".."),
    fetchImpl,
  });
  expect(result).toMatchObject({ source: "live", models: ["saluki-27b"] });
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://127.0.0.1:8080/v1/models",
    expect.objectContaining({ headers: {} }),
  );
});
