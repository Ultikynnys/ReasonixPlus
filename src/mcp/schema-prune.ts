/** Prune and compress MCP tool schemas for model consumption. */

import type { JSONSchema } from "../types.js";

export interface SchemaPruneOptions {
  /** Maximum length for property descriptions. Defaults to 160 characters. */
  maxDescriptionLength?: number;
  /** Strip non-required fields marked read-only or described as read-only. Default true. */
  stripReadOnly?: boolean;
  /** Strip internal metadata bags like extended properties and headers. Default true. */
  stripMetadataBags?: boolean;
  /** Strip empty object stubs with zero schema constraints. Default true. */
  stripEmptyObjects?: boolean;
  /** Maximum nesting depth for schema traversal. Default 6. */
  maxDepth?: number;
}

const DEFAULT_MAX_DESCRIPTION_LENGTH = 160;
const DEFAULT_MAX_DEPTH = 6;

const METADATA_BAG_PATTERN = /(?:ExtendedProperties|internetMessageHeaders)$/i;

const CHILD_COLLECTION_NAMES = new Set(["messageRules", "messages", "childFolders"]);

/** Truncate a description to a concise first sentence or length cap. */
export function compactDescription(desc: string, maxLen = DEFAULT_MAX_DESCRIPTION_LENGTH): string {
  const trimmed = desc.trim();
  if (trimmed.length <= maxLen) return trimmed;

  // Prefer first sentence if it ends early enough.
  const match = trimmed.match(/^([^.!?\n]+[.!?])(?:\s|\n|$)/);
  if (match?.[1] && match[1].length <= maxLen) {
    return match[1].trim();
  }

  return `${trimmed.slice(0, maxLen - 3).trimEnd()}...`;
}

function isPlainEmptyObject(val: unknown): boolean {
  return (
    typeof val === "object" && val !== null && !Array.isArray(val) && Object.keys(val).length === 0
  );
}

function isReadOnlyProperty(prop: JSONSchema): boolean {
  if (prop.readOnly === true) return true;
  if (typeof prop.description === "string" && /\bRead-only\b/i.test(prop.description)) {
    return true;
  }
  return false;
}

/** A bridged tool's own description ships in every request: keep its first sentence. */
export const MAX_TOOL_DESCRIPTION_CHARS = 240;

/** Keywords that never change how a model fills an argument. `pattern` is a
 *  serialized validator (ISO-8601 regexes run 250+ chars) and `format` survives instead. */
const SCHEMA_VALUE_NOISE = new Set([
  "$schema",
  "$id",
  "$comment",
  "examples",
  "default",
  "title",
  "pattern",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const DEFAULT_DESCRIPTION_DEPTH_LIMIT = 1;
const DEFAULT_CONDENSED_DESCRIPTION_LENGTH = 120;
const DEFAULT_COLLAPSE_OBJECT_DEPTH = 2;
/** Prefix marking a collapsed field map, so re-condensing keeps it at any depth. */
const FIELD_MAP_PREFIX = "fields: ";
/** Recursion guard; a real tool schema bottoms out far above it. */
const MAX_CONDENSE_DEPTH = 32;

export interface SchemaCondenseOptions {
  /** Keep `description` only down to this property level. Default 1: top-level parameters only. */
  descriptionDepthLimit?: number;
  /** Cap for the descriptions that survive. Defaults to 120 characters. */
  maxDescriptionLength?: number;
  /** Objects nested at or below this level collapse into a one-line field map. Default 2:
   *  top-level parameters keep their schema, the entities inside them are summarized. */
  collapseObjectDepth?: number;
}

function isNullBranch(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "null"
  );
}

/** Collapse `anyOf`/`oneOf` null wrappers and `["x","null"]` type arrays: Graph emits both
 *  for every nullable field, and the null branch repeats the parent's own docs. */
function withoutNullableWrapper(schema: Record<string, unknown>): Record<string, unknown> {
  const unionKey = Array.isArray(schema.anyOf)
    ? "anyOf"
    : Array.isArray(schema.oneOf)
      ? "oneOf"
      : null;
  if (unionKey) {
    const branches = schema[unionKey] as unknown[];
    const kept = branches.filter((branch) => !isNullBranch(branch));
    if (kept.length === 1 && kept.length < branches.length) {
      const merged: Record<string, unknown> = { ...(kept[0] as Record<string, unknown>) };
      for (const [key, value] of Object.entries(schema)) {
        if (key !== unionKey) merged[key] = value;
      }
      return merged;
    }
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type) => type !== "null");
    if (types.length > 0 && types.length < schema.type.length) {
      return { ...schema, type: types.length === 1 ? types[0] : types };
    }
  }
  return schema;
}

/** One-line field map for a collapsed object: names, `*` required, `[]` array, `{}` object,
 *  `(a|b)` enum. Keeps what a caller must produce without resending the sub-schema. */
function summarizeObjectFields(node: Record<string, unknown>): string | null {
  const props = node.properties;
  if (!props || typeof props !== "object") return null;
  const names = Object.keys(props as Record<string, unknown>).sort();
  if (names.length === 0) return null;
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const parts = names.map((name) => {
    const prop = (props as Record<string, JSONSchema>)[name] as Record<string, unknown>;
    const type =
      typeof prop.type === "string"
        ? prop.type
        : Array.isArray(prop.type)
          ? prop.type.join("|")
          : "";
    const shape = type === "array" ? "[]" : prop.properties ? "{}" : "";
    const values = Array.isArray(prop.enum) ? `(${prop.enum.join("|")})` : "";
    return `${name}${required.has(name) ? "*" : ""}${shape}${values}`;
  });
  return `${FIELD_MAP_PREFIX}${parts.join(", ")}`;
}

