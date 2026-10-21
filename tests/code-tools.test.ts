// Consolidated from 9 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { Jimp } from "jimp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInCode } from "../src/code-query/find-in-code.js";
import { grammarForPath, parseSource } from "../src/code-query/parser.js";
import { extractSymbols } from "../src/code-query/symbols.js";
import { decodeFileBuffer, encodeFile } from "../src/code/file-encoding.js";
import { loadProjectPathAllowed, writeConfig } from "../src/config.js";
import { PauseGate } from "../src/core/pause-gate.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import {
  MAX_VISION_DIMENSION,
  isAnimatedWebp,
  normalizeImageToDataUrls,
  sniffImageFormat,
} from "../src/image-format.js";
import {
  KEEP_LAST_IMAGES,
  isPayloadTooLargeError,
  pruneOldImageParts,
  shrinkImagePartsForRetry,
} from "../src/loop/image-retry.js";
import { ToolRegistry } from "../src/tools.js";
import { registerFilesystemTools } from "../src/tools/filesystem.js";
import { extractOutline, formatOutline } from "../src/tools/fs/outline.js";
import type { ChatMessage } from "../src/types.js";

describe("code-query-find-in-code", () => {
  describe("findInCode", () => {
    it("finds an identifier across definition, references, and call sites", async () => {
      const source = `
  function fetchUser(id: string) {
    return fetchUser.cache?.[id];
  }
  const u = fetchUser("a");
  const v = fetchUser("b");
  `;
      const matches = await findInCode("a.ts", source, "fetchUser");
      const kinds = matches.map((m) => m.kind).sort();
      expect(kinds).toContain("definition");
      expect(kinds.filter((k) => k === "call").length).toBe(2);
      expect(kinds.filter((k) => k === "reference").length).toBeGreaterThanOrEqual(1);
    });

    it("does not match identifiers inside string literals or comments", async () => {
      const source = `
  // fetchUser is a function defined elsewhere
  function fetchUser() {}
  const note = "call fetchUser here";
  fetchUser();
  `;
      const matches = await findInCode("a.ts", source, "fetchUser");
      expect(matches.length).toBe(2);
      const kinds = matches.map((m) => m.kind).sort();
      expect(kinds).toEqual(["call", "definition"]);
    });

    it("filters by kind=call", async () => {
      const source = `
  function helper() {}
  helper();
  const r = helper;
  helper();
  `;
      const matches = await findInCode("a.ts", source, "helper", { kind: "call" });
      expect(matches.length).toBe(2);
      expect(matches.every((m) => m.kind === "call")).toBe(true);
    });

    it("filters by kind=definition", async () => {
      const source = `
  interface User { id: string; }
  type User = string;
  const User = 1;
  `;
      const matches = await findInCode("a.ts", source, "User", { kind: "definition" });
      expect(matches.length).toBeGreaterThanOrEqual(2);
      expect(matches.every((m) => m.kind === "definition")).toBe(true);
    });

    it("returns 1-based line/column and the source-line snippet", async () => {
      const source = "const x = 1;\nconst y = 2;\nconsole.log(y);\n";
      const matches = await findInCode("a.ts", source, "y");
      expect(matches.length).toBeGreaterThanOrEqual(1);
      const first = matches[0]!;
      expect(first.line).toBe(2);
      expect(first.column).toBe(7);
      expect(first.snippet).toBe("const y = 2;");
    });

    it("returns empty for unsupported language", async () => {
      expect(await findInCode("a.cpp", "int x = 1;\n", "x")).toEqual([]);
    });

    it("classifies Python calls (foo() and obj.foo())", async () => {
      const source = "def foo():\n    pass\nfoo()\nobj.foo()\n";
      const matches = await findInCode("a.py", source, "foo");
      const kinds = matches.map((m) => m.kind).sort();
      expect(kinds).toEqual(["call", "call", "definition"]);
    });

    it("classifies Go calls and method invocations", async () => {
      const source = `package main
  func hello() {}
  func main() {
    hello()
    m.hello()
  }
  `;
      const calls = await findInCode("a.go", source, "hello", { kind: "call" });
      expect(calls.length).toBe(2);
    });

    it("classifies Rust function calls and method calls", async () => {
      const source = `fn helper() {}
  fn main() {
    helper();
    obj.helper();
  }
  `;
      const calls = await findInCode("a.rs", source, "helper", { kind: "call" });
      expect(calls.length).toBe(2);
    });

    it("classifies Java method invocations", async () => {
      const source = `class C {
    void run() { obj.run(); other.run(); }
  }
  `;
      const calls = await findInCode("C.java", source, "run", { kind: "call" });
      expect(calls.length).toBe(2);
    });

    it("returns empty when name is empty", async () => {
      expect(await findInCode("a.ts", "function foo(){}", "")).toEqual([]);
    });

    it("classifies obj.foo() as a call on foo", async () => {
      const source = "obj.foo(); function foo(){}";
      const matches = await findInCode("a.ts", source, "foo");
      const kinds = matches.map((m) => m.kind).sort();
      expect(kinds).toEqual(["call", "definition"]);
    });

    it("classifies bare access obj.foo (no call) as a reference", async () => {
      const source = "const r = obj.foo;\nfunction foo(){}";
      const matches = await findInCode("a.ts", source, "foo");
      const kinds = matches.map((m) => m.kind).sort();
      expect(kinds).toEqual(["definition", "reference"]);
    });

    it("classifies `new Foo()` and `new obj.Foo()` as calls on Foo", async () => {
      const source = "class Foo {}\nconst a = new Foo();\nconst b = new ns.Foo();";
      const matches = await findInCode("a.ts", source, "Foo");
      const kinds = matches.map((m) => m.kind).sort();
      expect(kinds).toEqual(["call", "call", "definition"]);
    });
  });
});

