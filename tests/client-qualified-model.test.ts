/** Provider-qualified model references (`<provider>/<id>`) are client-side
 *  routing syntax: every wire payload must carry the bare id. */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient, type ResolvedTransport } from "../src/client.js";
import { isThinkingModeModel, thinkingModeForModel } from "../src/loop.js";
import { resolveContextTokens } from "../src/telemetry/stats.js";

const savedReasonixConfig = process.env.REASONIX_CONFIG;
const testConfigPath = join(tmpdir(), "reasonix-test-qualified-model-config.json");

beforeEach(() => {
  process.env.REASONIX_CONFIG = testConfigPath;
  writeFileSync(testConfigPath, "{}", "utf8");
});

afterEach(() => {
  if (savedReasonixConfig === undefined) {
    // biome-ignore lint/performance/noDelete: restore exact env state
    delete process.env.REASONIX_CONFIG;
  } else {
    process.env.REASONIX_CONFIG = savedReasonixConfig;
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function capturingFetch(): { fetch: typeof fetch; body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const fetch = vi.fn(async (_input, requestInit) => {
    captured = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  return { fetch, body: () => captured };
}

describe("qualified model refs on the chat-completions wire", () => {
  it("sends the bare id for an opencode-qualified mimo id", async () => {
    const { fetch, body } = capturingFetch();
    const client = new DeepSeekClient({
      apiKey: "public",
      baseUrl: "https://opencode.ai/zen/go/v1",
      fetch,
    });
    await client.chat({
      model: "opencode/mimo-v2.6-pro",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(body().model).toBe("mimo-v2.6-pro");
  });

  it("sends the bare id for a mimo-qualified ref on the MiMo endpoint", async () => {
    const { fetch, body } = capturingFetch();
    const client = new DeepSeekClient({
      apiKey: "mimo-test-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      fetch,
    });
    await client.chat({
      model: "mimo/mimo-v2.6-pro",
      messages: [{ role: "user", content: "hello" }],
      thinking: "enabled",
    });
    expect(body().model).toBe("mimo-v2.6-pro");
    // Capability logic sees the wire id: the MiMo thinking toggle rides top-level.
    expect(body().thinking).toEqual({ type: "enabled" });
  });

  it("keeps stripping ollama/<id> on the native payload", async () => {
    const { fetch, body } = capturingFetch();
    const client = new DeepSeekClient({
      apiKey: undefined,
      baseUrl: "http://localhost:11434/v1",
      allowMissingKey: true,
      fetch,
    });
    await client.chat({
      model: "ollama/llama3.1:latest",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(body().model).toBe("llama3.1:latest");
  });
});

describe("qualified model refs on the Responses wire", () => {
  it("sends the bare id in the responses payload", async () => {
    const TRANSPORT: ResolvedTransport = {
      endpoint: "https://opencode.ai/zen/go/v1/responses",
      headers: { Authorization: "Bearer oc_sk_test" },
      api: "responses",
    };
    let captured: Record<string, unknown> = {};
    const fetch = vi.fn(async (_input, requestInit) => {
      captured = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
      return jsonResponse({ output: [] });
    }) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      apiKey: "oc_sk_test",
      baseUrl: "https://opencode.ai/zen/go/v1",
      fetch,
      transportResolver: async () => TRANSPORT,
      retry: { maxAttempts: 1 },
    });
    await client.chat({
      model: "opencode/mimo-v2.6-pro",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(captured.model).toBe("mimo-v2.6-pro");
  });
});

describe("capability predicates on qualified refs", () => {
  it("thinking-mode predicates match the wire id", () => {
    expect(isThinkingModeModel("opencode/mimo-v2.6-pro")).toBe(true);
    expect(thinkingModeForModel("opencode/mimo-v2.6-pro")).toBe("enabled");
    expect(thinkingModeForModel("mimo/mimo-v2.6-pro")).toBe("enabled");
    // An unrecognized prefix is part of the id, so nothing changes for it.
    expect(isThinkingModeModel("foo/mimo-v2.6-pro")).toBe(false);
  });

  it("context-window lookup matches the wire id", () => {
    expect(resolveContextTokens("opencode/deepseek-flash")).toBe(
      resolveContextTokens("deepseek-flash"),
    );
    expect(resolveContextTokens("ollama/llama3.1:latest", 8192)).toBe(8192);
  });
});
