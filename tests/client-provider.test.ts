// Consolidated from 8 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { providerDeclared } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient, Usage } from "../src/client.js";
import { isThinkingModeModel, thinkingModeForModel } from "../src/loop/thinking.js";
import type { ChatMessage } from "../src/types.js";
import { makeFakeClient } from "./support/fake-client.js";

describe("client-deepseek-message-ids", () => {
  /** History that round-trips both message kinds the DeepSeek deserializer
   *  demands ids for: an assistant message carrying tool_calls, and the
   *  matching tool result. */
  const HISTORY: ChatMessage[] = [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call-1", name: "read_file", content: "contents" },
  ];

  describe("DeepSeek wire-path message ids", () => {
    it("stamps msg-<index> ids on assistant/tool messages for deepseek requests", async () => {
      const { client, captured } = makeFakeClient([{ content: "done" }]);
      await client.chat({
        model: "deepseek-v4-flash",
        messages: [...HISTORY, { role: "assistant", content: "final answer" }],
        tools: [],
      });

      const sent = captured[0]?.messages ?? [];
      expect(sent.length).toBe(4);
      sent.forEach((m, i) => {
        if (m.role === "assistant" || m.role === "tool") {
          expect(m.id, `role ${m.role} at ${i}`).toBe(`msg-${i}`);
        } else {
          expect(m.id).toBeUndefined();
        }
      });
    });

    it("leaves existing ids untouched", async () => {
      const { client, captured } = makeFakeClient([{ content: "done" }]);
      await client.chat({
        model: "deepseek-v4-flash",
        messages: [{ ...HISTORY[0]!, id: "keep-me" }],
        tools: [],
      });
      expect(captured[0]?.messages[0]?.id).toBe("keep-me");
    });

    it("does not stamp ids for other providers", async () => {
      const { client, captured } = makeFakeClient([{ content: "done" }]);
      await client.chat({
        model: "glm-5.3",
        messages: HISTORY,
        tools: [],
      });
      for (const m of captured[0]?.messages ?? []) {
        expect(m.id).toBeUndefined();
      }
    });

    it("keeps ids deterministic across repeated sends of the same log state", async () => {
      const first = makeFakeClient([{ content: "done" }]);
      const second = makeFakeClient([{ content: "done" }]);
      await first.client.chat({ model: "deepseek-v4-flash", messages: HISTORY, tools: [] });
      await second.client.chat({ model: "deepseek-v4-flash", messages: HISTORY, tools: [] });
      expect(first.captured[0]?.messages.map((m) => m.id)).toEqual(
        second.captured[0]?.messages.map((m) => m.id),
      );
    });
  });
});

