import { describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import type { McpTransport } from "../src/mcp/stdio.js";
import type { JsonRpcMessage } from "../src/mcp/types.js";

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
      const longer = expect(client.callTool("longer", {}, { timeoutMs: 600_000 })).rejects.toThrow(
        "after 600000ms",
      );
      const shorter = expect(client.callTool("shorter", {}, { timeoutMs: 1_000 })).rejects.toThrow(
        "after 1000ms",
      );
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