describe("code-query-parser", () => {
  describe("code-query parser", () => {
    describe("grammarForPath", () => {
      it("maps TS/TSX/JS/JSX extensions to the right grammar", () => {
        expect(grammarForPath("a.ts")).toBe("typescript");
        expect(grammarForPath("a.mts")).toBe("typescript");
        expect(grammarForPath("a.cts")).toBe("typescript");
        expect(grammarForPath("a.tsx")).toBe("tsx");
        expect(grammarForPath("a.js")).toBe("javascript");
        expect(grammarForPath("a.mjs")).toBe("javascript");
        expect(grammarForPath("a.cjs")).toBe("javascript");
        expect(grammarForPath("a.jsx")).toBe("javascript");
      });

      it("maps Python/Go/Rust/Java extensions to the right grammar", () => {
        expect(grammarForPath("a.py")).toBe("python");
        expect(grammarForPath("a.pyi")).toBe("python");
        expect(grammarForPath("a.go")).toBe("go");
        expect(grammarForPath("a.rs")).toBe("rust");
        expect(grammarForPath("A.java")).toBe("java");
      });

      it("returns null for unsupported extensions", () => {
        expect(grammarForPath("a.cpp")).toBeNull();
        expect(grammarForPath("README.md")).toBeNull();
        expect(grammarForPath("no-extension")).toBeNull();
      });
    });

    describe("parseSource", () => {
      it("initializes the runtime and grammar assets through the parser seam", async () => {
        const result = await parseSource("runtime-check.ts", "export const ready = true;");
        expect(result).not.toBeNull();
        expect(result!.tree.rootNode.type).toBe("program");
        result!.tree.delete();
      });

      it("parses a TypeScript snippet and yields a non-empty tree", async () => {
        const result = await parseSource(
          "foo.ts",
          "export function add(a: number, b: number): number { return a + b; }",
        );
        expect(result).not.toBeNull();
        expect(result!.grammar).toBe("typescript");
        const root = result!.tree.rootNode;
        expect(root.type).toBe("program");
        expect(root.childCount).toBeGreaterThan(0);
        result!.tree.delete();
      });

      it("parses TSX with JSX literals", async () => {
        const result = await parseSource("foo.tsx", "const x = <div>hi</div>;");
        expect(result).not.toBeNull();
        expect(result!.grammar).toBe("tsx");
        expect(result!.tree.rootNode.hasError).toBe(false);
        result!.tree.delete();
      });

      it("parses JavaScript with JSX", async () => {
        const result = await parseSource("foo.jsx", "const x = <div>hi</div>;");
        expect(result).not.toBeNull();
        expect(result!.grammar).toBe("javascript");
        expect(result!.tree.rootNode.hasError).toBe(false);
        result!.tree.delete();
      });

      it("returns null for unsupported file extensions", async () => {
        expect(await parseSource("x.cpp", "int main(){}")).toBeNull();
        expect(await parseSource("x.swift", "func main() {}")).toBeNull();
      });

      it("parses Python", async () => {
        const result = await parseSource("a.py", "def hello():\n    return 1\n");
        expect(result!.grammar).toBe("python");
        expect(result!.tree.rootNode.hasError).toBe(false);
        result!.tree.delete();
      });

      it("parses Go", async () => {
        const result = await parseSource("a.go", "package main\nfunc Hello() int { return 1 }\n");
        expect(result!.grammar).toBe("go");
        expect(result!.tree.rootNode.hasError).toBe(false);
        result!.tree.delete();
      });

      it("parses Rust", async () => {
        const result = await parseSource("a.rs", "fn hello() -> i32 { 1 }\n");
        expect(result!.grammar).toBe("rust");
        expect(result!.tree.rootNode.hasError).toBe(false);
        result!.tree.delete();
      });

      it("parses Java", async () => {
        const result = await parseSource("A.java", "class A { int hello() { return 1; } }\n");
        expect(result!.grammar).toBe("java");
        expect(result!.tree.rootNode.hasError).toBe(false);
        result!.tree.delete();
      });

      it("distinguishes valid syntax from broken syntax", async () => {
        const good = await parseSource("foo.ts", "const x = 1;");
        const bad = await parseSource("foo.ts", "const = ;");
        expect(good!.tree.rootNode.hasError).toBe(false);
        expect(bad!.tree.rootNode.hasError).toBe(true);
        good!.tree.delete();
        bad!.tree.delete();
      });
    });
  });
});

describe("code-query-symbols", () => {
  describe("extractSymbols", () => {
    it("finds top-level function and class declarations in TS", async () => {
      const source = `
  export function add(a: number, b: number): number {
    return a + b;
  }

  export class Calculator {
    total = 0;
    add(n: number): void {
      this.total += n;
    }
  }
  `;
      const symbols = await extractSymbols("calc.ts", source);
      const names = symbols.map((s) => `${s.kind}:${s.name}${s.parent ? `@${s.parent}` : ""}`);
      expect(names).toContain("function:add");
      expect(names).toContain("class:Calculator");
      expect(names).toContain("property:total@Calculator");
      expect(names).toContain("method:add@Calculator");
    });

    it("extracts interfaces, type aliases, and enums", async () => {
      const source = `
  interface User { id: string; }
  type ID = string | number;
  enum Color { Red, Green, Blue }
  `;
      const symbols = await extractSymbols("types.ts", source);
      const byKind = (k: string) => symbols.filter((s) => s.kind === k).map((s) => s.name);
      expect(byKind("interface")).toEqual(["User"]);
      expect(byKind("type")).toEqual(["ID"]);
      expect(byKind("enum")).toEqual(["Color"]);
    });

    it("treats arrow-function variables as functions", async () => {
      const source = `
  const greet = (name: string): string => "hi " + name;
  const noop = function () {};
  const value = 42;
  `;
      const symbols = await extractSymbols("vars.ts", source);
      const names = symbols.filter((s) => s.kind === "function").map((s) => s.name);
      expect(names).toContain("greet");
      expect(names).toContain("noop");
      expect(names).not.toContain("value");
    });

    it("returns symbols in source order with 1-based positions", async () => {
      const source = "function a(){}\nfunction b(){}\nfunction c(){}\n";
      const symbols = await extractSymbols("order.ts", source);
      expect(symbols.map((s) => s.name)).toEqual(["a", "b", "c"]);
      expect(symbols[0]!.line).toBe(1);
      expect(symbols[1]!.line).toBe(2);
      expect(symbols[2]!.line).toBe(3);
      expect(symbols.every((s) => s.column === 1)).toBe(true);
    });

    it("handles TSX with class + JSX method body", async () => {
      const source = `
  class App {
    render() {
      return <div>hi</div>;
    }
  }
  `;
      const symbols = await extractSymbols("App.tsx", source);
      const names = symbols.map((s) => `${s.kind}:${s.name}`);
      expect(names).toContain("class:App");
      expect(names).toContain("method:render");
    });

    it("handles JS without interfaces or types", async () => {
      const source = `
  function hello() {}
  class Foo {
    bar() {}
  }
  const g = () => 1;
  `;
      const symbols = await extractSymbols("a.js", source);
      const names = symbols.map((s) => `${s.kind}:${s.name}`);
      expect(names).toContain("function:hello");
      expect(names).toContain("class:Foo");
      expect(names).toContain("method:bar");
      expect(names).toContain("function:g");
    });

    it("returns empty for unsupported language", async () => {
      expect(await extractSymbols("file.cpp", "int main(){}")).toEqual([]);
    });

    it("extracts Python functions and classes; nested functions become methods", async () => {
      const source = `
  def hello():
      return 1

  class Greeter:
      def greet(self):
          return "hi"

      def __init__(self):
          self.n = 0
  `;
      const symbols = await extractSymbols("a.py", source);
      const named = symbols.map((s) => `${s.kind}:${s.name}${s.parent ? `@${s.parent}` : ""}`);
      expect(named).toContain("function:hello");
      expect(named).toContain("class:Greeter");
      expect(named).toContain("method:greet@Greeter");
      expect(named).toContain("method:__init__@Greeter");
    });

    it("extracts Go funcs, methods, structs, and interfaces", async () => {
      const source = `package main

  type User struct {
    Name string
  }

  type Greeter interface {
    Greet() string
  }

  func Hello() string { return "hi" }
  func (u *User) Greet() string { return "hi " + u.Name }
  `;
      const symbols = await extractSymbols("a.go", source);
      const named = symbols.map((s) => `${s.kind}:${s.name}`);
      expect(named).toContain("class:User");
      expect(named).toContain("interface:Greeter");
      expect(named).toContain("function:Hello");
      expect(named).toContain("method:Greet");
    });

    it("extracts Rust functions, structs, traits, and impl methods", async () => {
      const source = `pub struct User { pub name: String }
  pub trait Greet { fn greet(&self) -> String; }
  pub fn hello() -> i32 { 1 }
  impl User {
    pub fn name_len(&self) -> usize { self.name.len() }
  }
  `;
      const symbols = await extractSymbols("a.rs", source);
      const named = symbols.map((s) => `${s.kind}:${s.name}${s.parent ? `@${s.parent}` : ""}`);
      expect(named).toContain("class:User");
      expect(named).toContain("interface:Greet");
      expect(named).toContain("function:hello");
      expect(named).toContain("method:name_len@User");
    });

    it("extracts Java classes, methods, and fields", async () => {
      const source = `public class Calc {
    int total = 0;
    public int add(int n) { return total + n; }
    public Calc() {}
  }
  `;
      const symbols = await extractSymbols("Calc.java", source);
      const named = symbols.map((s) => `${s.kind}:${s.name}${s.parent ? `@${s.parent}` : ""}`);
      expect(named).toContain("class:Calc");
      expect(named).toContain("method:add@Calc");
      expect(named).toContain("method:Calc@Calc");
      expect(named).toContain("property:total@Calc");
    });

    it("returns empty for empty source", async () => {
      expect(await extractSymbols("empty.ts", "")).toEqual([]);
    });

    it("survives parse errors and still extracts what came before", async () => {
      const source = "function ok() {}\nconst broken = ;\n";
      const symbols = await extractSymbols("partial.ts", source);
      expect(symbols.map((s) => s.name)).toContain("ok");
    });
  });
});

