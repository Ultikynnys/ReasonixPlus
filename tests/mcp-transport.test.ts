// Consolidated from 9 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import type { ChildProcess } from "node:child_process";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { reconnectMcpServer } from "../src/mcp/reconnect.js";
import {
  type BridgeEnv,
  type McpClientHost,
  bridgeMcpTools,
  flattenMcpResult,
  registerSingleMcpTool,
} from "../src/mcp/registry.js";
import { SseTransport } from "../src/mcp/sse.js";
import { type McpTransport, StdioTransport, formatServerExitReason } from "../src/mcp/stdio.js";
import { StreamableHttpTransport } from "../src/mcp/streamable-http.js";
import {
  type CallToolResult,
  type GetPromptResult,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type ListPromptsResult,
  type ListResourcesResult,
  MCP_PROTOCOL_VERSION,
  type McpTool,
  type ReadResourceResult,
} from "../src/mcp/types.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import type { ToolSpec } from "../src/types.js";

describe("mcp-client-timeout", () => {
  abstract class StubTransport implements McpTransport {
    protected closed = false;
    protected readonly queue: JsonRpcMessage[] = [];
    protected readonly waiters: Array<(m: JsonRpcMessage | null) => void> = [];

    abstract send(msg: JsonRpcMessage): Promise<void>;

    async *messages(): AsyncIterableIterator<JsonRpcMessage> {
      while (true) {
        if (this.queue.length > 0) {
          yield this.queue.shift()!;
          continue;
        }
        if (this.closed) return;
        const next = await new Promise<JsonRpcMessage | null>((resolve) => {
          this.waiters.push(resolve);
        });
        if (next === null) return;
        yield next;
      }
    }

    async close(): Promise<void> {
      this.closed = true;
      while (this.waiters.length > 0) this.waiters.shift()!(null);
    }
  }

  class HangingSendTransport extends StubTransport {
    async send(_msg: JsonRpcMessage): Promise<void> {
      return new Promise(() => {});
    }
  }

  class RejectingSendTransport extends StubTransport {
    async send(_msg: JsonRpcMessage): Promise<void> {
      throw new Error("transport send failed");
    }
  }

  class SilentServerTransport extends StubTransport {
    async send(_msg: JsonRpcMessage): Promise<void> {}
  }

  class ToolTimeoutTransport extends StubTransport {
    readonly sent: JsonRpcMessage[] = [];

    async send(msg: JsonRpcMessage): Promise<void> {
      this.sent.push(msg);
      if ("method" in msg && msg.method === "initialize" && "id" in msg) {
        const response: JsonRpcMessage = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { capabilities: {}, serverInfo: { name: "test", version: "1" } },
        };
        const waiter = this.waiters.shift();
        if (waiter) waiter(response);
        else this.queue.push(response);
      }
    }
  }

  describe("McpClient per-call deadlines", () => {
    it("preserves the 60s default and isolates concurrent longer and shorter overrides", async () => {
      vi.useFakeTimers();
      const transport = new ToolTimeoutTransport();
      const client = new McpClient({ transport });
      try {
        await client.initialize();
        const normal = expect(client.callTool("normal")).rejects.toThrow("after 60000ms");
        const longer = expect(
          client.callTool("longer", {}, { timeoutMs: 600_000 }),
        ).rejects.toThrow("after 600000ms");
        const shorter = expect(
          client.callTool("shorter", {}, { timeoutMs: 1_000 }),
        ).rejects.toThrow("after 1000ms");
        await vi.advanceTimersByTimeAsync(1_000);
        await shorter;
        expect(vi.getTimerCount()).toBe(2);
        await vi.advanceTimersByTimeAsync(59_000);
        await normal;
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(540_000);
        await longer;
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await client.close();
        vi.useRealTimers();
      }
    });

    it("keeps a configured default after an override", async () => {
      vi.useFakeTimers();
      const client = new McpClient({ transport: new ToolTimeoutTransport(), requestTimeoutMs: 25 });
      try {
        await client.initialize();
        const override = expect(client.callTool("override", {}, { timeoutMs: 10 })).rejects.toThrow(
          "after 10ms",
        );
        await vi.advanceTimersByTimeAsync(10);
        await override;
        const normal = expect(client.callTool("normal")).rejects.toThrow("after 25ms");
        await vi.advanceTimersByTimeAsync(25);
        await normal;
      } finally {
        await client.close();
        vi.useRealTimers();
      }
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
      "rejects invalid timeout %s before sending",
      async (timeoutMs) => {
        const transport = new ToolTimeoutTransport();
        const client = new McpClient({ transport });
        try {
          await client.initialize();
          const count = transport.sent.length;
          await expect(client.callTool("invalid", {}, { timeoutMs })).rejects.toThrow("timeoutMs");
          expect(transport.sent).toHaveLength(count);
        } finally {
          await client.close();
        }
      },
    );

    it("still cancels a call with a long override", async () => {
      const transport = new ToolTimeoutTransport();
      const client = new McpClient({ transport });
      try {
        await client.initialize();
        const controller = new AbortController();
        const pending = client.callTool(
          "long",
          {},
          { timeoutMs: 600_000, signal: controller.signal },
        );
        controller.abort();
        await expect(pending).rejects.toThrow("aborted");
        expect(transport.sent).toContainEqual(
          expect.objectContaining({ method: "notifications/cancelled" }),
        );
      } finally {
        await client.close();
      }
    });
  });

  describe("McpClient.request() timeout/no-crash", () => {
    const shortTimeoutMs = 50;

    it("hung send still rejects with timeout", async () => {
      const transport = new HangingSendTransport();
      const client = new McpClient({
        transport,
        requestTimeoutMs: shortTimeoutMs,
      });
      await expect(client.initialize()).rejects.toThrow(/timed out/);
      await client.close();
    });

    it("hung-send timeout does not emit unhandledRejection", async () => {
      const transport = new HangingSendTransport();
      const client = new McpClient({
        transport,
        requestTimeoutMs: shortTimeoutMs,
      });
      const handler = vi.fn();
      process.on("unhandledRejection", handler);
      try {
        await expect(client.initialize()).rejects.toThrow(/timed out/);
        await new Promise((r) => setTimeout(r, shortTimeoutMs + 50));
        expect(handler).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", handler);
        await client.close();
      }
    });

    it("rejecting send rejects with the send error, not timeout", async () => {
      const transport = new RejectingSendTransport();
      const client = new McpClient({
        transport,
        requestTimeoutMs: 60_000,
      });
      await expect(client.initialize()).rejects.toThrow("transport send failed");
      await client.close();
    });

    it("rejecting send clears the armed timeout (no late orphan rejection)", async () => {
      const transport = new RejectingSendTransport();
      const client = new McpClient({
        transport,
        requestTimeoutMs: shortTimeoutMs,
      });
      const handler = vi.fn();
      process.on("unhandledRejection", handler);
      try {
        await expect(client.initialize()).rejects.toThrow("transport send failed");
        await new Promise((r) => setTimeout(r, shortTimeoutMs + 100));
        expect(handler).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", handler);
        await client.close();
      }
    });

    it("normal silent-server timeout still works", async () => {
      const transport = new SilentServerTransport();
      const client = new McpClient({
        transport,
        requestTimeoutMs: shortTimeoutMs,
      });
      await expect(client.initialize()).rejects.toThrow(/timed out/);
      await client.close();
    });

    it("silent-server timeout does not emit unhandledRejection", async () => {
      const transport = new SilentServerTransport();
      const client = new McpClient({
        transport,
        requestTimeoutMs: shortTimeoutMs,
      });
      const handler = vi.fn();
      process.on("unhandledRejection", handler);
      try {
        await expect(client.initialize()).rejects.toThrow(/timed out/);
        await new Promise((r) => setTimeout(r, shortTimeoutMs + 100));
        expect(handler).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", handler);
        await client.close();
      }
    });

    it("initialize() rejects when the supplied AbortSignal fires (issue #1236)", async () => {
      const transport = new SilentServerTransport();
      const client = new McpClient({ transport, requestTimeoutMs: 60_000 });
      const ac = new AbortController();
      const pending = client.initialize({ signal: ac.signal });
      setTimeout(() => ac.abort(), 20);
      await expect(pending).rejects.toThrow(/aborted/);
      await client.close();
    });
  });
});

