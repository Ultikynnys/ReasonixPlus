// Consolidated from 8 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeepSeekClient,
  type ResolvedTransport,
  type StreamChunk,
  type Usage,
  stripTranscriptMarkers,
} from "../src/client.js";
import { saveOllamaGenerationPatch } from "../src/config.js";
import { isThinkingModeModel, thinkingModeForModel } from "../src/loop.js";
import { resolveContextTokens } from "../src/telemetry/stats.js";
import { estimateRequestTokens } from "../src/tokenizer.js";
import { makeFakeClient } from "./support/fake-client.js";

// Locks each declared wire quirk to the request it produces, so changing a
// *  provider's `wire` block cannot silently alter the payload it sends.
describe("client-wire", () => {
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
    it("deepseek stamps message ids and sends the toggle top-level", async () => {
      const { body } = await capture({ model: "deepseek-flash", thinking: "enabled" });
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.extra_body).toBeUndefined();
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
});

describe("client-stream-error", () => {
  /** SSE body with the given frames, then a clean EOF. */
  function sseFetch(frames: string[]): { fetch: typeof fetch; calls: () => number } {
    const fn = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames.join("")));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    return {
      fetch: fn,
      calls: () => (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length,
    };
  }

  describe("chat-completions SSE mid-stream error frames", () => {
    it("surfaces an OpenCode upstream-failure error frame instead of silently ending the stream", async () => {
      const { fetch } = sseFetch([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"error":{"message":"Upstream request failed: [server_error] The model failed to generate a response.","type":"server_error"}}\n\n',
      ]);
      const client = new DeepSeekClient({
        apiKey: "public",
        baseUrl: "https://opencode.ai/zen/v1",
        allowMissingKey: true,
        fetch,
        retry: { maxAttempts: 1 },
      });

      const consume = async () => {
        for await (const _ of client.stream({
          model: "glm-5-free",
          messages: [{ role: "user", content: "hi" }],
        })) {
          /* drain */
        }
      };

      // server_error-classified → synthetic 500, provider-branded, with the
      // loop-replay metadata the responses-path failure carries.
      await expect(consume()).rejects.toMatchObject({
        message: expect.stringContaining(
          "OpenCode 500: Upstream request failed: [server_error] The model failed to generate a response.",
        ),
        phase: "stream_body_read",
        code: "server_error",
      });
    });

    it("maps a bare-string error frame to a 400-class error for non-server codes", async () => {
      const { fetch } = sseFetch(['data: {"error":"upstream exploded"}\n\n']);
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch,
        retry: { maxAttempts: 1 },
      });

      const consume = async () => {
        for await (const _ of client.stream({
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "hi" }],
        })) {
          /* drain */
        }
      };

      const err = (await consume().then(
        () => null,
        (e) => e as Record<string, unknown>,
      )) as Record<string, unknown> | null;
      expect(err?.message).toBe("DeepSeek 400: upstream exploded");
      expect(err?.phase).toBe("stream_body_read");
      // No code key at all when the frame carries none (spread omits it).
      expect("code" in (err as object)).toBe(false);
    });

    it("lets frames with a null error field pass through untouched", async () => {
      const { fetch } = sseFetch([
        'data: {"error":null}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{}}\n\n',
        "data: [DONE]\n\n",
      ]);
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch,
        retry: { maxAttempts: 1 },
      });

      const chunks: unknown[] = [];
      for await (const chunk of client.stream({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  function makeStreamThatErrors(error: Error): typeof fetch {
    return vi.fn(async () => {
      let callCount = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          callCount++;
          if (callCount === 1) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
            );
            return;
          }
          controller.error(error);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
  }

  describe("DeepSeekClient.stream() mid-stream error wrapping", () => {
    it("wraps body-reader errors with phase and original code", async () => {
      const err = Object.assign(new Error("terminated"), { code: "UND_ERR_ABORTED" });
      const fetch = makeStreamThatErrors(err);
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch,
        timeoutMs: 60_000,
        retry: { maxAttempts: 1 },
      });

      const chunks: any[] = [];
      const consume = async () => {
        for await (const chunk of client.stream({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
        })) {
          chunks.push(chunk);
        }
      };

      await expect(consume()).rejects.toMatchObject({
        message: expect.stringContaining("terminated"),
        phase: "stream_body_read",
        code: "UND_ERR_ABORTED",
      });
      expect(chunks).toHaveLength(1);
    });

    it("falls back to stream_body_read without code when error lacks one", async () => {
      const fetch = makeStreamThatErrors(new Error("network dropped"));
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch,
        timeoutMs: 60_000,
        retry: { maxAttempts: 1 },
      });

      const consume = async () => {
        for await (const _ of client.stream({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
        })) {
          /* drain */
        }
      };

      await expect(consume()).rejects.toMatchObject({
        phase: "stream_body_read",
        code: undefined,
      });
    });
  });
});