describe("file-encoding", () => {
  describe("decodeFileBuffer (#1445)", () => {
    it("decodes plain ASCII as utf8", () => {
      const buf = Buffer.from("hello world\n", "utf8");
      expect(decodeFileBuffer(buf)).toEqual({ text: "hello world\n", encoding: "utf8" });
    });

    it("decodes valid UTF-8 multibyte as utf8", () => {
      const buf = Buffer.from("你好世界\n", "utf8");
      expect(decodeFileBuffer(buf)).toEqual({ text: "你好世界\n", encoding: "utf8" });
    });

    it("strips UTF-8 BOM and reports utf8-bom encoding", () => {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const buf = Buffer.concat([bom, Buffer.from("// hi 你好\n", "utf8")]);
      expect(decodeFileBuffer(buf)).toEqual({ text: "// hi 你好\n", encoding: "utf8-bom" });
    });

    it("falls back to gb18030 for invalid-UTF-8 CN bytes (any platform)", () => {
      const buf = iconv.encode("你好世界\n", "gb18030");
      expect(decodeFileBuffer(buf)).toEqual({ text: "你好世界\n", encoding: "gb18030" });
    });

    it("returns empty file as utf8", () => {
      expect(decodeFileBuffer(Buffer.alloc(0))).toEqual({ text: "", encoding: "utf8" });
    });
  });

  describe("encodeFile (#1445)", () => {
    it("round-trips utf8", () => {
      const text = "hello 你好\n";
      expect(decodeFileBuffer(encodeFile(text, "utf8"))).toEqual({ text, encoding: "utf8" });
    });

    it("round-trips utf8-bom preserving the BOM bytes", () => {
      const text = "// hi 你好\n";
      const buf = encodeFile(text, "utf8-bom");
      expect(buf[0]).toBe(0xef);
      expect(buf[1]).toBe(0xbb);
      expect(buf[2]).toBe(0xbf);
      expect(decodeFileBuffer(buf)).toEqual({ text, encoding: "utf8-bom" });
    });

    it("round-trips gb18030 bytes", () => {
      const text = "你好世界\n";
      const buf = encodeFile(text, "gb18030");
      expect(iconv.decode(buf, "gb18030")).toBe(text);
    });
  });
});