// MCP integration — spawns the demo MCP server, bridges tools, invokes them end-to-end.
describe("mcp-integration", () => {
  // Spawning `tsx` directly needs a cross-platform approach. `node --import tsx`
  // works everywhere Node 22+ is installed (which is our engines target) and
  // avoids the Windows `.cmd` resolution gotcha in child_process.spawn.
  const NODE_CMD = process.execPath;
  const DEMO_SERVER_ARGS = ["--import", "tsx", "tests/fixtures/mcp-server-demo.ts"];

  describe("MCP integration — real subprocess against bundled demo server", () => {
    let client: McpClient | null = null;

    afterEach(async () => {
      if (client) {
        await client.close();
        client = null;
      }
    });

    it("initializes, lists tools, and calls echo/add end-to-end", async () => {
      const transport = new StdioTransport({
        command: NODE_CMD,
        args: DEMO_SERVER_ARGS,
        // We're spawning node.exe directly — bypass the shell-true default
        // that exists for .cmd wrappers (npx etc.). Saves a cmd.exe hop
        // and the quoting concerns that come with it.
        shell: false,
      });
      client = new McpClient({ transport, requestTimeoutMs: 15_000 });
      const info = await client.initialize();
      expect(info.serverInfo.name).toBe("reasonix-demo-mcp");
      expect(info.capabilities.tools).toBeDefined();

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["add", "echo", "get_time", "slow_count"]);

      const echoResult = await client.callTool("echo", { msg: "hello" });
      const echoText = echoResult.content.map((c) => ("text" in c ? c.text : "")).join("");
      expect(echoText).toContain("hello");

      const addResult = await client.callTool("add", { a: 17, b: 25 });
      const addText = addResult.content.map((c) => ("text" in c ? c.text : "")).join("");
      expect(addText).toContain("42");
    }, 30_000);

    it("bridges real MCP tools into a Reasonix ToolRegistry", async () => {
      const transport = new StdioTransport({
        command: NODE_CMD,
        args: DEMO_SERVER_ARGS,
        shell: false,
      });
      client = new McpClient({ transport, requestTimeoutMs: 15_000 });
      await client.initialize();

      const { registry, registeredNames } = await bridgeMcpTools(client, { namePrefix: "demo_" });
      expect(registeredNames.sort()).toEqual([
        "demo_add",
        "demo_echo",
        "demo_get_time",
        "demo_slow_count",
      ]);

      // Dispatch through the registry — should round-trip through MCP
      const out = await registry.dispatch("demo_add", JSON.stringify({ a: 100, b: 1 }));
      expect(out).toContain("101");
    }, 30_000);

    it("host indirection: bridged tool calls follow host.client when it's swapped out", async () => {
      // Without invoking reconnect (which adds parseMcpSpec / shell quoting
      // concerns on Windows paths with spaces), prove the indirection layer
      // alone: bridge with a host, manually swap host.client to a fresh
      // McpClient pointing at a second demo subprocess, confirm the existing
      // registered tool routes through the new client.
      const tA = new StdioTransport({ command: NODE_CMD, args: DEMO_SERVER_ARGS, shell: false });
      const a = new McpClient({ transport: tA, requestTimeoutMs: 15_000 });
      await a.initialize();
      const host: McpClientHost = { client: a };
      const { registry } = await bridgeMcpTools(a, {
        registry: new ToolRegistry(),
        namePrefix: "demo_",
        host,
      });
      const okBefore = await registry.dispatch("demo_add", JSON.stringify({ a: 1, b: 1 }));
      expect(okBefore).toContain("2");

      // Spin up a fresh subprocess and swap host.client.
      const tB = new StdioTransport({ command: NODE_CMD, args: DEMO_SERVER_ARGS, shell: false });
      const b = new McpClient({ transport: tB, requestTimeoutMs: 15_000 });
      await b.initialize();
      host.client = b;
      await a.close();

      // Same registered tool, now serviced by the new client.
      const okAfter = await registry.dispatch("demo_add", JSON.stringify({ a: 7, b: 8 }));
      expect(okAfter).toContain("15");
      await b.close();
    }, 60_000);

    it("bridges two MCP servers into a shared registry with different prefixes", async () => {
      // Two instances of the same demo server, namespaced `a_` and `b_`.
      // Proves the multi-server CLI wiring: both dispatches go through
      // their respective subprocesses without cross-talk.
      const tA = new StdioTransport({ command: NODE_CMD, args: DEMO_SERVER_ARGS, shell: false });
      const a = new McpClient({ transport: tA, requestTimeoutMs: 15_000 });
      const tB = new StdioTransport({ command: NODE_CMD, args: DEMO_SERVER_ARGS, shell: false });
      const b = new McpClient({ transport: tB, requestTimeoutMs: 15_000 });
      try {
        await a.initialize();
        await b.initialize();
        const shared = new ToolRegistry();
        const resA = await bridgeMcpTools(a, { registry: shared, namePrefix: "a_" });
        const resB = await bridgeMcpTools(b, { registry: shared, namePrefix: "b_" });
        expect(resA.registeredNames).toHaveLength(4);
        expect(resB.registeredNames).toHaveLength(4);
        expect(shared.size).toBe(8);

        const outA = await shared.dispatch("a_add", JSON.stringify({ a: 10, b: 20 }));
        expect(outA).toContain("30");
        const outB = await shared.dispatch("b_add", JSON.stringify({ a: 1, b: 2 }));
        expect(outB).toContain("3");
      } finally {
        await a.close();
        await b.close();
      }
    }, 30_000);

    it("rejects immediately on non-zero subprocess exit with captured stderr", async () => {
      const transport = new StdioTransport({
        command: NODE_CMD,
        args: ["-e", "process.stderr.write('fatal boom!\\n'); process.exit(17)"],
        shell: false,
      });
      client = new McpClient({ transport, requestTimeoutMs: 15_000 });
      const t0 = Date.now();
      await expect(client.initialize()).rejects.toThrow(/exited with code 17.*fatal boom!/);
      expect(Date.now() - t0).toBeLessThan(5_000);
    });
  });
});

describe("mcp-reconnect", () => {
  /** A throwaway client we can hand to the host without bothering to initialize — reconnect won't touch it on the parse-failure path. */
  function dummyHost(): McpClientHost {
    const transport = new StdioTransport({ command: "true", args: [], shell: false });
    return { client: new McpClient({ transport, requestTimeoutMs: 1_000 }) };
  }

  describe("reconnectMcpServer — early-return paths", () => {
    it("returns spec_parse when the spec string is empty", async () => {
      const host = dummyHost();
      const r = await reconnectMcpServer({ host, spec: "", beforeTools: [] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.reason).toBe("spec_parse");
      expect(r.message).toMatch(/empty MCP spec/);
      await host.client.close();
    });

    it("returns spec_parse when the spec has a name but no command", async () => {
      const host = dummyHost();
      const r = await reconnectMcpServer({ host, spec: "fs=", beforeTools: [] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.reason).toBe("spec_parse");
      expect(r.message).toMatch(/has name but no command/);
      await host.client.close();
    });

    // Handshake-failure path is platform-sensitive (Windows shell:true doesn't
    // surface ENOENT synchronously). Exercised in mcp-integration.test.ts via
    // the live demo server instead.
  });
});

// Pins down the cache-prefix claims in RFC #110 (MCP reconnect).
describe("mcp-reconnect-prefix-invariant", () => {
  function tool(name: string, description = "", params: object = { type: "object" }): ToolSpec {
    return {
      type: "function",
      function: { name, description, parameters: params },
    };
  }

  describe("RFC #110 — cache-prefix invariant under MCP reconnect", () => {
    it("re-bridging an IDENTICAL tool list yields byte-identical fingerprint (the safe case)", () => {
      const before = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read"), tool("write"), tool("search")],
      });
      const after = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read"), tool("write"), tool("search")],
      });
      expect(after.fingerprint).toBe(before.fingerprint);
    });

    it("re-bridging with one ADDED tool changes the fingerprint (cache miss next turn)", () => {
      const before = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read"), tool("write")],
      });
      const after = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read"), tool("write"), tool("delete")],
      });
      expect(after.fingerprint).not.toBe(before.fingerprint);
    });

    it("re-bridging with one REMOVED tool changes the fingerprint", () => {
      const before = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read"), tool("write"), tool("search")],
      });
      const after = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read"), tool("write")],
      });
      expect(after.fingerprint).not.toBe(before.fingerprint);
    });

    it("a description-only change on an existing tool changes the fingerprint", () => {
      const before = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read", "reads a file")],
      });
      const after = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read", "reads a file (utf-8)")],
      });
      expect(after.fingerprint).not.toBe(before.fingerprint);
    });

    it("a parameter-schema change on an existing tool changes the fingerprint", () => {
      const before = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read", "", { type: "object", properties: { path: { type: "string" } } })],
      });
      const after = new ImmutablePrefix({
        system: "s",
        toolSpecs: [
          tool("read", "", {
            type: "object",
            properties: { path: { type: "string" }, encoding: { type: "string" } },
          }),
        ],
      });
      expect(after.fingerprint).not.toBe(before.fingerprint);
    });

    it("REORDERING the same tools keeps the fingerprint stable (prefix sorts tool specs)", () => {
      const a = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("read"), tool("write"), tool("search")],
      });
      const b = new ImmutablePrefix({
        system: "s",
        toolSpecs: [tool("write"), tool("read"), tool("search")],
      });
      expect(b.fingerprint).toBe(a.fingerprint);
    });
  });
});

