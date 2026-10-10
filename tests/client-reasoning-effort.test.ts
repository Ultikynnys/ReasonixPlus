import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: keep the real catalog helpers config.ts depends on, but drive
// the per-model effort lookup directly so the test never touches disk.
vi.mock("../src/opencode-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/opencode-models.js")>();
  return { ...actual, reasoningEffortsForModel: vi.fn() };
});

import { DeepSeekClient } from "../src/client.js";
import { reasoningEffortsForModel } from "../src/opencode-models.js";

const mocked = vi.mocked(reasoningEffortsForModel);

function capture() {
  let body: Record<string, unknown> = {};
  const fetch = vi.fn(async (_url: unknown, init: unknown) => {
    body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, body: () => body };
}

function opencodeClient(fetch: typeof globalThis.fetch) {
  return new DeepSeekClient({ apiKey: "public", baseUrl: "https://opencode.ai/zen/v1", fetch });
}

describe("reasoning-effort clamping (client)", () => {
  beforeEach(() => mocked.mockReset());

  it("clamps a native provider's unsupported effort (deepseek has no medium)", async () => {
    mocked.mockReturnValue(["low", "high", "max"]);
    const { fetch, body } = capture();
    await new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      fetch,
    }).chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "medium",
    });
    expect(body().reasoning_effort).toBe("high");
  });

  it("sends an allowed effort unchanged", async () => {
    mocked.mockReturnValue(["low", "medium"]);
    const { fetch, body } = capture();
    await opencodeClient(fetch).chat({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "medium",
    });
    expect(body().reasoning_effort).toBe("medium");
  });

  it("clamps an unsupported effort to the nearest allowed level", async () => {
    mocked.mockReturnValue(["high", "max"]);
    const { fetch, body } = capture();
    await opencodeClient(fetch).chat({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "low",
    });
    expect(body().reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort for a toggle/budget-only model", async () => {
    mocked.mockReturnValue([]);
    const { fetch, body } = capture();
    await opencodeClient(fetch).chat({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "high",
    });
    expect("reasoning_effort" in body()).toBe(false);
  });

  it("clamps on the Responses API transport too (not just chat completions)", async () => {
    mocked.mockReturnValue(["high", "max"]);
    let body: Record<string, unknown> = {};
    const fetch = vi.fn(async (_url: unknown, init: unknown) => {
      body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: response.completed\ndata: ${JSON.stringify({
                type: "response.completed",
                response: {
                  status: "completed",
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new DeepSeekClient({
      apiKey: "public",
      baseUrl: "https://opencode.ai/zen/v1",
      fetch,
      transportResolver: async () => ({
        endpoint: "https://example.test/v1/responses",
        headers: {},
        api: "responses" as const,
      }),
    });

    for await (const _ of client.stream({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "low",
    })) {
      // drain
    }

    expect((body.reasoning as { effort?: string })?.effort).toBe("high");
  });
});
