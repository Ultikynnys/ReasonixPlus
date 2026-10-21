// Consolidated from 11 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyGate } from "../src/core/concurrency-gate.js";
import { looksLikeCompleteJson } from "../src/loop.js";
import { ToolRegistry } from "../src/tools.js";
import { registerComputerUseTool } from "../src/tools/computer-use.js";
import { registerFilesystemTools } from "../src/tools/filesystem.js";
import { ToolRateLimiter, normalizeToolRateLimitConfig } from "../src/tools/rate-limit.js";
import { ReadTracker } from "../src/tools/read-tracker.js";
import type { MonitorInfo } from "../src/tools/screen-capture.js";
import {
  applyDeclarativeFilter,
  declarativeFilterMatches,
  validateDeclarativeFilter,
} from "../src/tools/shell/declarative-filter.js";
import type { RunCommandResult } from "../src/tools/shell/exec.js";
import { BUILTIN_DECLARATIVE_FILTERS } from "../src/tools/shell/filters/builtin.js";
import {
  applyOutputFilter,
  classifyCommandFamily,
  commandSupportsOutputFiltering,
} from "../src/tools/shell/output-filter.js";
import { type TodoItem, registerTodoTool } from "../src/tools/todo.js";
import {
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  formatLocal,
  formatUtc,
  registerWaitTool,
} from "../src/tools/wait.js";