describe("mcp-registry-readiness", () => {
  interface FakeClient {
    callTool: (
      name: string,
      args?: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => Promise<CallToolResult>;
  }

  function makeFakeHost(callImpl: FakeClient["callTool"]): McpClientHost {
    const fake: FakeClient = { callTool: callImpl };
    // The bridge only touches host.client.callTool — cast to satisfy the type.
    return { client: fake as unknown as McpClientHost["client"] };
  }

  const TOOL: McpTool = {
    name: "echo",
    description: "echo input",
    inputSchema: { type: "object", properties: { msg: { type: "string" } } },
  };

  describe("MCP bridge readiness gate", () => {
    it("dispatch fired mid-handshake waits for the ready deferred and then resolves", async () => {
      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => {
        resolveReady = r;
      });
      let callsAttempted = 0;
      const host = makeFakeHost(async () => {
        callsAttempted += 1;
        return {
          content: [{ type: "text", text: "pong" }],
        };
      });
      const registry = new ToolRegistry();
      const env: BridgeEnv = {
        registry,
        host,
        prefix: "demo_",
        maxResultChars: 32_000,
        tracker: null,
        ready,
        readyTimeoutMs: 5_000,
        serverName: "demo",
      };
      const name = registerSingleMcpTool(TOOL, env);
      expect(name).toBe("demo_echo");

      const dispatched = registry.dispatch(name, JSON.stringify({ msg: "hi" }));

      // Yield a few microtasks — the dispatch must still be awaiting `ready`
      // since `callTool` hasn't been invoked yet.
      await new Promise((r) => setTimeout(r, 30));
      expect(callsAttempted).toBe(0);

      resolveReady();
      const out = await dispatched;
      expect(out).toContain("pong");
      expect(callsAttempted).toBe(1);
    });

    it("dispatch rejects with the failure reason when ready rejects", async () => {
      const ready = Promise.reject(new Error('MCP server "demo" failed to start: ENOENT'));
      // Avoid unhandledRejection warning before the bridge consumes it.
      ready.catch(() => undefined);
      const host = makeFakeHost(async () => {
        throw new Error("callTool should not run for a failed server");
      });
      const registry = new ToolRegistry();
      const env: BridgeEnv = {
        registry,
        host,
        prefix: "demo_",
        maxResultChars: 32_000,
        tracker: null,
        ready,
        readyTimeoutMs: 5_000,
        serverName: "demo",
      };
      const name = registerSingleMcpTool(TOOL, env);
      const out = await registry.dispatch(name, JSON.stringify({ msg: "hi" }));
      // ToolRegistry.dispatch returns a string envelope; the failure reason
      // must surface to the model rather than the bare transport error.
      expect(out).toContain("ENOENT");
    });

    it("dispatch surfaces a timeout error when ready never resolves within the budget", async () => {
      const ready = new Promise<void>(() => {
        // never settles
      });
      const host = makeFakeHost(async () => {
        throw new Error("callTool should not run while still handshaking");
      });
      const registry = new ToolRegistry();
      const env: BridgeEnv = {
        registry,
        host,
        prefix: "demo_",
        maxResultChars: 32_000,
        tracker: null,
        ready,
        readyTimeoutMs: 60,
        serverName: "demo",
      };
      const name = registerSingleMcpTool(TOOL, env);
      const out = await registry.dispatch(name, JSON.stringify({ msg: "hi" }));
      expect(out.toLowerCase()).toContain("handshaking");
    });
  });
});

