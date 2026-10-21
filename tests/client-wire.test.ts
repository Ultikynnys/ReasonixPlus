/** Locks each declared wire quirk to the request it produces, so changing a
 *  provider's `wire` block cannot silently alter the payload it sends. */
import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface CaptureOptions {
  model: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "low" | "high";
  tools?: boolean;
}

async function capture(
  opts: CaptureOptions,
): Promise<{ url: string; body: Record<string, unknown> }> {
  let url = "";
  let init: RequestInit | undefined;
  const mockFetch = vi.fn(async (input, requestInit) => {
    url = String(input);
    init = requestInit as RequestInit;
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof globalThis.fetch;
  const client = new DeepSeekClient({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    fetch: mockFetch,
  });
  await client.chat({
    model: opts.model,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    ...(opts.tools
      ? {
          tools: [
            {
              type: "function" as const,
              function: { name: "noop", description: "noop", parameters: { type: "object" } },
            },
          ],
        }
      : {}),
  });
  return { url, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
}

describe("declared wire quirks", () => {
  it("deepseek stamps message ids and nests the toggle under extra_body", async () => {
    const { body } = await capture({ model: "deepseek-flash", thinking: "enabled" });
    expect(body.extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(body.thinking).toBeUndefined();
    const messages = body.messages as { role: string; id?: string }[];
    // Only assistant/tool turns are stamped; a user turn is left untouched.
    expect(messages[0]?.id).toBeUndefined();
    expect(messages[1]?.id).toBe("msg-1");
    // The ladder is accepted, so the static set is still sent.
    expect(
      (await capture({ model: "deepseek-flash", reasoningEffort: "high" })).body.reasoning_effort,
    ).toBe("high");
  });

  it("zai takes a top-level toggle that clears prior thinking", async () => {
    const { body } = await capture({ model: "glm-5.3", thinking: "enabled" });
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(body.extra_body).toBeUndefined();
  });

  it("mimo takes a bare top-level toggle and never a reasoning_effort", async () => {
    const { body } = await capture({
      model: "mimo-v2.6-pro",
      thinking: "enabled",
      reasoningEffort: "high",
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("openai pins store:false with one tool call per response", async () => {
    const { body } = await capture({ model: "gpt-6.1-sol", thinking: "enabled" });
    expect(body.store).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);
    // OpenAI refuses the proprietary toggle entirely.
    expect(body.extra_body).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("ollama routes to its native chat format instead of chat-completions", async () => {
    const { url } = await capture({ model: "ollama/deepseek-v4.1-flash" });
    expect(url).not.toContain("/chat/completions");
  });
});
