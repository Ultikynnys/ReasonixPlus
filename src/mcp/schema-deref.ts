/** Inline JSON Schema `$ref`s (`#/$defs/…`, zod v4 MCP servers) so an MCP tool schema is
 *  self-contained; opencode's harness normalizes tool schemas the same way (packages/ai). */

import type { JSONSchema } from "../types.js";

/** Guard against pathological/cyclic ref chains; a self-referential `$defs`
 *  entry is cut to a bare node well before this. */
const MAX_REF_DEPTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a local JSON pointer (`#/$defs/x`, `#/definitions/x`, `#/a/b`) against
 *  the document root. Returns undefined for a missing segment or a non-local ref. */
function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((seg) => decodeURIComponent(seg).replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const seg of segments) {
    if (Array.isArray(current)) {
      const index = Number(seg);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      if (!Object.hasOwn(current, seg)) return undefined;
      current = current[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Walk a node, replacing every `$ref` with its resolved target. `stack` holds
 *  the refs currently being expanded so a cycle becomes a bare node instead of
 *  an infinite loop; siblings of a `$ref` win over the target's own keys. */
function inlineNode(
  node: unknown,
  root: Record<string, unknown>,
  stack: readonly string[],
  depth: number,
): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineNode(item, root, stack, depth));
  if (!isRecord(node)) return node;

  const ref = typeof node.$ref === "string" ? node.$ref : undefined;
  if (ref !== undefined) {
    const { $ref: _ref, ...siblings } = node;
    const resolvedSiblings = inlineNode(siblings, root, stack, depth) as Record<string, unknown>;
    if (stack.includes(ref) || depth >= MAX_REF_DEPTH) return resolvedSiblings;
    const target = resolvePointer(root, ref);
    // Unresolvable (external URL, missing pointer): drop the dangling `$ref`
    // rather than ship a schema the provider will reject.
    if (target === undefined) return resolvedSiblings;
    const inlined = inlineNode(target, root, [...stack, ref], depth + 1);
    return isRecord(inlined) ? { ...inlined, ...resolvedSiblings } : inlined;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = inlineNode(value, root, stack, depth);
  }
  return out;
}

/** Return a copy of `schema` with every internal `$ref` inlined and the now-dead
 *  `$defs`/`definitions` blocks removed. A root `$ref` collapses to its target,
 *  so an object-rooted result falls out naturally. */
export function derefJsonSchema(schema: JSONSchema | undefined): JSONSchema {
  if (!isRecord(schema)) return (schema ?? {}) as JSONSchema;
  const inlined = inlineNode(schema, schema, [], 0);
  if (!isRecord(inlined)) return {} as JSONSchema;
  const { $defs: _defs, definitions: _definitions, ...rest } = inlined;
  return rest as JSONSchema;
}
