import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import type { CodeMatchKind, FindInCodeOptions } from "../code-query/find-in-code.js";
import { grammarForPath } from "../code-query/grammar-map.js";
import { lazy } from "../core/lazy.js";
import type { ToolRegistry } from "../tools.js";

/** web-tree-sitter is a multi-MB Emscripten runtime — defer until the model actually
 *  dispatches one of these tools so sessions that never touch code_query don't pay for it. */
const loadSymbols = lazy(() => import("../code-query/symbols.js"));
const loadFindInCode = lazy(() => import("../code-query/find-in-code.js"));

export interface CodeQueryToolOpts {
  rootDir: string;
}

const UNSUPPORTED =
  "language not supported (TS/TSX/JS/JSX/Python/Go/Rust/Java); use search_content for grep-style matching";

export function registerCodeQueryTools(registry: ToolRegistry, opts: CodeQueryToolOpts): void {
  const { rootDir } = opts;

  registry.register({
    name: "get_symbols",
    description:
      "Outline one TS/TSX/JS/JSX/Python/Go/Rust/Java file with tree-sitter. Returns top-level and nested symbols (functions, classes, methods, interfaces, types, enums, namespaces) with 1-based line/column. Ignores names inside comments and strings. Use for 'what's in this file' or 'where is X defined here'; use search_content for arbitrary text, comments, strings, or cross-file scans. Paths are project-root-relative; leading / or \\ is also treated as project-root-relative. Result: {path, symbols:[{name, kind, line, column, endLine, endColumn, parent?}]} or {path, error}.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path relative to the project root. Leading / or \\ is also treated as project-root-relative; external absolute paths are not supported.",
        },
      },
      required: ["path"],
    },
    fn: async (args: { path: string }) => {
      const filePath = resolveProjectPath(rootDir, args.path);
      if (!grammarForPath(filePath)) {
        return JSON.stringify({ path: args.path, error: UNSUPPORTED });
      }
      const source = await readFile(filePath, "utf8");
      const { extractSymbols } = await loadSymbols();
      const symbols = await extractSymbols(filePath, source);
      return JSON.stringify({ path: args.path, symbols });
    },
  });

  registry.register({
    name: "find_in_code",
    description:
      "Find an identifier `name` in one TS/TSX/JS/JSX/Python/Go/Rust/Java file using the AST. Skips comments and strings. `kind` can narrow results to 'call', 'definition', 'reference', or 'any'. This is within-file only and does not resolve cross-file references; use search_content plus reading for arbitrary text or cross-file scans. Paths are project-root-relative; leading / or \\ is also treated as project-root-relative. Result: {path, matches:[{line, column, kind, snippet}]} or {path, error}.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact identifier text to find.",
        },
        path: {
          type: "string",
          description:
            "File path relative to the project root. Leading / or \\ is also treated as project-root-relative; external absolute paths are not supported.",
        },
        kind: {
          type: "string",
          enum: ["any", "call", "definition", "reference"],
          description: "Filter by syntactic role. Default 'any'.",
        },
      },
      required: ["name", "path"],
    },
    fn: async (args: { name: string; path: string; kind?: string }) => {
      const filePath = resolveProjectPath(rootDir, args.path);
      if (!grammarForPath(filePath)) {
        return JSON.stringify({ path: args.path, error: UNSUPPORTED });
      }
      const source = await readFile(filePath, "utf8");
      const kind = (args.kind ?? "any") as CodeMatchKind | "any";
      const findOpts: FindInCodeOptions = kind === "any" ? {} : { kind };
      const { findInCode } = await loadFindInCode();
      const matches = await findInCode(filePath, source, args.name, findOpts);
      return JSON.stringify({ path: args.path, matches });
    },
  });
}

function resolveProjectPath(rootDir: string, raw: string): string {
  const stripped = raw.replace(/^[/\\]+/, "");
  return pathResolve(rootDir, stripped.length === 0 ? "." : stripped);
}