describe("filesystem-outside-sandbox", () => {
  describe("filesystem outside-sandbox gate (#684)", () => {
    let root: string;
    let outside: string;
    let configDir: string;
    let configPath: string;
    let tools: ToolRegistry;
    let gate: PauseGate;
    let gateRequests: Array<{ kind: string; payload: unknown }>;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "reasonix-sandbox-"));
      outside = await mkdtemp(join(tmpdir(), "reasonix-outside-"));
      configDir = await mkdtemp(join(tmpdir(), "reasonix-cfg-"));
      configPath = join(configDir, "config.json");
      writeConfig({}, configPath);
      tools = new ToolRegistry();
      registerFilesystemTools(tools, { rootDir: root });
      await fs.writeFile(join(outside, "secret.txt"), "outside content");
      gateRequests = [];
      gate = new PauseGate();
      gate.on((req) => {
        gateRequests.push({ kind: req.kind, payload: req.payload });
      });
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    });

    it("dispatches a path_access gate request when a system absolute path escapes the sandbox", async () => {
      const target = join(outside, "secret.txt");
      const call = tools.dispatch("read_file", { path: target }, { confirmationGate: gate });
      await new Promise((r) => setTimeout(r, 5));
      expect(gateRequests).toHaveLength(1);
      expect(gateRequests[0]?.kind).toBe("path_access");
      const payload = gateRequests[0]?.payload as {
        path: string;
        intent: string;
        toolName: string;
      };
      expect(payload.intent).toBe("read");
      expect(payload.toolName).toBe("read_file");
      expect(payload.path).toBe(target);
      const current = gate.current;
      expect(current).not.toBeNull();
      gate.resolve(current!.id, { type: "run_once" });
      const result = await call;
      expect(result).toContain("outside content");
    });

    it("throws a user-denied error when the gate verdict is deny", async () => {
      const target = join(outside, "secret.txt");
      const call = tools.dispatch("read_file", { path: target }, { confirmationGate: gate });
      await new Promise((r) => setTimeout(r, 5));
      const current = gate.current;
      expect(current).not.toBeNull();
      gate.resolve(current!.id, { type: "deny", denyContext: "not on the contract" });
      const result = await call;
      expect(result).toMatch(/user denied/);
      expect(result).toMatch(/not on the contract/);
    });

    it("run_once approval covers a follow-up access in the same directory without re-prompting", async () => {
      await fs.writeFile(join(outside, "second.txt"), "second");
      const first = tools.dispatch(
        "read_file",
        { path: join(outside, "secret.txt") },
        { confirmationGate: gate },
      );
      await new Promise((r) => setTimeout(r, 5));
      gate.resolve(gate.current!.id, { type: "run_once" });
      await first;
      const second = await tools.dispatch(
        "read_file",
        { path: join(outside, "second.txt") },
        { confirmationGate: gate },
      );
      expect(second).toContain("second");
      expect(gateRequests).toHaveLength(1);
    });

    it("rejects relative paths that escape (only system absolutes are gate-eligible)", async () => {
      const result = await tools.dispatch(
        "read_file",
        { path: "../escape" },
        { confirmationGate: gate },
      );
      expect(result).toMatch(/escapes sandbox root/);
      expect(gateRequests).toHaveLength(0);
    });

    it("preserves the leading-slash sandbox convention for paths like /src/foo.ts", async () => {
      await fs.mkdir(join(root, "src"), { recursive: true });
      await fs.writeFile(join(root, "src", "foo.ts"), "inside");
      const result = await tools.dispatch(
        "read_file",
        { path: "/src/foo.ts" },
        { confirmationGate: gate },
      );
      expect(result).toContain("inside");
      expect(gateRequests).toHaveLength(0);
    });

    it("write_file outside the sandbox routes through the gate with intent=write", async () => {
      const target = join(outside, "written.txt");
      const call = tools.dispatch(
        "write_file",
        { path: target, content: "from-test" },
        { confirmationGate: gate },
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(gateRequests).toHaveLength(1);
      const payload = gateRequests[0]?.payload as { intent: string; toolName: string };
      expect(payload.intent).toBe("write");
      expect(payload.toolName).toBe("write_file");
      gate.resolve(gate.current!.id, { type: "run_once" });
      await call;
      const onDisk = await fs.readFile(target, "utf8");
      expect(onDisk).toBe("from-test");
    });

    it("Windows drive-letter paths route to the gate (covers the looksAbsoluteSystemPath fallback)", async () => {
      // This path doesn't exist on POSIX but the resolver/check fires regardless.
      if (process.platform !== "win32") return;
      const call = tools.dispatch(
        "read_file",
        { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" },
        { confirmationGate: gate },
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(gateRequests).toHaveLength(1);
      gate.resolve(gate.current!.id, { type: "deny" });
      const result = await call;
      expect(result).toMatch(/user denied/);
    });

    it("loadProjectPathAllowed is independently exposed for the slash-permissions UI", () => {
      expect(loadProjectPathAllowed(root, configPath)).toEqual([]);
    });
  });
});