describe("client-stream-timeout", () => {
  /** Mock fetch that returns a streaming body which never completes until
   *  the request signal aborts. Sends one SSE keep-alive comment first so
   *  the response headers flush and the consumer enters the read loop. */
  function hangingStreamFetch(): { fetch: typeof fetch; calls: () => number } {
    let count = 0;
    const spy = vi.fn(async (_url: unknown, init: unknown) => {
      count++;
      const reqSignal = (init as RequestInit).signal as AbortSignal | null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
          if (!reqSignal) return;
          if (reqSignal.aborted) {
            controller.error(reqSignal.reason);
            return;
          }
          reqSignal.addEventListener(
            "abort",
            () => {
              try {
                controller.error(reqSignal.reason);
              } catch {
                /* controller already closed */
              }
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    return { fetch: spy as unknown as typeof fetch, calls: () => count };
  }

  /** Mock fetch whose JSON body promise never resolves until the request
   *  signal aborts. Used to cover the non-streaming chat() path. */
  function hangingJsonFetch(): typeof fetch {
    const spy = vi.fn(async (_url: unknown, init: unknown) => {
      const reqSignal = (init as RequestInit).signal as AbortSignal | null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!reqSignal) return;
          if (reqSignal.aborted) {
            controller.error(reqSignal.reason);
            return;
          }
          reqSignal.addEventListener(
            "abort",
            () => {
              try {
                controller.error(reqSignal.reason);
              } catch {
                /* controller already closed */
              }
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    return spy as unknown as typeof fetch;
  }

  describe("DeepSeekClient.stream() timeout with caller signal (issue #1535)", () => {
    it("aborts the stream when timeoutMs elapses even if the caller passed a signal", async () => {
      const { fetch } = hangingStreamFetch();
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch,
        timeoutMs: 50,
        retry: { maxAttempts: 1 },
      });

      const callerCtrl = new AbortController();
      const consume = async () => {
        for await (const _chunk of client.stream({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
          signal: callerCtrl.signal,
        })) {
          /* drain */
        }
      };

      await expect(consume()).rejects.toThrow(/timed out/i);
      expect(callerCtrl.signal.aborted).toBe(false);
    });

    it("caller's signal still aborts the stream", async () => {
      const { fetch } = hangingStreamFetch();
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch,
        timeoutMs: 60_000,
        retry: { maxAttempts: 1 },
      });

      const callerCtrl = new AbortController();
      const consume = async () => {
        for await (const _chunk of client.stream({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
          signal: callerCtrl.signal,
        })) {
          /* drain */
        }
      };

      const promise = consume();
      setTimeout(() => callerCtrl.abort(new Error("user pressed esc")), 30);
      await expect(promise).rejects.toThrow(/user pressed esc/);
    });
  });

  describe("DeepSeekClient.chat() timeout with caller signal", () => {
    it("aborts the request when timeoutMs elapses even if the caller passed a signal", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: hangingJsonFetch(),
        timeoutMs: 50,
        retry: { maxAttempts: 1 },
      });

      const callerCtrl = new AbortController();
      await expect(
        client.chat({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
          signal: callerCtrl.signal,
        }),
      ).rejects.toThrow(/timed out/i);
      expect(callerCtrl.signal.aborted).toBe(false);
    });
  });
});

describe("client-wait-status", () => {
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
});

