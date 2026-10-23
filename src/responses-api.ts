/** OpenAI Responses API (v1/responses) conversion for chatgpt.com's codex
 *  backend, which 400-rejects chat-completions payloads. */

import { stripProviderQualifier } from "@reasonix/core-utils";
import type { ReasoningControl } from "./reasoning-control.js";
import { sanitizeWireToolName } from "./tool-name.js";
import type { ChatMessage, ChatRequestOptions } from "./types.js";

export interface ResponsesInputItem {
  type: string;
  [k: string]: unknown;
}

// Build the `content` field for a Responses API message: plain string for
// text-only (bypasses the type enum — works across backend deployments that
// disagree on input_text vs output_text), array for mixed text+image content.
function contentParts(content: ChatMessage["content"]): string | ResponsesInputItem[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content; // plain string — safest across backends
  // If the array has no images, join the text parts into a single string.
  if (content.every((p) => p.type === "text")) {
    const textParts: string[] = [];
    for (const part of content) {
      if (part.type === "text" && part.text) textParts.push(part.text);
    }
    return textParts.join("\n");
  }
  // Mixed content — use input_text / input_image parts.
  const parts: ResponsesInputItem[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) parts.push({ type: "input_text", text: part.text });
    } else if (part.type === "image_url") {
      // Responses input_image takes the URL as a bare string (chat
      // completions wraps it in { url, detail }).
      parts.push({
        type: "input_image",
        image_url: part.image_url.url,
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
      });
    }
    // Generated-image parts (type === "image") are output-side only and are
    // not re-sent as input in the Responses API path.
  }
  return parts;
}

/** Split messages: leading system text → top-level `instructions` (like the
 *  Codex CLI), the rest → `input` items (system becomes developer role). */
function splitMessages(messages: ChatMessage[]): {
  instructions: string;
  items: ResponsesInputItem[];
} {
  const systemTexts: string[] = [];
  const items: ResponsesInputItem[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system": {
        if (items.length === 0 && typeof m.content === "string") {
          systemTexts.push(m.content);
        } else {
          // Always send content (even empty) — the wire schema requires it.
          items.push({ type: "message", role: "developer", content: contentParts(m.content) });
        }
        break;
      }
      case "user": {
        items.push({ type: "message", role: "user", content: contentParts(m.content) });
        break;
      }
      case "assistant": {
        items.push({
          type: "message",
          role: "assistant",
          content: contentParts(m.content),
        });
        for (const tc of m.tool_calls ?? []) {
          items.push({
            type: "function_call",
            call_id: tc.id ?? "",
            name: sanitizeWireToolName(tc.function.name ?? ""),
            arguments: tc.function.arguments ?? "",
          });
        }
        break;
      }
      case "tool": {
        items.push({
          type: "function_call_output",
          call_id: m.tool_call_id ?? "",
          output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        });
        break;
      }
    }
  }
  return { instructions: systemTexts.join("\n\n"), items };
}

/** Per-request extras a caller declares. Both are omitted when unset, so a wire
 *  that rejects them never sees one. */
export interface ResponsesExtras {
  /** Session-stable cache hint. */
  cacheKey?: string;
  /** Request-level burst gate; unset leaves the provider default. */
  parallelToolCalls?: boolean;
}

/** Chat-completions -> Responses payload (mirrors the Codex CLI). Chat-completions-only
 *  fields are omitted because the endpoint 400s unknowns. `extras` carries the
 *  declared request additions; every one stays absent unless the caller sets it. */
export function buildResponsesPayload(
  opts: ChatRequestOptions,
  stream: boolean,
  provider?: string,
  control?: ReasoningControl,
  extras: ResponsesExtras = {},
): Record<string, unknown> {
  const { instructions, items } = splitMessages(opts.messages);
  // MiMo's Responses implementation rejects unknown fields, so the Codex-only
  // extras (store, parallel_tool_calls, reasoning.summary) are omitted for it.
  const mimo = provider === "mimo";
  const payload: Record<string, unknown> = {
    model: stripProviderQualifier(opts.model),
    input: items,
    stream,
  };
  // Codex always sends store:false; the declared request extras ride only when set.
  if (!mimo) payload.store = false;
  if (extras.parallelToolCalls !== undefined) {
    payload.parallel_tool_calls = extras.parallelToolCalls;
  }
  if (instructions) payload.instructions = instructions;
  // Responses spelling of the output cap. Absent stays absent: an unconfigured
  // cap must not become a model default the user never chose.
  if (opts.maxTokens !== undefined) payload.max_output_tokens = opts.maxTokens;
  if (extras.cacheKey) payload.prompt_cache_key = extras.cacheKey;
  if (opts.tools?.length) {
    payload.tools = opts.tools.map((t) => ({
      type: "function",
      name: sanitizeWireToolName(t.function.name),
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }
  if (control?.effort) {
    // Responses nests effort under `reasoning`; `summary: "concise"` mirrors
    // the Codex CLI so reasoning summaries stream back to the UI.
    payload.reasoning = mimo
      ? { effort: control.effort }
      : { effort: control.effort, summary: "concise" };
  } else if (mimo && control?.thinking === "disabled") {
    // MiMo's Responses effort enum differentiates only on/off: `none` disables
    // reasoning; omitting `reasoning` leaves MiMo's default (enabled).
    payload.reasoning = { effort: "none" };
  }
  return payload;
}