// Experiential Labs gateway chat: it refuses unknown fields (400,
// *  unsupported_parameter), and forwards reasoning effort by its own policy.
describe("client-experiential", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  describe.skipIf(!providerDeclared("experiential"))("Experiential Labs gateway chat", () => {
    it("never sends a thinking toggle, strips the qualifier, and forwards a supported effort", async () => {
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
      // The gateway forwards an effort its route supports; it never invents one.
      expect(body.reasoning_effort).toBe("high");
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

    it("sends image tool feedback without the injected transcript marker", async () => {
      let init: RequestInit | undefined;
      const fetch = vi.fn(async (_input, requestInit) => {
        init = requestInit as RequestInit;
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "xpl-test-key",
        baseUrl: "https://api.experientiallabs.ai/v1",
        fetch,
      });

      // A see_image result arrives as a machine-written user record. The gateway
      // validates the message schema strictly and 400s the key by name
      // ("Invalid value for 'messages.2.injected'"), so it may never be sent.
      await client.chat({
        model: "experiential/deepseek-v4.1-flash-1017",
        messages: [
          { role: "user", content: "look at the screenshot" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "see_image", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", name: "see_image", content: "[image]" },
          {
            role: "user",
            injected: true,
            content: [
              { type: "text", text: "see_image result" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      });

      const body = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
      expect(body.messages.some((message) => "injected" in message)).toBe(false);
      // The pixels the record exists to deliver must survive the strip.
      expect(body.messages.at(-1)?.content).toEqual([
        { type: "text", text: "see_image result" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ]);
    });

    it("still sends the thinking toggle for the same model id routed to its native provider", async () => {
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
      expect(body.thinking).toEqual({ type: "enabled" });
    });
  });
});

// Gemini provider (Antigravity/Cloud Code API): payload shape, wrapped
// *  response parsing, and SSE streaming.
describe("client-gemini", () => {
  const auth = { accessToken: "google-token", projectId: "proj-123" };

  function geminiClient(fetch: typeof fetch): DeepSeekClient {
    return new DeepSeekClient({
      baseUrl: "https://cloudcode-pa.googleapis.com",
      allowMissingKey: true,
      geminiAuthResolver: async () => auth,
      fetch,
    });
  }

  function wrappedResponse(parts: unknown[], usage?: unknown): unknown {
    return {
      response: {
        candidates: [{ content: { parts }, finishReason: "STOP" }],
        usageMetadata: usage ?? {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("gemini payload", () => {
    it("posts to /v1internal:generateContent with contents + systemInstruction + tools", async () => {
      let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
      const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        captured = {
          url: String(url),
          body: JSON.parse(init?.body as string),
          headers: (init?.headers ?? {}) as Record<string, string>,
        };
        return new Response(JSON.stringify(wrappedResponse([{ text: "hi" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-2.5-flash",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hello" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "read a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      });

      expect(captured?.url).toBe(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
      );
      expect(captured?.headers.authorization).toBe("Bearer google-token");
      expect(captured?.headers["user-agent"]).toBe("antigravity");
      const body = captured?.body as {
        model: string;
        project: string;
        user_prompt_id: string;
        request: {
          contents: unknown[];
          systemInstruction: unknown;
          tools: unknown[];
          toolConfig: unknown;
        };
      };
      expect(body.model).toBe("gemini-2.5-flash");
      expect(body.project).toBe("proj-123");
      expect(body.user_prompt_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.request.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
      expect(body.request.systemInstruction).toEqual({
        role: "user",
        parts: [{ text: "be brief" }],
      });
      expect(body.request.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: "read",
              description: "read a file",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ]);
      expect(body.request.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
      expect(res.content).toBe("hi");
      expect(res.usage.promptTokens).toBe(10);
      expect(res.usage.completionTokens).toBe(5);
    });

    it("wraps string and text-part tool outputs in structured function responses", async () => {
      const bodies: Array<{
        request: {
          contents: Array<{
            role: string;
            parts: Array<{
              functionResponse?: {
                name: string;
                response: unknown;
              };
            }>;
          }>;
        };
      }> = [];
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-2.5-flash",
        messages: [{ role: "tool", name: "list_directory", content: "a/\nb.txt" }],
      });
      await client.chat({
        model: "gemini-2.5-flash",
        messages: [
          {
            role: "tool",
            name: "read_file",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        ],
      });

      expect(bodies[0]?.request.contents).toEqual([
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "list_directory",
                response: { result: "a/\nb.txt" },
              },
            },
          ],
        },
      ]);
      expect(bodies[1]?.request.contents).toEqual([
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "read_file",
                response: { result: "first\nsecond" },
              },
            },
          ],
        },
      ]);
    });

    it("echoes a Gemini thoughtSignature back on the function call", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-3.1-flash-high",
        messages: [
          { role: "user", content: "use the tool" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-read-1",
                function: { name: "read_file", arguments: '{"path":"/a"}' },
                thoughtSignature: "signature-abc-123",
              },
            ],
          },
        ],
      });

      const contents = (captured as { request: { contents: unknown[] } }).request.contents;
      expect(contents[1]).toEqual({
        role: "model",
        parts: [
          {
            functionCall: { id: "call-read-1", name: "read_file", args: { path: "/a" } },
            thoughtSignature: "signature-abc-123",
          },
        ],
      });
    });

    it("backfills thoughtSignature to sibling parallel calls that lack one", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-3.1-flash-high",
        messages: [
          { role: "user", content: "search web and read file" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-1",
                function: { name: "web_search", arguments: '{"query":"reasonix"}' },
                thoughtSignature: "sig-parallel-1",
              },
              {
                id: "call-2",
                function: { name: "read_file", arguments: '{"path":"README.md"}' },
                // Missing thoughtSignature (e.g. Gemini 3 Flash parallel calls bug)
              },
            ],
          },
        ],
      });

      const contents = (
        captured as { request: { contents: Array<{ role: string; parts: unknown[] }> } }
      ).request.contents;
      expect(contents[1]?.parts).toEqual([
        {
          functionCall: { id: "call-1", name: "web_search", args: { query: "reasonix" } },
          thoughtSignature: "sig-parallel-1",
        },
        {
          functionCall: { id: "call-2", name: "read_file", args: { path: "README.md" } },
          thoughtSignature: "sig-parallel-1",
        },
      ]);
    });

    it("backfills thoughtSignature from conversation history when a prior call lacks one", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-3.1-flash-high",
        messages: [
          { role: "user", content: "search first" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-search",
                function: { name: "web_search", arguments: '{"query":"q"}' },
                // Lacks signature
              },
            ],
          },
          { role: "tool", name: "web_search", tool_call_id: "call-search", content: "res" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-read",
                function: { name: "read_file", arguments: '{"path":"a"}' },
                thoughtSignature: "sig-turn-2",
              },
            ],
          },
        ],
      });

      const contents = (
        captured as {
          request: {
            contents: Array<{ role: string; parts: Array<{ thoughtSignature?: string }> }>;
          };
        }
      ).request.contents;
      // Both assistant turns carry a thoughtSignature now so the API never 400s
      expect(contents[1]?.parts[0]?.thoughtSignature).toBe("sig-turn-2");
      expect(contents[3]?.parts[0]?.thoughtSignature).toBe("sig-turn-2");
    });

    it("emits the skip_thought_signature_validator sentinel when no signature exists anywhere", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-3.1-flash-high",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            tool_calls: [
              { id: "call-1", function: { name: "unreal_mcp_get_capabilities", arguments: "{}" } },
            ],
          },
          {
            role: "tool",
            name: "unreal_mcp_get_capabilities",
            tool_call_id: "call-1",
            content: "{}",
          },
        ],
      });

      const contents = (
        captured as {
          request: {
            contents: Array<{ role: string; parts: Array<{ thoughtSignature?: string }> }>;
          };
        }
      ).request.contents;
      // Gemini 3 400s on a bare functionCall part; the documented sentinel keeps
      // the request alive for history carried over from a non-signing source.
      expect(contents[1]?.parts[0]?.thoughtSignature).toBe("skip_thought_signature_validator");
    });

    it("never attaches a thoughtSignature sentinel to legacy Gemini 2.5 tool calls", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-2.5-flash",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            tool_calls: [{ id: "call-1", function: { name: "web_search", arguments: "{}" } }],
          },
          { role: "tool", name: "web_search", tool_call_id: "call-1", content: "r" },
        ],
      });

      const contents = (
        captured as {
          request: {
            contents: Array<{ role: string; parts: Array<{ thoughtSignature?: string }> }>;
          };
        }
      ).request.contents;
      expect(contents[1]?.parts[0]?.thoughtSignature).toBeUndefined();
    });

    it("accepts thought_signature snake_case on tool_calls", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-3.1-flash-high",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-1",
                function: { name: "web_search", arguments: "{}" },
                thought_signature: "sig-snake",
              } as any,
            ],
          },
        ],
      });

      const contents = (
        captured as {
          request: {
            contents: Array<{ role: string; parts: Array<{ thoughtSignature?: string }> }>;
          };
        }
      ).request.contents;
      expect(contents[1]?.parts[0]?.thoughtSignature).toBe("sig-snake");
    });

    it("coalesces parallel tool responses into one user turn", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-2.5-flash",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            tool_calls: [
              { id: "call-a", function: { name: "a", arguments: "{}" } },
              { id: "call-b", function: { name: "b", arguments: "{}" } },
            ],
          },
          { role: "tool", name: "a", tool_call_id: "call-a", content: "ra" },
          { role: "tool", name: "b", tool_call_id: "call-b", content: "rb" },
        ],
      });

      const contents = (captured as { request: { contents: unknown[] } }).request.contents;
      expect(contents).toEqual([
        { role: "user", parts: [{ text: "hi" }] },
        {
          role: "model",
          parts: [
            { functionCall: { id: "call-a", name: "a", args: {} } },
            { functionCall: { id: "call-b", name: "b", args: {} } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { id: "call-a", name: "a", response: { result: "ra" } } },
            { functionResponse: { id: "call-b", name: "b", response: { result: "rb" } } },
          ],
        },
      ]);
    });

    it("merges a tool response and a trailing user instruction into one user turn", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "summary" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-2.5-flash",
        messages: [
          { role: "user", content: "read the file" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-read",
                function: { name: "read_file", arguments: '{"path":"src/client.ts"}' },
              },
            ],
          },
          {
            role: "tool",
            name: "read_file",
            tool_call_id: "call-read",
            content: "file contents",
          },
          { role: "user", content: "Summarize the conversation." },
        ],
      });

      const contents = (captured as { request: { contents: unknown[] } }).request.contents;
      expect(contents).toEqual([
        { role: "user", parts: [{ text: "read the file" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call-read",
                name: "read_file",
                args: { path: "src/client.ts" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-read",
                name: "read_file",
                response: { result: "file contents" },
              },
            },
            { text: "Summarize the conversation." },
          ],
        },
      ]);
    });

    it("prepends a user turn when message history starts with an assistant turn", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-2.5-flash",
        messages: [
          { role: "assistant", content: "prior summary from fold" },
          { role: "user", content: "what next?" },
        ],
      });

      const contents = (
        captured as { request: { contents: Array<{ role: string; parts: unknown[] }> } }
      ).request.contents;
      expect(contents[0]?.role).toBe("user");
      expect(contents[0]?.parts).toEqual([{ text: "Continue the conversation." }]);
      expect(contents[1]?.role).toBe("model");
      expect(contents[1]?.parts).toEqual([{ text: "prior summary from fold" }]);
      expect(contents[2]?.role).toBe("user");
      expect(contents[2]?.parts).toEqual([{ text: "what next?" }]);
    });

    it("prepends a user turn when message history starts with an assistant function call", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-2.5-flash",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-1",
                function: { name: "read_file", arguments: '{"path":"foo.ts"}' },
              },
            ],
          },
          {
            role: "tool",
            name: "read_file",
            tool_call_id: "call-1",
            content: "file contents",
          },
          { role: "user", content: "Summarize." },
        ],
      });

      const contents = (
        captured as { request: { contents: Array<{ role: string; parts: unknown[] }> } }
      ).request.contents;
      // The first turn is normalized to user, so the model's functionCall turn
      // immediately follows a user turn instead of appearing at index 0.
      expect(contents[0]?.role).toBe("user");
      expect(contents[0]?.parts).toEqual([{ text: "Continue the conversation." }]);
      expect(contents[1]?.role).toBe("model");
      expect(contents[1]?.parts).toEqual([
        {
          functionCall: {
            id: "call-1",
            name: "read_file",
            args: { path: "foo.ts" },
          },
        },
      ]);
    });

    it("skips user contents with zero parts", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "" }] });

      const contents = (captured as { request: { contents: unknown[] } }).request.contents;
      expect(contents).toEqual([]);
    });

    it("omits optional generation config for fragile discovered models", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({ model: "gemini-3.7-flash", messages: [{ role: "user", content: "hi" }] });

      expect((captured as { request: Record<string, unknown> }).request).not.toHaveProperty(
        "generationConfig",
      );
    });

    it("routes an uncataloged id through the gemini wire when the endpoint is antigravity-configured", async () => {
      // The id matches no catalog, no discovery, and no config mapping: the name
      // says nothing about its provider. The client was CONSTRUCTED as an
      // Antigravity endpoint (geminiAuthResolver) — the endpoint config decides
      // the wire format, never the name.
      let captured: { url: string; body: unknown } | null = null;
      const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        captured = { url: String(url), body: JSON.parse(init?.body as string) };
        return new Response(JSON.stringify(wrappedResponse([{ text: "ok" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "some-gateway-model-42",
        messages: [{ role: "user", content: "hi" }],
      });

      const body = captured?.body as { model: string; request: { contents: unknown[] } };
      expect(captured?.url).toBe(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
      );
      expect(body.model).toBe("some-gateway-model-42");
      expect(body.request.contents).toHaveLength(1);
    });

    it("only sends explicit thinking config to Gemini models", async () => {
      const bodies: Array<{ request: Record<string, unknown> }> = [];
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-3.1-flash-high",
        messages: [{ role: "user", content: "hi" }],
        thinking: "disabled",
      });
      await client.chat({
        model: "claude-opus-4-6-thinking",
        messages: [{ role: "user", content: "hi" }],
        thinking: "disabled",
      });

      expect(bodies[0]?.request.generationConfig).toEqual({
        thinkingConfig: { includeThoughts: false },
      });
      expect(bodies[1]?.request).not.toHaveProperty("generationConfig");
    });

    it("captures thought-summary parts as reasoning_content, not content", async () => {
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              wrappedResponse([{ text: "let me think", thought: true }, { text: "the answer" }]),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      const res = await client.chat({
        model: "gemini-3.8-flash-tiered",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(res.content).toBe("the answer");
      expect(res.reasoningContent).toBe("let me think");
    });

    it("strips Gemini-incompatible JSON-Schema keywords from tool parameters", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp_tool",
              description: "d",
              parameters: {
                type: "object",
                $schema: "http://json-schema.org/draft-07/schema#",
                additionalProperties: false,
                oneOf: [{ type: "string" }],
                properties: {
                  file: { type: "string", $ref: "#/$defs/x", pattern: "^[a-z]+$" },
                  dir: { type: "object", items: { type: "string", anyOf: [{ type: "string" }] } },
                },
              },
            },
          },
        ],
      });

      const tools = (captured as { request: { tools: { functionDeclarations: unknown[] }[] } })
        .request.tools;
      expect(tools[0]?.functionDeclarations[0]).toEqual({
        name: "mcp_tool",
        description: "d",
        parameters: {
          type: "object",
          properties: {
            file: { type: "string", pattern: "^[a-z]+$" },
            dir: { type: "object", items: { type: "string" } },
          },
        },
      });
    });

    it("strips propertyNames and other draft-only keywords the Gemini Schema type rejects", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "outlook_mail_tool",
              description: "d",
              parameters: {
                type: "object",
                propertyNames: { pattern: "^[a-z]+$" },
                properties: {
                  headers: {
                    type: "object",
                    propertyNames: { type: "string" },
                    const: { a: 1 },
                    exclusiveMinimum: 0,
                    examples: [{ a: 1 }],
                    properties: { subject: { type: "string", description: "subj" } },
                  },
                  limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
                  kind: { type: "string", enum: ["a", "b"] },
                },
                required: ["headers"],
              },
            },
          },
        ],
      });

      const tools = (captured as { request: { tools: { functionDeclarations: unknown[] }[] } })
        .request.tools;
      expect(tools[0]?.functionDeclarations[0]).toEqual({
        name: "outlook_mail_tool",
        description: "d",
        parameters: {
          type: "object",
          properties: {
            headers: {
              type: "object",
              properties: { subject: { type: "string", description: "subj" } },
            },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            kind: { type: "string", enum: ["a", "b"] },
          },
          required: ["headers"],
        },
      });
    });

    it("collapses JSON-Schema type unions into a single Gemini type (+nullable)", async () => {
      let captured: unknown = null;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(wrappedResponse([{ text: "done" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      await client.chat({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "outlook_mail_send_mail",
              description: "d",
              parameters: {
                type: "object",
                properties: {
                  subject: { type: ["string", "null"], description: "s" },
                  count: { type: ["integer"] },
                  recipients: {
                    type: "array",
                    items: {
                      type: ["object", "null"],
                      properties: {
                        emailAddress: {
                          type: "object",
                          properties: {
                            address: { type: ["string", "null"] },
                            name: { type: ["string", "null"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      });

      const tools = (captured as { request: { tools: { functionDeclarations: unknown[] }[] } })
        .request.tools;
      expect(tools[0]?.functionDeclarations[0]).toEqual({
        name: "outlook_mail_send_mail",
        description: "d",
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string", nullable: true, description: "s" },
            count: { type: "integer" },
            recipients: {
              type: "array",
              items: {
                type: "object",
                nullable: true,
                properties: {
                  emailAddress: {
                    type: "object",
                    properties: {
                      address: { type: "string", nullable: true },
                      name: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      });
    });

    it("surfaces daily endpoint failures without gateway fallback", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          new Response("unavailable", { status: 503 }),
        ) as unknown as typeof globalThis.fetch;
      const client = geminiClient(fetch);

      await expect(
        client.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow("Antigravity 503: unavailable");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
      );
    });

    it("preserves a functionCall id and JSON-stringifies its args", async () => {
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify(
            wrappedResponse([
              { functionCall: { id: "call-read", name: "read", args: { path: "/a" } } },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "read /a" }],
      });
      expect(res.toolCalls).toEqual([
        {
          id: "call-read",
          type: "function",
          function: { name: "read", arguments: '{"path":"/a"}' },
        },
      ]);
    });

    it("generates an id when an Antigravity functionCall omits one", async () => {
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify(wrappedResponse([{ functionCall: { name: "read", args: {} } }])),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "claude-opus-4-6-thinking",
        messages: [{ role: "user", content: "read" }],
      });

      expect(res.toolCalls[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("captures the sibling thoughtSignature on a functionCall part", async () => {
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify(
            wrappedResponse([
              {
                functionCall: { name: "read", args: { path: "/a" } },
                thoughtSignature: "sig-xyz",
              },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-3.1-flash-high",
        messages: [{ role: "user", content: "read /a" }],
      });
      expect(res.toolCalls[0]?.thoughtSignature).toBe("sig-xyz");
    });

    it("captures a thoughtSignature returned in a separate trailing part", async () => {
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify(
            wrappedResponse([
              { functionCall: { name: "read", args: { path: "/a" } } },
              { text: "", thoughtSignature: "sig-separate" },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-3.1-pro-high",
        messages: [{ role: "user", content: "read /a" }],
      });
      expect(res.toolCalls[0]?.thoughtSignature).toBe("sig-separate");
    });

    it("captures a snake_case thought_signature on a functionCall part", async () => {
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify(
            wrappedResponse([
              {
                functionCall: { name: "web_search", args: { query: "q" } },
                thought_signature: "sig-snake-part",
              },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-3.1-flash-high",
        messages: [{ role: "user", content: "search" }],
      });
      expect(res.toolCalls[0]?.thoughtSignature).toBe("sig-snake-part");
    });

    it("captures thought_signature nested inside functionCall", async () => {
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify(
            wrappedResponse([
              {
                functionCall: {
                  name: "web_search",
                  args: { query: "q" },
                  thought_signature: "sig-nested",
                },
              },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-3.1-flash-high",
        messages: [{ role: "user", content: "search" }],
      });
      expect(res.toolCalls[0]?.thoughtSignature).toBe("sig-nested");
    });

    it("captures snake_case thought_signature returned in a separate trailing part", async () => {
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify(
            wrappedResponse([
              { functionCall: { name: "web_search", args: { query: "q" } } },
              { thought_signature: "sig-trailing-snake" },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-3.1-pro-high",
        messages: [{ role: "user", content: "search" }],
      });
      expect(res.toolCalls[0]?.thoughtSignature).toBe("sig-trailing-snake");
    });

    it("serializes image_url parts to inlineData for the vision API", async () => {
      let captured: { body: unknown } | null = null;
      const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        captured = { body: JSON.parse(init?.body as string) };
        return new Response(JSON.stringify(wrappedResponse([{ text: "seen" }])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-2.5-flash",
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

      const body = captured?.body as {
        request: { contents: Array<{ role: string; parts: unknown[] }> };
      };
      expect(body.request.contents[0]?.parts).toEqual([
        { text: "what is this?" },
        { inlineData: { mimeType: "image/png", data: "AAAA" } },
      ]);
      expect(res.content).toBe("seen");
    });

    it("throws a clear error when not signed in", async () => {
      const client = new DeepSeekClient({
        baseUrl: "https://cloudcode-pa.googleapis.com",
        allowMissingKey: true,
        geminiAuthResolver: async () => null,
      });
      await expect(
        client.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(/Not signed in to Google Antigravity/);
    });

    it("surfaces SUBSCRIPTION_REQUIRED without retrying or downgrading the model", async () => {
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              details: [{ reason: "SUBSCRIPTION_REQUIRED" }],
            },
          }),
          { status: 403 },
        );
      }) as unknown as typeof globalThis.fetch;
      const client = geminiClient(fetch);

      await expect(
        client.chat({
          model: "claude-sonnet-4-6-thinking",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow(/licensed Gemini Code Assist access.*not downgraded or retried/i);
      expect(fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
      expect(body.model).toBe("claude-sonnet-4-6-thinking");
    });

    it("does not send a request without a companion project", async () => {
      const fetch = vi.fn() as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        baseUrl: "https://cloudcode-pa.googleapis.com",
        allowMissingKey: true,
        geminiAuthResolver: async () => ({ accessToken: "google-token" }),
        fetch,
      });

      await expect(
        client.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(/did not provide a companion project/);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("gemini streaming", () => {
    it("parses SSE envelopes into content deltas and usage", async () => {
      const noUsage = (parts: unknown[]) => ({
        response: { candidates: [{ content: { parts }, finishReason: "STOP" }] },
      });
      const sse = [
        `data: ${JSON.stringify(noUsage([{ text: "hel" }]))}`,
        `data: ${JSON.stringify(noUsage([{ text: "lo" }]))}`,
        `data: ${JSON.stringify(wrappedResponse([], { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }))}`,
        "data: [DONE]",
      ].join("\n\n");

      const fetch = vi.fn(async (url: unknown) => {
        expect(String(url)).toBe(
          "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        );
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const chunks = [];
      for await (const chunk of client.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      const text = chunks.map((c) => c.contentDelta ?? "").join("");
      expect(text).toBe("hello");
      const usageChunk = chunks.find((c) => c.usage);
      expect(usageChunk?.usage?.promptTokens).toBe(3);
      expect(usageChunk?.usage?.completionTokens).toBe(2);
    });

    it("routes thought-summary parts to reasoning deltas", async () => {
      const frame = (parts: unknown[]) =>
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts } }] } })}`;
      const sse = [
        frame([{ text: "hmm ", thought: true }]),
        frame([{ text: "answer" }]),
        "data: [DONE]",
      ].join("\n\n");
      const fetch = vi.fn(
        async () =>
          new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
      ) as unknown as typeof fetch;
      const client = geminiClient(fetch);

      const chunks = [];
      for await (const chunk of client.stream({
        model: "gemini-3.8-flash-tiered",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks.map((c) => c.reasoningDelta ?? "").join("")).toBe("hmm ");
      expect(chunks.map((c) => c.contentDelta ?? "").join("")).toBe("answer");
    });

    it("parses cachedContentTokenCount in streaming SSE usageMetadata into cache hit and miss tokens", async () => {
      const sse = [
        `data: ${JSON.stringify(
          wrappedResponse([{ text: "hello" }], {
            promptTokenCount: 1500,
            candidatesTokenCount: 50,
            totalTokenCount: 1550,
            cachedContentTokenCount: 1200,
          }),
        )}`,
        "data: [DONE]",
      ].join("\n\n");

      const fetch = vi.fn(async () => {
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const chunks = [];
      for await (const chunk of client.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      const usageChunk = chunks.find((c) => c.usage);
      expect(usageChunk?.usage?.promptTokens).toBe(1500);
      expect(usageChunk?.usage?.completionTokens).toBe(50);
      expect(usageChunk?.usage?.totalTokens).toBe(1550);
      expect(usageChunk?.usage?.promptCacheHitTokens).toBe(1200);
      expect(usageChunk?.usage?.promptCacheMissTokens).toBe(300);
      expect(usageChunk?.usage?.cacheHitRatio).toBe(0.8);
    });

    it("parses cachedContentTokenCount in non-streaming response into cache hit and miss tokens", async () => {
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify(
            wrappedResponse([{ text: "cached answer" }], {
              promptTokenCount: 2000,
              candidatesTokenCount: 100,
              totalTokenCount: 2100,
              cachedContentTokenCount: 1600,
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(res.usage.promptTokens).toBe(2000);
      expect(res.usage.completionTokens).toBe(100);
      expect(res.usage.totalTokens).toBe(2100);
      expect(res.usage.promptCacheHitTokens).toBe(1600);
      expect(res.usage.promptCacheMissTokens).toBe(400);
      expect(res.usage.cacheHitRatio).toBe(0.8);
    });

    it("Usage.fromApi parses Gemini usage metadata correctly", () => {
      const raw = {
        promptTokenCount: 1000,
        candidatesTokenCount: 200,
        totalTokenCount: 1200,
        cachedContentTokenCount: 750,
      };
      expect(Usage.hasApiUsage(raw)).toBe(true);
      const usage = Usage.fromApi(raw);
      expect(usage.promptTokens).toBe(1000);
      expect(usage.completionTokens).toBe(200);
      expect(usage.totalTokens).toBe(1200);
      expect(usage.promptCacheHitTokens).toBe(750);
      expect(usage.promptCacheMissTokens).toBe(250);
    });

    it("preserves parallel function calls across and within SSE frames", async () => {
      const envelope = (parts: unknown[]) => ({
        response: { candidates: [{ content: { parts } }] },
      });
      const sse = [
        `data: ${JSON.stringify(
          envelope([
            { functionCall: { id: "call-a", name: "a", args: { value: 1 } } },
            { functionCall: { id: "call-b", name: "b", args: { value: 2 } } },
          ]),
        )}`,
        `data: ${JSON.stringify(
          envelope([{ functionCall: { id: "call-c", name: "c", args: { value: 3 } } }]),
        )}`,
        "data: [DONE]",
      ].join("\n\n");

      const fetch = vi.fn(async () => {
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const calls = [];
      for await (const chunk of client.stream({
        model: "claude-opus-4-6-thinking",
        messages: [{ role: "user", content: "run all" }],
      })) {
        if (chunk.toolCallDelta) calls.push(chunk.toolCallDelta);
      }

      expect(calls.map(({ index, id, name }) => ({ index, id, name }))).toEqual([
        { index: 0, id: "call-a", name: "a" },
        { index: 1, id: "call-b", name: "b" },
        { index: 2, id: "call-c", name: "c" },
      ]);
    });

    it("attaches a thoughtSignature delivered in a separate part of the same frame", async () => {
      const envelope = (parts: unknown[]) => ({
        response: { candidates: [{ content: { parts } }] },
      });
      const sse = [
        `data: ${JSON.stringify(
          envelope([
            { functionCall: { id: "call-a", name: "todo_write", args: { text: "x" } } },
            { text: "", thoughtSignature: "sig-frame" },
          ]),
        )}`,
        "data: [DONE]",
      ].join("\n\n");

      const fetch = vi.fn(async () => {
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const callDeltas = [];
      const chunkSignatures: string[] = [];
      for await (const chunk of client.stream({
        model: "gemini-3.1-pro-high",
        messages: [{ role: "user", content: "run" }],
      })) {
        if (chunk.toolCallDelta) callDeltas.push(chunk.toolCallDelta);
        if (chunk.thoughtSignature) chunkSignatures.push(chunk.thoughtSignature);
      }

      expect(callDeltas[0]?.thoughtSignature).toBe("sig-frame");
      expect(chunkSignatures).toContain("sig-frame");
    });

    it("attaches snake_case thought_signature in streaming SSE", async () => {
      const envelope = (parts: unknown[]) => ({
        response: { candidates: [{ content: { parts } }] },
      });
      const sse = [
        `data: ${JSON.stringify(
          envelope([
            {
              functionCall: { id: "call-ws", name: "web_search", args: { query: "reasonix" } },
              thought_signature: "sig-sse-snake",
            },
          ]),
        )}`,
        "data: [DONE]",
      ].join("\n\n");

      const fetch = vi.fn(async () => {
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const callDeltas = [];
      for await (const chunk of client.stream({
        model: "gemini-3.1-pro-high",
        messages: [{ role: "user", content: "search" }],
      })) {
        if (chunk.toolCallDelta) callDeltas.push(chunk.toolCallDelta);
      }

      expect(callDeltas[0]?.thoughtSignature).toBe("sig-sse-snake");
    });

    it("attaches snake_case thought_signature from trailing SSE frame", async () => {
      const envelope = (parts: unknown[]) => ({
        response: { candidates: [{ content: { parts } }] },
      });
      const sse = [
        `data: ${JSON.stringify(
          envelope([
            { functionCall: { id: "call-ws", name: "web_search", args: { query: "reasonix" } } },
          ]),
        )}`,
        `data: ${JSON.stringify(envelope([{ thought_signature: "sig-trailing-frame-snake" }]))}`,
        "data: [DONE]",
      ].join("\n\n");

      const fetch = vi.fn(async () => {
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const chunkSignatures: string[] = [];
      for await (const chunk of client.stream({
        model: "gemini-3.1-pro-high",
        messages: [{ role: "user", content: "search" }],
      })) {
        if (chunk.thoughtSignature) chunkSignatures.push(chunk.thoughtSignature);
      }

      expect(chunkSignatures).toContain("sig-trailing-frame-snake");
    });

    it("captures an inlineData image part as StreamChunk.image", async () => {
      const b64 = Buffer.from("fake-bytes").toString("base64");
      const sse = [
        `data: ${JSON.stringify({
          response: {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: b64 } }] } },
            ],
          },
        })}`,
        "data: [DONE]",
      ].join("\n\n");

      const fetch = vi.fn(async () => {
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const chunks: Array<{ image?: { dataUrl: string; mimeType: string } }> = [];
      for await (const chunk of client.stream({
        model: "gemini-3.1-flash-image",
        messages: [{ role: "user", content: "draw a square" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => c.image)).toBe(true);
      expect(chunks.find((c) => c.image)?.image).toEqual({
        dataUrl: `data:image/jpeg;base64,${b64}`,
        mimeType: "image/jpeg",
      });
    });
  });

  describe("gemini inlineData image parsing", () => {
    it("captures an inlineData part as ChatResponse.image (non-streaming)", async () => {
      const b64 = Buffer.from("fake-bytes").toString("base64");
      const fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify(wrappedResponse([{ inlineData: { mimeType: "image/jpeg", data: b64 } }])),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const client = geminiClient(fetch);
      const res = await client.chat({
        model: "gemini-3.1-flash-image",
        messages: [{ role: "user", content: "draw a square" }],
      });

      expect(res.image).toEqual({
        dataUrl: `data:image/jpeg;base64,${b64}`,
        mimeType: "image/jpeg",
      });
    });
  });
});

// GPT-5.6 (OpenAI) payload compatibility — reasoning field, error prefixes, no DeepSeek-only fields.
describe("client-gpt56", () => {
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

  function jsonFetch(status: number, body: unknown): typeof fetch {
    return vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
  }

  describe("DeepSeekClient with OpenAI GPT-5.6 payloads", () => {
    it("streams OpenAI's delta.reasoning as reasoningDelta", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        fetch: sseFetch([
          'data: {"choices":[{"delta":{"reasoning":"think"}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning":"ing hard"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      });
      const chunks: any[] = [];
      for await (const c of client.stream({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(c);
      }
      const reasoning = chunks
        .map((c) => c.reasoningDelta)
        .filter(Boolean)
        .join("");
      expect(reasoning).toBe("thinking hard");
      expect(chunks.some((c) => c.contentDelta === "answer")).toBe(true);
    });

    it("still streams DeepSeek's delta.reasoning_content", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com",
        fetch: sseFetch([
          'data: {"choices":[{"delta":{"reasoning_content":"ds think"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      });
      const chunks: any[] = [];
      for await (const c of client.stream({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(c);
      }
      expect(
        chunks
          .map((c) => c.reasoningDelta)
          .filter(Boolean)
          .join(""),
      ).toBe("ds think");
    });

    it("non-streaming chat() reads message.reasoning", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        fetch: jsonFetch(200, {
          choices: [{ message: { content: "ok", reasoning: "inner monologue" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });
      const resp = await client.chat({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(resp.reasoningContent).toBe("inner monologue");
      expect(resp.content).toBe("ok");
    });

    it("prefixes errors OpenAI on OpenAI models, DeepSeek on DeepSeek models", async () => {
      const openai = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        fetch: jsonFetch(401, { error: { message: "invalid api key" } }),
        retry: { maxAttempts: 1 },
      });
      await expect(
        openai.chat({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(/^OpenAI 401:/);

      const ds = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com",
        fetch: jsonFetch(401, { error: { message: "bad key" } }),
        retry: { maxAttempts: 1 },
      });
      await expect(
        ds.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(/^DeepSeek 401:/);
    });

    it("never sends a thinking toggle for gpt models, still sends it for deepseek", async () => {
      const spy = vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        fetch: spy as unknown as typeof fetch,
        retry: { maxAttempts: 1 },
      });
      await client.chat({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        thinking: "enabled",
        reasoningEffort: "xhigh",
      });
      const [, init] = spy.mock.calls[0]!;
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      expect(body.extra_body).toBeUndefined();
      expect(body.reasoning_effort).toBe("xhigh");

      const dsClient = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com",
        fetch: spy as unknown as typeof fetch,
        retry: { maxAttempts: 1 },
      });
      await dsClient.chat({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
        thinking: "enabled",
      });
      const [, init2] = spy.mock.calls[1]!;
      const body2 = JSON.parse(String(init2!.body)) as Record<string, unknown>;
      expect(body2.thinking).toEqual({ type: "enabled" });
    });

    it("sends parallel_tool_calls:false for gpt models, never for deepseek", async () => {
      const spy = vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        fetch: spy as unknown as typeof fetch,
        retry: { maxAttempts: 1 },
      });
      await client.chat({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
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
      });
      const [, init] = spy.mock.calls[0]!;
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      expect(body.store).toBe(false);
      expect(body.parallel_tool_calls).toBe(false);

      const dsClient = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com",
        fetch: spy as unknown as typeof fetch,
        retry: { maxAttempts: 1 },
      });
      await dsClient.chat({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      });
      const [, init2] = spy.mock.calls[1]!;
      const body2 = JSON.parse(String(init2!.body)) as Record<string, unknown>;
      expect(body2.store).toBeUndefined();
      expect(body2.parallel_tool_calls).toBeUndefined();
    });

    it("apiKeyResolver supplies the per-request Authorization when no static key exists", async () => {
      const spy = vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const resolver = vi.fn(async () => "oauth-token-1");
      const client = new DeepSeekClient({
        baseUrl: "https://api.openai.com/v1",
        fetch: spy as unknown as typeof fetch,
        apiKeyResolver: resolver,
      });
      await client.chat({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      });
      const [, init] = spy.mock.calls[0]!;
      expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer oauth-token-1");
      expect(resolver).toHaveBeenCalledTimes(1);
    });

    it("apiKeyResolver falling back to undefined uses the static key", async () => {
      const spy = vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new DeepSeekClient({
        apiKey: "sk-static",
        baseUrl: "https://api.openai.com/v1",
        fetch: spy as unknown as typeof fetch,
        apiKeyResolver: async () => undefined,
      });
      await client.chat({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      });
      const [, init] = spy.mock.calls[0]!;
      expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-static");
    });

    it("constructor still throws without a key and without a resolver", () => {
      const prev = process.env.DEEPSEEK_API_KEY;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.DEEPSEEK_API_KEY;
      try {
        expect(() => new DeepSeekClient({ baseUrl: "https://api.openai.com/v1" })).toThrow(
          "No authentication configured for the resolved model endpoint",
        );
      } finally {
        if (prev === undefined) {
          // biome-ignore lint/performance/noDelete: restore exact env state
          delete process.env.DEEPSEEK_API_KEY;
        } else {
          process.env.DEEPSEEK_API_KEY = prev;
        }
      }
    });
  });
});

// Xiaomi MiMo chat contract: the `thinking` toggle is sent top-level; MiMo has
// *  no effort ladder, so `reasoning_effort` must never ride along.
describe("client-mimo", () => {
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
});

describe("client-models", () => {
  function makeFetch(status: number, body: unknown) {
    return vi.fn(
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
  }

  describe("DeepSeekClient.listModels", () => {
    it("parses the OpenAI-style model list", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: makeFetch(200, {
          object: "list",
          data: [
            { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
            { id: "deepseek-reasoner", object: "model", owned_by: "deepseek" },
          ],
        }),
      });
      const list = await client.listModels();
      expect(list).not.toBeNull();
      expect(list!.data.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    });

    it("returns null on non-2xx (bad key / offline)", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-bad",
        fetch: makeFetch(401, { error: "unauthorized" }),
      });
      expect(await client.listModels()).toBeNull();
    });

    it("returns null on malformed payload", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: makeFetch(200, { whatever: "not a list" }),
      });
      expect(await client.listModels()).toBeNull();
    });

    it("returns null when fetch throws (network error)", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      });
      expect(await client.listModels()).toBeNull();
    });

    it("sends the bearer token header", async () => {
      const spy = vi.fn(
        async () =>
          new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new DeepSeekClient({
        apiKey: "sk-xyz",
        fetch: spy as unknown as typeof fetch,
      });
      await client.listModels();
      const [, init] = spy.mock.calls[0]!;
      expect((init as RequestInit).method).toBe("GET");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-xyz");
    });
  });

  describe("DeepSeekClient rateLimit", () => {
    it("waits between chat requests when rpm is configured", async () => {
      vi.useFakeTimers();
      const spy = vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: spy as unknown as typeof fetch,
        rateLimit: { rpm: 30 },
      });
      try {
        await client.chat({ model: "deepseek-chat", messages: [] });
        const second = client.chat({ model: "deepseek-chat", messages: [] });
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1999);
        expect(spy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await second;
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("DeepSeekClient usage parsing", () => {
    it("parses Ollama native top-level token metrics", async () => {
      const client = new DeepSeekClient({
        apiKey: "ollama",
        fetch: makeFetch(200, {
          model: "gpt-oss:20b",
          message: { role: "assistant", content: "ok" },
          done: true,
          prompt_eval_count: 42,
          eval_count: 7,
        }),
      });
      const resp = await client.chat({ model: "gpt-oss:20b", messages: [] });
      expect(resp.usage.promptTokens).toBe(42);
      expect(resp.usage.completionTokens).toBe(7);
      expect(resp.usage.totalTokens).toBe(49);
      expect(resp.usage.promptCacheMissTokens).toBe(42);
    });

    it("requests usage metadata for streaming calls", async () => {
      let body: { stream_options?: unknown } | null = null;
      const fetch = vi.fn(async (_url, init) => {
        body = JSON.parse(String((init as RequestInit).body)) as { stream_options?: unknown };
        const frames = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
          "data: [DONE]\n\n",
        ];
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
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch });

      const chunks = [];
      for await (const chunk of client.stream({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      expect(body?.stream_options).toEqual({ include_usage: true });
      expect(chunks.at(-1)?.usage?.promptTokens).toBe(10);
      expect(chunks.at(-1)?.usage?.promptCacheMissTokens).toBe(10);
    });

    it("reads a top-level cached_tokens count (OpenAI-compatible gateways)", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        fetch: makeFetch(200, {
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 5,
            total_tokens: 1005,
            cached_tokens: 640,
          },
        }),
      });
      const resp = await client.chat({ model: "gpt-5.6-sol", messages: [] });
      expect(resp.usage.promptCacheHitTokens).toBe(640);
      expect(resp.usage.promptCacheMissTokens).toBe(360);
    });

    it("reads a top-level cache_read_input_tokens count", async () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        fetch: makeFetch(200, {
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 800,
            completion_tokens: 5,
            total_tokens: 805,
            cache_read_input_tokens: 512,
          },
        }),
      });
      const resp = await client.chat({ model: "gpt-5.6-sol", messages: [] });
      expect(resp.usage.promptCacheHitTokens).toBe(512);
      expect(resp.usage.promptCacheMissTokens).toBe(288);
    });
  });

  describe("DeepSeekClient request serialization", () => {
    it("replaces lone UTF-16 surrogates before sending JSON", async () => {
      let sentBody = "";
      const spy = vi.fn(async (_url: unknown, init: unknown) => {
        sentBody = String((init as RequestInit).body ?? "");
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: spy as unknown as typeof fetch,
      });

      await client.chat({
        model: "deepseek-chat",
        messages: [{ role: "user", content: `bad ${String.fromCharCode(0xd800)} text` }],
      });

      expect(sentBody).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
      expect(JSON.parse(sentBody).messages[0].content).toBe("bad \uFFFD text");
    });
  });

  describe("DeepSeekClient ollama provider (keyless + prefix strip)", () => {
    it("allowMissingKey skips the no-key constructor throw", () => {
      expect(
        () => new DeepSeekClient({ baseUrl: "http://localhost:11434/v1", allowMissingKey: true }),
      ).not.toThrow();
    });

    it("without allowMissingKey the constructor still throws for a missing key", () => {
      // The runner env may carry DEEPSEEK_API_KEY — the fallback must not mask
      // the missing-key throw, so clear it for this assertion.
      const saved = process.env.DEEPSEEK_API_KEY;
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.DEEPSEEK_API_KEY;
      try {
        expect(() => new DeepSeekClient({ baseUrl: "http://localhost:11434/v1" })).toThrow(
          "No authentication configured for the resolved model endpoint",
        );
      } finally {
        if (saved === undefined) {
          // biome-ignore lint/performance/noDelete: restore exact env state
          delete process.env.DEEPSEEK_API_KEY;
        } else {
          process.env.DEEPSEEK_API_KEY = saved;
        }
      }
    });

    it("keyless chat omits the Authorization header, strips the ollama/ prefix, and hits the native /api/chat endpoint", async () => {
      const savedKeepAlive = process.env.OLLAMA_KEEP_ALIVE;
      const savedNumCtx = process.env.OLLAMA_NUM_CTX;
      process.env.OLLAMA_KEEP_ALIVE = "30m";
      // biome-ignore lint/performance/noDelete: test needs the env unset
      delete process.env.OLLAMA_NUM_CTX;
      try {
        let capturedUrl = "";
        let capturedInit: RequestInit | undefined;
        const fetch = vi.fn(async (url, init) => {
          capturedUrl = String(url);
          capturedInit = init as RequestInit;
          return new Response(
            JSON.stringify({
              model: "llama3.1:latest",
              message: { role: "assistant", content: "hi" },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 5,
              eval_count: 1,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as unknown as typeof fetch;
        const client = new DeepSeekClient({
          baseUrl: "http://localhost:11434/v1",
          allowMissingKey: true,
          fetch,
        });

        const res = await client.chat({
          model: "ollama/llama3.1:latest",
          messages: [{ role: "user", content: "hi" }],
        });

        expect(capturedUrl).toBe("http://localhost:11434/api/chat");
        expect(capturedInit!.headers).not.toHaveProperty("Authorization");
        const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
        expect(body.model).toBe("llama3.1:latest");
        expect(body.keep_alive).toBe("30m");
        expect(body.options).toMatchObject({
          num_ctx: 131072,
        });
        expect(res.content).toBe("hi");
      } finally {
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
      }
    });

    it("a cloud key IS sent when configured, and ollama maps effort to think instead of DeepSeek fields", async () => {
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn(async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init as RequestInit;
        return new Response(
          JSON.stringify({
            model: "qwen3:32b",
            message: { role: "assistant", content: "ok" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      const client = new DeepSeekClient({
        baseUrl: "https://ollama.example.com",
        apiKey: "sk-ollama-cloud",
        fetch,
      });

      await client.chat({
        model: "ollama/qwen3:32b",
        messages: [{ role: "user", content: "hi" }],
        thinking: "enabled",
        reasoningEffort: "high",
      });

      expect(capturedUrl).toBe("https://ollama.example.com/api/chat");
      const headers = capturedInit!.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-ollama-cloud");
      const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
      expect(body.model).toBe("qwen3:32b");
      expect(body.extra_body).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      // thinking wins over effort in the native `think` field.
      expect(body.think).toBe(true);
    });
  });

  describe("DeepSeekClient.getBalance", () => {
    function balanceClient(payloads: unknown[], urls: string[]) {
      let call = 0;
      const fetch = vi.fn(async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify(payloads[Math.min(call++, payloads.length - 1)]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;
      return new DeepSeekClient({ baseUrl: "https://api.deepseek.com", apiKey: "sk-test", fetch });
    }

    it("reads a declared path off the endpoint, and DeepSeek's by default", async () => {
      const urls: string[] = [];
      const client = balanceClient([{ is_available: true, balance_infos: [] }], urls);

      expect(await client.getBalance({ url: "/wallet/balance" })).toEqual({
        is_available: true,
        balance_infos: [],
      });
      expect(urls[0]).toBe("https://api.deepseek.com/wallet/balance");
      await client.getBalance();
      expect(urls[1]).toBe("https://api.deepseek.com/user/balance");
    });

    it("uses an absolute URL when the wallet lives on another route", async () => {
      const urls: string[] = [];
      const client = balanceClient([{ data: { total_credits: 25, total_usage: 4.5 } }], urls);

      const balance = await client.getBalance({
        url: "https://api.experientiallabs.ai/api/v1/credits",
        shape: "credits-usage",
      });
      // Not appended to the /v1 endpoint: the route is on the bare host.
      expect(urls[0]).toBe("https://api.experientiallabs.ai/api/v1/credits");
      // A credits ledger reports what was granted and what was spent; the balance is
      // the difference, presented as the one wallet shape every caller already reads.
      expect(balance).toEqual({
        is_available: true,
        balance_infos: [{ currency: "USD", total_balance: "20.5" }],
      });
    });

    it("reports an exhausted credits ledger as unavailable", async () => {
      const client = balanceClient([{ data: { total_credits: 5, total_usage: 5 } }], []);
      expect(
        await client.getBalance({
          url: "https://api.experientiallabs.ai/api/v1/credits",
          shape: "credits-usage",
        }),
      ).toEqual({ is_available: false, balance_infos: [{ currency: "USD", total_balance: "0" }] });
    });

    it("returns null for a reply that does not match the declared shape", async () => {
      const urls: string[] = [];
      const malformed = balanceClient([{ is_available: true, balance_infos: [] }], urls);
      expect(await malformed.getBalance({ url: "/x", shape: "credits-usage" })).toBeNull();
      const missing = balanceClient([{ data: {} }], urls);
      expect(await missing.getBalance({ url: "/x", shape: "credits-usage" })).toBeNull();
    });
  });
});

describe("client-opencode-session", () => {
  /** Captures request headers and bodies per call, answering SSE when the
   *  request streams (opencode `chat` always does) and JSON otherwise. */
  function headerCapturingFetch(): {
    fetch: typeof fetch;
    headers: () => Array<Record<string, string>>;
    bodies: () => Array<Record<string, unknown>>;
  } {
    const seen: Array<Record<string, string>> = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fn = vi.fn(
      async (_url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
        seen.push({ ...(init?.headers ?? {}) });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        bodies.push(body);
        if (!body.stream) {
          return new Response(
            JSON.stringify({
              choices: [
                { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const frames = [
          { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
          .map(
            (f) =>
              `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", ...f })}\n\n`,
          )
          .join("");
        return new Response(`${frames}data: [DONE]\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    ) as unknown as typeof fetch;
    return { fetch: fn, headers: () => seen, bodies: () => bodies };
  }

  describe("OpenCode harness identity (opencode.ai/docs/go)", () => {
    it("stamps the whole OpenCode identity on opencode requests", async () => {
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
        // A conversation id is hashed into the `ses_` shape rather than sent raw.
        const session = h["x-opencode-session"];
        expect(session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        expect(session).not.toContain("desktop-");
        expect(h["x-opencode-session-id"]).toBe(session);
        expect(h["x-session-affinity"]).toBe(session);
        expect(h["X-Session-Id"]).toBe(session);
        expect(h["x-opencode-client"]).toBe("cli");
        expect(h["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/);
        expect(h["User-Agent"]).toMatch(/^opencode\/[a-z]+\/[\d.]+\/cli$/);
      }
      // Same conversation → same id on both requests, so provider routing and
      // prompt caching stay pinned to it.
      expect(headers()[0]?.["x-opencode-session"]).toBe(headers()[1]?.["x-opencode-session"]);
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

    it("streams even on the non-streaming path, and advertises `read` when tool-less", async () => {
      const { fetch, bodies } = headerCapturingFetch();
      const client = new DeepSeekClient({
        apiKey: "public",
        baseUrl: "https://opencode.ai/zen/v1",
        allowMissingKey: true,
        fetch,
      });

      // `chat()` is the non-streaming API, but the gateway refuses a non-streamed request.
      const reply = await client.chat({
        model: "deepseek-v4.1-flash-free",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(reply.content).toBe("ok");
      expect(bodies()[0]?.stream).toBe(true);
      // A tool-less body is refused too, so `read` rides along on its own.
      const tools = bodies()[0]?.tools as Array<{ function: { name: string } }>;
      expect(tools.map((t) => t.function.name)).toEqual(["read"]);
    });

    it("adds `read` to a caller tool list that lacks the required alias", async () => {
      const { fetch, bodies } = headerCapturingFetch();
      const client = new DeepSeekClient({
        apiKey: "public",
        baseUrl: "https://opencode.ai/zen/v1",
        allowMissingKey: true,
        fetch,
      });

      await client.chat({
        model: "deepseek-v4.1-flash-free",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "read_file", description: "d", parameters: { type: "object" } },
          },
        ],
      });

      const tools = bodies()[0]?.tools as Array<{ function: { name: string } }>;
      expect(tools.map((t) => t.function.name)).toEqual(["read_file", "read"]);
    });

    it("does not duplicate a supplied `read` tool", async () => {
      const { fetch, bodies } = headerCapturingFetch();
      const client = new DeepSeekClient({
        apiKey: "public",
        baseUrl: "https://opencode.ai/zen/v1",
        allowMissingKey: true,
        fetch,
      });
      const read = {
        type: "function" as const,
        function: { name: "read", description: "d", parameters: { type: "object" } },
      };

      await client.chat({
        model: "deepseek-v4.1-flash-free",
        messages: [{ role: "user", content: "hi" }],
        tools: [read],
      });

      expect(bodies()[0]?.tools).toEqual([read]);
    });

    it("preserves text and image content in an admitted streamed payload", async () => {
      const { fetch, bodies } = headerCapturingFetch();
      const client = new DeepSeekClient({
        apiKey: "public",
        baseUrl: "https://opencode.ai/zen/v1",
        allowMissingKey: true,
        fetch,
      });
      const image = "data:image/png;base64,iVBORw0KGgo=";

      const reply = await client.chat({
        model: "deepseek-v4.1-flash-free",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image." },
              { type: "image_url", image_url: { url: image, detail: "low" } },
            ],
          },
        ],
      });

      expect(reply.content).toBe("ok");
      const body = bodies()[0];
      expect(body?.stream).toBe(true);
      expect(body?.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            { type: "image_url", image_url: { url: image, detail: "low" } },
          ],
        },
      ]);
      const tools = body?.tools as Array<{ function: { name: string } }>;
      expect(tools.map((tool) => tool.function.name)).toEqual(["read"]);
    });

    it("reconstructs tool calls from the OpenCode streaming collector", async () => {
      const frames = [
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "read", arguments: '{"path' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '":"a.txt"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const fetch = vi.fn(
        async () =>
          new Response(new TextEncoder().encode(frames.join("")), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "public",
        baseUrl: "https://opencode.ai/zen/v1",
        allowMissingKey: true,
        fetch,
      });

      const reply = await client.chat({
        model: "deepseek-v4.1-flash-free",
        messages: [{ role: "user", content: "read a file" }],
      });

      expect(reply.toolCalls).toEqual([
        {
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: '{"path":"a.txt"}' },
        },
      ]);
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
      expect(headers()[0]?.["x-opencode-client"]).toBeUndefined();
      expect(headers()[0]?.["User-Agent"]).toBeUndefined();
    });

    it("sends x-opencode-org-id when a Console session org is available", async () => {
      const { fetch, headers } = headerCapturingFetch();
      const client = new DeepSeekClient({
        apiKey: "public",
        baseUrl: "https://opencode.ai/zen/v1",
        allowMissingKey: true,
        opencodeOrgResolver: () => "org-42",
        fetch,
      });

      await client.chat({ model: "glm-5-free", messages: [{ role: "user", content: "hi" }] });

      expect(headers()[0]?.["x-opencode-org-id"]).toBe("org-42");
    });

    it("omits x-opencode-org-id for a static API key with no org", async () => {
      const { fetch, headers } = headerCapturingFetch();
      const client = new DeepSeekClient({
        apiKey: "sk-service-key",
        baseUrl: "https://opencode.ai/zen/v1",
        allowMissingKey: true,
        opencodeOrgResolver: () => undefined,
        fetch,
      });

      await client.chat({ model: "glm-5-free", messages: [{ role: "user", content: "hi" }] });

      expect(headers()[0]?.["x-opencode-org-id"]).toBeUndefined();
    });

    it("does not send x-opencode-org-id for non-opencode providers", async () => {
      const { fetch, headers } = headerCapturingFetch();
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        opencodeOrgResolver: () => "org-42",
        fetch,
      });

      await client.chat({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(headers()[0]?.["x-opencode-org-id"]).toBeUndefined();
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

    it("reads cache hits from prompt_tokens_details.cached_tokens via chat()", async () => {
      // chat() streams under the hood for opencode (the gateway refuses otherwise),
      // so the frame carrying usage is the last SSE event.
      const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ finish_reason: "stop", delta: {} }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 20,
            total_tokens: 1020,
            prompt_tokens_details: { cached_tokens: 800 },
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

      const res = await opencodeClient(fetch).chat({
        model: "glm-5-free",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(res.content).toBe("ok");
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
});

describe("client-zai", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  describe("Z.AI GLM chat", () => {
    it("sends the documented top-level thinking parameters", async () => {
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
        apiKey: "zai-test-key",
        baseUrl: "https://api.z.ai/api/paas/v4/",
        fetch,
      });

      const response = await client.chat({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "hello" }],
        thinking: "enabled",
        reasoningEffort: "max",
        temperature: 1,
      });

      expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer zai-test-key");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
      expect(body.reasoning_effort).toBe("max");
      expect(body.extra_body).toBeUndefined();
      expect(body.temperature).toBe(1);
      expect(response.reasoningContent).toBe("thought");
    });

    it("enables streamed tool calls and normalizes object arguments", async () => {
      let body: Record<string, unknown> | undefined;
      const fetch = vi.fn(async (_input, requestInit) => {
        body = JSON.parse(String((requestInit as RequestInit).body)) as Record<string, unknown>;
        const frames = [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: { query: "glm" } } }] }, finish_reason: "tool_calls" }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
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
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "zai-test-key",
        baseUrl: "https://api.z.ai/api/paas/v4",
        fetch,
      });

      const chunks = [];
      for await (const chunk of client.stream({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "search" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a query",
              parameters: { type: "object" },
            },
          },
        ],
        thinking: "enabled",
        reasoningEffort: "xhigh",
      })) {
        chunks.push(chunk);
      }

      expect(body?.tool_stream).toBe(true);
      expect(body?.stream_options).toBeUndefined();
      expect(body?.reasoning_effort).toBe("max");
      expect(chunks[0]?.reasoningDelta).toBe("think");
      expect(chunks[1]?.toolCallDelta?.argumentsDelta).toBe('{"query":"glm"}');
    });

    it("passes image_url content blocks through unchanged", async () => {
      let body: Record<string, unknown> | undefined;
      const fetch = vi.fn(async (_input, requestInit) => {
        body = JSON.parse(String((requestInit as RequestInit).body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: "image" } }] });
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "zai-test-key",
        baseUrl: "https://api.z.ai/api/paas/v4",
        fetch,
      });
      const content = [
        { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "text" as const, text: "describe" },
      ];

      await client.chat({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content }],
      });

      expect((body?.messages as Array<{ content: unknown }>)[0]?.content).toEqual(content);
    });

    it("retries the alternate Z.AI endpoint when the Developer endpoint 401s a Coding Plan key", async () => {
      const urls: string[] = [];
      const fetch = vi.fn(async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/api/paas/v4/chat/completions")) {
          return new Response(
            JSON.stringify({ error: { code: "1000", message: "Authentication Failed" } }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "coding-plan-key",
        baseUrl: "https://api.z.ai/api/paas/v4",
        fetch,
        retry: { maxAttempts: 1 },
      });

      const response = await client.chat({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(urls[0]).toBe("https://api.z.ai/api/paas/v4/chat/completions");
      expect(urls[1]).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
      expect(response.content).toBe("ok");
    });

    it("retries the alternate Z.AI endpoint when the Developer endpoint reports no balance (429/1113)", async () => {
      const urls: string[] = [];
      const fetch = vi.fn(async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/api/paas/v4/chat/completions")) {
          return new Response(
            JSON.stringify({ error: { code: "1113", message: "Insufficient balance." } }),
            {
              status: 429,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "coding-plan-key",
        baseUrl: "https://api.z.ai/api/paas/v4",
        fetch,
        retry: { maxAttempts: 1 },
      });

      const response = await client.chat({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(urls[0]).toBe("https://api.z.ai/api/paas/v4/chat/completions");
      expect(urls[1]).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
      expect(response.content).toBe("ok");
    });

    it("keeps the Developer no-balance error when the alternate endpoint is also wrong-keyed", async () => {
      const fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.includes("/api/paas/v4/chat/completions")) {
          return new Response(
            JSON.stringify({ error: { code: "1113", message: "Insufficient balance." } }),
            {
              status: 429,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({ error: { code: "1000", message: "Authentication Failed" } }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "developer-key",
        baseUrl: "https://api.z.ai/api/paas/v4",
        fetch,
        retry: { maxAttempts: 1 },
      });

      await expect(
        client.chat({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(/429/);
    });

    it("routes Z.AI through the Responses API when the transport is Responses", async () => {
      let url = "";
      let body: Record<string, unknown> | undefined;
      const fetch = vi.fn(async (input, requestInit) => {
        url = String(input);
        body = JSON.parse(String((requestInit as RequestInit).body)) as Record<string, unknown>;
        const frames = [
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "pong", output_index: 0 })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
          "data: [DONE]\n\n",
        ];
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
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "coding-plan-key",
        baseUrl: "https://api.z.ai/api/paas/v4",
        fetch,
        transportResolver: async () => ({
          endpoint: "https://api.z.ai/api/v1/responses",
          headers: { Authorization: "Bearer coding-plan-key" },
          api: "responses" as const,
        }),
      });

      const chunks = [];
      for await (const chunk of client.stream({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      expect(url).toBe("https://api.z.ai/api/v1/responses");
      expect(body?.messages).toBeUndefined();
      expect(body?.input).toBeDefined();
      expect(body?.store).toBe(false);
      expect(chunks.find((c) => c.contentDelta)?.contentDelta).toBe("pong");
    });

    it("falls back to chat completions when the Z.AI Responses endpoint rejects the key", async () => {
      const urls: string[] = [];
      const fetch = vi.fn(async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/api/v1/responses")) {
          return new Response(
            JSON.stringify({ error: { code: "1000", message: "Authentication Failed" } }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        const frames = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
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
      }) as unknown as typeof globalThis.fetch;
      const client = new DeepSeekClient({
        apiKey: "developer-key",
        baseUrl: "https://api.z.ai/api/paas/v4",
        fetch,
        retry: { maxAttempts: 1 },
        transportResolver: async () => ({
          endpoint: "https://api.z.ai/api/v1/responses",
          headers: { Authorization: "Bearer developer-key" },
          api: "responses" as const,
        }),
      });

      const chunks = [];
      for await (const chunk of client.stream({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      expect(urls[0]).toBe("https://api.z.ai/api/v1/responses");
      expect(urls[1]).toBe("https://api.z.ai/api/paas/v4/chat/completions");
      expect(chunks.find((c) => c.contentDelta)?.contentDelta).toBe("ok");
    });

    it("classifies GLM models as preserved-thinking models", () => {
      expect(isThinkingModeModel("glm-5.3-flash")).toBe(true);
      expect(thinkingModeForModel("glm-5.3")).toBe("enabled");
    });
  });
});