describe("image-format", () => {
  /** A real, valid PNG generated by jimp (avoids hand-rolled base64 mistakes). */
  async function makePng(): Promise<Buffer> {
    const img = new Jimp({ width: 4, height: 4, color: 0x00ff00ff });
    return img.getBuffer("image/png");
  }

  /** A real, valid PNG with translucent pixels (alpha must keep it PNG). */
  async function makeAlphaPng(): Promise<Buffer> {
    const img = new Jimp({ width: 4, height: 4, color: 0x00ff0080 });
    return img.getBuffer("image/png");
  }

  /** A real, valid JPEG generated by jimp. */
  async function makeJpeg(): Promise<Buffer> {
    const img = new Jimp({ width: 4, height: 4, color: 0x0000ffff });
    return img.getBuffer("image/jpeg", { quality: 90 });
  }

  describe("sniffImageFormat", () => {
    it("detects PNG, JPEG, GIF and WebP from magic bytes", async () => {
      const png = await makePng();
      expect(sniffImageFormat(png)).toBe("png");
      const jpeg = await makeJpeg();
      expect(sniffImageFormat(jpeg)).toBe("jpeg");
      expect(sniffImageFormat(Buffer.from("GIF89a....", "utf8"))).toBe("gif");
      const webp = Buffer.concat([Buffer.from("RIFFxxxxWEBP", "utf8"), Buffer.alloc(8)]);
      expect(sniffImageFormat(webp)).toBe("webp");
    });

    it("returns undefined for non-raster / empty input", () => {
      expect(sniffImageFormat(Buffer.from("hello world", "utf8"))).toBeUndefined();
      expect(sniffImageFormat(Buffer.alloc(0))).toBeUndefined();
    });
  });

  /** Build a minimal RIFF/WEBP container with the given top-level chunks. The
   *  bytes only need to be structurally correct for the sniff + animation walker
   *  (no real pixels — jimp can't produce WebP anyway). */
  function makeWebp(chunks: Array<{ fourcc: string; payload: Buffer }>): Buffer {
    const body = Buffer.concat(
      chunks.map((c) => {
        const size = Buffer.alloc(4);
        size.writeUInt32LE(c.payload.length, 0);
        const pad = c.payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
        return Buffer.concat([Buffer.from(c.fourcc, "ascii"), size, c.payload, pad]);
      }),
    );
    const riffSize = Buffer.alloc(4);
    riffSize.writeUInt32LE(body.length, 0);
    return Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      riffSize,
      Buffer.from("WEBP", "ascii"),
      body,
    ]);
  }

  const STATIC_WEBP = makeWebp([{ fourcc: "VP8 ", payload: Buffer.alloc(8) }]);
  const STATIC_WEBP_EXTENDED = makeWebp([{ fourcc: "VP8X", payload: Buffer.alloc(10) }]);
  // Synthetic animated container (structurally correct, garbage pixels) — enough
  // to exercise the animation detector, but not decodable by any image lib.
  const ANIMATED_WEBP = makeWebp([
    { fourcc: "VP8X", payload: Buffer.alloc(10) },
    { fourcc: "ANIM", payload: Buffer.alloc(6) },
    { fourcc: "ANMF", payload: Buffer.alloc(16) },
  ]);
  // A real 2-frame animated WebP (generated by Pillow) — sharp must decode the
  // first frame from this.
  const REAL_ANIMATED_WEBP = Buffer.from(
    "UklGRsoAAABXRUJQVlA4WAoAAAACAAAAAwAAAwAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAMAAAMAAGQAAAJWUDggMgAAADABAJ0BKgQABAABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkwAAAAAAAAAAAADAAADAABkAAAAVlA4IDQAAAA0AQCdASoEAAQAAAAmJaAAA3AA/ukiH//3nz//ufP/+58/6M///yn7//I4//8jj/5QIAAA",
    "base64",
  );
  // A real single-frame (static) WebP (generated by Pillow) — must also convert
  // to PNG, since the vision API rejects WebP regardless of animation.
  const REAL_STATIC_WEBP = Buffer.from(
    "UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoIAAgAAUAmJZQCdAFAAAD+/DeBV/fU6D4r4AAA",
    "base64",
  );

  describe("isAnimatedWebp", () => {
    it("flags an animated WebP (ANIM / ANMF chunks) as animated", () => {
      expect(sniffImageFormat(ANIMATED_WEBP)).toBe("webp");
      expect(isAnimatedWebp(ANIMATED_WEBP)).toBe(true);
    });

    it("treats a lone lossy / lossless / extended WebP as static", () => {
      expect(isAnimatedWebp(STATIC_WEBP)).toBe(false);
      expect(isAnimatedWebp(STATIC_WEBP_EXTENDED)).toBe(false);
    });

    it("is false for non-WebP input", () => {
      expect(isAnimatedWebp(Buffer.from("hello", "ascii"))).toBe(false);
      expect(isAnimatedWebp(Buffer.alloc(0))).toBe(false);
    });
  });

  describe("normalizeImageToDataUrls", () => {
    it("re-encodes an opaque PNG as JPEG so lossless bytes don't bloat the payload", async () => {
      const png = await makePng();
      const res = await normalizeImageToDataUrls(png);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.mime).toBe("image/jpeg");
      expect(res.dataUrls).toHaveLength(1);
      const url = res.dataUrls[0]!;
      expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
      // Round-trip: the data URL must decode back to a sniffable JPEG.
      const decoded = Buffer.from(url.split(",")[1]!, "base64");
      expect(sniffImageFormat(decoded)).toBe("jpeg");
    });

    it("keeps a translucent PNG as PNG (JPEG carries no alpha)", async () => {
      const res = await normalizeImageToDataUrls(await makeAlphaPng());
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.mime).toBe("image/png");
      expect(res.dataUrls[0]!.startsWith("data:image/png;base64,")).toBe(true);
    });

    it("passes through an already-valid JPEG without re-encoding", async () => {
      const jpeg = await makeJpeg();
      const res = await normalizeImageToDataUrls(jpeg);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.mime).toBe("image/jpeg");
      expect(res.dataUrls[0]!.startsWith("data:image/jpeg;base64,")).toBe(true);
    });

    it("converts a real static WebP into an accepted opaque format (renamed .png still sniffed as webp)", async () => {
      const res = await normalizeImageToDataUrls(REAL_STATIC_WEBP);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.mime === "image/jpeg" || res.mime === "image/png").toBe(true);
      const decoded = Buffer.from(res.dataUrls[0]!.split(",")[1]!, "base64");
      expect(sniffImageFormat(decoded)).toBe(res.mime === "image/jpeg" ? "jpeg" : "png");
    });

    it("falls back to an error when a WebP can't be decoded", async () => {
      // Structurally-webp bytes with no decodable pixels.
      const webp = Buffer.concat([Buffer.from("RIFFxxxxWEBP", "utf8"), Buffer.alloc(8)]);
      const res = await normalizeImageToDataUrls(webp);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toMatch(/WebP could not be decoded/i);
    });

    it("extracts the first frame of a real animated WebP into an accepted format", async () => {
      const res = await normalizeImageToDataUrls(REAL_ANIMATED_WEBP);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.mime === "image/jpeg" || res.mime === "image/png").toBe(true);
      const decoded = Buffer.from(res.dataUrls[0]!.split(",")[1]!, "base64");
      expect(sniffImageFormat(decoded)).toBe(res.mime === "image/jpeg" ? "jpeg" : "png");
    });

    it("falls back to an error when an animated WebP can't be decoded", async () => {
      // Synthetic container with garbage frame pixels — sharp can't decode it.
      const res = await normalizeImageToDataUrls(ANIMATED_WEBP);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toMatch(/WebP could not be decoded/i);
    });

    it("rejects garbage bytes with an error instead of shipping them", async () => {
      const res = await normalizeImageToDataUrls(Buffer.from("definitely not an image", "utf8"));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toMatch(/not a decodable image|image is empty/);
    });

    it("rejects empty input", async () => {
      const res = await normalizeImageToDataUrls(Buffer.alloc(0));
      expect(res.ok).toBe(false);
    });

    it("splits an image taller than the vision cap into accepted tiles", async () => {
      // DeepSeek 400s on any side above 8192; a full-page screenshot can exceed it.
      // Only the over-cap height matters to the assertion, so a narrow fixture keeps
      // the pure-JS PNG codec fast (same trick as the within-cap test below).
      const img = new Jimp({ width: 16, height: MAX_VISION_DIMENSION + 2000, color: 0x3366ccff });
      const png = await img.getBuffer("image/png");
      const res = await normalizeImageToDataUrls(png);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.dataUrls.length).toBeGreaterThanOrEqual(2);
      for (const url of res.dataUrls) {
        const decoded = Buffer.from(url.split(",")[1]!, "base64");
        const tile = await Jimp.fromBuffer(decoded);
        expect(Math.max(tile.width, tile.height)).toBeLessThanOrEqual(MAX_VISION_DIMENSION);
      }
    });

    it("keeps a within-cap image as a single data URL", async () => {
      // Size is irrelevant to the assertion (any within-cap image passes through
      // un-tiled), so a small fixture keeps the pure-JS PNG encode fast.
      const img = new Jimp({ width: 1024, height: 1024, color: 0x3366ccff });
      const png = await img.getBuffer("image/png");
      const res = await normalizeImageToDataUrls(png);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.dataUrls).toHaveLength(1);
    });
  });
});

