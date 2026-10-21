/** Experiential Labs gateway chat: it refuses unknown fields (400,
 *  unsupported_parameter), so never send extra_body or a reasoning_effort. */

import { providerDeclared } from "@reasonix/core-utils";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe.skipIf(!providerDeclared("experiential"))("Experiential Labs gateway chat", () => {
  it("never sends extra_body or a thinking toggle, and strips the qualifier", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (input, requestInit) => {
      url = String(input);
      init = requestInit as RequestInit;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "xpl-test-key",
      baseUrl: "https://api.experientiallabs.ai/v1",
      fetch,
    });

    // `experiential/<id>` pins routing to the gateway; the bare id would route
    // to its native provider (deepseek). Thinking mode is on for the bare id.
    const response = await client.chat({
      model: "experiential/deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      thinking: "enabled",
      reasoningEffort: "high",
      tools: [
        {
          type: "function",
          function: { name: "noop", description: "noop", parameters: { type: "object" } },
        },
      ],
    });

    expect(url).toBe("https://api.experientiallabs.ai/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer xpl-test-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.extra_body).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    // Documented fields the gateway refuses on every route must never be sent.
    for (const refused of [
      "audio",
      "modalities",
      "logit_bias",
      "seed",
      "functions",
      "function_call",
      "prediction",
      "prompt_cache_retention",
      "route",
    ]) {
      expect(body[refused], `${refused} must be omitted`).toBeUndefined();
    }
    expect(response.content).toBe("ok");
  });

  it("still sends extra_body for the same model id routed to its native provider", async () => {
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (_input, requestInit) => {
      init = requestInit as RequestInit;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      fetch,
    });

    await client.chat({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      thinking: "enabled",
    });

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.extra_body).toEqual({ thinking: { type: "enabled" } });
  });
});
