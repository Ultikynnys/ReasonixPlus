import { stripProviderQualifier } from "@reasonix/core-utils";

/** DeepSeek v4 models (official API or Ollama-hosted like ollama/deepseek-v4-flash:0731). */
function isDeepSeekV4ThinkingModel(model: string): boolean {
  return (
    model.includes("deepseek-flash") ||
    model.includes("deepseek-v4-flash") ||
    model.includes("deepseek-v4-pro")
  );
}

/** True when the model emits reasoning_content and requires it round-tripped on follow-ups. */
export function isThinkingModeModel(model: string): boolean {
  // Capability checks match the wire id: `opencode/<id>` and the same id bare
  // are one model on different endpoints.
  const id = stripProviderQualifier(model);
  if (id.startsWith("gpt-")) return false;
  if (id.includes("reasoner")) return true;
  if (id.startsWith("glm-")) return true;
  if (isDeepSeekV4ThinkingModel(id)) return true;
  // Ollama DeepSeek R1 models (e.g. ollama/deepseek-r1:14b, deepseek-r1:7b)
  if (id.includes("deepseek-r1")) return true;
  // Xiaomi MiMo emits reasoning_content and 400s if a tool-call turn drops it.
  if (id.startsWith("mimo-")) return true;
  return false;
}

/** Pins extra_body.thinking.type; `undefined` lets third-party endpoints skip the field. */
export function thinkingModeForModel(model: string): "enabled" | "disabled" | undefined {
  const id = stripProviderQualifier(model);
  if (id.startsWith("gpt-")) return undefined;
  if (id === "deepseek-chat") return "disabled";
  // Gemini 2.5+/3.x thinking models: opt into thought summaries so their
  // reasoning is captured (and persisted) instead of silently dropped.
  if (id.startsWith("gemini-")) return "enabled";
  if (id.startsWith("glm-")) return "enabled";
  if (id.includes("reasoner")) return "enabled";
  if (isDeepSeekV4ThinkingModel(id)) return "enabled";
  // Ollama DeepSeek R1 models (e.g. ollama/deepseek-r1:14b, deepseek-r1:8b)
  if (id.includes("deepseek-r1")) return "enabled";
  // Xiaomi MiMo: thinking is on by default and toggled via `thinking: { type }`.
  if (id.startsWith("mimo-")) return "enabled";
  return undefined;
}

/** Strip hallucinated tool-call envelopes — `tools: undefined` doesn't always force prose. */
export function stripHallucinatedToolMarkup(s: string): string {
  let out = s;
  // DeepSeek's DSML envelope (full-width "｜" is the form R1 emits in practice).
  out = out.replace(
    /<[｜|]DSML[｜|]function_calls>[\s\S]*?<\/?(?:[｜|]DSML[｜|]function_calls)?>/g,
    "",
  );
  out = out.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "");
  // Loose DSML invoke blocks without wrapping function_calls.
  out = out.replace(/<[｜|]DSML[｜|]invoke\s+[^>]*>[\s\S]*?<\/[｜|]DSML[｜|]invoke>/g, "");
  // Lone unpaired DSML opener left over after R1 truncates mid-call.
  out = out.replace(/<[｜|]DSML[｜|][\s\S]*$/g, "");
  return out.trim();
}

/** Extract literal thinking tags (`<think>...</think>`) from content if the model
 *  emitted reasoning directly into the content stream instead of the thinking channel.
 *  Returns the cleaned content and any extracted reasoning text. */
export function extractThinkingTags(content: string): {
  content: string;
  extractedReasoning: string | null;
} {
  const THINK_BLOCK_RE = /<think>([\s\S]*?)<\/think>/gi;
  const thoughts: string[] = [];
  let cleaned = content.replace(THINK_BLOCK_RE, (_, thought: string) => {
    const trimmed = thought.trim();
    if (trimmed) thoughts.push(trimmed);
    return "";
  });

  // Handle open-ended/truncated <think> at the end of content
  const UNCLOSED_THINK_RE = /<think>([\s\S]*)$/i;
  const unclosed = UNCLOSED_THINK_RE.exec(cleaned);
  if (unclosed) {
    const trimmed = unclosed[1]?.trim();
    if (trimmed) thoughts.push(trimmed);
    cleaned = cleaned.replace(UNCLOSED_THINK_RE, "");
  }

  // Also strip stray orphaned closing </think> tags
  cleaned = cleaned.replace(/<\/think>/gi, "");

  const extractedReasoning = thoughts.length > 0 ? thoughts.join("\n\n") : null;
  return {
    content: cleaned.trim(),
    extractedReasoning,
  };
}
