import { providerDeclared } from "@reasonix/core-utils";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, antigravityThinkingConfig } from "../src/client.js";
import { effectiveReasoningEffort, supportedReasoningEfforts } from "../src/config.js";
import { reasoningControl } from "../src/reasoning-control.js";
import { buildResponsesPayload } from "../src/responses-api.js";

/** Capture the chat-completions body the client would send. */
async function chatBody(
  opts: { apiKey: string; baseUrl: string },
  request: {
    model: string;
    thinking?: "enabled" | "disabled";
    reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    tools?: boolean;
  },
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const fetch = vi.fn(async (_url: unknown, init: unknown) => {
    body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  const client = new DeepSeekClient({ ...opts, fetch });
  await client.chat({
    model: request.model,
    messages: [{ role: "user", content: "hi" }],
    ...(request.thinking ? { thinking: request.thinking } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(request.tools
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
  return body;
}

function geminiConfig(
  model: string,
  thinking: "enabled" | "disabled" | undefined,
  reasoningEffort?: "low" | "medium" | "high",
): Record<string, unknown> | undefined {
  return antigravityThinkingConfig(
    reasoningControl({
      provider: "gemini",
      model,
      thinking,
      reasoningEffort,
      supported: supportedReasoningEfforts(`gemini/${model}`),
    }),
  );
}

describe("effort on the chat-completions wire", () => {
  it.skipIf(!providerDeclared("deepseek"))(
    "sends DeepSeek's thinking toggle top-level",
    async () => {
      const body = await chatBody(
        { apiKey: "sk-test", baseUrl: "https://api.deepseek.com" },
        { model: "deepseek-v4-pro", thinking: "enabled", reasoningEffort: "medium" },
      );
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.extra_body).toBeUndefined();
      // DeepSeek maps a medium request onto high; it has no medium level.
      expect(body.reasoning_effort).toBe("high");
    },
  );

  it.skipIf(!providerDeclared("deepseek"))("drops the effort when thinking is off", async () => {
    const body = await chatBody(
      { apiKey: "sk-test", baseUrl: "https://api.deepseek.com" },
      { model: "deepseek-v4-pro", thinking: "disabled", reasoningEffort: "max" },
    );
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it.skipIf(!providerDeclared("zai"))(
    "keeps a forced-thinking GLM enabled with its effort",
    async () => {
      const body = await chatBody(
        { apiKey: "sk-test", baseUrl: "https://api.z.ai/api/paas/v4" },
        { model: "glm-5.3", thinking: "disabled", reasoningEffort: "xhigh" },
      );
      // GLM-5.3 cannot think off, and effort only applies while thinking is on.
      expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
      expect(body.reasoning_effort).toBe("max");
    },
  );

  it.skipIf(!providerDeclared("zai"))(
    "omits the effort for a GLM model with no ladder",
    async () => {
      const body = await chatBody(
        { apiKey: "sk-test", baseUrl: "https://api.z.ai/api/paas/v4" },
        { model: "glm-4.7", thinking: "enabled", reasoningEffort: "max" },
      );
      expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
      expect(body.reasoning_effort).toBeUndefined();
    },
  );
});

describe("effort on the Cloud Code wire", () => {
  it.skipIf(!providerDeclared("gemini"))("sends a thinkingLevel for Gemini 3 models", () => {
    expect(geminiConfig("gemini-3.8-flash-tiered", "enabled", "low")).toEqual({
      includeThoughts: true,
      thinkingLevel: "low",
    });
    expect(geminiConfig("gemini-3.1-pro", "enabled", "medium")).toEqual({
      includeThoughts: true,
      thinkingLevel: "medium",
    });
  });

  it.skipIf(!providerDeclared("gemini"))("sends a thinkingBudget for Gemini 2.5 models", () => {
    expect(geminiConfig("gemini-2.5-flash", "enabled", "high")).toEqual({
      includeThoughts: true,
      thinkingBudget: 24576,
    });
    // Flash accepts 0 as "no thinking"; Pro is forced on, so a disable is moot.
    expect(geminiConfig("gemini-2.5-flash", "disabled")).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    });
    expect(geminiConfig("gemini-2.5-pro", "disabled")).toBeUndefined();
    expect(geminiConfig("gemini-2.5-pro", "enabled", "high")).toEqual({
      includeThoughts: true,
      thinkingBudget: 32768,
    });
  });

  it.skipIf(!providerDeclared("gemini"))(
    "maps a Claude thinking build onto its budget keys",
    () => {
      expect(geminiConfig("claude-opus-4-6-thinking", "enabled", "medium")).toEqual({
        include_thoughts: true,
        thinking_budget: 16384,
      });
      // Without an effort there is nothing to say; leave the model's default alone.
      expect(geminiConfig("claude-opus-4-6-thinking", "disabled")).toBeUndefined();
    },
  );

  it.skipIf(!providerDeclared("gemini"))("sends nothing for a model with no depth control", () => {
    expect(geminiConfig("gpt-oss-120b-medium", "enabled", "high")).toBeUndefined();
    expect(geminiConfig("gemini-3.8-flash-tiered", undefined)).toBeUndefined();
  });
});

describe("effort on the native Ollama wire", () => {
  function ollamaClient(show: unknown) {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/api/show")) {
        return new Response(JSON.stringify(show), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { content: "ok" }, done: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return {
      bodies,
      client: new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      }),
    };
  }

  it.skipIf(!providerDeclared("ollama"))(
    "clamps the level to what /api/show advertises",
    async () => {
      const { bodies, client } = ollamaClient({
        thinking: { values: ["low", "medium", "high"], default: "medium" },
      });
      await client.chat({
        model: "ollama/custom-thinker:7b",
        messages: [{ role: "user", content: "hi" }],
        reasoningEffort: "max",
        thinking: "enabled",
      });
      // The model never advertised "max", so the request lands on its own top level.
      expect(bodies[0]?.think).toBe("high");
    },
  );

  it.skipIf(!providerDeclared("ollama"))(
    "sends no think value to a model that cannot think",
    async () => {
      const { bodies, client } = ollamaClient({ thinking: { values: [false] } });
      await client.chat({
        model: "ollama/no-thinker:3b",
        messages: [{ role: "user", content: "hi" }],
        thinking: "enabled",
        reasoningEffort: "high",
      });
      expect("think" in (bodies[0] ?? {})).toBe(false);
      expect(bodies[0]?.think).toBeUndefined();
    },
  );
});

describe("effort on the Responses wire", () => {
  it.skipIf(!providerDeclared("mimo"))("maps a disabled MiMo tool request to effort none", () => {
    const control = reasoningControl({
      provider: "mimo",
      model: "mimo-v2.6-pro",
      thinking: "disabled",
      supported: supportedReasoningEfforts("mimo-v2.6-pro"),
    });
    const payload = buildResponsesPayload(
      { model: "mimo-v2.6-pro", messages: [{ role: "user", content: "hi" }] },
      true,
      "mimo",
      control,
    );
    expect(payload.reasoning).toEqual({ effort: "none" });
  });

  it.skipIf(!providerDeclared("openai"))("nests a supported effort under reasoning", () => {
    const control = reasoningControl({
      provider: "openai",
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
      thinking: "enabled",
      supported: supportedReasoningEfforts("gpt-6-astra"),
    });
    const payload = buildResponsesPayload(
      { model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }] },
      true,
      "openai",
      control,
    );
    expect(payload.reasoning).toEqual({ effort: "xhigh", summary: "concise" });
  });
});

describe("picker agreement", () => {
  it.skipIf(!providerDeclared("gemini"))("offers only the levels the wire can carry", () => {
    expect(supportedReasoningEfforts("gemini/gemini-3.6-flash-tiered")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(effectiveReasoningEffort("gemini/gemini-3.6-flash-tiered", "xhigh")).toBe("high");
  });
});