/** Condense a bridged tool schema without dropping a field: null wrappers and value noise go,
 *  and nested entities collapse into a one-line field map so a shape repeated across tools
 *  costs one line each. Deterministic idempotent, so re-canonicalizing never churns the prefix. */
export function condenseMcpSchema(
  schema: JSONSchema | undefined,
  opts: SchemaCondenseOptions = {},
  depth = 0,
): JSONSchema {
  if (!schema || typeof schema !== "object" || depth > MAX_CONDENSE_DEPTH) {
    return (schema ?? {}) as JSONSchema;
  }
  const descriptionDepthLimit = opts.descriptionDepthLimit ?? DEFAULT_DESCRIPTION_DEPTH_LIMIT;
  const maxLen = opts.maxDescriptionLength ?? DEFAULT_CONDENSED_DESCRIPTION_LENGTH;
  const collapseObjectDepth = opts.collapseObjectDepth ?? DEFAULT_COLLAPSE_OBJECT_DEPTH;
  const source = withoutNullableWrapper(schema as Record<string, unknown>);
  if (depth >= collapseObjectDepth) {
    const fields = summarizeObjectFields(source);
    if (fields) return { type: "object", description: fields } as JSONSchema;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (SCHEMA_VALUE_NOISE.has(key)) continue;
    if (key === "additionalProperties" && value === true) continue;
    if (key === "description" && typeof value === "string") {
      // A field map is already the condensation; compacting it would cut the field list.
      if (value.startsWith(FIELD_MAP_PREFIX)) {
        out.description = value;
        continue;
      }
      if (depth > descriptionDepthLimit) continue;
      out.description = compactDescription(value, maxLen);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object"
          ? condenseMcpSchema(item as JSONSchema, opts, depth + 1)
          : item,
      );
      continue;
    }
    if (value && typeof value === "object") {
      if (key === "properties") {
        const props: Record<string, JSONSchema> = {};
        for (const [name, prop] of Object.entries(value as Record<string, JSONSchema>)) {
          props[name] = condenseMcpSchema(prop, opts, depth + 1);
        }
        out.properties = props;
      } else {
        out[key] = condenseMcpSchema(value as JSONSchema, opts, depth + 1);
      }
      continue;
    }
    out[key] = value;
  }
  return out as JSONSchema;
}

/** Recursively prune and compress a JSON Schema for model consumption. */
export function pruneMcpToolSchema(
  schema: JSONSchema | undefined,
  opts: SchemaPruneOptions = {},
  depth = 0,
): JSONSchema {
  if (!schema || typeof schema !== "object") {
    return (schema ?? {}) as JSONSchema;
  }

  const maxLen = opts.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const stripReadOnly = opts.stripReadOnly !== false;
  const stripMetadataBags = opts.stripMetadataBags !== false;
  const stripEmptyObjects = opts.stripEmptyObjects !== false;

  if (depth > maxDepth) {
    return schema;
  }

  const out: Record<string, unknown> = {};
  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);

  for (const [key, val] of Object.entries(schema)) {
    // 1. Prune properties map
    if (key === "properties" && val && typeof val === "object" && !Array.isArray(val)) {
      const cleanProps: Record<string, JSONSchema> = {};
      const requiredArr = Array.isArray(schema.required) ? [...schema.required] : [];

      for (const [propName, propVal] of Object.entries(val as Record<string, JSONSchema>)) {
        if (!propVal || typeof propVal !== "object") continue;

        const isRequired = requiredSet.has(propName);

        // Never prune required properties.
        if (!isRequired) {
          // Strip empty stubs like `body.from: {}`
          if (stripEmptyObjects && isPlainEmptyObject(propVal)) {
            continue;
          }

          // Strip read-only properties
          if (stripReadOnly && isReadOnlyProperty(propVal)) {
            continue;
          }

          // Strip metadata bags like extended properties and headers
          if (stripMetadataBags && METADATA_BAG_PATTERN.test(propName)) {
            continue;
          }

          // Strip non-required heavy child collections on entities
          const basePropName = propName.split(".").pop() ?? propName;
          if (CHILD_COLLECTION_NAMES.has(basePropName)) {
            continue;
          }
        }

        cleanProps[propName] = pruneMcpToolSchema(propVal, opts, depth + 1);
      }

      out.properties = cleanProps;

      // Ensure required array only mentions properties that still exist
      if (requiredArr.length > 0) {
        const remaining = requiredArr.filter((r) => r in cleanProps);
        if (remaining.length > 0) {
          out.required = remaining;
        }
      }
      continue;
    }

    // 2. Compact descriptions (a condenser field map must survive verbatim)
    if (key === "description" && typeof val === "string") {
      out.description = val.startsWith(FIELD_MAP_PREFIX) ? val : compactDescription(val, maxLen);
      continue;
    }

    // 3. Handle array items
    if (key === "items" && val && typeof val === "object") {
      out.items = pruneMcpToolSchema(val as JSONSchema, opts, depth + 1);
      continue;
    }

    // 4. Handle union branches (anyOf, oneOf, allOf)
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(val)) {
      out[key] = val.map((item) =>
        typeof item === "object" && item !== null
          ? pruneMcpToolSchema(item as JSONSchema, opts, depth + 1)
          : item,
      );
      continue;
    }

    // Recurse on general nested objects (excluding already handled special keys)
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      out[key] = pruneMcpToolSchema(val as JSONSchema, opts, depth + 1);
    } else {
      out[key] = val;
    }
  }

  return out as JSONSchema;
}