// SSE transport — in-process http.Server speaking the MCP HTTP+SSE wire shape.
describe("mcp-sse", () => {
  interface FakeSseServer {
    url: string;
    requests: Array<{ method: string; url: string; body?: string }>;
    stop: () => Promise<void>;
  }

  interface FakeSseOptions {
    /** Endpoint URL announced in the first SSE event. Relative or absolute. */
    endpointPath?: string;
    /** Override the SSE GET path (default `/sse`). */
    ssePath?: string;
    /** Override the POST path (default `/messages`). */
    postPath?: string;
    /** Auto-answer incoming JSON-RPC requests on the SSE channel. */
    autoRespond?: (body: unknown) => unknown;
    /** Return this status for the initial SSE GET instead of 200. */
    handshakeStatus?: number;
  }

  function startFakeSseServer(opts: FakeSseOptions = {}): Promise<FakeSseServer> {
    const ssePath = opts.ssePath ?? "/sse";
    const postPath = opts.postPath ?? "/messages";
    const endpointPath = opts.endpointPath ?? postPath;
    let sseRes: ServerResponse | null = null;
    const requests: FakeSseServer["requests"] = [];

    const writeFrame = (res: ServerResponse, event: string, data: string) => {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === ssePath) {
        requests.push({ method: "GET", url: req.url ?? "" });
        if (opts.handshakeStatus && opts.handshakeStatus !== 200) {
          res.statusCode = opts.handshakeStatus;
          res.end("not ok");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        sseRes = res;
        writeFrame(res, "endpoint", endpointPath);
        req.on("close", () => {
          if (sseRes === res) sseRes = null;
        });
        return;
      }
      if (req.method === "POST" && req.url === postPath) {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          requests.push({ method: "POST", url: req.url ?? "", body });
          res.writeHead(202);
          res.end();
          if (opts.autoRespond && sseRes) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch {
              return;
            }
            const reply = opts.autoRespond(parsed);
            if (reply !== undefined) {
              writeFrame(sseRes, "message", JSON.stringify(reply));
            }
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}${ssePath}`,
          requests,
          stop: () =>
            new Promise<void>((r) => {
              sseRes?.end();
              server.close(() => r());
              server.closeAllConnections?.();
            }),
        });
      });
    });
  }

  describe("SseTransport: handshake + round-trip", () => {
    let fake: FakeSseServer | null = null;

    beforeEach(() => {
      fake = null;
    });
    afterEach(async () => {
      await fake?.stop();
    });

    it("resolves a relative endpoint URL against the SSE base", async () => {
      fake = await startFakeSseServer({
        endpointPath: "/messages",
        autoRespond: (req) => ({
          jsonrpc: "2.0",
          id: (req as { id: number }).id,
          result: { ok: true },
        }),
      });
      const transport = new SseTransport({ url: fake.url });
      await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

      // Read one incoming message.
      const iter = transport.messages();
      const first = await iter.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({ id: 1, result: { ok: true } });
      await transport.close();
    });

    it("drives a full McpClient initialize → tools/list round-trip", async () => {
      fake = await startFakeSseServer({
        autoRespond: (raw) => {
          const req = raw as { id?: number; method: string };
          if (req.id === undefined) return undefined; // notification (initialized)
          if (req.method === "initialize") {
            return {
              jsonrpc: "2.0",
              id: req.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: "fake-sse", version: "0.0.0" },
                capabilities: { tools: { listChanged: false } },
              },
            };
          }
          if (req.method === "tools/list") {
            return {
              jsonrpc: "2.0",
              id: req.id,
              result: {
                tools: [
                  {
                    name: "ping",
                    description: "responds pong",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
            };
          }
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: `no such method ${req.method}` },
          };
        },
      });
      const client = new McpClient({ transport: new SseTransport({ url: fake.url }) });
      const info = await client.initialize();
      expect(info.serverInfo.name).toBe("fake-sse");
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("ping");

      await client.close();

      // We should have exactly: GET /sse, POST initialize, POST notifications/initialized, POST tools/list
      const posts = fake.requests.filter((r) => r.method === "POST");
      expect(posts).toHaveLength(3);
      const methods = posts.map((p) => (JSON.parse(p.body!) as { method: string }).method);
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    });

    it("accepts an absolute endpoint URL", async () => {
      // Spin up a first server just to get a port we can embed in the other.
      const probe = await startFakeSseServer();
      const absoluteEndpoint = new URL("/messages", probe.url).toString();
      await probe.stop();

      fake = await startFakeSseServer({
        endpointPath: absoluteEndpoint,
        autoRespond: (req) => ({
          jsonrpc: "2.0",
          id: (req as { id: number }).id,
          result: { pong: true },
        }),
      });
      // Point the SSE transport at THIS server, but have it advertise the
      // stale probe URL — we care that the client stores it verbatim
      // rather than resolving it against the base, so the POST will land
      // on the dead probe port and fail. That's the assertion.
      const t = new SseTransport({ url: fake.url });
      await expect(t.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow();
      await t.close();
    });

    it("surfaces a handshake failure as a synthetic error frame", async () => {
      fake = await startFakeSseServer({ handshakeStatus: 500 });
      const t = new SseTransport({ url: fake.url });
      // Any pending send() rejects with the handshake error.
      await expect(t.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(/500/);
      await t.close();
    });
  });
});

// StdioTransport.close() must terminate server trees and remain safe on kill errors.
describe("mcp-stdio-close", () => {
  describe("StdioTransport.close()", () => {
    it("swallows kill() EINVAL without throwing", async () => {
      const t = new StdioTransport({
        command: "node",
        args: ["-e", "process.exit(0)"],
        shell: false,
      });
      // Let child exit so .kill() hits a reaped/zombie-like state.
      await new Promise((r) => setTimeout(r, 200));
      await expect(t.close()).resolves.toBeUndefined();
    });

    it("does not throw on failed spawn", async () => {
      const t = new StdioTransport({
        command: "nonexistent_command_that_does_not_exist_12345",
        shell: false,
      });
      const iter = t.messages();
      const msg = await iter[Symbol.asyncIterator]().next();
      expect(msg.value?.error?.code).toBe(-32000);
      await expect(t.close()).resolves.toBeUndefined();
    });

    it("is idempotent — second close() is a no-op", async () => {
      const t = new StdioTransport({
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        shell: false,
      });
      await t.close();
      await expect(t.close()).resolves.toBeUndefined();
    });

    it("terminates through the process-tree path before the direct-child fallback", async () => {
      const t = new StdioTransport({
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        shell: false,
      });
      const child = (t as unknown as { child: ChildProcess }).child;
      const originalKill = child.kill.bind(child);
      let directKillCalled = false;
      child.kill = (signal?: NodeJS.Signals | number) => {
        directKillCalled = true;
        return originalKill(signal);
      };
      await expect(t.close()).resolves.toBeUndefined();
      expect(directKillCalled).toBe(false);
      try {
        originalKill();
      } catch {
        /* already dead */
      }
    });
  });
});

// Streamable HTTP transport — in-process fake server speaking the Streamable HTTP wire shape.
describe("mcp-streamable-http", () => {
  interface FakeServer {
    url: string;
    requests: Array<{
      method: string;
      url: string;
      body?: string;
      headers: Record<string, string | string[] | undefined>;
    }>;
    stop: () => Promise<void>;
  }

  interface FakeOptions {
    /** Override path (default `/mcp`). */
    path?: string;
    /** Hand back this session id on the initialize response. Default "sess-1". */
    sessionId?: string;
    /** `{ stream: [...] }` → SSE frames; `undefined` → 202 ack; else single application/json body. */
    reply?: (body: unknown) => unknown | { stream: unknown[] } | undefined;
    /** Failure injection lookup runs after `reply` so it can short-circuit the normal path. */
    forceStatus?: (body: unknown) => { status: number; body?: string } | undefined;
  }

  function startFakeServer(opts: FakeOptions = {}): Promise<FakeServer> {
    const path = opts.path ?? "/mcp";
    const sessionId = opts.sessionId ?? "sess-1";
    const requests: FakeServer["requests"] = [];
    let mintedSession = false;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url || !req.url.startsWith(path)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          requests.push({
            method: "POST",
            url: req.url ?? "",
            body,
            headers: req.headers,
          });
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end("bad json");
            return;
          }

          const forced = opts.forceStatus?.(parsed);
          if (forced) {
            res.writeHead(forced.status);
            res.end(forced.body ?? "");
            return;
          }

          const reply = opts.reply?.(parsed);

          // The session id is minted on the first response that has a
          // body — i.e. the initialize response. Notifications (202) and
          // unknown methods don't get a session header until then.
          const responseHeaders: Record<string, string> = {};
          const isInitialize =
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { method?: string }).method === "initialize";
          if (isInitialize && !mintedSession) {
            responseHeaders["mcp-session-id"] = sessionId;
            mintedSession = true;
          }

          if (reply === undefined) {
            // notification → 202 Accepted, no body
            res.writeHead(202, responseHeaders);
            res.end();
            return;
          }
          if (
            typeof reply === "object" &&
            reply !== null &&
            Array.isArray((reply as { stream?: unknown[] }).stream)
          ) {
            const frames = (reply as { stream: unknown[] }).stream;
            res.writeHead(200, {
              ...responseHeaders,
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            for (const frame of frames) {
              res.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
            }
            res.end();
            return;
          }
          res.writeHead(200, {
            ...responseHeaders,
            "content-type": "application/json",
          });
          res.end(JSON.stringify(reply));
        });
        return;
      }

      res.writeHead(405);
      res.end("method not allowed");
    });

    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}${path}`,
          requests,
          stop: () =>
            new Promise<void>((r) => {
              server.close(() => r());
              server.closeAllConnections?.();
            }),
        });
      });
    });
  }

  describe("StreamableHttpTransport: POST round-trip", () => {
    let fake: FakeServer | null = null;

    beforeEach(() => {
      fake = null;
    });
    afterEach(async () => {
      await fake?.stop();
    });

    it("delivers a single application/json response back through messages()", async () => {
      fake = await startFakeServer({
        reply: (req) => ({
          jsonrpc: "2.0",
          id: (req as { id: number }).id,
          result: { ok: true },
        }),
      });
      const transport = new StreamableHttpTransport({ url: fake.url });
      await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

      const iter = transport.messages();
      const first = await iter.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({ id: 1, result: { ok: true } });
      await transport.close();
    });

    it("resolves expiring headers for every request and overrides static values", async () => {
      fake = await startFakeServer({
        reply: (req) => ({
          jsonrpc: "2.0",
          id: (req as { id: number }).id,
          result: {},
        }),
      });
      let generation = 0;
      const transport = new StreamableHttpTransport({
        url: fake.url,
        headers: { authorization: "Bearer stale", "x-static": "kept" },
        headersResolver: async () => ({ authorization: `Bearer fresh-${++generation}` }),
      });
      await transport.send({ jsonrpc: "2.0", id: 1, method: "first" });
      await transport.send({ jsonrpc: "2.0", id: 2, method: "second" });
      expect(fake.requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer fresh-1",
        "Bearer fresh-2",
      ]);
      expect(fake.requests.every((request) => request.headers["x-static"] === "kept")).toBe(true);
      await transport.close();
    });

    it("treats 202 Accepted as a no-op (notification ack, no message yielded)", async () => {
      fake = await startFakeServer({
        reply: (req) => {
          // Notifications have no id — return undefined → 202.
          if ((req as { id?: number }).id === undefined) return undefined;
          return { jsonrpc: "2.0", id: (req as { id: number }).id, result: {} };
        },
      });
      const transport = new StreamableHttpTransport({ url: fake.url });
      await transport.send({ jsonrpc: "2.0", method: "notifications/cancelled" });
      // Now send a real request so we can prove the iterator only got
      // the response (one message), not the notification (no message).
      await transport.send({ jsonrpc: "2.0", id: 42, method: "ping" });
      const iter = transport.messages();
      const first = await iter.next();
      expect(first.value).toMatchObject({ id: 42 });
      await transport.close();
    });

    it("captures Mcp-Session-Id from the initialize response and echoes it on subsequent POSTs", async () => {
      fake = await startFakeServer({
        sessionId: "alpha-session",
        reply: (req) => {
          const r = req as { id?: number; method: string };
          if (r.method === "initialize") {
            return {
              jsonrpc: "2.0",
              id: r.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: "fake", version: "0.0.0" },
                capabilities: {},
              },
            };
          }
          if (r.id === undefined) return undefined;
          return { jsonrpc: "2.0", id: r.id, result: { echoed: r.method } };
        },
      });
      const transport = new StreamableHttpTransport({ url: fake.url });
      const client = new McpClient({ transport });
      await client.initialize();
      expect(transport.getSessionId()).toBe("alpha-session");

      await client.listTools().catch(() => undefined);
      await client.close();

      // First POST = initialize: no session header yet (we don't have one).
      // Second POST = notifications/initialized: should have session id.
      // Third POST = tools/list: should have session id.
      const posts = fake.requests.filter((r) => r.method === "POST");
      expect(posts.length).toBeGreaterThanOrEqual(2);
      expect(posts[0]!.headers["mcp-session-id"]).toBeUndefined();
      for (let i = 1; i < posts.length; i++) {
        expect(posts[i]!.headers["mcp-session-id"]).toBe("alpha-session");
      }
    });

    it("delivers SSE-streamed responses with multiple frames in order", async () => {
      fake = await startFakeServer({
        reply: (req) => {
          const r = req as { id: number };
          return {
            stream: [
              // a progress notification first
              { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 50 } },
              // then the real response
              { jsonrpc: "2.0", id: r.id, result: { done: true } },
            ],
          };
        },
      });
      const transport = new StreamableHttpTransport({ url: fake.url });
      await transport.send({ jsonrpc: "2.0", id: 7, method: "slow_tool" });
      const iter = transport.messages();
      const first = await iter.next();
      expect(first.value).toMatchObject({ method: "notifications/progress" });
      const second = await iter.next();
      expect(second.value).toMatchObject({ id: 7, result: { done: true } });
      await transport.close();
    });

    it("drives a full McpClient initialize → tools/list round-trip", async () => {
      fake = await startFakeServer({
        reply: (raw) => {
          const r = raw as { id?: number; method: string };
          if (r.id === undefined) return undefined;
          if (r.method === "initialize") {
            return {
              jsonrpc: "2.0",
              id: r.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: "fake-streamable", version: "0.0.0" },
                capabilities: { tools: { listChanged: false } },
              },
            };
          }
          if (r.method === "tools/list") {
            return {
              jsonrpc: "2.0",
              id: r.id,
              result: {
                tools: [
                  {
                    name: "ping",
                    description: "responds pong",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
            };
          }
          return {
            jsonrpc: "2.0",
            id: r.id,
            error: { code: -32601, message: `no such method ${r.method}` },
          };
        },
      });
      const transport = new StreamableHttpTransport({ url: fake.url });
      const client = new McpClient({ transport });
      const info = await client.initialize();
      expect(info.serverInfo.name).toBe("fake-streamable");
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("ping");
      await client.close();

      // initialize + notifications/initialized + tools/list = 3 POSTs.
      const posts = fake.requests.filter((r) => r.method === "POST");
      expect(posts).toHaveLength(3);
      const methods = posts.map((p) => (JSON.parse(p.body!) as { method: string }).method);
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    });

    it("surfaces a 404 with an existing session id as 'session expired'", async () => {
      fake = await startFakeServer({
        reply: (req) => {
          const r = req as { id?: number; method: string };
          if (r.method === "initialize") {
            return {
              jsonrpc: "2.0",
              id: r.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: "fake", version: "0.0.0" },
                capabilities: {},
              },
            };
          }
          if (r.id === undefined) return undefined;
          return { jsonrpc: "2.0", id: r.id, result: {} };
        },
        forceStatus: (req) => {
          const r = req as { method?: string };
          if (r.method === "tools/list") {
            return { status: 404, body: "session expired" };
          }
          return undefined;
        },
      });
      const transport = new StreamableHttpTransport({ url: fake.url });
      const client = new McpClient({ transport });
      await client.initialize();
      expect(transport.getSessionId()).not.toBeNull();
      // Once the session id is set, a 404 should surface as a clear error.
      await expect(client.listTools()).rejects.toThrow(/session expired/i);
      await client.close();
    });

    it("surfaces a non-OK response as an error from send()", async () => {
      fake = await startFakeServer({
        forceStatus: () => ({ status: 500, body: "boom" }),
      });
      const transport = new StreamableHttpTransport({ url: fake.url });
      await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(
        /500/,
      );
      await transport.close();
    });

    it("close() unblocks an idle messages() iterator", async () => {
      fake = await startFakeServer({ reply: () => undefined });
      const transport = new StreamableHttpTransport({ url: fake.url });
      const iter = transport.messages();
      const next = iter.next();
      await transport.close();
      const settled = await next;
      expect(settled.done).toBe(true);
    });
  });
});

