/** Xiaomi MiMo chat contract: the `thinking` toggle is sent top-level; MiMo has
 *  no effort ladder, so `reasoning_effort` must never ride along. */

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Xiaomi MiMo chat", () => {
  it("sends the thinking toggle and never a reasoning_effort ladder", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (input, requestInit) => {
      url = String(input);
      init = requestInit as RequestInit;
      return jsonResponse({
        choices: [{ message: { content: "ok", reasoning_content: "thought" } }],
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "mimo-test-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      fetch,
    });

    const response = await client.chat({
      model: "mimo-v2.6-pro",
      messages: [{ role: "user", content: "hello" }],
      thinking: "enabled",
      reasoningEffort: "high",
    });

    expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.extra_body).toBeUndefined();
    expect(response.reasoningContent).toBe("thought");
  });

  it("MIMO_DISABLE_THINKING_WITH_TOOLS forces the toggle off on tool requests", async () => {
    process.env.MIMO_DISABLE_THINKING_WITH_TOOLS = "1";
    try {
      let init: RequestInit | undefined;
      const fetch = vi.fn(async (_input, requestInit) => {
        init = requestInit as RequestInit;
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "mimo-test-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        fetch,
      });
      await client.chat({
        model: "mimo-v2.6-pro",
        messages: [{ role: "user", content: "hello" }],
        thinking: "enabled",
        tools: [
          {
            type: "function",
            function: { name: "noop", description: "noop", parameters: { type: "object" } },
          },
        ],
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: "disabled" });
    } finally {
      process.env.MIMO_DISABLE_THINKING_WITH_TOOLS = "";
    }
  });

  it("forwards audio and video content parts in MiMo's wire shape", async () => {
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (_input, requestInit) => {
      init = requestInit as RequestInit;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "mimo-test-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      fetch,
    });
    await client.chat({
      model: "mimo-v2.6-pro",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize this" },
            { type: "input_audio", input_audio: { data: "data:audio/wav;base64,AAAA" } },
            {
              type: "video_url",
              video_url: { url: "https://example.com/v.mp4" },
              fps: 5,
              media_resolution: "max",
            },
          ],
        },
      ],
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.content).toEqual([
      { type: "text", text: "summarize this" },
      { type: "input_audio", input_audio: { data: "data:audio/wav;base64,AAAA" } },
      {
        type: "video_url",
        video_url: { url: "https://example.com/v.mp4" },
        fps: 5,
        media_resolution: "max",
      },
    ]);
  });

  it("surfaces MiMo prompt-cache hits from prompt_tokens_details.cached_tokens", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    ) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "mimo-test-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      fetch,
    });
    const resp = await client.chat({
      model: "mimo-v2.6-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.usage.promptTokens).toBe(100);
    expect(resp.usage.promptCacheHitTokens).toBe(80);
    expect(resp.usage.promptCacheMissTokens).toBe(20);
  });

  it("treats an explicit zero cached_tokens as a real zero-cache, not missing usage", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
    ) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "mimo-test-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      fetch,
    });
    const resp = await client.chat({
      model: "mimo-v2.6-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    // The usage block IS present — a 0 cache hit means all 100 input tokens missed.
    expect(resp.usage.promptCacheHitTokens).toBe(0);
    expect(resp.usage.promptCacheMissTokens).toBe(100);
  });

  it("yields an all-zero usage when MiMo omits the usage block", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    ) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "mimo-test-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      fetch,
    });
    const resp = await client.chat({
      model: "mimo-v2.6-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.usage.promptTokens).toBe(0);
    expect(resp.usage.promptCacheHitTokens).toBe(0);
    expect(resp.usage.promptCacheMissTokens).toBe(0);
  });
});
