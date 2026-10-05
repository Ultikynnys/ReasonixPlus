/** Tree-sitter parser singleton + bundled grammar registry. */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Tree } from "web-tree-sitter";
import { type GrammarName, grammarForPath } from "./grammar-map.js";

export { type GrammarName, grammarForPath } from "./grammar-map.js";

const localRequire = createRequire(import.meta.url);

function resolveRuntimeWasmPath(): string {
  const filename = "web-tree-sitter.wasm";
  const candidates = [
    // Production builds copy this asset beside the bundled grammars. The
    // parser can be emitted under dist/ or dist/cli/, so check both layouts.
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "grammars", filename),
    resolve(dirname(fileURLToPath(import.meta.url)), "grammars", filename),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return localRequire.resolve("web-tree-sitter/web-tree-sitter.wasm");
  } catch {
    throw new Error(
      `web-tree-sitter runtime not found. Looked in: ${candidates.join(", ")} and the installed web-tree-sitter package`,
    );
  }
}

let parserInitPromise: Promise<void> | null = null;
const languageCache = new Map<GrammarName, Promise<Language>>();

export async function getParser(grammar: GrammarName): Promise<Parser> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init({
      locateFile: (name: string) =>
        name === "web-tree-sitter.wasm" ? resolveRuntimeWasmPath() : name,
    });
  }
  await parserInitPromise;
  const language = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

export async function parseSource(
  filePath: string,
  source: string,
): Promise<{ grammar: GrammarName; tree: Tree; language: Language | null } | null> {
  const grammar = grammarForPath(filePath);
  if (!grammar) return null;
  const parser = await getParser(grammar);
  const language = parser.language;
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) return null;
  return { grammar, tree, language };
}

function loadLanguage(grammar: GrammarName): Promise<Language> {
  const cached = languageCache.get(grammar);
  if (cached) return cached;
  const wasmPath = resolveGrammarPath(grammar);
  const bytes = readFileSync(wasmPath);
  const promise = Language.load(new Uint8Array(bytes));
  languageCache.set(grammar, promise);
  return promise;
}

function resolveGrammarPath(grammar: GrammarName): string {
  const filename = `tree-sitter-${grammar}.wasm`;
  const candidates: string[] = [];
  candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "..", "grammars", filename));
  candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "grammars", filename));
  for (const pkg of DEV_PACKAGE_FOR_GRAMMAR[grammar]) {
    try {
      candidates.push(resolve(dirname(localRequire.resolve(`${pkg}/package.json`)), filename));
    } catch {
      /* dev-only grammar package not installed — fine in production builds */
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`tree-sitter grammar ${grammar} not found. Looked in: ${candidates.join(", ")}`);
}

const DEV_PACKAGE_FOR_GRAMMAR: Record<GrammarName, string[]> = {
  typescript: ["tree-sitter-typescript"],
  tsx: ["tree-sitter-typescript"],
  javascript: ["tree-sitter-javascript"],
  python: ["tree-sitter-python"],
  go: ["tree-sitter-go"],
  rust: ["tree-sitter-rust"],
  java: ["tree-sitter-java"],
};