describe("tools", () => {
  describe("ToolRegistry", () => {
    it("registers and dispatches a tool with JSON args", async () => {
      const reg = new ToolRegistry();
      reg.register<{ a: number; b: number }, number>({
        name: "add",
        description: "add two ints",
        parameters: {
          type: "object",
          properties: { a: { type: "integer" }, b: { type: "integer" } },
          required: ["a", "b"],
        },
        fn: ({ a, b }) => a + b,
      });
      expect(reg.has("add")).toBe(true);
      const result = await reg.dispatch("add", '{"a":2,"b":3}');
      expect(result).toBe("5");
    });

    it("emits tool.call audit events with parsed args", async () => {
      const reg = new ToolRegistry();
      const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
      reg.register({
        name: "echo",
        fn: (args: { msg: string; apiKey: string }) => args.msg,
      });
      reg.setAuditListener((event) => {
        seen.push({
          name: event.name,
          args: JSON.parse(JSON.stringify(event.args)) as Record<string, unknown>,
        });
      });

      await reg.dispatch("echo", '{"msg":"hi","apiKey":"secret-value"}');

      expect(seen).toEqual([
        {
          name: "echo",
          args: { msg: "hi", apiKey: "secret-value" },
        },
      ]);
    });

    it("returns structured error for unknown tool, naming the nearest real ones", async () => {
      const reg = new ToolRegistry();
      reg.register({ name: "read_file", description: "read a file", fn: () => "ok" });
      const out = await reg.dispatch("red_file", "{}");
      const parsed = JSON.parse(out);
      expect(parsed.error).toMatch(/unknown tool: red_file/);
      expect(parsed.error).toMatch(/Did you mean read_file/);
      expect(parsed.didYouMean).toEqual(["read_file"]);
      expect(parsed.toolCount).toBe(1);
    });

    it("omits the suggestion when nothing is close", async () => {
      const reg = new ToolRegistry();
      reg.register({ name: "read_file", description: "read a file", fn: () => "ok" });
      const parsed = JSON.parse(await reg.dispatch("zzzzzzzzzzzz", "{}"));
      expect(parsed.didYouMean).toEqual([]);
      expect(parsed.error).not.toMatch(/Did you mean/);
    });

    it("handles invalid JSON arguments gracefully", async () => {
      const reg = new ToolRegistry();
      reg.register({ name: "noop", fn: () => "ok" });
      const out = await reg.dispatch("noop", "{bad json");
      expect(JSON.parse(out).error).toMatch(/invalid tool arguments JSON/);
    });

    it("emits OpenAI-shaped specs", () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "echo",
        description: "echo input",
        parameters: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
        fn: ({ msg }: { msg: string }) => msg,
      });
      const spec = reg.specs()[0]!;
      expect(spec.type).toBe("function");
      expect(spec.function.name).toBe("echo");
      expect(spec.function.parameters.required).toEqual(["msg"]);
    });

    it("does NOT flatten shallow schemas", () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "shallow",
        parameters: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["a"],
        },
        fn: () => "ok",
      });
      expect(reg.wasFlattened("shallow")).toBe(false);
      expect(reg.specs()[0]!.function.parameters.properties).toHaveProperty("a");
    });

    it("auto-flattens deep schemas and re-nests args on dispatch", async () => {
      const reg = new ToolRegistry();
      let received: any = null;
      reg.register({
        name: "deep",
        parameters: {
          type: "object",
          required: ["user"],
          properties: {
            user: {
              type: "object",
              required: ["profile"],
              properties: {
                profile: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    age: { type: "integer" },
                  },
                },
              },
            },
          },
        },
        fn: (args: any) => {
          received = args;
          return "ok";
        },
      });

      expect(reg.wasFlattened("deep")).toBe(true);
      const spec = reg.specs()[0]!;
      expect(spec.function.parameters.properties).toHaveProperty("user.profile.name");
      expect(spec.function.parameters.properties).toHaveProperty("user.profile.age");

      // Model emits flat dot-notation args (as it would after seeing the flat spec).
      await reg.dispatch("deep", '{"user.profile.name":"alice","user.profile.age":30}');
      expect(received).toEqual({ user: { profile: { name: "alice", age: 30 } } });
    });

    it("auto-flattens wide schemas (>10 leaf params)", () => {
      const reg = new ToolRegistry();
      const props: Record<string, { type: string }> = {};
      for (let i = 0; i < 15; i++) props[`p${i}`] = { type: "string" };
      reg.register({
        name: "wide",
        parameters: { type: "object", properties: props },
        fn: () => "ok",
      });
      expect(reg.wasFlattened("wide")).toBe(true);
    });

    it("dispatch passes through nested args even when tool was flattened (defensive)", async () => {
      const reg = new ToolRegistry();
      let received: any = null;
      reg.register({
        name: "deep",
        parameters: {
          type: "object",
          properties: {
            a: {
              type: "object",
              properties: {
                b: { type: "object", properties: { c: { type: "string" } } },
              },
            },
          },
        },
        fn: (args: any) => {
          received = args;
          return "ok";
        },
      });
      expect(reg.wasFlattened("deep")).toBe(true);
      // Some models may ignore the flat spec and emit nested args anyway.
      await reg.dispatch("deep", '{"a":{"b":{"c":"hi"}}}');
      expect(received).toEqual({ a: { b: { c: "hi" } } });
    });

    it("truncates oversized results when maxResultChars is set", async () => {
      const reg = new ToolRegistry();
      const big = "x".repeat(50_000);
      reg.register({
        name: "bloat",
        parameters: { type: "object", properties: {} },
        fn: () => big,
      });
      const out = await reg.dispatch("bloat", "{}", { maxResultChars: 1000 });
      expect(out.length).toBeLessThan(2000);
      expect(out).toMatch(/truncated/);
    });

    it("passes results through unchanged when maxResultChars is absent", async () => {
      const reg = new ToolRegistry();
      const big = "x".repeat(50_000);
      reg.register({
        name: "bloat",
        parameters: { type: "object", properties: {} },
        fn: () => big,
      });
      const out = await reg.dispatch("bloat", "{}");
      expect(out.length).toBe(50_000);
    });

    it("autoFlatten:false opts out", () => {
      const reg = new ToolRegistry({ autoFlatten: false });
      reg.register({
        name: "deep",
        parameters: {
          type: "object",
          properties: {
            a: {
              type: "object",
              properties: { b: { type: "object", properties: { c: { type: "string" } } } },
            },
          },
        },
        fn: () => "ok",
      });
      expect(reg.wasFlattened("deep")).toBe(false);
      expect(reg.specs()[0]!.function.parameters.properties).toHaveProperty("a");
    });

    describe("tool interceptor", () => {
      it("short-circuits dispatch when interceptor returns a string", async () => {
        const reg = new ToolRegistry();
        let fnCalled = false;
        reg.register({
          name: "edit_file",
          fn: () => {
            fnCalled = true;
            return "should not run";
          },
        });
        reg.setToolInterceptor((name) => (name === "edit_file" ? "queued" : null));
        const out = await reg.dispatch("edit_file", '{"path":"foo"}');
        expect(out).toBe("queued");
        expect(fnCalled).toBe(false);
      });

      it("passes intercepted tool results through the result augmenter", async () => {
        const reg = new ToolRegistry();
        const seen: Array<{ name: string; result: string }> = [];
        reg.register({ name: "edit_file", fn: () => "should not run" });
        reg.addToolInterceptor("review-gate", () => "▸ edit blocks: 1/1 applied");
        reg.setResultAugmenter((name, _args, result) => {
          seen.push({ name, result });
          return `${result}\naugmented`;
        });

        const out = await reg.dispatch("edit_file", '{"path":"src/app.ts"}');

        expect(out).toBe("▸ edit blocks: 1/1 applied\naugmented");
        expect(seen).toEqual([{ name: "edit_file", result: "▸ edit blocks: 1/1 applied" }]);
      });

      it("falls through to tool.fn when interceptor returns null", async () => {
        const reg = new ToolRegistry();
        reg.register({ name: "read_file", fn: () => "content" });
        reg.setToolInterceptor(() => null);
        const out = await reg.dispatch("read_file", "{}");
        expect(out).toBe("content");
      });

      it("receives parsed args (including flattened→nested)", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "edit_file",
          fn: () => "ok",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, search: { type: "string" } },
            required: ["path"],
          },
        });
        let seen: Record<string, unknown> | null = null;
        reg.setToolInterceptor((_name, args) => {
          seen = args;
          return "captured";
        });
        await reg.dispatch("edit_file", '{"path":"a","search":"b"}');
        expect(seen).toEqual({ path: "a", search: "b" });
      });

      it("does not fire in plan mode — plan-mode refusal wins", async () => {
        const reg = new ToolRegistry();
        let interceptorCalled = false;
        reg.register({ name: "edit_file", fn: () => "ok" });
        reg.setToolInterceptor(() => {
          interceptorCalled = true;
          return "queued";
        });
        reg.setPlanMode(true);
        const out = await reg.dispatch("edit_file", '{"path":"x"}');
        expect(JSON.parse(out).error).toMatch(/blocked in Read only mode/);
        expect(interceptorCalled).toBe(false);
      });

      it("setToolInterceptor(null) clears a prior install", async () => {
        const reg = new ToolRegistry();
        reg.register({ name: "edit_file", fn: () => "fn-output" });
        reg.setToolInterceptor(() => "queued");
        expect(await reg.dispatch("edit_file", "{}")).toBe("queued");
        reg.setToolInterceptor(null);
        expect(await reg.dispatch("edit_file", "{}")).toBe("fn-output");
      });

      it("runs ordered interceptors before the legacy interceptor", async () => {
        const reg = new ToolRegistry();
        const seen: string[] = [];
        reg.register({ name: "edit_file", fn: () => "ok" });
        reg.addToolInterceptor("first", () => {
          seen.push("first");
          return null;
        });
        reg.addToolInterceptor("second", () => {
          seen.push("second");
          return "blocked";
        });
        reg.setToolInterceptor(() => {
          seen.push("legacy");
          return null;
        });

        const out = await reg.dispatch("edit_file", "{}");

        expect(out).toBe("blocked");
        expect(seen).toEqual(["first", "second"]);
      });

      it("can remove an ordered interceptor by id", async () => {
        const reg = new ToolRegistry();
        reg.register({ name: "edit_file", fn: () => "ok" });
        const remove = reg.addToolInterceptor("blocker", () => "blocked");
        remove();

        const out = await reg.dispatch("edit_file", "{}");

        expect(out).toBe("ok");
      });

      it("sharpens repeated identical interceptor rejections", async () => {
        const reg = new ToolRegistry();
        reg.register({ name: "multi_edit", fn: () => "ok" });
        reg.addToolInterceptor("lifecycle", () =>
          JSON.stringify({
            error: "multi_edit blocked",
            rejectedReason: "engineering-lifecycle",
          }),
        );

        const first = JSON.parse(await reg.dispatch("multi_edit", '{"edits":[]}'));
        const second = JSON.parse(await reg.dispatch("multi_edit", '{"edits":[]}'));

        expect(first.consecutiveInterceptorRejection).toBeUndefined();
        expect(second.consecutiveInterceptorRejection).toBe(true);
        expect(second.error).toMatch(/do not retry identical args/);
      });

      it("sharpens repeated gate rejections when JSON key order changes", async () => {
        const reg = new ToolRegistry();
        reg.register({ name: "run_command", fn: () => "should not run" });
        reg.addToolInterceptor("guard", () =>
          JSON.stringify({ error: "run_command blocked", rejectedReason: "guard" }),
        );

        const first = JSON.parse(
          await reg.dispatch("run_command", '{"command":"rm -rf dist","cwd":"/repo"}'),
        );
        const second = JSON.parse(
          await reg.dispatch("run_command", '{"cwd":"/repo","command":"rm -rf dist"}'),
        );

        expect(first.rejectedReason).toBe("guard");
        expect(first.consecutiveInterceptorRejection).toBeUndefined();
        expect(second.rejectedReason).toBe("guard");
        expect(second.consecutiveInterceptorRejection).toBe(true);
        expect(second.error).toMatch(/do not retry identical args/);
      });

      it("sharpens repeated gate rejections across a call corpus", async () => {
        const cases: Array<{ name: string; args: Record<string, unknown> }> = [
          {
            name: "multi_edit",
            args: { edits: [{ path: "src/a.ts", search: "a", replace: "b" }] },
          },
          { name: "delete_file", args: { path: "src/old.ts" } },
          { name: "run_command", args: { command: "npm install left-pad", cwd: "/repo" } },
        ];

        for (const item of cases) {
          const reg = new ToolRegistry();
          reg.register({ name: item.name, fn: () => "should not run" });
          reg.addToolInterceptor("guard", () =>
            JSON.stringify({ error: `${item.name} blocked`, rejectedReason: "guard" }),
          );

          const rawArgs = JSON.stringify(item.args);
          const first = JSON.parse(await reg.dispatch(item.name, rawArgs));
          const second = JSON.parse(await reg.dispatch(item.name, rawArgs));

          expect(first.rejectedReason).toBe("guard");
          expect(first.consecutiveInterceptorRejection).toBeUndefined();
          expect(second.rejectedReason).toBe("guard");
          expect(second.consecutiveInterceptorRejection).toBe(true);
        }
      });

      it("sharpens repeated edit gate rejections from review-mode text", async () => {
        const reg = new ToolRegistry();
        reg.register({ name: "edit_file", fn: () => "should not run" });
        reg.setToolInterceptor((name, args) => {
          if (name !== "edit_file") return null;
          return `User rejected this edit to ${String(args.path)}. Don't retry the same SEARCH/REPLACE; either try a different approach or ask the user what they want instead.`;
        });

        const rawArgs = JSON.stringify({
          path: "src/app.ts",
          search: "oldValue",
          replace: "newValue",
        });
        const first = await reg.dispatch("edit_file", rawArgs);
        const second = JSON.parse(await reg.dispatch("edit_file", rawArgs));

        expect(first).toMatch(/User rejected this edit to src\/app\.ts/);
        expect(second.rejectedReason).toBe("edit-gate");
        expect(second.consecutiveInterceptorRejection).toBe(true);
        expect(second.error).toMatch(/do not retry identical args/);
        expect(second.error).toMatch(/different edit/);
      });

      it("surfaces interceptor throws as structured errors", async () => {
        const reg = new ToolRegistry();
        reg.register({ name: "edit_file", fn: () => "ok" });
        reg.setToolInterceptor(() => {
          throw new Error("boom");
        });
        const out = await reg.dispatch("edit_file", "{}");
        expect(JSON.parse(out).error).toMatch(/interceptor failed: boom/);
      });
    });

    describe("rate limit", () => {
      it("does not consume quota for unknown tools", async () => {
        const reg = new ToolRegistry({
          rateLimit: { aggregate: { maxCalls: 1, windowSeconds: 60 }, tools: {} },
        });
        let calls = 0;
        reg.register({ name: "ok", fn: () => String(++calls) });

        await reg.dispatch("missing", "{}");
        expect(await reg.dispatch("ok", "{}")).toBe("1");
        expect(JSON.parse(await reg.dispatch("ok", "{}")).error).toBe("rate_limited");
        expect(calls).toBe(1);
      });

      it("does not consume quota for malformed or missing required args", async () => {
        const reg = new ToolRegistry({
          rateLimit: { aggregate: { maxCalls: 1, windowSeconds: 60 }, tools: {} },
        });
        let calls = 0;
        reg.register({
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          fn: () => String(++calls),
        });

        await reg.dispatch("read_file", "{bad json");
        await reg.dispatch("read_file", "{}");
        expect(await reg.dispatch("read_file", '{"path":"a"}')).toBe("1");
        expect(JSON.parse(await reg.dispatch("read_file", '{"path":"b"}')).error).toBe(
          "rate_limited",
        );
        expect(calls).toBe(1);
      });

      it("does not consume quota for plan-mode refusals", async () => {
        const reg = new ToolRegistry({
          rateLimit: { aggregate: { maxCalls: 1, windowSeconds: 60 }, tools: {} },
        });
        let calls = 0;
        reg.register({ name: "edit_file", fn: () => String(++calls) });

        reg.setPlanMode(true);
        await reg.dispatch("edit_file", "{}");
        reg.setPlanMode(false);

        expect(await reg.dispatch("edit_file", "{}")).toBe("1");
        expect(JSON.parse(await reg.dispatch("edit_file", "{}")).error).toBe("rate_limited");
        expect(calls).toBe(1);
      });

      it("does not consume quota for interceptor short-circuits", async () => {
        const reg = new ToolRegistry({
          rateLimit: { aggregate: { maxCalls: 1, windowSeconds: 60 }, tools: {} },
        });
        let calls = 0;
        reg.register({ name: "edit_file", fn: () => String(++calls) });
        reg.setToolInterceptor(() => "queued");

        expect(await reg.dispatch("edit_file", "{}")).toBe("queued");
        reg.setToolInterceptor(null);
        expect(await reg.dispatch("edit_file", "{}")).toBe("1");
        expect(JSON.parse(await reg.dispatch("edit_file", "{}")).error).toBe("rate_limited");
        expect(calls).toBe(1);
      });

      it("consumes quota before the tool fn awaits", async () => {
        const reg = new ToolRegistry({
          rateLimit: { aggregate: { maxCalls: 1, windowSeconds: 60 }, tools: {} },
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        reg.register({
          name: "slow",
          fn: async () => {
            await gate;
            return "done";
          },
        });

        const first = reg.dispatch("slow", "{}");
        const second = reg.dispatch("slow", "{}");
        release();

        expect(JSON.parse(await second).error).toBe("rate_limited");
        expect(await first).toBe("done");
      });

      it("does not call fn or audit when rate-limited", async () => {
        const reg = new ToolRegistry({
          rateLimit: { aggregate: { maxCalls: 1, windowSeconds: 60 }, tools: {} },
        });
        let calls = 0;
        const audit: string[] = [];
        reg.register({ name: "echo", fn: () => String(++calls) });
        reg.setAuditListener((event) => audit.push(event.name));

        expect(await reg.dispatch("echo", "{}")).toBe("1");
        const blocked = JSON.parse(await reg.dispatch("echo", "{}"));

        expect(blocked).toMatchObject({ error: "rate_limited", tool: "echo" });
        expect(calls).toBe(1);
        expect(audit).toEqual(["echo"]);
      });
    });

    describe("isParallelSafe", () => {
      it("returns true when the tool opts in", () => {
        const reg = new ToolRegistry();
        reg.register({ name: "read_thing", parallelSafe: true, fn: () => "ok" });
        expect(reg.isParallelSafe("read_thing")).toBe(true);
      });

      it("defaults to false on unannotated tools", () => {
        const reg = new ToolRegistry();
        reg.register({ name: "do_thing", fn: () => "ok" });
        expect(reg.isParallelSafe("do_thing")).toBe(false);
      });

      it("returns false for unknown tools", () => {
        const reg = new ToolRegistry();
        expect(reg.isParallelSafe("nope")).toBe(false);
      });
    });

    describe("required parameter validation", () => {
      it("returns a structured error when a required param is missing entirely", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "read_file",
          description: "read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to read." },
            },
            required: ["path"],
          },
          fn: ({ path }: { path: string }) => `read ${path}`,
        });
        const out = await reg.dispatch("read_file", "{}");
        expect(JSON.parse(out).error).toMatch(/missing required parameter "path"/);
      });

      it("lets the tool fn handle empty string — JSON Schema required only checks presence, not emptiness", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "read_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
          fn: ({ path }: { path: string }) => `read ${path}`,
        });
        const out = await reg.dispatch("read_file", '{"path": ""}');
        expect(out).toBe("read ");
      });

      it("passes through when all required params are present and non-empty", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "read_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
          fn: ({ path }: { path: string }) => `read ${path}`,
        });
        const out = await reg.dispatch("read_file", '{"path": "/foo/bar.ts"}');
        expect(out).toBe("read /foo/bar.ts");
      });

      it("skips validation when the schema has no required list (all params optional)", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "optional_tool",
          parameters: {
            type: "object",
            properties: {
              msg: { type: "string" },
            },
          },
          fn: () => "ok",
        });
        const out = await reg.dispatch("optional_tool", "{}");
        expect(out).toBe("ok");
      });

      it("passes through when required param is a nested object (not a string)", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "write_file",
          parameters: {
            type: "object",
            properties: {
              file: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                },
              },
            },
            required: ["file"],
          },
          fn: ({ file }: { file: { path: string; content: string } }) => `wrote ${file.path}`,
        });
        const out = await reg.dispatch("write_file", '{"file": {"path": "/foo", "content": "hi"}}');
        expect(out).toBe("wrote /foo");
      });
    });

    describe("malformed-args storm guard (issue #651)", () => {
      function readFileReg(): ToolRegistry {
        const reg = new ToolRegistry();
        reg.register({
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          fn: ({ path }: { path: string }) => `read ${path}`,
        });
        return reg;
      }

      it("first malformed call returns the normal missing-param error", async () => {
        const reg = readFileReg();
        const out = await reg.dispatch("read_file", "{}");
        const parsed = JSON.parse(out);
        expect(parsed.error).toMatch(/missing required parameter "path"/);
        expect(parsed.consecutiveMalformed).toBeUndefined();
      });

      it("2nd consecutive identical malformed call short-circuits with a sharper error", async () => {
        const reg = readFileReg();
        await reg.dispatch("read_file", "{}");
        const out = await reg.dispatch("read_file", "{}");
        const parsed = JSON.parse(out);
        expect(parsed.consecutiveMalformed).toBe(true);
        expect(parsed.error).toMatch(/DO NOT retry with identical args/);
      });

      it("a successful call between two malformed ones clears the streak", async () => {
        const reg = readFileReg();
        await reg.dispatch("read_file", "{}"); // 1st malformed
        await reg.dispatch("read_file", '{"path": "ok.txt"}'); // success — clears
        const out = await reg.dispatch("read_file", "{}"); // 1st-again, NOT 2nd-consecutive
        const parsed = JSON.parse(out);
        expect(parsed.consecutiveMalformed).toBeUndefined();
      });

      it("different malformed args to the same tool do not trip the guard", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "edit",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, body: { type: "string" } },
            required: ["path", "body"],
          },
          fn: () => "edited",
        });
        await reg.dispatch("edit", '{"path": "x"}'); // missing body
        const out = await reg.dispatch("edit", '{"body": "y"}'); // missing path — different shape
        const parsed = JSON.parse(out);
        expect(parsed.consecutiveMalformed).toBeUndefined();
      });

      it("invalid JSON, identical twice, also short-circuits", async () => {
        const reg = readFileReg();
        await reg.dispatch("read_file", "{not json");
        const out = await reg.dispatch("read_file", "{not json");
        const parsed = JSON.parse(out);
        expect(parsed.consecutiveMalformed).toBe(true);
        expect(parsed.error).toMatch(/invalid tool arguments JSON/);
      });

      it("per-tool tracking — malformed read_file does not affect a separate edit_file tool", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          fn: () => "r",
        });
        reg.register({
          name: "edit_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          fn: () => "e",
        });
        await reg.dispatch("read_file", "{}");
        const out = await reg.dispatch("edit_file", "{}"); // first time for edit_file
        const parsed = JSON.parse(out);
        expect(parsed.consecutiveMalformed).toBeUndefined();
      });
    });

    describe("isReadOnlyCall — buggy readOnlyCheck", () => {
      it("warns when readOnlyCheck throws and treats the call as not read-only", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "buggy_tool",
          readOnlyCheck: () => {
            throw new Error("check is buggy");
          },
          fn: () => "ok",
        });
        reg.setPlanMode(true);
        const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const out = await reg.dispatch("buggy_tool", "{}");
          expect(JSON.parse(out).error).toMatch(/blocked in Read only mode/);
          const writes = writeSpy.mock.calls.map((c) => String(c[0]));
          expect(
            writes.some((w) => w.includes("readOnlyCheck for buggy_tool threw: check is buggy")),
          ).toBe(true);
        } finally {
          writeSpy.mockRestore();
        }
      });

      it("stays silent when readOnlyCheck succeeds", async () => {
        const reg = new ToolRegistry();
        reg.register({
          name: "good_tool",
          readOnlyCheck: () => true,
          fn: () => "ok",
        });
        reg.setPlanMode(true);
        const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          await reg.dispatch("good_tool", "{}");
          const writes = writeSpy.mock.calls.map((c) => String(c[0]));
          expect(writes.some((w) => w.includes("readOnlyCheck for"))).toBe(false);
        } finally {
          writeSpy.mockRestore();
        }
      });
    });
  });

  describe("origin-scoped tool names", () => {
    it("refuses a bridged tool that would shadow a built-in", () => {
      const reg = new ToolRegistry();
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(
          reg.tryRegister({ name: "web_search", description: "built-in", fn: () => "built-in" }),
        ).toBe(true);
        expect(
          reg.tryRegister(
            { name: "web_search", description: "mcp version", fn: () => "mcp" },
            { origin: "mcp:web" },
          ),
        ).toBe(false);
        expect(reg.get("web_search")?.description).toBe("built-in");
        const writes = writeSpy.mock.calls.map((c) => String(c[0]));
        expect(writes.some((w) => w.includes('refused tool "web_search" from mcp:web'))).toBe(true);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it("allows same-origin re-registration (JEV re-enable, MCP reconnect)", () => {
      const reg = new ToolRegistry();
      reg.register({ name: "x", description: "v1", fn: () => "1" }, { origin: "mcp:a" });
      expect(
        reg.tryRegister({ name: "x", description: "v2", fn: () => "2" }, { origin: "mcp:a" }),
      ).toBe(true);
      expect(reg.get("x")?.description).toBe("v2");
    });

    it("reports a collision once, not on every reconnect", () => {
      const reg = new ToolRegistry();
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        reg.register({ name: "n", description: "builtin", fn: () => "" });
        const mcpTool = { name: "n", description: "mcp", fn: () => "" };
        reg.register(mcpTool, { origin: "mcp:s" });
        reg.register(mcpTool, { origin: "mcp:s" });
        expect(writeSpy).toHaveBeenCalledTimes(1);
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  describe("dotted parameter names", () => {
    it("skips flattening when a top-level param already contains a dot", async () => {
      const reg = new ToolRegistry();
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        reg.register({
          name: "dotted",
          description: "has a dotted parameter name",
          parameters: {
            type: "object",
            properties: {
              "a.b": { type: "string" },
              outer: {
                type: "object",
                properties: {
                  mid: { type: "object", properties: { deep: { type: "string" } } },
                },
              },
            },
            required: ["a.b"],
          },
          fn: (args: Record<string, unknown>) => JSON.stringify(args),
        });
        // Deep enough to flatten normally, but the dotted key makes dot-paths ambiguous.
        expect(reg.wasFlattened("dotted")).toBe(false);
        expect(JSON.parse(await reg.dispatch("dotted", '{"a.b":"x"}'))).toEqual({ "a.b": "x" });
        const writes = writeSpy.mock.calls.map((c) => String(c[0]));
        expect(writes.some((w) => w.includes('not flattening tool "dotted"'))).toBe(true);
      } finally {
        writeSpy.mockRestore();
      }
    });
  });
});

describe("delete-tools", () => {
  describe("delete_range tool", () => {
    let root: string;
    let tools: ToolRegistry;
    let readTracker: ReadTracker;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "reasonix-delete-tools-"));
      tools = new ToolRegistry();
      registerFilesystemTools(tools, { rootDir: root });
      readTracker = new ReadTracker();
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("delete_range refuses unread files, then deletes an anchored range after read_file", async () => {
      await fs.writeFile(join(root, "demo.txt"), "before\nSTART\nremove\nEND\nafter\n");

      const unread = await tools.dispatch(
        "delete_range",
        { path: "demo.txt", start_anchor: "START\n", end_anchor: "END\n" },
        { readTracker },
      );
      expect(unread).toMatch(/read_file first/);

      await tools.dispatch("read_file", { path: "demo.txt" }, { readTracker });
      const out = await tools.dispatch(
        "delete_range",
        { path: "demo.txt", start_anchor: "START\n", end_anchor: "END\n" },
        { readTracker },
      );

      expect(out).toMatch(/delete_range: deleted/);
      await expect(fs.readFile(join(root, "demo.txt"), "utf8")).resolves.toBe("before\nafter\n");
    });

    it("delete_range is a no-op when anchors are duplicated", async () => {
      await fs.writeFile(join(root, "demo.txt"), "A\nSTART\nx\nSTART\nEND\n");
      await tools.dispatch("read_file", { path: "demo.txt" }, { readTracker });

      const out = await tools.dispatch(
        "delete_range",
        { path: "demo.txt", start_anchor: "START", end_anchor: "END" },
        { readTracker },
      );

      expect(out).toMatch(/no-op/);
      await expect(fs.readFile(join(root, "demo.txt"), "utf8")).resolves.toContain("x");
    });
  });

  describe("delete_symbol tool", () => {
    let root: string;
    let tools: ToolRegistry;
    let readTracker: ReadTracker;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "reasonix-delete-tools-"));
      tools = new ToolRegistry();
      registerFilesystemTools(tools, { rootDir: root });
      readTracker = new ReadTracker();
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("deletes a single TypeScript function by AST range", async () => {
      await fs.writeFile(
        join(root, "demo.ts"),
        "export function keep() {\n  return 1;\n}\n\nexport function removeMe() {\n  return 2;\n}\n",
      );
      await tools.dispatch("read_file", { path: "demo.ts" }, { readTracker });

      const out = await tools.dispatch(
        "delete_symbol",
        { path: "demo.ts", name: "removeMe", kind: "function" },
        { readTracker },
      );

      expect(out).toMatch(/delete_symbol: deleted lines/);
      const after = await fs.readFile(join(root, "demo.ts"), "utf8");
      expect(after).toContain("keep");
      expect(after).not.toContain("removeMe");
    });

    it("deletes leading decorators and JSDoc with a TypeScript symbol", async () => {
      await fs.writeFile(
        join(root, "decorated.ts"),
        [
          "export function keep() {",
          "  return 1;",
          "}",
          "",
          "/** Remove this class. */",
          "@sealed",
          "export class RemoveMe {",
          "  value = 2;",
          "}",
          "",
        ].join("\n"),
      );
      await tools.dispatch("read_file", { path: "decorated.ts" }, { readTracker });

      const out = await tools.dispatch(
        "delete_symbol",
        { path: "decorated.ts", name: "RemoveMe", kind: "class" },
        { readTracker },
      );

      expect(out).toMatch(/delete_symbol: deleted lines/);
      const after = await fs.readFile(join(root, "decorated.ts"), "utf8");
      expect(after).toContain("keep");
      expect(after).not.toContain("RemoveMe");
      expect(after).not.toContain("@sealed");
      expect(after).not.toContain("Remove this class");
    });

    it("deletes Python decorators with the symbol", async () => {
      await fs.writeFile(
        join(root, "decorated.py"),
        "def keep():\n    return 1\n\n@cached\n@traced\ndef remove_me():\n    return 2\n",
      );
      await tools.dispatch("read_file", { path: "decorated.py" }, { readTracker });

      const out = await tools.dispatch(
        "delete_symbol",
        { path: "decorated.py", name: "remove_me", kind: "function" },
        { readTracker },
      );

      expect(out).toMatch(/delete_symbol: deleted lines/);
      const after = await fs.readFile(join(root, "decorated.py"), "utf8");
      expect(after).toContain("keep");
      expect(after).not.toContain("remove_me");
      expect(after).not.toContain("@cached");
      expect(after).not.toContain("@traced");
    });
  });
});

