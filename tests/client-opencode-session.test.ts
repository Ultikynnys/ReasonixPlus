import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

/** 200 chat-completions response; captures the request headers per call. */
function headerCapturingFetch(): {
  fetch: typeof fetch;
  headers: () => Array<Record<string, string>>;
} {
  const seen: Array<Record<string, string>> = [];
  const fn = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ ...(init?.headers ?? {}) });
    return new Response(
      JSON.stringify({
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fn, headers: () => seen };
}

describe("OpenCode session headers (opencode.ai/docs/go)", () => {
  it("sends x-opencode-session and a reasonix User-Agent on opencode requests", async () => {
    const { fetch, headers } = headerCapturingFetch();
    const client = new DeepSeekClient({
      apiKey: "public",
      baseUrl: "https://opencode.ai/zen/v1",
      allowMissingKey: true,
      sessionId: "desktop-17123456789012-3",
      fetch,
    });

    await client.chat({ model: "glm-5-free", messages: [{ role: "user", content: "hi" }] });
    await client
      .stream({
        model: "glm-5-free",
        messages: [{ role: "user", content: "hi again" }],
      })
      .next();

    expect(headers().length).toBe(2);
    for (const h of headers()) {
      expect(h["x-opencode-session"]).toBe("desktop-17123456789012-3");
      expect(h["User-Agent"]).toMatch(/^reasonix\//);
    }
  });

  it("generates one stable session id per client when none is configured", async () => {
    const { fetch, headers } = headerCapturingFetch();
    const client = new DeepSeekClient({
      apiKey: "public",
      baseUrl: "https://opencode.ai/zen/v1",
      allowMissingKey: true,
      fetch,
    });

    await client.chat({ model: "glm-5-free", messages: [{ role: "user", content: "a" }] });
    await client.chat({ model: "glm-5-free", messages: [{ role: "user", content: "b" }] });

    const [first, second] = headers();
    expect(first?.["x-opencode-session"]).toBeTruthy();
    expect(first?.["x-opencode-session"]).toBe(second?.["x-opencode-session"]);
    expect(first?.["x-opencode-session"]).not.toBe("desktop-17123456789012-3");
  });

  it("does not send the session header for non-opencode providers", async () => {
    const { fetch, headers } = headerCapturingFetch();
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
    });

    await client.chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(headers()[0]?.["x-opencode-session"]).toBeUndefined();
    expect(headers()[0]?.["User-Agent"]).toBeUndefined();
  });
});

/** Zen reports cache hits in the Chat Completions `prompt_tokens_details`
 *  object, not the Responses API `input_tokens_details` object. */
describe("OpenCode Zen cache usage parsing", () => {
  function opencodeClient(fetch: typeof globalThis.fetch): DeepSeekClient {
    return new DeepSeekClient({
      apiKey: "public",
      baseUrl: "https://opencode.ai/zen/v1",
      allowMissingKey: true,
      fetch,
    });
  }

  it("reads cache hits from prompt_tokens_details.cached_tokens (non-streaming)", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 20,
              total_tokens: 1020,
              prompt_tokens_details: { cached_tokens: 800 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const res = await opencodeClient(fetch).chat({
      model: "glm-5-free",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.usage.promptTokens).toBe(1000);
    expect(res.usage.promptCacheHitTokens).toBe(800);
    expect(res.usage.promptCacheMissTokens).toBe(200);
    expect(res.usage.cacheHitRatio).toBe(0.8);
  });

  it("reads cache hits from prompt_tokens_details.cached_tokens (streaming)", async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ finish_reason: "stop", delta: {} }],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 10,
          total_tokens: 510,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const fetch = vi.fn(async () => {
      const stream = new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const chunks = [];
    for await (const chunk of opencodeClient(fetch).stream({
      model: "glm-5-free",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    const usage = chunks.find((chunk) => chunk.usage)?.usage;
    expect(usage?.promptCacheHitTokens).toBe(400);
    expect(usage?.promptCacheMissTokens).toBe(100);
  });
});