// MCP client + bridge — in-process fake transport answering initialize / tools/list / tools/call.
describe("mcp", () => {
  interface FakeServerOptions {
    tools: McpTool[];
    /** Server's response per (name, args). Called for tools/call. */
    callHandler?: (name: string, args: Record<string, unknown>) => CallToolResult;
    /** Return an error from tools/call instead of a result. */
    errorFor?: Set<string>;
    /** Track every call the server received. */
    received?: JsonRpcRequest[];
    /** resources/list response. Optional — omit to return empty. */
    listResources?: () => ListResourcesResult;
    /** resources/read response keyed by URI. Throw-returns method-not-found for unknowns. */
    readResource?: (uri: string) => ReadResourceResult;
    /** prompts/list response. */
    listPrompts?: () => ListPromptsResult;
    /** prompts/get response keyed by name. */
    getPrompt?: (name: string, args?: Record<string, string>) => GetPromptResult;
    /** Initialize capabilities override — defaults advertise tools only. */
    capabilities?: Record<string, unknown>;
    /** Client responses to server-initiated requests. */
    responses?: JsonRpcMessage[];
  }

  /** In-process MCP transport — responds in `send()` by pushing onto the queue. */
  class FakeMcpTransport implements McpTransport {
    private readonly queue: JsonRpcMessage[] = [];
    private readonly waiters: Array<(m: JsonRpcMessage | null) => void> = [];
    private closed = false;
    constructor(private readonly opts: FakeServerOptions) {
      opts.received = opts.received ?? [];
    }

    async send(msg: JsonRpcMessage): Promise<void> {
      if (this.closed) throw new Error("fake transport closed");
      if (!("method" in msg)) {
        this.opts.responses?.push(msg);
        return;
      }
      if (!("id" in msg)) {
        // notification — e.g. notifications/initialized — acknowledge silently
        this.opts.received!.push(msg as JsonRpcRequest);
        return;
      }
      const req = msg as JsonRpcRequest;
      this.opts.received!.push(req);
      const response = this.handle(req);
      this.push(response);
    }

    async *messages(): AsyncIterableIterator<JsonRpcMessage> {
      while (true) {
        if (this.queue.length > 0) {
          yield this.queue.shift()!;
          continue;
        }
        if (this.closed) return;
        const next = await new Promise<JsonRpcMessage | null>((resolve) => {
          this.waiters.push(resolve);
        });
        if (next === null) return;
        yield next;
      }
    }

    async close(): Promise<void> {
      this.closed = true;
      while (this.waiters.length > 0) this.waiters.shift()!(null);
    }

    pushServerMessage(msg: JsonRpcMessage): void {
      this.push(msg);
    }

    private handle(req: JsonRpcRequest): JsonRpcMessage {
      switch (req.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              serverInfo: { name: "fake-mcp", version: "0.0.0" },
              capabilities: this.opts.capabilities ?? { tools: { listChanged: false } },
            },
          };
        case "tools/list":
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: { tools: this.opts.tools },
          };
        case "tools/call": {
          const params = req.params as { name: string; arguments?: Record<string, unknown> };
          if (this.opts.errorFor?.has(params.name)) {
            return {
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32001, message: `server-side error for ${params.name}` },
            };
          }
          const result = this.opts.callHandler
            ? this.opts.callHandler(params.name, params.arguments ?? {})
            : { content: [{ type: "text" as const, text: `called ${params.name}` }] };
          return { jsonrpc: "2.0", id: req.id, result };
        }
        case "resources/list":
          if (!this.opts.listResources) {
            return {
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32601, message: "method not found: resources/list" },
            };
          }
          return { jsonrpc: "2.0", id: req.id, result: this.opts.listResources() };
        case "resources/read": {
          if (!this.opts.readResource) {
            return {
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32601, message: "method not found: resources/read" },
            };
          }
          const { uri } = req.params as { uri: string };
          return { jsonrpc: "2.0", id: req.id, result: this.opts.readResource(uri) };
        }
        case "prompts/list":
          if (!this.opts.listPrompts) {
            return {
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32601, message: "method not found: prompts/list" },
            };
          }
          return { jsonrpc: "2.0", id: req.id, result: this.opts.listPrompts() };
        case "prompts/get": {
          if (!this.opts.getPrompt) {
            return {
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32601, message: "method not found: prompts/get" },
            };
          }
          const { name, arguments: a } = req.params as {
            name: string;
            arguments?: Record<string, string>;
          };
          return { jsonrpc: "2.0", id: req.id, result: this.opts.getPrompt(name, a) };
        }
        default:
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: `method not found: ${req.method}` },
          };
      }
    }

    private push(msg: JsonRpcMessage): void {
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    }
  }

  describe("McpClient: initialize handshake", () => {
    it("completes initialize and sends notifications/initialized", async () => {
      const received: JsonRpcRequest[] = [];
      const transport = new FakeMcpTransport({ tools: [], received });
      const client = new McpClient({ transport });
      const info = await client.initialize();
      expect(info.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(info.serverInfo.name).toBe("fake-mcp");

      // Client should have sent two messages: initialize + notifications/initialized
      expect(received).toHaveLength(2);
      expect(received[0]!.method).toBe("initialize");
      expect(received[1]!.method).toBe("notifications/initialized");

      await client.close();
    });

    it("advertises the roots capability when a workspace is configured", async () => {
      const received: JsonRpcRequest[] = [];
      const workspaceDir = "/tmp/reasonix-workspace";
      const transport = new FakeMcpTransport({ tools: [], received });
      const client = new McpClient({ transport, workspaceDir });
      await client.initialize();
      const init = received.find((r) => r.method === "initialize")!;
      const params = init.params as {
        capabilities: Record<string, unknown>;
      } & Record<string, unknown>;
      expect(params.capabilities).toHaveProperty("roots");
      expect(params).not.toHaveProperty("rootUri");
      expect(params).not.toHaveProperty("workspaceFolders");
      await client.close();
    });

    it("answers roots/list with the configured workspace root", async () => {
      const responses: JsonRpcMessage[] = [];
      const workspaceDir = "/tmp/reasonix-workspace";
      const workspaceUri = pathToFileURL(workspaceDir).href;
      const transport = new FakeMcpTransport({ tools: [], responses });
      const client = new McpClient({ transport, workspaceDir });
      await client.initialize();
      transport.pushServerMessage({ jsonrpc: "2.0", id: "roots-1", method: "roots/list" });
      for (let i = 0; responses.length === 0 && i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(responses[0]).toMatchObject({
        jsonrpc: "2.0",
        id: "roots-1",
        result: { roots: [{ uri: workspaceUri, name: "reasonix-workspace" }] },
      });
      await client.close();
    });

    it("refuses listTools before initialize", async () => {
      const client = new McpClient({ transport: new FakeMcpTransport({ tools: [] }) });
      await expect(client.listTools()).rejects.toThrow(/not initialized/);
      await client.close();
    });

    it("refuses a second initialize call", async () => {
      const client = new McpClient({ transport: new FakeMcpTransport({ tools: [] }) });
      await client.initialize();
      await expect(client.initialize()).rejects.toThrow(/already initialized/);
      await client.close();
    });
  });

  describe("McpClient: tools/list + tools/call", () => {
    const SAMPLE_TOOLS: McpTool[] = [
      {
        name: "echo",
        description: "echoes its input",
        inputSchema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
      },
      {
        name: "add",
        description: "a+b",
        inputSchema: {
          type: "object",
          properties: { a: { type: "integer" }, b: { type: "integer" } },
          required: ["a", "b"],
        },
      },
    ];

    it("lists tools and invokes them", async () => {
      const transport = new FakeMcpTransport({
        tools: SAMPLE_TOOLS,
        callHandler: (name, args) => {
          if (name === "echo") {
            return { content: [{ type: "text", text: String(args.msg ?? "") }] };
          }
          if (name === "add") {
            const sum = Number(args.a) + Number(args.b);
            return { content: [{ type: "text", text: String(sum) }] };
          }
          return { content: [{ type: "text", text: "?" }] };
        },
      });
      const client = new McpClient({ transport });
      await client.initialize();

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);

      const echoResult = await client.callTool("echo", { msg: "hi" });
      expect(echoResult.content[0]).toEqual({ type: "text", text: "hi" });

      const addResult = await client.callTool("add", { a: 17, b: 25 });
      expect(addResult.content[0]).toEqual({ type: "text", text: "42" });

      await client.close();
    });

    it("surfaces server errors as rejected promises", async () => {
      const transport = new FakeMcpTransport({
        tools: SAMPLE_TOOLS,
        errorFor: new Set(["echo"]),
      });
      const client = new McpClient({ transport });
      await client.initialize();
      await expect(client.callTool("echo", { msg: "x" })).rejects.toThrow(/MCP -32001/);
      await client.close();
    });
  });

  describe("bridgeMcpTools timeout controls", () => {
    it("exposes an optional deadline and strips it before hooks and upstream dispatch", async () => {
      const received: JsonRpcRequest[] = [];
      const tool: McpTool = {
        name: "import",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      };
      const client = new McpClient({
        transport: new FakeMcpTransport({ tools: [tool], received }),
      });
      await client.initialize();
      try {
        const call = vi.spyOn(client, "callTool");
        const transformArgs = vi.fn((_name, args) => ({ ...args, hydrated: true }));
        const beforeCall = vi.fn(async () => null);
        const { registry } = await bridgeMcpTools(client, { transformArgs, beforeCall });
        const schema = registry.specs()[0].function.parameters;
        // The deadline is documented once in the system prompt, not copied into each schema.
        expect(schema.properties).not.toHaveProperty("timeoutSec");
        expect(schema.required).toEqual(["path"]);
        expect(tool.inputSchema.properties).not.toHaveProperty("timeoutSec");
        const args = { path: "model.glb", timeoutSec: 600 };
        await registry.dispatch("import", JSON.stringify(args));
        expect(transformArgs).toHaveBeenCalledWith(
          "import",
          { path: "model.glb" },
          expect.any(Object),
        );
        expect(beforeCall).toHaveBeenCalledWith(
          "import",
          { path: "model.glb", hydrated: true },
          expect.any(Object),
        );
        expect(call).toHaveBeenLastCalledWith(
          "import",
          { path: "model.glb", hydrated: true },
          expect.objectContaining({ timeoutMs: 600_000 }),
        );
        expect(received.find((req) => req.method === "tools/call")?.params).toMatchObject({
          arguments: { path: "model.glb", hydrated: true },
        });
        expect(args.timeoutSec).toBe(600);
        await registry.dispatch("import", JSON.stringify({ path: "next.glb" }));
        expect(call).toHaveBeenLastCalledWith(
          "import",
          { path: "next.glb", hydrated: true },
          expect.objectContaining({ timeoutMs: undefined }),
        );
        for (const timeoutSec of [0, -1, 1.5, "600", null, 2_147_484]) {
          const count = call.mock.calls.length;
          const result = await registry.dispatch(
            "import",
            JSON.stringify({ path: "bad", timeoutSec }),
          );
          expect(result).toMatch(/error|invalid|integer|minimum|maximum/i);
          expect(call).toHaveBeenCalledTimes(count);
        }
      } finally {
        await client.close();
      }
    });

    it("keeps a parameters.properties object even when the server declares no arguments", async () => {
      // Providers validate the shape: a bare {type:"object"} without `properties` is a 400
      // risk, and the removed host-deadline property used to guarantee the key existed.
      const client = new McpClient({
        transport: new FakeMcpTransport({
          tools: [{ name: "ping", inputSchema: { type: "object" } }],
        }),
      });
      await client.initialize();
      try {
        const { registry } = await bridgeMcpTools(client, {});
        expect(registry.specs()[0].function.parameters).toEqual({ type: "object", properties: {} });
      } finally {
        await client.close();
      }
    });

    it("preserves upstream timeout names and picks a deterministic collision-free control", async () => {
      const client = new McpClient({
        transport: new FakeMcpTransport({
          tools: [
            {
              name: "wait",
              inputSchema: {
                type: "object",
                properties: {
                  timeoutSec: { type: "integer" },
                  _mcpTimeoutSec: { type: "integer" },
                },
              },
            },
          ],
        }),
      });
      await client.initialize();
      try {
        const call = vi.spyOn(client, "callTool");
        const first = await bridgeMcpTools(client);
        const second = await bridgeMcpTools(client);
        expect(first.registry.specs()).toEqual(second.registry.specs());
        expect(first.registry.specs()[0].function.parameters.properties).not.toHaveProperty(
          "__mcpTimeoutSec",
        );
        await first.registry.dispatch(
          "wait",
          JSON.stringify({
            timeoutSec: 5,
            _mcpTimeoutSec: 7,
            __mcpTimeoutSec: 600,
          }),
        );
        expect(call).toHaveBeenCalledWith(
          "wait",
          { timeoutSec: 5, _mcpTimeoutSec: 7 },
          expect.objectContaining({ timeoutMs: 600_000 }),
        );
      } finally {
        await client.close();
      }
    });
  });

  describe("bridgeMcpTools (MCP → ToolRegistry)", () => {
    it("registers every MCP tool into a ToolRegistry and dispatch calls through the client", async () => {
      const transport = new FakeMcpTransport({
        tools: [
          {
            name: "echo",
            description: "echoes",
            inputSchema: {
              type: "object",
              properties: { msg: { type: "string" } },
              required: ["msg"],
            },
          },
        ],
        callHandler: (_name, args) => ({
          content: [{ type: "text", text: `you said: ${args.msg}` }],
        }),
      });
      const client = new McpClient({ transport });
      await client.initialize();

      const { registry, registeredNames } = await bridgeMcpTools(client);
      expect(registeredNames).toEqual(["echo"]);
      expect(registry.has("echo")).toBe(true);

      // Dispatching through the registry should go through the MCP transport
      const result = await registry.dispatch("echo", JSON.stringify({ msg: "hello" }));
      expect(result).toContain("you said: hello");

      await client.close();
    });

    it("applies a name prefix when collisions could happen", async () => {
      const transport = new FakeMcpTransport({
        tools: [
          {
            name: "search",
            description: "fs search",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      const client = new McpClient({ transport });
      await client.initialize();

      const { registeredNames, registry } = await bridgeMcpTools(client, { namePrefix: "fs_" });
      expect(registeredNames).toEqual(["fs_search"]);
      expect(registry.has("fs_search")).toBe(true);
      expect(registry.has("search")).toBe(false);

      await client.close();
    });
  });

  describe("flattenMcpResult", () => {
    it("joins text blocks with newlines", () => {
      const out = flattenMcpResult({
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      });
      expect(out).toBe("line one\nline two");
    });

    it("prefixes error results", () => {
      const out = flattenMcpResult({
        content: [{ type: "text", text: "bad input" }],
        isError: true,
      });
      expect(out).toMatch(/^ERROR: /);
      expect(out).toContain("bad input");
    });

    it("renders image blocks as placeholders", () => {
      const out = flattenMcpResult({
        content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
      });
      expect(out).toContain("[image image/png");
    });

    it("truncates oversized results when maxChars is given, keeping head + tail", () => {
      const big = `${"X".repeat(50_000)}END_MARKER`;
      const out = flattenMcpResult(
        { content: [{ type: "text", text: big }] },
        { maxChars: 10_000 },
      );
      expect(out.length).toBeLessThan(11_000); // cap + a small envelope
      expect(out).toContain("truncated");
      // tail preservation: the distinctive END_MARKER at the original's end must survive
      expect(out).toContain("END_MARKER");
      // head preservation: first chars must survive
      expect(out.startsWith("X")).toBe(true);
    });

    it("does NOT truncate when below the cap", () => {
      const small = "hello world";
      const out = flattenMcpResult(
        { content: [{ type: "text", text: small }] },
        { maxChars: 1000 },
      );
      expect(out).toBe("hello world");
    });
  });

  describe("flattenMcpResult: schema validation", () => {
    it("rejects a non-object result", () => {
      expect(() => flattenMcpResult(null as unknown as CallToolResult)).toThrow("non-object");
      expect(() => flattenMcpResult("str" as unknown as CallToolResult)).toThrow("non-object");
      expect(() => flattenMcpResult(42 as unknown as CallToolResult)).toThrow("non-object");
    });

    it("rejects a result missing content", () => {
      expect(() => flattenMcpResult({} as unknown as CallToolResult)).toThrow("non-array content");
    });

    it("rejects non-array content", () => {
      expect(() => flattenMcpResult({ content: "nope" } as unknown as CallToolResult)).toThrow(
        "non-array content",
      );
      expect(() => flattenMcpResult({ content: null } as unknown as CallToolResult)).toThrow(
        "non-array content",
      );
    });

    it("rejects a content block that isn't an object", () => {
      expect(() => flattenMcpResult({ content: ["string"] } as unknown as CallToolResult)).toThrow(
        "is not an object",
      );
      expect(() => flattenMcpResult({ content: [null] } as unknown as CallToolResult)).toThrow(
        "is not an object",
      );
    });

    it("rejects an unknown content block type", () => {
      expect(() =>
        flattenMcpResult({
          content: [{ type: "resource", uri: "file:///etc/passwd" }],
        } as unknown as CallToolResult),
      ).toThrow("unknown type");
    });

    it("rejects a text block with non-string text", () => {
      expect(() =>
        flattenMcpResult({
          content: [{ type: "text", text: 42 }],
        } as unknown as CallToolResult),
      ).toThrow("non-string text");
    });

    it("rejects an image block with non-string data", () => {
      expect(() =>
        flattenMcpResult({
          content: [{ type: "image", data: null, mimeType: "image/png" }],
        } as unknown as CallToolResult),
      ).toThrow("non-string data");
    });

    it("rejects an image block with non-string mimeType", () => {
      expect(() =>
        flattenMcpResult({
          content: [{ type: "image", data: "abc", mimeType: 7 }],
        } as unknown as CallToolResult),
      ).toThrow("non-string mimeType");
    });

    it("passes a valid result through unchanged", () => {
      const out = flattenMcpResult({
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        isError: false,
      });
      expect(out).toContain("hello");
      expect(out).toContain("[image image/png");
    });
  });

  describe("bridgeMcpTools: result-size cap", () => {
    it("caps a giant MCP tool result before handing it to the registry", async () => {
      // Minimal local fake — just enough to exercise the dispatch path.
      const transport: McpTransport = {
        async send() {},
        async *messages() {},
        async close() {},
      };
      const big = "A".repeat(200_000);
      const client = {
        listTools: async () => ({
          tools: [
            {
              name: "dump",
              description: "returns a massive string",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
        callTool: async () => ({ content: [{ type: "text" as const, text: big }] }),
      } as unknown as McpClient;
      // Default cap (32k): enough to confirm the feature bites.
      const { registry } = await bridgeMcpTools(client, { namePrefix: "x_" });
      const out = await registry.dispatch("x_dump", "{}");
      expect(out.length).toBeLessThan(33_000);
      expect(out).toContain("truncated");
      // Sanity-silence TS about the unused transport binding.
      void transport;
    });
  });

  describe("McpClient: abort via AbortSignal", () => {
    /** Stalling transport — initialize ok, tools/call never replies; exercises client-side abort. */
    function makeStallingTransport(): { transport: McpTransport; received: JsonRpcRequest[] } {
      const received: JsonRpcRequest[] = [];
      const queue: JsonRpcMessage[] = [];
      const waiters: Array<(m: JsonRpcMessage | null) => void> = [];
      let closed = false;
      const push = (m: JsonRpcMessage) => {
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      };
      const transport: McpTransport = {
        async send(msg) {
          if (closed) throw new Error("closed");
          if (!("id" in msg) || !("method" in msg)) {
            received.push(msg as JsonRpcRequest);
            return;
          }
          const req = msg as JsonRpcRequest;
          received.push(req);
          if (req.method === "initialize") {
            push({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: "stall", version: "0" },
                capabilities: {},
              },
            });
          }
          // tools/call: no response, ever.
        },
        async *messages() {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            if (closed) return;
            const next = await new Promise<JsonRpcMessage | null>((resolve) => {
              waiters.push(resolve);
            });
            if (next === null) return;
            yield next;
          }
        },
        async close() {
          closed = true;
          while (waiters.length > 0) waiters.shift()!(null);
        },
      };
      return { transport, received };
    }

    it("rejects the pending callTool promise when the signal aborts", async () => {
      const { transport } = makeStallingTransport();
      const client = new McpClient({ transport, requestTimeoutMs: 60_000 });
      await client.initialize();
      const ctrl = new AbortController();
      const p = client.callTool("slow", {}, { signal: ctrl.signal });
      // Fire the abort on the next microtask so the request actually
      // reaches the transport before we cancel.
      setTimeout(() => ctrl.abort(), 5);
      await expect(p).rejects.toThrow(/aborted/);
      await client.close();
    });

    it("emits notifications/cancelled with the request id on abort", async () => {
      const { transport, received } = makeStallingTransport();
      const client = new McpClient({ transport, requestTimeoutMs: 60_000 });
      await client.initialize();
      const ctrl = new AbortController();
      const p = client.callTool("slow", {}, { signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 5);
      await p.catch(() => {});
      const callReq = received.find((r) => r.method === "tools/call");
      const cancelNotif = received.find((r) => r.method === "notifications/cancelled");
      expect(callReq).toBeDefined();
      expect(cancelNotif).toBeDefined();
      expect((cancelNotif!.params as { requestId: number }).requestId).toBe(callReq!.id);
      await client.close();
    });

    it("rejects immediately when called with an already-aborted signal", async () => {
      const { transport } = makeStallingTransport();
      const client = new McpClient({ transport, requestTimeoutMs: 60_000 });
      await client.initialize();
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(client.callTool("slow", {}, { signal: ctrl.signal })).rejects.toThrow(/aborted/);
      await client.close();
    });
  });

  describe("McpClient: progress notifications", () => {
    /** Multi-tick transport — emits notifications/progress frames keyed off `_meta.progressToken`. */
    function makeProgressTransport(
      progressFrames: Array<{ progress: number; total?: number; message?: string }>,
    ): { transport: McpTransport; received: JsonRpcRequest[] } {
      const received: JsonRpcRequest[] = [];
      const queue: JsonRpcMessage[] = [];
      const waiters: Array<(m: JsonRpcMessage | null) => void> = [];
      let closed = false;
      const push = (m: JsonRpcMessage) => {
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      };
      const transport: McpTransport = {
        async send(msg) {
          if (closed) throw new Error("closed");
          if (!("id" in msg) || !("method" in msg)) return;
          const req = msg as JsonRpcRequest;
          received.push(req);
          if (req.method === "initialize") {
            push({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: "fake", version: "0" },
                capabilities: { tools: {} },
              },
            });
            return;
          }
          if (req.method === "tools/call") {
            const token = (req.params as { _meta?: { progressToken?: string | number } })._meta
              ?.progressToken;
            // Emit progress frames first (all with the same token), then
            // the final response.
            for (const frame of progressFrames) {
              push({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken: token, ...frame },
              });
            }
            push({
              jsonrpc: "2.0",
              id: req.id,
              result: { content: [{ type: "text" as const, text: "done" }] },
            });
            return;
          }
          push({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: "method not found" },
          });
        },
        async *messages() {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            if (closed) return;
            const next = await new Promise<JsonRpcMessage | null>((resolve) => {
              waiters.push(resolve);
            });
            if (next === null) return;
            yield next;
          }
        },
        async close() {
          closed = true;
          while (waiters.length > 0) waiters.shift()!(null);
        },
      };
      return { transport, received };
    }

    it("routes progress notifications to the per-call onProgress callback", async () => {
      const { transport } = makeProgressTransport([
        { progress: 1, total: 3, message: "reading..." },
        { progress: 2, total: 3 },
        { progress: 3, total: 3, message: "done" },
      ]);
      const client = new McpClient({ transport });
      await client.initialize();

      const received: Array<{ progress: number; total?: number; message?: string }> = [];
      const result = await client.callTool(
        "scan",
        {},
        { onProgress: (info) => received.push(info) },
      );
      expect(result.content[0]).toEqual({ type: "text", text: "done" });
      expect(received).toEqual([
        { progress: 1, total: 3, message: "reading..." },
        { progress: 2, total: 3, message: undefined },
        { progress: 3, total: 3, message: "done" },
      ]);
      await client.close();
    });

    it("omits _meta.progressToken when no onProgress callback is provided", async () => {
      const { transport, received } = makeProgressTransport([]);
      const client = new McpClient({ transport });
      await client.initialize();
      await client.callTool("x", { k: 1 });
      const callReq = received.find((r) => r.method === "tools/call")!;
      expect((callReq.params as { _meta?: unknown })._meta).toBeUndefined();
      await client.close();
    });

    it("sets a distinct _meta.progressToken when onProgress IS provided", async () => {
      const { transport, received } = makeProgressTransport([]);
      const client = new McpClient({ transport });
      await client.initialize();
      await client.callTool("x", {}, { onProgress: () => {} });
      const callReq = received.find((r) => r.method === "tools/call")!;
      const token = (callReq.params as { _meta?: { progressToken?: number } })._meta?.progressToken;
      expect(token).toBeTypeOf("number");
    });

    it("late progress frames after the call resolved are dropped silently", async () => {
      // Use the handler-transport shape from progress-transport: we
      // send the final result, THEN push a trailing progress frame.
      // The client must not throw when the handler map is already empty.
      const received: JsonRpcRequest[] = [];
      const queue: JsonRpcMessage[] = [];
      const waiters: Array<(m: JsonRpcMessage | null) => void> = [];
      let closed = false;
      const push = (m: JsonRpcMessage) => {
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      };
      let lastToken: string | number | undefined;
      const transport: McpTransport = {
        async send(msg) {
          if (!("id" in msg) || !("method" in msg)) return;
          const req = msg as JsonRpcRequest;
          received.push(req);
          if (req.method === "initialize") {
            push({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: "fake", version: "0" },
                capabilities: {},
              },
            });
          } else if (req.method === "tools/call") {
            lastToken = (req.params as { _meta?: { progressToken?: string | number } })._meta
              ?.progressToken;
            // Final response first, then a trailing progress — mimics
            // a race where the server finished but a progress frame
            // was already in flight.
            push({
              jsonrpc: "2.0",
              id: req.id,
              result: { content: [] },
            });
            push({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken: lastToken, progress: 42 },
            });
          }
        },
        async *messages() {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            if (closed) return;
            const next = await new Promise<JsonRpcMessage | null>((resolve) => {
              waiters.push(resolve);
            });
            if (next === null) return;
            yield next;
          }
        },
        async close() {
          closed = true;
          while (waiters.length > 0) waiters.shift()!(null);
        },
      };
      const client = new McpClient({ transport });
      await client.initialize();
      const seen: number[] = [];
      await client.callTool("x", {}, { onProgress: (i) => seen.push(i.progress) });
      // Give the reader loop a tick to process the trailing
      // notification — should be swallowed, not thrown.
      await new Promise((r) => setTimeout(r, 10));
      expect(seen).toEqual([]); // the trailing frame was dropped
      await client.close();
    });
  });

  describe("bridgeMcpTools: progress pass-through", () => {
    it("threads per-tool progress callbacks with the registered (prefixed) name", async () => {
      const { transport } = (function makeProgressTransport(
        frames: Array<{ progress: number; total?: number }>,
      ) {
        const queue: JsonRpcMessage[] = [];
        const waiters: Array<(m: JsonRpcMessage | null) => void> = [];
        let closed = false;
        const push = (m: JsonRpcMessage) => {
          const w = waiters.shift();
          if (w) w(m);
          else queue.push(m);
        };
        const t: McpTransport = {
          async send(msg) {
            if (!("id" in msg) || !("method" in msg)) return;
            const req = msg as JsonRpcRequest;
            if (req.method === "initialize") {
              push({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                  protocolVersion: MCP_PROTOCOL_VERSION,
                  serverInfo: { name: "fs", version: "0" },
                  capabilities: { tools: {} },
                },
              });
            } else if (req.method === "tools/list") {
              push({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                  tools: [{ name: "scan", description: "", inputSchema: { type: "object" } }],
                },
              });
            } else if (req.method === "tools/call") {
              const token = (req.params as { _meta?: { progressToken?: string | number } })._meta
                ?.progressToken;
              for (const f of frames) {
                push({
                  jsonrpc: "2.0",
                  method: "notifications/progress",
                  params: { progressToken: token, ...f },
                });
              }
              push({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text" as const, text: "ok" }] },
              });
            }
          },
          async *messages() {
            while (true) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }
              if (closed) return;
              const next = await new Promise<JsonRpcMessage | null>((resolve) => {
                waiters.push(resolve);
              });
              if (next === null) return;
              yield next;
            }
          },
          async close() {
            closed = true;
            while (waiters.length > 0) waiters.shift()!(null);
          },
        };
        return { transport: t };
      })([{ progress: 5, total: 10 }]);

      const client = new McpClient({ transport });
      await client.initialize();
      const observed: Array<{ toolName: string; progress: number; total?: number }> = [];
      const { registry } = await bridgeMcpTools(client, {
        namePrefix: "fs_",
        onProgress: ({ toolName, progress, total }) => observed.push({ toolName, progress, total }),
      });
      await registry.dispatch("fs_scan", "{}");
      expect(observed).toEqual([{ toolName: "fs_scan", progress: 5, total: 10 }]);
      await client.close();
    });
  });

  describe("McpClient: resources", () => {
    it("lists resources and reads one by URI", async () => {
      const transport = new FakeMcpTransport({
        tools: [],
        capabilities: { tools: {}, resources: { listChanged: false } },
        listResources: () => ({
          resources: [
            { uri: "file:///a.md", name: "a", mimeType: "text/markdown" },
            { uri: "custom://b", name: "b" },
          ],
        }),
        readResource: (uri) => ({
          contents: [{ uri, mimeType: "text/plain", text: `body of ${uri}` }],
        }),
      });
      const client = new McpClient({ transport });
      await client.initialize();

      const list = await client.listResources();
      expect(list.resources).toHaveLength(2);
      expect(list.resources[0]!.uri).toBe("file:///a.md");

      const read = await client.readResource("file:///a.md");
      expect(read.contents).toHaveLength(1);
      const block = read.contents[0]!;
      expect("text" in block ? block.text : "").toBe("body of file:///a.md");
      expect(block.mimeType).toBe("text/plain");

      await client.close();
    });

    it("surfaces method-not-found as an error when the server lacks resources support", async () => {
      // Default FakeMcpTransport (no listResources handler) → −32601.
      const transport = new FakeMcpTransport({ tools: [] });
      const client = new McpClient({ transport });
      await client.initialize();
      await expect(client.listResources()).rejects.toThrow(/-32601/);
      await client.close();
    });

    it("advertises resources + prompts in the initialize capabilities payload", async () => {
      const received: JsonRpcRequest[] = [];
      const transport = new FakeMcpTransport({ tools: [], received });
      const client = new McpClient({ transport });
      await client.initialize();
      const init = received.find((r) => r.method === "initialize")!;
      const params = init.params as { capabilities: Record<string, unknown> };
      // The client now claims to support all three method families.
      expect(params.capabilities).toHaveProperty("tools");
      expect(params.capabilities).toHaveProperty("resources");
      expect(params.capabilities).toHaveProperty("prompts");
      await client.close();
    });

    it("propagates the pagination cursor to resources/list", async () => {
      const received: JsonRpcRequest[] = [];
      const transport = new FakeMcpTransport({
        tools: [],
        received,
        listResources: () => ({ resources: [], nextCursor: undefined }),
      });
      const client = new McpClient({ transport });
      await client.initialize();
      await client.listResources("page2");
      const listReq = received.find((r) => r.method === "resources/list")!;
      expect((listReq.params as { cursor?: string }).cursor).toBe("page2");
      await client.close();
    });
  });

  describe("McpClient: prompts", () => {
    it("lists prompts and fetches a rendered one with arguments", async () => {
      const transport = new FakeMcpTransport({
        tools: [],
        capabilities: { tools: {}, prompts: { listChanged: false } },
        listPrompts: () => ({
          prompts: [
            {
              name: "summarize",
              description: "summarize a document",
              arguments: [{ name: "lang", required: true }],
            },
          ],
        }),
        getPrompt: (name, args) => ({
          description: `rendered ${name}`,
          messages: [
            {
              role: "user",
              content: { type: "text", text: `please summarize in ${args?.lang ?? "?"}` },
            },
          ],
        }),
      });
      const client = new McpClient({ transport });
      await client.initialize();

      const list = await client.listPrompts();
      expect(list.prompts).toHaveLength(1);
      expect(list.prompts[0]!.name).toBe("summarize");
      expect(list.prompts[0]!.arguments?.[0]?.required).toBe(true);

      const got = await client.getPrompt("summarize", { lang: "zh" });
      expect(got.messages).toHaveLength(1);
      const msg = got.messages[0]!;
      expect(msg.role).toBe("user");
      expect(msg.content.type).toBe("text");
      if (msg.content.type === "text") {
        expect(msg.content.text).toContain("zh");
      }

      await client.close();
    });

    it("omits the arguments field when caller passes no args", async () => {
      const received: JsonRpcRequest[] = [];
      const transport = new FakeMcpTransport({
        tools: [],
        received,
        getPrompt: () => ({ messages: [] }),
      });
      const client = new McpClient({ transport });
      await client.initialize();
      await client.getPrompt("hello");
      const getReq = received.find((r) => r.method === "prompts/get")!;
      expect(getReq.params).toEqual({ name: "hello" });
      await client.close();
    });
  });

  describe("formatServerExitReason", () => {
    it("formats friendly error when Playwright fails on Node < 18.18 with getDefaultAutoSelectFamilyAttemptTimeout", () => {
      const rawStderr = `TypeError: import_net.default.getDefaultAutoSelectFamilyAttemptTimeout is not a function
  at packages/utils/network.ts (C:\\Users\\foo\\playwright-core\\lib\\coreBundle.js:8947:72)
  Node.js v18.16.0`;
      const reason = formatServerExitReason(1, rawStderr);
      expect(reason).toContain("Node.js is outdated (detected v18.16.0)");
      expect(reason).toContain("Playwright requires Node.js >= 18.18");
      expect(reason).toContain("https://nodejs.org");
    });

    it("handles engine mismatch errors clearly", () => {
      const rawStderr =
        "npm error code EBADENGINE\nnpm error unsupported engine for package: requires node >=20.0.0";
      const reason = formatServerExitReason(1, rawStderr);
      expect(reason).toContain("Node.js is outdated");
      expect(reason).toContain("requires a newer Node.js runtime");
    });

    it("falls back to standard message for other errors", () => {
      const reason = formatServerExitReason(127, "command not found: foobar");
      expect(reason).toBe("server process exited with code 127: command not found: foobar");
    });
  });
});