// Tool-call ready progress — incrementing `toolCallReadyCount` lets the UI render "N ready · building call M".
describe("tool-call-ready", () => {
  describe("looksLikeCompleteJson", () => {
    it("empty / whitespace → false", () => {
      expect(looksLikeCompleteJson("")).toBe(false);
      expect(looksLikeCompleteJson("   ")).toBe(false);
    });

    it("partial JSON → false (the common streaming case)", () => {
      expect(looksLikeCompleteJson("{")).toBe(false);
      expect(looksLikeCompleteJson('{"path"')).toBe(false);
      expect(looksLikeCompleteJson('{"path": "foo.md", "content": "hel')).toBe(false);
    });

    it("complete JSON object → true", () => {
      expect(looksLikeCompleteJson("{}")).toBe(true);
      expect(looksLikeCompleteJson('{"path": "foo.md", "content": "hello"}')).toBe(true);
    });

    it("complete JSON array → true", () => {
      expect(looksLikeCompleteJson("[]")).toBe(true);
      expect(looksLikeCompleteJson('[{"a": 1}]')).toBe(true);
    });

    it("primitive JSON values → true", () => {
      expect(looksLikeCompleteJson("true")).toBe(true);
      expect(looksLikeCompleteJson("42")).toBe(true);
      expect(looksLikeCompleteJson('"text"')).toBe(true);
    });

    it("valid JSON with trailing whitespace → true", () => {
      expect(looksLikeCompleteJson('{"a":1}\n')).toBe(true);
    });
  });
});