// Codex backend (ChatGPT plan quota) transport — the endpoint speaks the OpenAI Responses API: payloads convert messages→input, responses parse from envelopes / SSE events (400 "Unsupported parameter: messages").
describe("client-responses", () => {
  const CODEX_TRANSPORT: ResolvedTransport = {
    endpoint: "https://chatgpt.com/backend-api/codex/responses",
    headers: { Authorization: "Bearer oauth", "ChatGPT-Account-Id": "acct-1" },
    api: "responses",
  };

  function codexClient(fetch: typeof fetch): DeepSeekClient {
    return new DeepSeekClient({
      baseUrl: "https://api.openai.com/v1",
      fetch,
      transportResolver: async () => CODEX_TRANSPORT,
      retry: { maxAttempts: 1 },
    });
  }

  function sseFetch(events: string[]): typeof fetch {
    return vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const ev of events) controller.enqueue(new TextEncoder().encode(ev));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
  }

  describe("Responses payload conversion (codex backend)", () => {
    it("sends input/instructions/flat tools/reasoning.effort — never chat-completions fields", async () => {
      const spy = vi.fn(
        async () =>
          new Response(JSON.stringify({ output: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = codexClient(spy as unknown as typeof fetch);
      await client.chat({
        model: "gpt-5.6-sol",
        messages: [
          { role: "system", content: "you are a coding agent" },
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.ts"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "file contents" },
          { role: "user", content: "thanks" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        reasoningEffort: "high",
        maxTokens: 500,
        temperature: 0.2,
        thinking: "enabled",
      });
      const [url, init] = spy.mock.calls[0]!;
      expect(String(url)).toBe(CODEX_TRANSPORT.endpoint);
      expect((init!.headers as Record<string, string>)["ChatGPT-Account-Id"]).toBe("acct-1");
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      expect(body.messages).toBeUndefined();
      expect(body.stream_options).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
      expect(body.temperature).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.extra_body).toBeUndefined();
      expect(body.store).toBe(false);
      expect(body.instructions).toBe("you are a coding agent");
      expect(body.reasoning).toEqual({ effort: "high", summary: "concise" });
      expect(body.tools).toEqual([
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
          // gpt-* models must not burst parallel tool calls — one call per
          // response so the loop feeds each result back before the next round.
          parallel_tool_calls: false,
        },
      ]);
      expect(body.input).toEqual([
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "assistant", content: "" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"a.ts"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "file contents" },
        { type: "message", role: "user", content: "thanks" },
      ]);
    });

    it("maps image parts to input_image with a bare URL string", async () => {
      const spy = vi.fn(
        async () =>
          new Response(JSON.stringify({ output: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = codexClient(spy as unknown as typeof fetch);
      await client.chat({
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAAA", detail: "low" },
              },
            ],
          },
        ],
      });
      const [, init] = spy.mock.calls[0]!;
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      expect(body.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what is this?" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" },
          ],
        },
      ]);
    });

    it("keeps chat-completions payloads for non-responses transports (DeepSeek regression)", async () => {
      const spy = vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com",
        fetch: spy as unknown as typeof fetch,
        retry: { maxAttempts: 1 },
      });
      await client.chat({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
        thinking: "enabled",
      });
      const [, init] = spy.mock.calls[0]!;
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      expect(body.input).toBeUndefined();
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      expect(body.thinking).toEqual({ type: "enabled" });
    });
  });

  describe("Responses chat() → internal streaming (Codex requires stream:true)", () => {
    it("collects streamed output into a ChatResponse: text, reasoning, tool calls, usage", async () => {
      const client = codexClient(
        sseFetch([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_9","name":"edit_file","arguments":""}}\n\n',
          'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking about it"}\n\n',
          'data: {"type":"response.output_text.delta","delta":"the answer"}\n\n',
          'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":\\"a.ts\\"}"}\n\n',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_9","name":"edit_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":40}}}}\n\n',
        ]),
      );
      const resp = await client.chat({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(resp.content).toBe("the answer");
      expect(resp.reasoningContent).toBe("thinking about it");
      expect(resp.toolCalls).toEqual([
        {
          id: "call_9",
          type: "function",
          function: { name: "edit_file", arguments: '{"path":"a.ts"}' },
        },
      ]);
      expect(resp.usage.promptTokens).toBe(100);
      expect(resp.usage.completionTokens).toBe(20);
      expect(resp.usage.totalTokens).toBe(120);
      expect(resp.usage.promptCacheHitTokens).toBe(40);
    });

    it("throws a formatted error on response.failed", async () => {
      const client = codexClient(
        sseFetch([
          'data: {"type":"response.failed","code":"invalid_prompt","message":"quota exceeded"}\n\n',
        ]),
      );
      await expect(
        client.chat({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(/^OpenAI 400: quota exceeded/);
    });

    it("preserves server_error metadata from response.failed", async () => {
      const client = codexClient(
        sseFetch([
          'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"An error occurred while processing your request."}}}\n\n',
        ]),
      );

      await expect(
        client.chat({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/^OpenAI 500: .*\(server_error\)$/),
        code: "server_error",
        phase: "stream_body_read",
      });
    });
  });

  describe("Responses streaming", () => {
    it("maps output_text / reasoning_summary_text deltas, tool-call deltas and completed usage", async () => {
      const client = codexClient(
        sseFetch([
          'data: {"type":"response.created"}\n\n',
          'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"read_file","arguments":""}}\n\n',
          'data: {"type":"response.reasoning_summary_text.delta","delta":"let me check"}\n\n',
          'data: {"type":"response.output_text.delta","delta":"looking"}\n\n',
          'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"path\\":\\"a.ts\\"}"}\n\n',
          'data: {"type":"response.output_text.delta","delta":" up"}\n\n',
          'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":50,"output_tokens":5,"total_tokens":55,"input_tokens_details":{"cached_tokens":10}}}}\n\n',
        ]),
      );
      const chunks: any[] = [];
      for await (const c of client.stream({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(c);
      }
      const text = chunks
        .map((c) => c.contentDelta)
        .filter(Boolean)
        .join("");
      expect(text).toBe("looking up");
      expect(
        chunks
          .map((c) => c.reasoningDelta)
          .filter(Boolean)
          .join(""),
      ).toBe("let me check");
      // Tool calls arrive as a name-bearing `.added` chunk plus argument deltas
      // — accumulate exactly like the loop consumer does.
      const tcs = chunks.map((c) => c.toolCallDelta).filter(Boolean);
      expect(tcs[0]).toMatchObject({ index: 1, id: "call_1", name: "read_file" });
      expect(tcs.map((t) => t.argumentsDelta ?? "").join("")).toBe('{"path":"a.ts"}');
      const last = chunks.at(-1);
      expect(last?.usage?.promptTokens).toBe(50);
      expect(last?.usage?.promptCacheHitTokens).toBe(10);
      expect(last?.finishReason).toBe("stop");
    });

    it("falls back to the output_item.done snapshot when no argument deltas arrive", async () => {
      const client = codexClient(
        sseFetch([
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_2","name":"search","arguments":"{\\"q\\":\\"x\\"}"}}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ]),
      );
      const chunks: any[] = [];
      for await (const c of client.stream({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(c);
      }
      expect(chunks.find((c) => c.toolCallDelta)?.toolCallDelta).toEqual({
        index: 0,
        id: "call_2",
        name: "search",
        argumentsDelta: '{"q":"x"}',
      });
    });

    it("throws the nested provider error on response.failed", async () => {
      const client = codexClient(
        sseFetch([
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          'data: {"type":"response.failed","response":{"error":{"code":"invalid_prompt","message":"prompt is not allowed"}}}\n\n',
        ]),
      );
      const chunks: any[] = [];
      await expect(async () => {
        for await (const c of client.stream({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "hi" }],
        })) {
          chunks.push(c);
        }
      }).rejects.toThrow(/^OpenAI 400: prompt is not allowed \(invalid_prompt\)$/);
      expect(chunks.some((c) => c.contentDelta === "partial")).toBe(true);
    });

    it.each([
      [
        "top-level compatibility",
        { code: "invalid_prompt", message: "legacy failure" },
        "OpenAI 400: legacy failure (invalid_prompt)",
      ],
      [
        "nested message only",
        { response: { error: { message: "model unavailable" } } },
        "OpenAI 400: model unavailable",
      ],
      ["malformed nested error", { response: { error: "unknown" } }, "OpenAI 400: response failed"],
    ])("formats %s response.failed details", async (_name, failure, expected) => {
      const client = codexClient(
        sseFetch([`data: ${JSON.stringify({ type: "response.failed", ...failure })}\n\n`]),
      );

      await expect(async () => {
        for await (const _chunk of client.stream({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "hi" }],
        })) {
          // Consume the stream so its terminal failure is raised.
        }
      }).rejects.toThrow(expected);
    });

    it("marks incomplete streams with finishReason incomplete", async () => {
      const client = codexClient(
        sseFetch([
          'data: {"type":"response.incomplete"}\n\n',
          'data: {"type":"response.completed","response":{"status":"incomplete"}}\n\n',
        ]),
      );
      const chunks: any[] = [];
      for await (const c of client.stream({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(c);
      }
      expect(chunks.filter((c) => c.finishReason).map((c) => c.finishReason)).toEqual([
        "incomplete",
        "incomplete",
      ]);
    });
  });

  describe("MiMo Responses payload (provider=mimo)", () => {
    const MIMO_TRANSPORT: ResolvedTransport = {
      endpoint: "https://api.xiaomimimo.com/v1/responses",
      headers: { Authorization: "Bearer mkey" },
      api: "responses",
    };

    function mimoResponsesClient(fetch: typeof fetch): DeepSeekClient {
      return new DeepSeekClient({
        apiKey: "mkey",
        baseUrl: "https://api.xiaomimimo.com/v1",
        fetch,
        transportResolver: async () => MIMO_TRANSPORT,
        retry: { maxAttempts: 1 },
      });
    }

    const okFetch = () =>
      vi.fn(
        async () =>
          new Response(JSON.stringify({ output: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

    it("omits Codex-only fields and leaves reasoning enabled by default", async () => {
      const spy = okFetch();
      const client = mimoResponsesClient(spy as unknown as typeof fetch);
      await client.chat({
        model: "mimo-v2.6-pro",
        messages: [{ role: "user", content: "hi" }],
        thinking: "enabled",
        tools: [
          {
            type: "function",
            function: {
              name: "noop",
              description: "noop",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      });
      const [url, init] = spy.mock.calls[0]!;
      expect(String(url)).toBe(MIMO_TRANSPORT.endpoint);
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      expect(body.messages).toBeUndefined();
      expect(body.store).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
      expect(body.tools).toEqual([
        {
          type: "function",
          name: "noop",
          description: "noop",
          parameters: { type: "object", properties: {} },
        },
      ]);
      expect(body.input).toEqual([{ type: "message", role: "user", content: "hi" }]);
    });

    it("maps thinking=disabled to reasoning.effort=none", async () => {
      const spy = okFetch();
      const client = mimoResponsesClient(spy as unknown as typeof fetch);
      await client.chat({
        model: "mimo-v2.6-pro",
        messages: [{ role: "user", content: "hi" }],
        thinking: "disabled",
      });
      const [, init] = spy.mock.calls[0]!;
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      expect(body.reasoning).toEqual({ effort: "none" });
      expect(body.store).toBeUndefined();
    });

    it("reads cached tokens from MiMo Responses usage (input_tokens_details.cached_tokens)", async () => {
      const client = mimoResponsesClient(
        sseFetch([
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":200,"output_tokens":10,"total_tokens":210,"input_tokens_details":{"cached_tokens":150}}}}\n\n',
        ]),
      );
      const resp = await client.chat({
        model: "mimo-v2.6-pro",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(resp.usage.promptTokens).toBe(200);
      expect(resp.usage.promptCacheHitTokens).toBe(150);
      expect(resp.usage.promptCacheMissTokens).toBe(50);
    });
  });
});

// Native `/api/chat` transport for the Ollama provider: payload shape,
// *  non-stream + NDJSON stream parsing, cache-hit inference, num_ctx probe.
describe("client-ollama-native", () => {
  const savedKeepAlive = process.env.OLLAMA_KEEP_ALIVE;
  const savedNumCtx = process.env.OLLAMA_NUM_CTX;
  const savedTemperature = process.env.OLLAMA_TEMPERATURE;
  const savedReasonixConfig = process.env.REASONIX_CONFIG;
  const testConfigPath = join(tmpdir(), "reasonix-test-empty-config.json");

  beforeEach(() => {
    process.env.OLLAMA_KEEP_ALIVE = "30m";
    process.env.OLLAMA_NUM_CTX = "8192";
    // biome-ignore lint/performance/noDelete: persisted settings must win in live-reload tests
    delete process.env.OLLAMA_TEMPERATURE;
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
    if (savedKeepAlive === undefined) {
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_KEEP_ALIVE;
    } else {
      process.env.OLLAMA_KEEP_ALIVE = savedKeepAlive;
    }
    if (savedNumCtx === undefined) {
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_NUM_CTX;
    } else {
      process.env.OLLAMA_NUM_CTX = savedNumCtx;
    }
    if (savedTemperature === undefined) {
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_TEMPERATURE;
    } else {
      process.env.OLLAMA_TEMPERATURE = savedTemperature;
    }
  });

  /** Route by URL: /api/show → `show`, everything else → `chat`. */
  function mockOllamaFetch(
    chat: unknown,
    show?: unknown,
  ): { fetch: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (show !== undefined && u.includes("/api/show")) {
        return new Response(JSON.stringify(show), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(typeof chat === "string" ? chat : JSON.stringify(chat), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetch, calls };
  }

  function nativeChatResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: "qwen3:32b",
      message: { role: "assistant", content: "ok" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 500,
      eval_count: 2,
      prompt_eval_duration: 5_000_000,
      eval_duration: 2_000_000,
      load_duration: 10_000_000,
      ...overrides,
    };
  }

  describe("ollama native payload", () => {
    it("posts to /api/chat on the native origin, stripping /v1", async () => {
      const { fetch, calls } = mockOllamaFetch(nativeChatResponse());
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(calls[calls.length - 1]).toBe("http://localhost:11434/api/chat");
    });

    it("maps generation settings and request overrides into native options", async () => {
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init as RequestInit;
        return new Response(JSON.stringify(nativeChatResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "https://ollama.example.com",
        apiKey: "sk-cloud",
        fetch,
      });
      await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.5,
        maxTokens: 200,
        ollama: {
          topP: 0.85,
          minP: 0.05,
          seed: 42,
          repeatPenalty: 1.4,
          frequencyPenalty: 0.2,
          presencePenalty: 0.1,
          topK: 60,
          repeatLastN: 256,
          keepAlive: "1h",
        },
      });
      const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
      expect(body.model).toBe("qwen3:32b");
      expect(body.keep_alive).toBe("1h");
      expect(body.options).toEqual({
        num_predict: 200,
        temperature: 0.5,
        top_p: 0.85,
        min_p: 0.05,
        seed: 42,
        num_ctx: 8192,
        repeat_penalty: 1.4,
        frequency_penalty: 0.2,
        presence_penalty: 0.1,
        top_k: 60,
        repeat_last_n: 256,
      });
    });

    it("reloads modified generation settings for the current client on its next request", async () => {
      const capturedBodies: Array<Record<string, unknown>> = [];
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify(nativeChatResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      const request = {
        model: "ollama/qwen3:32b",
        messages: [{ role: "user" as const, content: "hi" }],
      };

      saveOllamaGenerationPatch({ temperature: 0.2, topP: 0.9 }, testConfigPath);
      await client.chat(request);
      saveOllamaGenerationPatch({ temperature: 1.7, topP: 0.2 }, testConfigPath);
      await client.chat(request);

      expect(capturedBodies[0]?.options).toMatchObject({ temperature: 0.2, top_p: 0.9 });
      expect(capturedBodies[1]?.options).toMatchObject({ temperature: 1.7, top_p: 0.2 });
    });

    it("converts image parts to native images and tool-call args to objects", async () => {
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init as RequestInit;
        return new Response(JSON.stringify(nativeChatResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      await client.chat({
        model: "ollama/llava",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,QUFBQQ==" } },
            ],
          },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.ts"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", name: "read_file", content: "42" },
        ],
      });
      const body = JSON.parse(String(capturedInit!.body)) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(body.messages[0]).toEqual({
        role: "user",
        content: "what is this?",
        images: ["QUFBQQ=="],
      });
      expect(body.messages[1]!.tool_calls).toEqual([
        { function: { name: "read_file", arguments: { path: "a.ts" } } },
      ]);
      expect(body.messages[2]).toEqual({
        role: "tool",
        tool_call_id: "call_1",
        tool_name: "read_file",
        content: "42",
      });
    });

    it("forwards repeat_penalty, frequency_penalty, presence_penalty, top_k, repeat_last_n when configured via env", async () => {
      process.env.OLLAMA_REPEAT_PENALTY = "1.3";
      process.env.OLLAMA_FREQUENCY_PENALTY = "0.5";
      process.env.OLLAMA_PRESENCE_PENALTY = "0.4";
      process.env.OLLAMA_TOP_K = "50";
      process.env.OLLAMA_REPEAT_LAST_N = "128";
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init as RequestInit;
        return new Response(JSON.stringify(nativeChatResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
      });
      const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
      const options = body.options as Record<string, unknown>;
      expect(options.repeat_penalty).toBe(1.3);
      expect(options.frequency_penalty).toBe(0.5);
      expect(options.presence_penalty).toBe(0.4);
      expect(options.top_k).toBe(50);
      expect(options.repeat_last_n).toBe(128);
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_REPEAT_PENALTY;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_FREQUENCY_PENALTY;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_PRESENCE_PENALTY;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_TOP_K;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_REPEAT_LAST_N;
    });

    it("omits sampling penalty options and top_k from payload when unconfigured so model defaults apply", async () => {
      // Ensure no env vars leak into this test.
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_REPEAT_PENALTY;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_FREQUENCY_PENALTY;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_PRESENCE_PENALTY;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_TOP_K;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.OLLAMA_REPEAT_LAST_N;
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init as RequestInit;
        return new Response(JSON.stringify(nativeChatResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
      });
      const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
      const options = (body.options ?? {}) as Record<string, unknown>;
      expect(options.repeat_penalty).toBeUndefined();
      expect(options.frequency_penalty).toBeUndefined();
      expect(options.presence_penalty).toBeUndefined();
      expect(options.top_k).toBeUndefined();
      expect(options.repeat_last_n).toBeUndefined();
    });

    it("maps thinking/effort to native think and responseFormat to format json", async () => {
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init as RequestInit;
        return new Response(JSON.stringify(nativeChatResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
        thinking: "enabled",
        responseFormat: { type: "json_object" },
      });
      const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
      expect(body.think).toBe(true);
      expect(body.format).toBe("json");
    });
  });

  describe("ollama native non-stream response", () => {
    it("parses message/thinking/tool_calls and metrics into Usage", async () => {
      const { fetch } = mockOllamaFetch(
        nativeChatResponse({
          message: {
            role: "assistant",
            content: "done",
            thinking: "let me think",
            tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }],
          },
        }),
      );
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      const res = await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.content).toBe("done");
      expect(res.reasoningContent).toBe("let me think");
      expect(res.toolCalls).toEqual([
        {
          id: undefined,
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ]);
      expect(res.usage.promptTokens).toBe(500);
      expect(res.usage.completionTokens).toBe(2);
      expect(res.usage.promptEvalDurationMs).toBe(5);
      expect(res.usage.evalDurationMs).toBe(2);
      expect(res.usage.loadDurationMs).toBe(10);
    });
  });

  describe("ollama native NDJSON stream", () => {
    it("accumulates content/thinking deltas, tool calls and the done-chunk metrics", async () => {
      const lines = [
        { model: "qwen3:32b", message: { role: "assistant", content: "Hel" }, done: false },
        { model: "qwen3:32b", message: { role: "assistant", content: "lo" }, done: false },
        {
          model: "qwen3:32b",
          message: {
            role: "assistant",
            tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }],
          },
          done: false,
        },
        {
          model: "qwen3:32b",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 500,
          eval_count: 2,
          prompt_eval_duration: 5_000_000,
        },
      ];
      const { fetch } = mockOllamaFetch(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      const chunks: Array<{
        contentDelta?: string;
        toolCallDelta?: unknown;
        finishReason?: string;
      }> = [];
      let usage: Usage | null = null;
      for await (const chunk of client.stream({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
        if (chunk.usage) usage = chunk.usage;
      }
      const deltas = chunks.map((c) => c.contentDelta).filter((d) => d !== undefined);
      expect(deltas).toEqual(["Hel", "lo"]);
      const toolChunk = chunks.find((c) => c.toolCallDelta);
      expect(toolChunk!.toolCallDelta).toEqual({
        index: 0,
        id: undefined,
        name: "read_file",
        argumentsDelta: '{"path":"a.ts"}',
      });
      const doneChunk = chunks.find((c) => c.finishReason !== undefined);
      expect(doneChunk!.finishReason).toBe("stop");
      expect(usage).not.toBeNull();
      expect(usage!.promptTokens).toBe(500);
      expect(usage!.completionTokens).toBe(2);
      expect(usage!.promptEvalDurationMs).toBe(5);
    });

    it("rejects a stream that EOFs without the done:true completion frame", async () => {
      const truncated = [
        { model: "qwen3:32b", message: { role: "assistant", content: "partial" }, done: false },
      ];
      const { fetch } = mockOllamaFetch(`${truncated.map((l) => JSON.stringify(l)).join("\n")}\n`);
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      const consume = async () => {
        for await (const _ of client.stream({
          model: "ollama/qwen3:32b",
          messages: [{ role: "user", content: "hi" }],
        })) {
          /* drain */
        }
      };
      await expect(consume()).rejects.toMatchObject({
        message: expect.stringContaining(
          "Ollama stream terminated before the `done` completion frame",
        ),
        phase: "stream_body_read",
      });
    });

    it("tags a mid-stream body read failure as stream_body_read", async () => {
      const readErr = Object.assign(new Error("terminated"), { code: "UND_ERR_ABORTED" });
      let callCount = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          callCount++;
          if (callCount === 1) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"model":"qwen3:32b","message":{"role":"assistant","content":"hi"},"done":false}\n',
              ),
            );
            return;
          }
          controller.error(readErr);
        },
      });
      const fetch = vi.fn(async () => {
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      const consume = async () => {
        for await (const _ of client.stream({
          model: "ollama/qwen3:32b",
          messages: [{ role: "user", content: "hi" }],
        })) {
          /* drain */
        }
      };
      await expect(consume()).rejects.toMatchObject({
        message: expect.stringContaining("Ollama stream body read failed: terminated"),
        phase: "stream_body_read",
        code: "UND_ERR_ABORTED",
      });
    });
  });

  describe("ollama cache-hit inference", () => {
    it("reports hits for a shared message prefix and drops them after a fold", async () => {
      const { fetch } = mockOllamaFetch(nativeChatResponse());
      const client = new DeepSeekClient({
        baseUrl: "http://localhost:11434/v1",
        allowMissingKey: true,
        fetch,
      });
      const system = { role: "system" as const, content: "you are a coding agent" };
      const first = await client.chat({
        model: "ollama/qwen3:32b",
        messages: [system, { role: "user", content: "hi" }],
      });
      // First request: no previous prefix to reuse.
      expect(first.usage.promptCacheHitTokens).toBe(0);

      const second = await client.chat({
        model: "ollama/qwen3:32b",
        messages: [
          system,
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "now read a.ts" },
        ],
      });
      // Shared prefix [system, user hi, assistant hello] is inferred as cached.
      expect(second.usage.promptCacheHitTokens).toBeGreaterThan(0);
      expect(second.usage.promptCacheHitTokens).toBeLessThan(second.usage.promptTokens);
      expect(second.usage.promptCacheMissTokens).toBeLessThan(second.usage.promptTokens);

      const preFold = await client.chat({
        model: "ollama/qwen3:32b",
        messages: [
          system,
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "now read a.ts" },
          { role: "assistant", content: "sure" },
          { role: "user", content: "and now?" },
          { role: "assistant", content: "done" },
          { role: "user", content: "next" },
        ],
      });
      const preFoldHit = preFold.usage.promptCacheHitTokens;
      // A fold replaces the conversation head with a summary — the shared prefix
      // with the previous request shrinks to the 5 matching head messages, and
      // the inferred hit count is exactly the token estimate of that prefix.
      const foldedMessages = [
        system,
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "now read a.ts" },
        { role: "assistant", content: "sure" },
        { role: "user", content: "[summary of earlier turns]" },
        { role: "assistant", content: "done" },
        { role: "user", content: "next" },
      ] as const;
      const folded = await client.chat({
        model: "ollama/qwen3:32b",
        messages: [...foldedMessages],
      });
      expect(folded.usage.promptCacheHitTokens).toBe(
        estimateRequestTokens(foldedMessages.slice(0, 5), undefined),
      );
      expect(folded.usage.promptCacheHitTokens).toBeGreaterThan(0);
      expect(folded.usage.promptCacheHitTokens).toBeLessThan(folded.usage.promptTokens);
      // Sanity: the fold's shared prefix (5 messages) is shorter than the prior
      // turn's (7 messages) — the estimate reflects the overlap, not the size of
      // the whole prompt.
      void preFoldHit;
    });
  });

  describe("ollama num_ctx learning", () => {
    it("probes /api/show once, caches the window, and sends it as options.num_ctx", async () => {
      // biome-ignore lint/performance/noDelete: test needs the env unset
      delete process.env.OLLAMA_NUM_CTX;
      const showCalls: string[] = [];
      const capturedBodies: Array<Record<string, unknown>> = [];
      const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("/api/show")) {
          showCalls.push(String(url));
          return new Response(JSON.stringify({ model_info: { "llama.context_length": 131072 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify(nativeChatResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "https://ollama.example.com",
        apiKey: "sk-cloud",
        fetch,
      });
      await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
      });
      await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(capturedBodies).toHaveLength(2);
      expect(capturedBodies[0]!.options).toEqual({
        num_ctx: 131072,
      });
      expect(showCalls).toHaveLength(1);
    });

    it("falls back to DEFAULT_CONTEXT_TOKENS (131072) when /api/show is unavailable", async () => {
      // biome-ignore lint/performance/noDelete: test needs the env unset
      delete process.env.OLLAMA_NUM_CTX;
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("/api/show")) {
          return new Response("not found", { status: 404 });
        }
        capturedInit = init as RequestInit;
        return new Response(JSON.stringify(nativeChatResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "https://ollama.example.com",
        apiKey: "sk-cloud",
        fetch,
      });
      await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
      });
      const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
      expect(body.options).toEqual({
        num_ctx: 131072,
      });
    });

    it("retains assistant messages with reasoning_content when content is empty", async () => {
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init as RequestInit;
        return new Response(JSON.stringify(nativeChatResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "https://ollama.example.com",
        apiKey: "sk-cloud",
        fetch,
      });
      await client.chat({
        model: "ollama/deepseek-v4-flash",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "", reasoning_content: "thinking about it" },
          { role: "assistant", content: "" }, // completely empty, should be dropped
        ],
      });
      const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe("user");
      expect(messages[1]!.role).toBe("assistant");
      expect(messages[1]!.thinking).toBe("thinking about it");
    });
  });
});

// Provider-qualified model references (`<provider>/<id>`) are client-side
// *  routing syntax: every wire payload must carry the bare id.
describe("client-qualified-model", () => {
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
});

describe("client-synthetic-marker", () => {
  describe("synthetic user-record marker", () => {
    it("strips the marker at the wire boundary and keeps message content", async () => {
      const { client, captured } = makeFakeClient([{ content: "ok" }]);
      await client.chat({
        model: "deepseek-v4-flash",
        messages: [
          { role: "user", content: "mid-turn steer", synthetic: true },
          { role: "user", content: "real prompt" },
        ],
      });
      expect(captured).toHaveLength(1);
      for (const message of captured[0]!.messages) {
        expect("synthetic" in message).toBe(false);
      }
      expect(captured[0]!.messages.map((m) => m.content)).toEqual([
        "mid-turn steer",
        "real prompt",
      ]);
    });

    it("strips the transcript stamp at the wire boundary", async () => {
      const { client, captured } = makeFakeClient([{ content: "ok" }]);
      await client.chat({
        model: "deepseek-v4-flash",
        messages: [
          { role: "user", content: "when was this asked", ts: 1_700_000_000_000 },
          { role: "assistant", content: "just now", ts: 1_700_000_001_000 },
        ],
      });
      expect(captured).toHaveLength(1);
      for (const message of captured[0]!.messages) {
        expect("ts" in message).toBe(false);
      }
      expect(captured[0]!.messages.map((m) => m.content)).toEqual([
        "when was this asked",
        "just now",
      ]);
    });

    it("strips the producing model at the wire boundary", async () => {
      const { client, captured } = makeFakeClient([{ content: "ok" }]);
      await client.chat({
        model: "deepseek-v4-flash",
        messages: [
          { role: "user", content: "who answered" },
          { role: "assistant", content: "this model", model: "deepseek-v4-pro" },
        ],
      });
      expect(captured).toHaveLength(1);
      for (const message of captured[0]!.messages) {
        expect("model" in message).toBe(false);
      }
    });

    it("leaves marker-free messages untouched (fast path)", () => {
      const messages = [
        { role: "user" as const, content: "a" },
        { role: "assistant" as const, content: "b" },
      ];
      const out = stripTranscriptMarkers(messages);
      expect(out).toEqual(messages);
      expect(out).not.toBe(messages);
    });

    it("strips the marker while preserving other message fields", () => {
      const out = stripTranscriptMarkers([
        { role: "user", content: "nudge", name: "nudge-name", synthetic: true },
      ]);
      expect(out).toEqual([{ role: "user", content: "nudge", name: "nudge-name" }]);
    });
  });
});
