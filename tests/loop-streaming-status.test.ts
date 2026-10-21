import { describe, expect, it } from "vitest";
import type { ClientStatus, DeepSeekClient, StreamChunk } from "../src/client.js";
import type { ReasoningEffort } from "../src/config.js";
import type { LoopEvent } from "../src/loop.js";
import { streamModelResponse } from "../src/loop/streaming.js";

function fakeClient(chunks: StreamChunk[]): DeepSeekClient {
  return {
    stream: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as DeepSeekClient;
}

async function events(chunks: StreamChunk[]): Promise<LoopEvent[]> {
  const gen = streamModelResponse({
    client: fakeClient(chunks),
    model: "test-model",
    messages: [],
    toolSpecs: [],
    signal: new AbortController().signal,
    reasoningEffort: "low" as ReasoningEffort,
    turn: 3,
  });
  const out: LoopEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    out.push(next.value);
    next = await gen.next();
  }
  return out;
}

describe("streamModelResponse — client waits", () => {
  it("forwards a rate-limit throttle as a tagged status before any content", async () => {
    const status: ClientStatus = { kind: "rate-limit", waitMs: 1_500 };
    const out = await events([
      { status, raw: null },
      { contentDelta: "hi", raw: null },
    ]);

    expect(out[0]).toMatchObject({
      role: "status",
      turn: 3,
      statusCode: "rate-limit",
      statusWaitMs: 1_500,
    });
    expect(out[0]?.content).toContain("rate limit");
    // The content that follows is untouched by the progress event.
    expect(out[1]).toMatchObject({ role: "assistant_delta", content: "hi" });
  });

  it("forwards a retry backoff with its attempt number and does not count it as output", async () => {
    const status: ClientStatus = { kind: "retry", waitMs: 3_400, attempt: 2, reason: "http 429" };
    const out = await events([{ status, raw: null }]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: "status",
      statusCode: "model-retry",
      statusAttempt: 2,
      statusWaitMs: 3_400,
    });
    expect(out[0]?.content).toContain("http 429");
    expect(out[0]?.content).toContain("attempt 2");
  });

  it("rounds a sub-second wait up so the row never promises 0s", async () => {
    const out = await events([{ status: { kind: "retry", waitMs: 40, attempt: 1 }, raw: null }]);

    expect(out[0]?.content).toContain("in 1s");
  });
});