describe("tools-rate-limit", () => {
  describe("ToolRateLimiter", () => {
    it("allows calls under the aggregate limit", () => {
      const now = 1_000;
      const limiter = new ToolRateLimiter(
        { aggregate: { maxCalls: 2, windowSeconds: 60 }, tools: {} },
        () => now,
      );

      expect(limiter.consume("read_file").allowed).toBe(true);
      expect(limiter.consume("search_files").allowed).toBe(true);
    });

    it("blocks the first call over the aggregate limit", () => {
      const now = 1_000;
      const limiter = new ToolRateLimiter(
        { aggregate: { maxCalls: 2, windowSeconds: 60 }, tools: {} },
        () => now,
      );

      limiter.consume("read_file");
      limiter.consume("search_files");
      const blocked = limiter.consume("list_directory");

      expect(blocked.allowed).toBe(false);
      expect(blocked.result).toMatchObject({
        error: "rate_limited",
        scope: "all_tools",
        limit: 2,
        windowSeconds: 60,
      });
      expect(blocked.result?.retryAfterMs).toBe(60_000);
    });

    it("lets a per-tool bucket block before the aggregate bucket", () => {
      const now = 1_000;
      const limiter = new ToolRateLimiter(
        {
          aggregate: { maxCalls: 10, windowSeconds: 60 },
          tools: { run_command: { maxCalls: 1, windowSeconds: 60 } },
        },
        () => now,
      );

      expect(limiter.consume("run_command").allowed).toBe(true);
      const blocked = limiter.consume("run_command");

      expect(blocked.allowed).toBe(false);
      expect(blocked.result).toMatchObject({
        tool: "run_command",
        scope: "run_command",
        limit: 1,
        windowSeconds: 60,
      });
    });

    it("per-tool false disables only that tool bucket while aggregate still applies", () => {
      const now = 1_000;
      const limiter = new ToolRateLimiter(
        {
          aggregate: { maxCalls: 2, windowSeconds: 60 },
          tools: { run_command: false },
        },
        () => now,
      );

      expect(limiter.consume("run_command").allowed).toBe(true);
      expect(limiter.consume("run_command").allowed).toBe(true);
      const blocked = limiter.consume("run_command");

      expect(blocked.allowed).toBe(false);
      expect(blocked.result?.scope).toBe("all_tools");
    });

    it("expires old timestamps after the window", () => {
      let now = 1_000;
      const limiter = new ToolRateLimiter(
        { aggregate: { maxCalls: 1, windowSeconds: 1 }, tools: {} },
        () => now,
      );

      expect(limiter.consume("read_file").allowed).toBe(true);
      expect(limiter.consume("read_file").allowed).toBe(false);
      now = 2_001;
      expect(limiter.consume("read_file").allowed).toBe(true);
    });

    it("enabled false never blocks", () => {
      const now = 1_000;
      const limiter = new ToolRateLimiter(false, () => now);

      expect(limiter.consume("run_command").allowed).toBe(true);
      expect(limiter.consume("run_command").allowed).toBe(true);
      expect(limiter.consume("run_command").allowed).toBe(true);
    });

    it("normalizes invalid values to defaults", () => {
      const normalized = normalizeToolRateLimitConfig({
        aggregate: { maxCalls: 0, windowSeconds: 0 },
        tools: {
          run_command: { maxCalls: -1, windowSeconds: 1.5 },
          custom_tool: { maxCalls: 3, windowSeconds: 4 },
        },
      });

      expect(normalized).toMatchObject({
        aggregate: { maxCalls: 200, windowSeconds: 60 },
        tools: {
          run_command: { maxCalls: 60, windowSeconds: 60 },
          run_background: { maxCalls: 10, windowSeconds: 60 },
          custom_tool: { maxCalls: 3, windowSeconds: 4 },
        },
      });
    });
  });
});

