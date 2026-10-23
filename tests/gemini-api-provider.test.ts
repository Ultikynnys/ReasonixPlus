// The Gemini API provider (`gemini-api`): Google's step_list interactions wire,
// separate from the Antigravity-served `gemini` catalog. Every expectation comes
// from the declaration plus the shapes the live API returns.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelAcceptsImages } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { providerForModel } from "../src/config.js";
import type { ChatMessage, ToolSpec } from "../src/types.js";

const MODEL = "gemini-api/gemini-3.5-flash-lite";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const HISTORY: ChatMessage[] = [
  { role: "system", content: "You are a terse assistant." },
  { role: "user", content: "I have 2 dogs in my house." },
  { role: "assistant", content: "Understood — two dogs." },
  { role: "user", content: "How many paws are in my house?" },
];

/** One live `/v1beta/interactions` reply, trimmed to the fields the client reads. */
function interaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "v1_interaction",
    status: "completed",
    object: "interaction",
    model: "gemini-3.5-flash-lite",
    usage: {
      total_tokens: 76,
      total_input_tokens: 40,
      total_cached_tokens: 8,
      total_output_tokens: 6,
      total_thought_tokens: 30,
    },
    steps: [
      { type: "thought", signature: "sig-thought" },
      { type: "model_output", content: [{ type: "text", text: "Eight paws." }] },
    ],
    ...overrides,
  };
}

