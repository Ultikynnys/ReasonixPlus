import { describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../src/client.js";
import { DeepSeekClient } from "../src/client.js";

/** A clean SSE body; the first attempt 429s when `failFirst` is set. */
function sseFetch(failFirst: boolean): { fetch: typeof fetch; calls: () => number } {
  let attempt = 0;
  const fn = vi.fn(async () => {
    attempt += 1;
    if (failFirst && attempt === 1) {
      return new Response("", { status: 429, headers: { "Retry-After": "0.01" } });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
        );
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return {
    fetch: fn,
    calls: () => (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length,
  };
}

async function collect(client: DeepSeekClient): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of client.stream({
    model: "glm-5-free",
    messages: [{ role: "user", content: "hi" }],
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

function makeClient(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new DeepSeekClient({
    apiKey: "public",
    baseUrl: "https://opencode.ai/zen/v1",
    allowMissingKey: true,
    fetch: fetchImpl,
    ...extra,
  });
}

describe("client waits on the stream channel", () => {
  it("announces a retry backoff before the retried request answers", async () => {
    const net = sseFetch(true);
    const client = makeClient(net.fetch, {
      retry: { maxAttempts: 2, initialBackoffMs: 1 },
    });

    const chunks = await collect(client);
    const wait = chunks[0]?.status;

    expect(wait).toMatchObject({ kind: "retry", attempt: 1, reason: "http 429" });
    expect(wait?.waitMs).toBeGreaterThan(0);
    // The content that follows is untouched, and the retried request did run.
    expect(chunks.some((c) => c.contentDelta === "hi")).toBe(true);
    expect(net.calls()).toBe(2);
  });

  it("announces the client-side rate-limit hold on the next request", async () => {
    const net = sseFetch(false);
    // 300 rpm = a 200ms slot: the first request claims it, the second must wait.
    const client = makeClient(net.fetch, { rateLimit: { rpm: 300 } });

    await collect(client);
    const second = await collect(client);
    const wait = second[0]?.status;

    expect(wait).toMatchObject({ kind: "rate-limit" });
    expect(wait?.waitMs).toBeGreaterThan(0);
    expect(second.some((c) => c.contentDelta === "hi")).toBe(true);
  });
});