describe("declarative-output-filter", () => {
  describe("declarative output filters", () => {
    it("validates every built-in declaration", () => {
      for (const filter of BUILTIN_DECLARATIVE_FILTERS)
        expect(() => validateDeclarativeFilter(filter)).not.toThrow();
    });

    it("matches exact executable and subcommand tokens", () => {
      const filter = BUILTIN_DECLARATIVE_FILTERS[0]!;
      expect(declarativeFilterMatches(filter, ["biome", "check", "src"])).toBe(true);
      expect(declarativeFilterMatches(filter, ["my-biome", "check", "src"])).toBe(false);
      expect(declarativeFilterMatches(filter, ["biome", "format", "src"])).toBe(false);
    });

    it("strips ANSI and known noise while retaining diagnostics", () => {
      const raw = "\u001b[31mChecked 42 files in 1s\u001b[0m\n\nsrc/a.ts:1:1 error\nFound 1 error.";
      const output = applyDeclarativeFilter(BUILTIN_DECLARATIVE_FILTERS[0]!, raw).output;
      expect(output).toContain("src/a.ts:1:1 error");
      expect(output).not.toContain("\u001b");
      expect(output).not.toContain("Checked 42");
    });

    it("rejects ambiguous declarations", () => {
      expect(() =>
        validateDeclarativeFilter({ id: "bad", commandFamily: "bad", executable: ".*" }),
      ).toThrow();
      expect(() =>
        validateDeclarativeFilter({
          id: "bad",
          commandFamily: "bad",
          executable: "x",
          stripLines: [/a/],
          keepLines: [/b/],
        }),
      ).toThrow();
    });
  });
});