// Payload-too-large heal: detection regex + in-place log image shrink,
// *  plus the send-time image retention window.
describe("image-retry", () => {
  function imgPart(n: number) {
    // 1x1 PNG, uniquely padded per index so replacement is observable.
    const pngBase =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    return {
      type: "image_url" as const,
      image_url: { url: `data:image/png;base64,${n}${pngBase.slice(1)}`, detail: "low" as const },
    };
  }

  function textPart(text: string) {
    return { type: "text" as const, text };
  }

  describe("isPayloadTooLargeError", () => {
    it("matches Ollama's daemon body-too-large text", () => {
      expect(
        isPayloadTooLargeError(new Error('Ollama 400: {"error":"http: request body too large"}')),
      ).toBe(true);
    });

    it("matches generic payload/entity phrasing", () => {
      expect(isPayloadTooLargeError(new Error("Upstream 413: Payload Too Large"))).toBe(true);
      expect(isPayloadTooLargeError(new Error("Upstream 413: Request Entity Too Large"))).toBe(
        true,
      );
    });

    it("matches the Anthropic-style image count cap relayed by OpenCode", () => {
      expect(
        isPayloadTooLargeError(
          new Error(
            "Upstream request failed: [invalid_request_error] Too many images in request: 67 > 64. Check parameters and tool schema.",
          ),
        ),
      ).toBe(true);
    });

    it("does not match unrelated errors", () => {
      expect(isPayloadTooLargeError(new Error("Ollama 400: model not found"))).toBe(false);
      expect(isPayloadTooLargeError(new Error("fetch failed"))).toBe(false);
      expect(isPayloadTooLargeError("not an error instance")).toBe(false);
    });
  });

  describe("shrinkImagePartsForRetry", () => {
    it("replaces undecodable image parts at level 1 without dropping any", async () => {
      const msg: ChatMessage = {
        role: "user",
        content: [textPart("look"), imgPart(1), imgPart(2)],
      };
      const res = await shrinkImagePartsForRetry([msg], 1);
      expect(res.dropped).toBe(0);
      expect(res.changed).toBe(false);
    });

    it("level 2 keeps only the newest image and marks older ones dropped", async () => {
      const msg: ChatMessage = {
        role: "user",
        content: [imgPart(1), textPart("between"), imgPart(2), imgPart(3)],
      };
      const res = await shrinkImagePartsForRetry([msg], 2);
      expect(res.dropped).toBe(2);
      const content = msg.content as Array<{ type: string; text?: string }>;
      expect(content).toHaveLength(4);
      expect(content[0]!.type).toBe("text");
      expect(content[0]!.text).toMatch(/image removed/);
      expect(content[1]!.type).toBe("text");
      expect(content[2]!.type).toBe("text");
      expect(content[3]!.type).toBe("image_url");
    });

    it("leaves plain-string content untouched", async () => {
      const msg: ChatMessage = { role: "user", content: "just text" };
      const res = await shrinkImagePartsForRetry([msg], 2);
      expect(res.changed).toBe(false);
      expect(msg.content).toBe("just text");
    });

    it("level 2 keeps the globally newest image across messages, not one per message", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: [imgPart(1), textPart("a")] },
        { role: "assistant", content: "b" },
        { role: "user", content: [textPart("c"), imgPart(2), imgPart(3)] },
      ];
      const res = await shrinkImagePartsForRetry(messages, 2);
      expect(res.dropped).toBe(2);
      // The survivor's data URL here is not decodable, so downscale leaves it
      // untouched — assert it stays an image part rather than counting shrinks.
      expect(res.shrunk).toBe(0);
      const first = messages[0]!.content as Array<{ type: string; text?: string }>;
      expect(first[0]!.type).toBe("text");
      expect(first[0]!.text).toMatch(/image removed/);
      expect(first[1]!.type).toBe("text");
      const last = messages[2]!.content as Array<{ type: string; text?: string }>;
      expect(last[1]!.type).toBe("text");
      expect(last[1]!.text).toMatch(/image removed/);
      expect(last[2]!.type).toBe("image_url");
    });
  });

  describe("pruneOldImageParts (send-time retention window)", () => {
    function msgWithImages(role: ChatMessage["role"], ...urls: string[]): ChatMessage {
      return {
        role,
        content: urls.map((url) => ({
          type: "image_url" as const,
          image_url: { url, detail: "low" as const },
        })),
      };
    }

    it("keeps only the newest KEEP_LAST_IMAGES image parts across messages", () => {
      const messages: ChatMessage[] = [
        msgWithImages("user", "img-1", "img-2"),
        { role: "assistant", content: "hi" },
        msgWithImages("user", "img-3", "img-4", "img-5"),
        msgWithImages("user", "img-6"),
      ];
      const pruned = pruneOldImageParts(messages, KEEP_LAST_IMAGES);
      const sent = pruned
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((p) => p.type === "image_url");
      expect(sent).toHaveLength(4);
      expect(sent.map((p) => (p as { image_url: { url: string } }).image_url.url)).toEqual([
        "img-3",
        "img-4",
        "img-5",
        "img-6",
      ]);
    });

    it("replaces pruned parts with a text note, preserving surrounding parts", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            textPart("before"),
            imgPart(1),
            textPart("middle"),
            imgPart(2),
            textPart("after"),
          ],
        },
      ];
      const pruned = pruneOldImageParts(messages, 1);
      const content = pruned[0]!.content as Array<{ type: string; text?: string }>;
      expect(content).toHaveLength(5);
      expect(content[0]!.text).toBe("before");
      expect(content[1]!.type).toBe("text");
      expect(content[1]!.text).toMatch(/image pruned/);
      expect(content[3]!.type).toBe("image_url");
      expect(content[4]!.text).toBe("after");
    });

    it("does not mutate the input messages", () => {
      const messages: ChatMessage[] = [msgWithImages("user", "img-1", "img-2", "img-3")];
      const snapshot = JSON.stringify(messages);
      pruneOldImageParts(messages, 1);
      expect(JSON.stringify(messages)).toBe(snapshot);
    });

    it("returns the input unchanged when under the window or keep <= 0", () => {
      const under = [msgWithImages("user", "img-1", "img-2")];
      const underPruned = pruneOldImageParts(under, 4);
      expect(underPruned).toBe(under);

      const over = [msgWithImages("user", "img-1", "img-2")];
      const disabled = pruneOldImageParts(over, 0);
      expect(disabled).not.toBe(over);
      expect(disabled[0]!.content).toEqual(over[0]!.content);
    });

    it("defaults the window to KEEP_LAST_IMAGES when no keep is passed", () => {
      const messages = [msgWithImages("user", ...Array.from({ length: 6 }, (_, i) => `img-${i}`))];
      const sent = pruneOldImageParts(messages)
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((p) => p.type === "image_url");
      expect(sent).toHaveLength(KEEP_LAST_IMAGES);
    });

    it("reduces an image-only message to a single placeholder, still a valid user message", () => {
      const messages: ChatMessage[] = [
        msgWithImages("user", "img-1"),
        msgWithImages("user", "img-2"),
        msgWithImages("user", "img-3"),
      ];
      const pruned = pruneOldImageParts(messages, 1);
      const first = pruned[0]!.content as Array<{ type: string; text?: string }>;
      expect(first).toHaveLength(1);
      expect(first[0]!.type).toBe("text");
      expect(first[0]!.text).toMatch(/image pruned/);
      // The newest image survives untouched, in its own message.
      const last = pruned[2]!.content as Array<{ type: string }>;
      expect(last[0]!.type).toBe("image_url");
    });

    it("returns the identical array when there are no image parts at all", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: [textPart("text only")] },
      ];
      expect(pruneOldImageParts(messages)).toBe(messages);
    });

    it("leaves non-image media parts (MiMo audio/video) untouched", () => {
      const messages: ChatMessage[] = [
        msgWithImages("user", "img-1"),
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: "data:audio/wav;base64,AAAA" } },
            { type: "video_url", video_url: { url: "data:video/mp4;base64,BBBB" } },
          ],
        },
        msgWithImages("user", "img-2"),
      ];
      const pruned = pruneOldImageParts(messages, 1);
      const media = pruned[1]!.content as Array<{ type: string }>;
      expect(media.map((p) => p.type)).toEqual(["input_audio", "video_url"]);
    });
  });
});