describe("gemini-api provider", () => {
  let dir: string;
  let savedConfig: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-gemini-api-"));
    savedConfig = process.env.REASONIX_CONFIG;
    process.env.REASONIX_CONFIG = join(dir, "config.json");
    writeFileSync(process.env.REASONIX_CONFIG, "{}", "utf8");
  });

  afterEach(() => {
    if (savedConfig === undefined) {
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.REASONIX_CONFIG;
    } else {
      process.env.REASONIX_CONFIG = savedConfig;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function clientWith(
    reply: unknown,
    init: { sse?: string } = {},
  ): { client: DeepSeekClient; requests: Array<{ url: string; init: RequestInit }> } {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, requestInit: RequestInit | undefined) => {
      requests.push({ url: String(url), init: requestInit ?? {} });
      if (init.sse !== undefined) {
        return new Response(new TextEncoder().encode(init.sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return {
      client: new DeepSeekClient({
        apiKey: "gemini-test-key",
        baseUrl: BASE_URL,
        fetch: fetchMock as unknown as typeof fetch,
      }),
      requests,
    };
  }

  function sentBody(request: { init: RequestInit }): Record<string, unknown> {
    return JSON.parse(String(request.init.body)) as Record<string, unknown>;
  }

  it("routes both bare and qualified catalogs to its own provider", () => {
    expect(providerForModel("gemini-3.5-flash-lite")).toBe("gemini-api");
    expect(providerForModel(MODEL)).toBe("gemini-api");
    // The declared id scheme keeps ids outside the static catalog routable.
    expect(providerForModel("gemini-api/gemini-4-argon")).toBe("gemini-api");
    // Antigravity's catalog keeps its own route.
    expect(providerForModel("gemini-3.6-flash-low")).toBe("gemini");
  });

  it("posts a step_list body to the declared path with the declared key header", async () => {
    const { client, requests } = clientWith(interaction());
    await client.chat({ model: MODEL, messages: HISTORY, tools: [TOOL] });

    const request = requests[0]!;
    expect(request.url).toBe(`${BASE_URL}/interactions`);
    const headers = request.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("gemini-test-key");
    expect(headers.Authorization).toBeUndefined();

    const body = sentBody(request);
    expect(body.model).toBe("gemini-3.5-flash-lite");
    expect(body.system_instruction).toBe("You are a terse assistant.");
    expect(body.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "I have 2 dogs in my house." }] },
      { type: "model_output", content: [{ type: "text", text: "Understood — two dogs." }] },
      { type: "user_input", content: [{ type: "text", text: "How many paws are in my house?" }] },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: TOOL.function.parameters,
      },
    ]);
    // Chat-completions fields have no meaning on this wire.
    expect(body.messages).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });

  it("replays a tool round trip as function_call then function_result steps", async () => {
    const { client, requests } = clientWith(interaction());
    await client.chat({
      model: MODEL,
      messages: [
        { role: "user", content: "What is the weather in Paris?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              thoughtSignature: "sig-call",
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "21C, clear" },
      ],
      tools: [TOOL],
    });

    expect(sentBody(requests[0]!).input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "What is the weather in Paris?" }] },
      {
        type: "function_call",
        id: "call_1",
        name: "get_weather",
        arguments: { city: "Paris" },
        signature: "sig-call",
      },
      { type: "function_result", name: "get_weather", result: "21C, clear" },
    ]);
  });

  it("names a tool result its function even when the message omits the name", async () => {
    const { client, requests } = clientWith(interaction());
    await client.chat({
      model: MODEL,
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "21C" },
      ],
      tools: [TOOL],
    });

    const steps = sentBody(requests[0]!).input as Array<Record<string, unknown>>;
    expect(steps.at(-1)).toEqual({ type: "function_result", name: "get_weather", result: "21C" });
  });

  it("sends an attached image as an image part", async () => {
    const { client, requests } = clientWith(interaction());
    await client.chat({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What colour is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });

    const steps = sentBody(requests[0]!).input as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(steps[0]?.content).toEqual([
      { type: "text", text: "What colour is this?" },
      { type: "image", mime_type: "image/png", data: "AAAA" },
    ]);
  });

  it("inlines a data URL and notes an image the wire cannot inline", async () => {
    const { client, requests } = clientWith(interaction());
    await client.chat({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "compare these" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
            // The API answers a linked image with "Unsupported url", so a link is
            // replaced by a visible note instead of failing the whole turn.
            { type: "image_url", image_url: { url: "https://example.com/a.png" } },
          ],
        },
      ],
    });

    const steps = sentBody(requests[0]!).input as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(steps[0]?.content).toEqual([
      { type: "text", text: "compare these" },
      { type: "image", mime_type: "image/jpeg", data: "BBBB" },
      { type: "text", text: "[image not sent: this endpoint accepts inline images only]" },
    ]);
  });

  it("declares vision for every Gemini id, so the composer offers attachments", () => {
    expect(modelAcceptsImages("gemini-api/gemini-3.5-flash-lite")).toBe(true);
    expect(modelAcceptsImages("gemini-3.5-flash-lite")).toBe(true);
    // An id outside the static catalog keeps the pattern rule ("gemini-").
    expect(modelAcceptsImages("gemini-api/gemini-4-argon")).toBe(true);
  });

  it("surfaces a generated image carried by a model_output part", async () => {
    const { client } = clientWith(
      interaction({
        steps: [
          {
            type: "model_output",
            content: [
              { type: "image", mime_type: "image/png", data: "AAAA" },
              { type: "text", text: "done" },
            ],
          },
        ],
      }),
    );
    const reply = await client.chat({ model: MODEL, messages: HISTORY });
    expect(reply.image).toEqual({
      dataUrl: "data:image/png;base64,AAAA",
      mimeType: "image/png",
    });
    expect(reply.content).toBe("done");
  });

  it("maps a reasoning effort onto thinking_level and a disable onto minimal", async () => {
    const { client, requests } = clientWith(interaction());
    await client.chat({
      model: MODEL,
      messages: HISTORY,
      reasoningEffort: "high",
      temperature: 0.2,
      maxTokens: 512,
    });
    expect(sentBody(requests[0]!).generation_config).toEqual({
      temperature: 0.2,
      max_output_tokens: 512,
      thinking_level: "high",
    });

    const off = clientWith(interaction());
    await off.client.chat({ model: MODEL, messages: HISTORY, thinking: "disabled" });
    expect(sentBody(off.requests[0]!).generation_config).toEqual({ thinking_level: "minimal" });
  });

  it("parses a completed interaction into content and usage", async () => {
    const { client } = clientWith(interaction());
    const reply = await client.chat({ model: MODEL, messages: HISTORY });
    expect(reply.content).toBe("Eight paws.");
    expect(reply.toolCalls).toEqual([]);
    expect(reply.usage.promptTokens).toBe(40);
    expect(reply.usage.completionTokens).toBe(6);
    expect(reply.usage.totalTokens).toBe(76);
    expect(reply.usage.promptCacheHitTokens).toBe(8);
    expect(reply.usage.promptCacheMissTokens).toBe(32);
  });

  it("parses function_call steps into tool calls that carry their signature", async () => {
    const { client } = clientWith(
      interaction({
        status: "requires_action",
        steps: [
          { type: "thought", signature: "sig-thought" },
          {
            type: "function_call",
            id: "call_281911",
            name: "get_weather",
            arguments: { city: "Paris" },
            signature: "sig-call",
          },
        ],
      }),
    );
    const reply = await client.chat({ model: MODEL, messages: HISTORY, tools: [TOOL] });
    expect(reply.content).toBe("");
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]?.id).toBe("call_281911");
    expect(reply.toolCalls[0]?.function.name).toBe("get_weather");
    expect(JSON.parse(reply.toolCalls[0]?.function.arguments ?? "{}")).toEqual({ city: "Paris" });
    expect(reply.toolCalls[0]?.thoughtSignature).toBe("sig-call");
  });

  it("streams text deltas, a tool call and the completed usage", async () => {
    const frames = [
      'event: interaction.created\ndata: {"interaction":{"id":"v1"},"event_type":"interaction.created"}\n\n',
      'event: step.start\ndata: {"index":0,"step":{"type":"thought"},"event_type":"step.start"}\n\n',
      'event: step.delta\ndata: {"index":0,"delta":{"signature":"sig-thought","type":"thought_signature"},"event_type":"step.delta"}\n\n',
      'event: step.stop\ndata: {"index":0,"event_type":"step.stop"}\n\n',
      'event: step.start\ndata: {"index":1,"step":{"type":"model_output"},"event_type":"step.start"}\n\n',
      'event: step.delta\ndata: {"index":1,"delta":{"text":"Calling ","type":"text"},"event_type":"step.delta"}\n\n',
      'event: step.delta\ndata: {"index":1,"delta":{"text":"the tool.","type":"text"},"event_type":"step.delta"}\n\n',
      'event: step.stop\ndata: {"index":1,"event_type":"step.stop"}\n\n',
      'event: step.start\ndata: {"index":2,"step":{"type":"function_call","id":"call_1","name":"get_weather"},"event_type":"step.start"}\n\n',
      'event: step.delta\ndata: {"index":2,"delta":{"arguments":"{\\"city\\":\\"Paris\\"}","type":"function_call"},"event_type":"step.delta"}\n\n',
      'event: step.stop\ndata: {"index":2,"event_type":"step.stop"}\n\n',
      `event: interaction.completed\ndata: ${JSON.stringify({
        interaction: {
          id: "v1",
          status: "completed",
          usage: { total_tokens: 90, total_input_tokens: 76, total_output_tokens: 14 },
        },
        event_type: "interaction.completed",
      })}\n\n`,
      "event: done\ndata: [DONE]\n\n",
    ].join("");

    const { client, requests } = clientWith(null, { sse: frames });
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of client.stream({ model: MODEL, messages: HISTORY, tools: [TOOL] })) {
      chunks.push(chunk as unknown as Record<string, unknown>);
    }

    // Streaming is declared on the body, not implied by an endpoint suffix.
    expect(sentBody(requests[0]!)).toMatchObject({ stream: true, model: "gemini-3.5-flash-lite" });

    const content = chunks.map((c) => c.contentDelta ?? "").join("");
    expect(content).toBe("Calling the tool.");
    expect(chunks.find((c) => c.thoughtSignature === "sig-thought")).toBeDefined();

    const deltas = chunks
      .map(
        (c) =>
          c.toolCallDelta as
            | { index: number; id?: string; name?: string; argumentsDelta?: string }
            | undefined,
      )
      .filter((d): d is { index: number; id?: string; name?: string; argumentsDelta?: string } =>
        Boolean(d),
      );
    expect(deltas[0]).toMatchObject({ index: 0, id: "call_1", name: "get_weather" });
    expect(deltas.map((d) => d.argumentsDelta ?? "").join("")).toBe('{"city":"Paris"}');

    const usage = chunks.find((c) => c.usage)?.usage as
      | { promptTokens: number; completionTokens: number; totalTokens: number }
      | undefined;
    expect(usage).toMatchObject({ promptTokens: 76, completionTokens: 14, totalTokens: 90 });
  });

  it("surfaces a generated image from a streamed image delta", async () => {
    const frames = [
      'event: step.start\ndata: {"index":0,"step":{"type":"model_output"},"event_type":"step.start"}\n\n',
      'event: step.delta\ndata: {"index":0,"delta":{"type":"image","mime_type":"image/png","data":"AAAA"},"event_type":"step.delta"}\n\n',
      'event: step.delta\ndata: {"index":0,"delta":{"text":"here it is","type":"text"},"event_type":"step.delta"}\n\n',
      "event: done\ndata: [DONE]\n\n",
    ].join("");

    const { client } = clientWith(null, { sse: frames });
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of client.stream({ model: MODEL, messages: HISTORY })) {
      chunks.push(chunk as unknown as Record<string, unknown>);
    }
    expect(chunks.find((c) => c.image)?.image).toEqual({
      dataUrl: "data:image/png;base64,AAAA",
      mimeType: "image/png",
    });
    expect(chunks.map((c) => c.contentDelta ?? "").join("")).toBe("here it is");
  });

  it("ignores the empty arguments placeholder the opening call frame carries", async () => {
    // Live wire: step.start announces `arguments: {}`, and the real arguments
    // arrive in the delta. Appending both would send "{}{city:...}".
    const frames = [
      'event: step.start\ndata: {"index":0,"step":{"type":"function_call","id":"call_1","name":"get_weather","arguments":{}},"event_type":"step.start"}\n\n',
      'event: step.delta\ndata: {"index":0,"delta":{"arguments":{"city":"Paris"},"type":"function_call"},"event_type":"step.delta"}\n\n',
      'event: step.stop\ndata: {"index":0,"event_type":"step.stop"}\n\n',
      "event: done\ndata: [DONE]\n\n",
    ].join("");

    const { client } = clientWith(null, { sse: frames });
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of client.stream({ model: MODEL, messages: HISTORY, tools: [TOOL] })) {
      chunks.push(chunk as unknown as Record<string, unknown>);
    }
    const args = chunks
      .map(
        (c) => (c.toolCallDelta as { argumentsDelta?: string } | undefined)?.argumentsDelta ?? "",
      )
      .join("");
    expect(args).toBe('{"city":"Paris"}');
  });

  it("reports a failed stream with the declared brand", async () => {
    // A rejected streaming request answers in SSE frames, not a JSON error body.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          'event: error\ndata: {"error":{"message":"Request contains an invalid argument.","code":"invalid_request"},"event_type":"error"}\n\n',
          { status: 400, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const client = new DeepSeekClient({
      apiKey: "bad-key",
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const drain = async (): Promise<void> => {
      for await (const _chunk of client.stream({ model: MODEL, messages: HISTORY })) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow("Gemini 400: Request contains an invalid argument.");
  });

  it("reports a failed turn with the declared brand", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('[{"error":{"message":"API key not valid."}}]', {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new DeepSeekClient({
      apiKey: "bad-key",
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.chat({ model: MODEL, messages: HISTORY })).rejects.toThrow(/^Gemini 400: /);
  });

  it("unwraps the API's JSON error envelope into the readable message", async () => {
    // The live 401 body is an ARRAY wrapping the error object.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","details":[]}}]',
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new DeepSeekClient({
      apiKey: "bad-key",
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.chat({ model: MODEL, messages: HISTORY })).rejects.toThrow(
      "Gemini 400: API key not valid. Please pass a valid API key.",
    );
  });

  // A Gemini 3 continuation is rejected when a replayed call has no signature
  // (verified live: "Request contains an invalid argument"); Google's documented
  // sentinel is accepted instead, which is what the Cloud Code builder does too.
  const CALL_HISTORY: ChatMessage[] = [
    { role: "user", content: "weather in Paris?" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "21C" },
  ];

  async function callSteps(model: string, messages: ChatMessage[]) {
    const { client, requests } = clientWith(interaction());
    await client.chat({ model, messages, tools: [TOOL] });
    return (sentBody(requests[0]!).input as Array<Record<string, unknown>>).filter(
      (step) => step.type === "function_call",
    );
  }

  it("falls back to the sentinel signature for a Gemini 3 call that lost its own", async () => {
    const calls = await callSteps(MODEL, CALL_HISTORY);
    expect(calls.map((call) => call.signature)).toEqual(["skip_thought_signature_validator"]);
  });

  it("echoes a known signature onto a later call that carries none", async () => {
    const calls = await callSteps(MODEL, [
      { role: "user", content: "weather in Paris?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
            thoughtSignature: "sig-earlier",
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "21C" },
      { role: "user", content: "and in Rome?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_2", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_2", name: "get_weather", content: "25C" },
    ]);
    expect(calls.map((call) => call.signature)).toEqual(["sig-earlier", "sig-earlier"]);
  });

  it("sends no signature for a Gemini 2.5 model, which never used one", async () => {
    const calls = await callSteps("gemini-api/gemini-2.5-flash", CALL_HISTORY);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("signature");
  });

  it("stands in a user turn when the transcript would otherwise be empty", async () => {
    // The wire answers an empty step_list with a misleading "model not found".
    const { client, requests } = clientWith(interaction());
    await client.chat({ model: MODEL, messages: [{ role: "system", content: "be brief" }] });
    expect(sentBody(requests[0]!).input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Continue the conversation." }] },
    ]);
  });

  it("routes an arguments_delta fragment even without an opening frame", async () => {
    const frames = [
      'event: step.delta\ndata: {"index":0,"delta":{"name":"get_weather","id":"call_9","type":"function_call"},"event_type":"step.delta"}\n\n',
      'event: step.delta\ndata: {"index":0,"delta":{"arguments":"{\\"city\\":","type":"arguments_delta"},"event_type":"step.delta"}\n\n',
      'event: step.delta\ndata: {"index":0,"delta":{"arguments":"\\"Paris\\"}","type":"arguments_delta"},"event_type":"step.delta"}\n\n',
      "event: done\ndata: [DONE]\n\n",
    ].join("");

    const { client } = clientWith(null, { sse: frames });
    const deltas: Array<{ id?: string; name?: string; argumentsDelta?: string }> = [];
    for await (const chunk of client.stream({ model: MODEL, messages: HISTORY, tools: [TOOL] })) {
      if (chunk.toolCallDelta) deltas.push(chunk.toolCallDelta);
    }
    expect(deltas[0]).toMatchObject({ id: "call_9", name: "get_weather" });
    expect(deltas.map((delta) => delta.argumentsDelta ?? "").join("")).toBe('{"city":"Paris"}');
  });

  it("reports an action it cannot run instead of a silent empty answer", async () => {
    // A server-side tool (google_search_call) leaves no client-side call to run.
    const { client } = clientWith(
      interaction({ status: "requires_action", steps: [{ type: "thought", signature: "s" }] }),
    );
    const reply = await client.chat({ model: MODEL, messages: HISTORY });
    expect(reply.content).toBe("");
    expect(reply.toolCalls).toEqual([]);
    expect(reply.stopReason).toBe("the model asked for an action this client cannot run");
  });

  it("reports the same unrunnable action from a streamed turn", async () => {
    const frames = [
      `event: interaction.completed\ndata: ${JSON.stringify({
        interaction: { id: "v1", status: "requires_action" },
        event_type: "interaction.completed",
      })}\n\n`,
      "event: done\ndata: [DONE]\n\n",
    ].join("");

    const { client } = clientWith(null, { sse: frames });
    const stops: string[] = [];
    for await (const chunk of client.stream({ model: MODEL, messages: HISTORY, tools: [TOOL] })) {
      if (chunk.stopReason) stops.push(chunk.stopReason);
    }
    expect(stops).toEqual(["the model asked for an action this client cannot run"]);
  });
});