describe("shell-output-filter", () => {
  function result(output: string, exitCode = 0): RunCommandResult {
    return {
      output,
      exitCode,
      timedOut: false,
      truncated: false,
      totalOutputBytes: output.length,
      durationMs: 1,
    };
  }

  describe("semantic shell output filters", () => {
    it("classifies parsed argv rather than raw prefixes", () => {
      expect(classifyCommandFamily(["npx", "vitest", "run"])).toBe("vitest");
      expect(classifyCommandFamily(["git", "status"])).toBe("git-status");
    });

    it("uses the same registry for filtering and raw-output preservation", () => {
      expect(commandSupportsOutputFiltering(["npx", "vitest", "run"])).toBe(true);
      expect(commandSupportsOutputFiltering(["npx", "vitest", "--reporter=junit"])).toBe(false);
      expect(commandSupportsOutputFiltering(["biome", "check", "src"])).toBe(true);
      expect(commandSupportsOutputFiltering(["node", "script.mjs"])).toBe(false);
    });

    it("compacts ANSI-colored Vitest success output", () => {
      const raw =
        "\u001b[36mRUN v2\u001b[0m\n ✓ a.test.ts (4 tests)\n\n Test Files  1 passed (1)\n      Tests  \u001b[32m4 passed (4)\u001b[0m\n Duration 1s";
      const filtered = applyOutputFilter(["npx", "vitest", "run"], result(raw));
      expect(filtered.filter.mode).toBe("filtered");
      expect(filtered.result.output).toContain("Tests 4 passed (4)");
      expect(filtered.result.output).not.toContain("RUN v2");
      expect(filtered.result.output).not.toContain("\u001b");
    });

    it("makes malformed Vitest output visibly degraded", () => {
      const raw = "runner crashed before summary";
      const filtered = applyOutputFilter(["npx", "vitest", "run"], result(raw, 1));
      expect(filtered.filter.mode).toBe("degraded");
      expect(filtered.result.output).toContain("output filter degraded");
      expect(filtered.result.output).toContain(raw);
    });

    it("honors explicit Vitest reporters", () => {
      const raw = "custom reporter output";
      const filtered = applyOutputFilter(["npx", "vitest", "--reporter=junit"], result(raw));
      expect(filtered.filter.mode).toBe("passthrough");
      expect(filtered.result.output).toBe(raw);
    });

    it("groups TypeScript diagnostics by file", () => {
      const raw = [
        "src/a.ts(2,3): error TS2322: Type 'string' is not assignable",
        "  The target type comes from a deeply nested generic declaration that repeats context.",
        "src/a.ts(8,1): error TS7006: Parameter has an implicit any type",
        "  Add an explicit parameter type to resolve this diagnostic.",
      ].join("\n");
      const filtered = applyOutputFilter(["npx", "tsc", "--noEmit"], result(raw, 2));
      expect(filtered.filter.mode).toBe("filtered");
      expect(filtered.result.output).toContain("2 typescript diagnostics");
      expect(filtered.result.output).toContain("2:3 TS2322");
    });

    it("compacts long git status but preserves conflict state", () => {
      const raw =
        "On branch main\nYou have unmerged paths.\n  (fix conflicts and run git commit)\n\nUnmerged paths:\n  both modified: src/a.ts\n";
      const filtered = applyOutputFilter(["git", "status"], result(raw, 1));
      expect(filtered.filter.mode).toBe("filtered");
      expect(filtered.result.output).toContain("conflicts");
    });

    it("skips semantic filtering when the raw preview is already truncated", () => {
      const raw = result("partial");
      raw.truncated = true;
      const filtered = applyOutputFilter(["npx", "vitest", "run"], raw);
      expect(filtered.filter.mode).toBe("passthrough");
      expect(filtered.filter.warning).toContain("raw preview was truncated");
    });
  });
});