describe("frontmatter", () => {
  describe("parseFrontmatter", () => {
    it("parses a basic single-line frontmatter", () => {
      const { data, body } = parseFrontmatter("---\nname: foo\ndescription: bar\n---\nhello\n");
      expect(data).toEqual({ name: "foo", description: "bar" });
      expect(body).toBe("hello\n");
    });

    it("strips a UTF-8 BOM before the opening delimiter", () => {
      const raw = "\uFEFF---\ndescription: with bom\n---\nbody\n";
      const { data, body } = parseFrontmatter(raw);
      expect(data.description).toBe("with bom");
      expect(body).toBe("body\n");
    });

    it("folds indented continuation lines into the preceding key", () => {
      const raw = "---\ndescription: first line\n  second line\n  third line\n---\nbody\n";
      const { data } = parseFrontmatter(raw);
      expect(data.description).toBe("first line second line third line");
    });

    it("folds continuations onto a key whose value started empty", () => {
      const raw = "---\ndescription:\n  one\n  two\n---\nbody\n";
      const { data } = parseFrontmatter(raw);
      expect(data.description).toBe("one two");
    });

    it("strips wrapping double quotes from a value", () => {
      const { data } = parseFrontmatter('---\ndescription: "quoted text"\n---\nb\n');
      expect(data.description).toBe("quoted text");
    });

    it("strips wrapping single quotes from a value", () => {
      const { data } = parseFrontmatter("---\ndescription: 'quoted text'\n---\nb\n");
      expect(data.description).toBe("quoted text");
    });

    it("leaves mismatched or interior quotes alone", () => {
      const { data } = parseFrontmatter('---\ndescription: "starts but no end\n---\nb\n');
      expect(data.description).toBe('"starts but no end');
    });

    it("returns body unchanged when frontmatter delimiters are missing", () => {
      const raw = "no frontmatter here\njust text\n";
      const { data, body } = parseFrontmatter(raw);
      expect(data).toEqual({});
      expect(body).toBe(raw);
    });

    it("returns body unchanged when the closing delimiter is missing", () => {
      const raw = "---\ndescription: never closed\nmore text\n";
      const { data, body } = parseFrontmatter(raw);
      expect(data).toEqual({});
      expect(body).toBe(raw);
    });

    it("handles CRLF line endings", () => {
      const raw = "---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n";
      const { data } = parseFrontmatter(raw);
      expect(data).toEqual({ name: "x", description: "y" });
    });

    it("resets continuation scope across a blank line inside frontmatter", () => {
      const raw = "---\ndescription: one\n\n  two\n---\nb\n";
      const { data } = parseFrontmatter(raw);
      expect(data.description).toBe("one");
    });

    it("drops keys that would mutate Object.prototype (__proto__, constructor, prototype)", () => {
      const raw =
        "---\n__proto__: polluted\nconstructor: nope\nprototype: also-nope\nname: ok\n---\n";
      const probe = {} as Record<string, unknown>;
      const before = probe.polluted;
      const { data } = parseFrontmatter(raw);
      expect(data.name).toBe("ok");
      expect(data.__proto__).toBeUndefined();
      expect(Object.getPrototypeOf(data)).toBeNull();
      expect(probe.polluted).toBe(before);
    });
  });
});