describe("read-before-edit-gate", () => {
  describe("read-before-edit gate", () => {
    let root: string;
    let tools: ToolRegistry;
    let readTracker: ReadTracker;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "reasonix-rbeg-"));
      tools = new ToolRegistry();
      registerFilesystemTools(tools, { rootDir: root });
      readTracker = new ReadTracker();
      await fs.writeFile(join(root, "hello.txt"), "alpha\nbeta\ngamma\n");
      await fs.writeFile(join(root, "other.txt"), "one\ntwo\nthree\n");
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("edit_file refuses an unread file with a read_file hint", async () => {
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "hello.txt", search: "alpha", replace: "ALPHA" }),
        { readTracker },
      );
      expect(out).toMatch(/read_file first/);
      expect(out).toMatch(/hello\.txt/);
      const after = await fs.readFile(join(root, "hello.txt"), "utf8");
      expect(after).toContain("alpha");
      expect(after).not.toContain("ALPHA");
    });

    it("edit_file succeeds after read_file marks the path", async () => {
      await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt" }), { readTracker });
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "hello.txt", search: "alpha", replace: "ALPHA" }),
        { readTracker },
      );
      expect(out).toMatch(/edited hello\.txt/);
      const after = await fs.readFile(join(root, "hello.txt"), "utf8");
      expect(after).toContain("ALPHA");
    });

    it("write_file counts as a read for that path", async () => {
      await tools.dispatch(
        "write_file",
        JSON.stringify({ path: "new.txt", content: "first line\nsecond line\n" }),
        { readTracker },
      );
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "new.txt", search: "first line", replace: "FIRST LINE" }),
        { readTracker },
      );
      expect(out).toMatch(/edited new\.txt/);
    });

    it("read_file with range or head still marks the path (partial read accepted)", async () => {
      await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt", head: 1 }), {
        readTracker,
      });
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "hello.txt", search: "alpha", replace: "ALPHA" }),
        { readTracker },
      );
      expect(out).toMatch(/edited hello\.txt/);
    });

    it("multi_edit refuses the whole batch when any target is unread", async () => {
      await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt" }), { readTracker });
      const out = await tools.dispatch(
        "multi_edit",
        JSON.stringify({
          edits: [
            { path: "hello.txt", search: "alpha", replace: "ALPHA" },
            { path: "other.txt", search: "one", replace: "ONE" },
          ],
        }),
        { readTracker },
      );
      expect(out).toMatch(/read_file first/);
      expect(out).toMatch(/other\.txt/);
      const hello = await fs.readFile(join(root, "hello.txt"), "utf8");
      expect(hello).toContain("alpha");
      const other = await fs.readFile(join(root, "other.txt"), "utf8");
      expect(other).toContain("one");
    });

    it("multi_edit succeeds when every target was read first", async () => {
      await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt" }), { readTracker });
      await tools.dispatch("read_file", JSON.stringify({ path: "other.txt" }), { readTracker });
      const out = await tools.dispatch(
        "multi_edit",
        JSON.stringify({
          edits: [
            { path: "hello.txt", search: "alpha", replace: "ALPHA" },
            { path: "other.txt", search: "one", replace: "ONE" },
          ],
        }),
        { readTracker },
      );
      expect(out).toMatch(/applied 2 edits across 2 files/);
    });

    it("a 2nd identical unread edit gets the sharper stop-retrying hint", async () => {
      const first = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "hello.txt", search: "alpha", replace: "ALPHA" }),
        { readTracker },
      );
      expect(first).toMatch(/read_file first/);
      const second = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "hello.txt", search: "alpha", replace: "ALPHA" }),
        { readTracker },
      );
      expect(second).toMatch(/do not retry identical args/i);
      expect(second).toMatch(/Call read_file on the target path first/);
    });

    it("ReadTracker.reset clears the seen set so a fresh edit needs a fresh read", async () => {
      await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt" }), { readTracker });
      readTracker.reset();
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "hello.txt", search: "alpha", replace: "ALPHA" }),
        { readTracker },
      );
      expect(out).toMatch(/read_file first/);
    });

    it("with no readTracker injected, edits proceed (backwards-compatible)", async () => {
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "hello.txt", search: "alpha", replace: "ALPHA" }),
      );
      expect(out).toMatch(/edited hello\.txt/);
    });
  });

  describe("ReadTracker path normalization", () => {
    it("treats different relative spellings of the same absolute path as the same file", () => {
      const tracker = new ReadTracker();
      const abs = process.platform === "win32" ? "C:\\foo\\bar.txt" : "/foo/bar.txt";
      tracker.markRead(abs);
      expect(tracker.hasRead(abs)).toBe(true);
      if (process.platform === "win32") {
        expect(tracker.hasRead(abs.toUpperCase())).toBe(true);
        expect(tracker.hasRead(abs.toLowerCase())).toBe(true);
      }
    });

    it("size reflects unique paths only", () => {
      const tracker = new ReadTracker();
      tracker.markRead("/a/b.ts");
      tracker.markRead("/a/b.ts");
      tracker.markRead("/a/c.ts");
      expect(tracker.size).toBe(2);
    });
  });
});

describe("concurrency-gate", () => {
  describe("ConcurrencyGate", () => {
    it("limits active work and drains higher-priority queued tasks first", async () => {
      const gate = new ConcurrencyGate(1);
      const order: string[] = [];
      let release!: () => void;
      const first = gate.run(
        () =>
          new Promise<string>((resolve) => {
            release = () => resolve("first");
          }),
      );
      const low = gate.run(async () => {
        order.push("low");
        return "low";
      });
      const high = gate.run(async () => {
        order.push("high");
        return "high";
      }, 1);
      release();
      await Promise.all([first, low, high]);
      expect(order).toEqual(["high", "low"]);
    });

    it("reports queue wait and continues after a rejection", async () => {
      const gate = new ConcurrencyGate(1);
      await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      await expect(gate.run(async () => "ok")).resolves.toMatchObject({ value: "ok" });
    });
  });
});

describe("wait-tool", () => {
  function makeRegistry(clock: {
    now: () => number;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  }): ToolRegistry {
    return registerWaitTool(new ToolRegistry(), { now: clock.now, sleep: clock.sleep });
  }

  describe("formatUtc / formatLocal", () => {
    it("formats UTC as timezone-independent sortable timestamp", () => {
      expect(formatUtc(Date.UTC(2026, 4, 14, 9, 5, 3))).toBe("2026-05-14 09:05:03 UTC");
    });

    it("formats local with the host timezone offset", () => {
      const ms = Date.UTC(2026, 4, 14, 12, 0, 0);
      const d = new Date(ms);
      const offsetMinutes = -d.getTimezoneOffset();
      const sign = offsetMinutes >= 0 ? "+" : "-";
      const abs = Math.abs(offsetMinutes);
      const expected = ` (UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(
        abs % 60,
      ).padStart(2, "0")})`;
      expect(formatLocal(ms)).toMatch(
        new RegExp(
          `\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}${expected.replace(/[+()]/g, "\\$&")}$`,
        ),
      );
    });
  });

  describe("wait tool", () => {
    it("registers as readOnly and reports full time accounting", async () => {
      let t = 1_000;
      let slept = 0;
      const registry = makeRegistry({
        now: () => t,
        sleep: async (ms) => {
          slept = ms;
          t += ms;
        },
      });
      expect(registry.get("wait")?.readOnly).toBe(true);
      const out = JSON.parse(
        (await registry.dispatch("wait", JSON.stringify({ ms: 2500 }))) as string,
      ) as Record<string, unknown>;
      expect(slept).toBe(2500);
      expect(out.requestedMs).toBe(2500);
      expect(out.waitedMs).toBe(2500);
      expect(out.clamped).toBe(false);
      expect(out.cancelledByUser).toBeUndefined();
      expect(out.timeBefore).toEqual({
        utc: "1970-01-01 00:00:01 UTC",
        local: formatLocal(1_000),
      });
      expect(out.timeAfter).toEqual({
        utc: "1970-01-01 00:00:03 UTC",
        local: formatLocal(3_500),
      });
      expect(out.elapsed).toBe("2.5s");
    });

    it("clamps values over the cap instead of rejecting", async () => {
      let t = 0;
      let slept = 0;
      const registry = makeRegistry({
        now: () => t,
        sleep: async (ms) => {
          slept = ms;
          t += ms;
        },
      });
      const out = JSON.parse(
        (await registry.dispatch("wait", JSON.stringify({ ms: WAIT_MAX_MS * 10 }))) as string,
      ) as Record<string, unknown>;
      expect(slept).toBe(WAIT_MAX_MS);
      expect(out.requestedMs).toBe(WAIT_MAX_MS);
      expect(out.clamped).toBe(true);
    });

    it("falls back to the default on missing / zero / non-numeric ms", async () => {
      for (const args of [
        "{}",
        JSON.stringify({ ms: 0 }),
        JSON.stringify({ ms: -5 }),
        JSON.stringify({ ms: "soon" }),
      ]) {
        let t = 0;
        let slept = 0;
        const registry = makeRegistry({
          now: () => t,
          sleep: async (ms) => {
            slept = ms;
            t += ms;
          },
        });
        const out = JSON.parse((await registry.dispatch("wait", args)) as string) as Record<
          string,
          unknown
        >;
        expect(slept).toBe(WAIT_DEFAULT_MS);
        expect(out.requestedMs).toBe(WAIT_DEFAULT_MS);
      }
    });

    it("reports a user cancellation instead of throwing", async () => {
      const controller = new AbortController();
      const registry = makeRegistry({
        now: () => 0,
        sleep: async (_ms, signal) => {
          await new Promise((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      });
      const dispatch = registry.dispatch("wait", "{}", { cancelSignal: controller.signal });
      controller.abort(new Error("user stop"));
      const out = JSON.parse((await dispatch) as string) as Record<string, unknown>;
      expect(out.cancelledByUser).toBe(true);
      expect(out.note).toMatch(/interrupted/);
    });

    it("wakes on the TURN abort signal too, not just the per-call cancel", async () => {
      const controller = new AbortController();
      let wakeAbort: (() => void) | null = null;
      const registry = makeRegistry({
        now: () => 0,
        sleep: async (_ms, signal) => {
          await new Promise((_resolve, reject) => {
            wakeAbort = () => reject(new Error("aborted"));
            signal?.addEventListener("abort", wakeAbort, { once: true });
          });
        },
      });
      const dispatch = registry.dispatch("wait", "{}", { signal: controller.signal });
      controller.abort(new Error("turn stop"));
      const out = JSON.parse((await dispatch) as string) as Record<string, unknown>;
      expect(out.cancelledByUser).toBe(true);
    });

    it("default sleeper sleeps no longer than requested (bounded real sleep)", async () => {
      const registry = registerWaitTool(new ToolRegistry());
      const out = JSON.parse(
        (await registry.dispatch("wait", JSON.stringify({ ms: 50 }))) as string,
      ) as Record<string, unknown>;
      expect(out.requestedMs).toBe(50);
      expect((out.waitedMs as number) >= 45).toBe(true);
      expect((out.waitedMs as number) < 2_000).toBe(true);
    });

    it("missing required-parameter path uses registry validation (ms is optional)", async () => {
      const registry = makeRegistry({ now: () => 0, sleep: async () => {} });
      expect(registry.get("wait")?.parameters?.required).toBeUndefined();
    });
  });
});

describe("computer-use", () => {
  describe("computer_use", () => {
    const monitors: MonitorInfo[] = [
      { id: "M0", name: "M0", index: 0, x: 0, y: 0, width: 100, height: 80, primary: true },
    ];

    it("performs click as one atomic action", async () => {
      const actions: unknown[] = [];
      const registry = new ToolRegistry();
      registerComputerUseTool(registry, {
        listMonitors: async () => monitors,
        actionRunner: async (action) => actions.push(action),
      });
      const result = await registry.dispatch(
        "computer_use",
        JSON.stringify({ action: "click", monitor: 0, x: 10, y: 20 }),
      );
      expect(result).toContain("clicked monitor 0");
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ kind: "click", point: { x: 10, y: 20 } });
    });

    it("rejects missing monitors and out-of-bounds clicks", async () => {
      const registry = new ToolRegistry();
      registerComputerUseTool(registry, {
        listMonitors: async () => monitors,
        actionRunner: async () => {},
      });
      await expect(
        registry.dispatch("computer_use", JSON.stringify({ action: "click", x: 1, y: 1 })),
      ).resolves.toContain("missing required parameter");
      await expect(
        registry.dispatch(
          "computer_use",
          JSON.stringify({ action: "click", monitor: 0, x: 100, y: 1 }),
        ),
      ).resolves.toContain("outside monitor");
    });

    it("focuses through the same atomic action seam", async () => {
      const actions: unknown[] = [];
      const registry = new ToolRegistry();
      registerComputerUseTool(registry, {
        listMonitors: async () => monitors,
        actionRunner: async (action) => actions.push(action),
      });
      await registry.dispatch(
        "computer_use",
        JSON.stringify({ action: "focus", monitor: 0, app: "Calculator" }),
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ kind: "focus", app: "Calculator", monitor: { index: 0 } });
    });
  });
});

describe("todo", () => {
  function setup(): { tools: ToolRegistry; updates: TodoItem[][] } {
    const updates: TodoItem[][] = [];
    const tools = new ToolRegistry();
    registerTodoTool(tools, { onTodosUpdated: (t) => updates.push(t) });
    return { tools, updates };
  }

  describe("todo_write — lightweight in-session task tracker", () => {
    it("registers as readOnly so plan mode allows it", () => {
      const tools = new ToolRegistry();
      registerTodoTool(tools);
      expect(tools.get("todo_write")?.readOnly).toBe(true);
    });

    it("accepts a well-formed todo list and echoes the rendered state", async () => {
      const { tools, updates } = setup();
      const out = await tools.dispatch(
        "todo_write",
        JSON.stringify({
          todos: [
            { content: "Read the spec", activeForm: "Reading the spec", status: "completed" },
            {
              content: "Sketch the parser",
              activeForm: "Sketching the parser",
              status: "in_progress",
            },
            { content: "Write tests", activeForm: "Writing tests", status: "pending" },
          ],
        }),
      );
      expect(out).toContain("1 done");
      expect(out).toContain("1 in progress");
      expect(out).toContain("1 pending");
      // Completed items are hidden from rendered output (header still counts them) — #2049.
      expect(out).not.toContain("[x] Read the spec");
      expect(out).toContain("[>] Sketching the parser");
      expect(out).toContain("[ ] Write tests");
      expect(updates).toHaveLength(1);
      expect(updates[0]).toHaveLength(3);
    });

    it("allows an empty list to clear the tracker", async () => {
      const { tools, updates } = setup();
      const out = await tools.dispatch("todo_write", JSON.stringify({ todos: [] }));
      expect(out).toMatch(/cleared/);
      expect(updates[0]).toEqual([]);
    });

    it("refuses two todos with status:in_progress at once", async () => {
      const { tools } = setup();
      const out = await tools.dispatch(
        "todo_write",
        JSON.stringify({
          todos: [
            { content: "A", activeForm: "Doing A", status: "in_progress" },
            { content: "B", activeForm: "Doing B", status: "in_progress" },
          ],
        }),
      );
      expect(out).toMatch(/at most one/);
    });

    it("refuses an unknown status value", async () => {
      const { tools } = setup();
      const out = await tools.dispatch(
        "todo_write",
        JSON.stringify({
          todos: [{ content: "A", activeForm: "Doing A", status: "blocked" }],
        }),
      );
      expect(out).toMatch(/status/);
      expect(out).toMatch(/pending\|in_progress\|completed/);
    });

    it("refuses an empty content string", async () => {
      const { tools } = setup();
      const out = await tools.dispatch(
        "todo_write",
        JSON.stringify({
          todos: [{ content: "  ", activeForm: "Doing it", status: "pending" }],
        }),
      );
      expect(out).toMatch(/content/);
      expect(out).toMatch(/non-empty/);
    });

    it("refuses an empty activeForm", async () => {
      const { tools } = setup();
      const out = await tools.dispatch(
        "todo_write",
        JSON.stringify({
          todos: [{ content: "Step", activeForm: "", status: "pending" }],
        }),
      );
      expect(out).toMatch(/activeForm/);
    });

    it("refuses a non-array todos field", async () => {
      const { tools } = setup();
      const out = await tools.dispatch("todo_write", JSON.stringify({ todos: "not-an-array" }));
      expect(out).toMatch(/must be an array/);
    });

    it("does not invoke onTodosUpdated when validation fails", async () => {
      const cb = vi.fn();
      const tools = new ToolRegistry();
      registerTodoTool(tools, { onTodosUpdated: cb });
      await tools.dispatch(
        "todo_write",
        JSON.stringify({
          todos: [{ content: "A", activeForm: "Doing A", status: "blocked" }],
        }),
      );
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