describe("outline", () => {
  function lines(src: string): string[] {
    return src.split(/\r?\n/);
  }

  describe("extractOutline", () => {
    describe("TypeScript / JavaScript", () => {
      it("captures top-level exports with kind + name", () => {
        const src = lines(
          [
            "export function alpha() {}",
            "export class Beta {}",
            "export const gamma = 1;",
            "export interface Delta {}",
            "export type Epsilon = string;",
            "export enum Zeta { A }",
          ].join("\n"),
        );
        const out = extractOutline("foo.ts", src);
        expect(out.map((e) => e.text)).toEqual([
          "export function alpha",
          "export class Beta",
          "export const gamma",
          "export interface Delta",
          "export type Epsilon",
          "export enum Zeta",
        ]);
      });

      it("ignores indented (non-top-level) exports", () => {
        const src = lines(
          [
            "class Outer {",
            "  export function inner() {} // syntactically invalid but worth covering",
            "}",
          ].join("\n"),
        );
        expect(extractOutline("foo.ts", src)).toEqual([]);
      });

      it("handles tsx/jsx/mjs/cjs/mts/cts extensions", () => {
        const src = lines("export const x = 1;");
        for (const name of ["a.tsx", "a.jsx", "a.mjs", "a.cjs", "a.mts", "a.cts", "a.js"]) {
          const out = extractOutline(name, src);
          expect(out, name).toHaveLength(1);
          expect(out[0]!.text).toBe("export const x");
        }
      });
    });

    describe("Python", () => {
      it("captures top-level def and class", () => {
        const src = lines(
          [
            "def foo():",
            "    pass",
            "",
            "class Bar:",
            "    def method(self):",
            "        pass",
            "",
            "async def baz():",
            "    pass",
          ].join("\n"),
        );
        const out = extractOutline("a.py", src);
        expect(out).toEqual([
          { line: 1, text: "def foo" },
          { line: 4, text: "class Bar" },
          { line: 8, text: "def baz" },
        ]);
      });

      it("skips indented methods inside a class", () => {
        const src = lines("class Foo:\n    def method(self):\n        pass");
        const out = extractOutline("a.py", src);
        expect(out).toEqual([{ line: 1, text: "class Foo" }]);
      });
    });

    describe("Go", () => {
      it("captures top-level func/type/var/const", () => {
        const src = lines(
          [
            "package main",
            "",
            "func Foo() {}",
            "type Bar struct {}",
            "var Baz = 1",
            "const Qux = 2",
            "",
            "func (r *Bar) Method() {}",
          ].join("\n"),
        );
        const out = extractOutline("a.go", src);
        expect(out.map((e) => e.text)).toEqual([
          "func Foo",
          "type Bar",
          "var Baz",
          "const Qux",
          "func Method",
        ]);
      });
    });

    describe("Rust", () => {
      it("captures top-level fn, struct, enum, trait, mod, type, const, static", () => {
        const src = lines(
          [
            "pub fn foo() {}",
            "fn bar() {}",
            "struct Baz;",
            "pub struct Qux { x: i32 }",
            "enum Variant { A, B }",
            "trait MyTrait {}",
            "mod nested {}",
            "type Alias = u32;",
            "const C: u32 = 1;",
            "static S: u32 = 2;",
            "pub async unsafe fn raw() {}",
          ].join("\n"),
        );
        const out = extractOutline("a.rs", src);
        expect(out.map((e) => e.text)).toEqual([
          "fn foo",
          "fn bar",
          "struct Baz",
          "struct Qux",
          "enum Variant",
          "trait MyTrait",
          "mod nested",
          "type Alias",
          "const C",
          "static S",
          "fn raw",
        ]);
      });

      it("captures impl blocks with their target type", () => {
        const src = lines(
          [
            "impl Foo {",
            "  pub fn new() -> Self {}",
            "}",
            "impl<T> Bar<T> {}",
            "impl Display for Foo {}",
          ].join("\n"),
        );
        const out = extractOutline("a.rs", src);
        expect(out.map((e) => e.text)).toEqual(["impl Foo", "impl Bar", "impl Foo"]);
      });
    });

    describe("Markdown", () => {
      it("captures headings at all levels", () => {
        const src = lines(["# Top", "", "## Sub", "", "### Sub-sub", "", "#### Deeper"].join("\n"));
        const out = extractOutline("a.md", src);
        expect(out).toEqual([
          { line: 1, text: "# Top" },
          { line: 3, text: "## Sub" },
          { line: 5, text: "### Sub-sub" },
          { line: 7, text: "#### Deeper" },
        ]);
      });

      it("skips headings inside fenced code blocks", () => {
        const src = lines(
          ["# Real heading", "", "```", "# Not a heading", "```", "", "## Also real"].join("\n"),
        );
        const out = extractOutline("a.md", src);
        expect(out).toEqual([
          { line: 1, text: "# Real heading" },
          { line: 7, text: "## Also real" },
        ]);
      });
    });

    describe("Protobuf", () => {
      it("captures top-level message / service / enum + nested rpc", () => {
        const src = lines(
          [
            'syntax = "proto3";',
            "package demo;",
            "",
            "message User {",
            "  string id = 1;",
            "}",
            "",
            "enum Status { OK = 0; }",
            "",
            "service Accounts {",
            "  rpc Get(GetReq) returns (User);",
            "  rpc List(ListReq) returns (ListResp);",
            "}",
          ].join("\n"),
        );
        const out = extractOutline("demo.proto", src);
        expect(out.map((e) => e.text)).toEqual([
          "message User",
          "enum Status",
          "service Accounts",
          "rpc Get",
          "rpc List",
        ]);
      });
    });

    describe("Plain text — novel / document chapter markers", () => {
      it("captures Chinese chapter, volume, prologue markers", () => {
        const src = lines(
          ["楔子", "今天天气不错。", "第一章 启程", "故事开始。", "卷二 江湖", "另一段。"].join(
            "\n",
          ),
        );
        const out = extractOutline("novel.txt", src);
        expect(out.map((e) => e.text)).toEqual(["楔子", "第一章 启程", "卷二 江湖"]);
      });

      it("captures English Chapter / Part markers", () => {
        const src = lines(
          [
            "Some intro.",
            "Chapter 1 The Beginning",
            "body.",
            "Part II Aftermath",
            "more body.",
          ].join("\n"),
        );
        const out = extractOutline("story.txt", src);
        expect(out.map((e) => e.text)).toEqual(["Chapter 1 The Beginning", "Part II Aftermath"]);
      });

      it("ignores prose lines that don't match a chapter pattern", () => {
        const src = lines(
          ["just some regular text", "another paragraph", "no chapters here"].join("\n"),
        );
        expect(extractOutline("plain.txt", src)).toEqual([]);
      });
    });

    describe("unknown extensions", () => {
      it("returns empty outline for unsupported file types", () => {
        const src = lines("function not_recognized() {}");
        expect(extractOutline("a.yml", src)).toEqual([]);
        expect(extractOutline("Makefile", src)).toEqual([]);
      });
    });
  });

  describe("formatOutline", () => {
    it("returns empty string for empty entries", () => {
      expect(formatOutline([])).toBe("");
    });

    it("formats single-entry outline without elision", () => {
      const result = formatOutline([{ line: 5, text: "def foo" }]);
      expect(result).toBe("[outline: 1 symbol]\n  L5  def foo");
    });

    it("singularises header for one entry, pluralises otherwise", () => {
      expect(formatOutline([{ line: 1, text: "a" }])).toMatch(/^\[outline: 1 symbol\]/);
      expect(
        formatOutline([
          { line: 1, text: "a" },
          { line: 2, text: "b" },
        ]),
      ).toMatch(/^\[outline: 2 symbols\]/);
    });

    it("right-pads line numbers to the widest entry", () => {
      const result = formatOutline([
        { line: 5, text: "a" },
        { line: 123, text: "b" },
      ]);
      // 'L  5' aligned under 'L123' — pad is to 3-wide.
      expect(result).toContain("L  5  a");
      expect(result).toContain("L123  b");
    });

    it("elides middle entries when over the 30-entry cap", () => {
      const entries = Array.from({ length: 35 }, (_, i) => ({
        line: i + 1,
        text: `sym${i + 1}`,
      }));
      const result = formatOutline(entries);
      expect(result).toMatch(/^\[outline: 35 symbols\]/);
      expect(result).toContain("sym1");
      expect(result).toContain("sym25");
      expect(result).not.toContain("sym26");
      expect(result).not.toContain("sym30");
      expect(result).toContain("sym31");
      expect(result).toContain("sym35");
      expect(result).toContain("[… 5 more symbols between L25 and L31 …]");
    });
  });
});
