import { tokensForMessage } from "../tokenizer.js";
import type { ChatMessage, ToolCall } from "../types.js";
import { messageText } from "./messages.js";

// Research-derived constants (Codex compact.rs, Gemini chatCompressionService,
// Cline basic-compaction): trigger at 0.8 of the window, settle near 0.55,
// keep the recent tail and user prompts verbatim, 8K headroom for summarizer
// output so reasoning models still return a summary.
export const AUTO_COMPACT_TRIGGER_RATIO = 0.8;
export const COMPACT_TARGET_RATIO = 0.55;
export const PRESERVE_RECENT_TOKENS = 20_000;
export const USER_RETENTION_TOKENS = 20_000;
export const SUMMARIZER_OUTPUT_HEADROOM = 8192;
export const SUMMARIZER_INPUT_MAX_TOKENS = 100_000;

export const COMPACTION_SUMMARY_PREFIX = "[COMPACT-SUMMARY]";
export const DROPPED_WORK_NOTICE_PREFIX = "[DROPPED-WORK SUMMARY]";

const TRANSCRIPT_MESSAGE_MAX_CHARS = 4_000;
const DIGEST_ENTRY_MAX_CHARS = 160;
const NOTICE_REPLY_MAX_CHARS = 300;
const NOTICE_PROMPT_MAX_CHARS = 120;

export function isCompactionSummary(m: ChatMessage): boolean {
  return messageText(m).trimStart().startsWith(COMPACTION_SUMMARY_PREFIX);
}

export function isDroppedWorkNotice(m: ChatMessage): boolean {
  return messageText(m).trimStart().startsWith(DROPPED_WORK_NOTICE_PREFIX);
}

/** The rolled-up summary body (prefix stripped) from a compacted message list, or
 *  "". Lets the compaction warning carry the same summary the fold installed. */
export function compactionSummaryBody(messages: ReadonlyArray<ChatMessage>): string {
  for (const m of messages) {
    if (!isCompactionSummary(m)) continue;
    const text = messageText(m).trimStart().slice(COMPACTION_SUMMARY_PREFIX.length).trim();
    if (text) return text;
  }
  return "";
}

/** Real user intent. Synthetic records (steers, nudges) and compaction
 *  artifacts are machine-generated and never count as prompts. */
export function isUserPrompt(m: ChatMessage): boolean {
  return m.role === "user" && !m.synthetic && messageText(m).trim().length > 0;
}

function isLegacy(m: ChatMessage): boolean {
  return isCompactionSummary(m) || isDroppedWorkNotice(m);
}

function isPlainAssistantFinal(m: ChatMessage): boolean {
  return (
    m.role === "assistant" &&
    (!m.tool_calls || m.tool_calls.length === 0) &&
    messageText(m).trim().length > 0
  );
}

function msgTokens(m: ChatMessage): number {
  return tokensForMessage(m, false);
}

function truncateChars(s: string, max: number): string {
  const trimmed = s.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

export interface ToolActivityDigest {
  filesRead: string[];
  filesEdited: string[];
  commands: string[];
  otherCalls: string[];
  foldedPrompts: string[];
  lastReply: string | null;
}

const READ_TOOLS = new Set([
  "read_file",
  "read",
  "search_files",
  "search_content",
  "glob",
  "find_in_code",
  "get_symbols",
  "list_directory",
  "directory_tree",
]);
const EDIT_TOOLS = new Set([
  "edit_file",
  "write_file",
  "multi_edit",
  "delete_file",
  "delete_range",
  "delete_symbol",
  "copy_file",
  "move_file",
]);
const COMMAND_TOOLS = new Set(["run_command", "run_background", "bash", "shell"]);

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function argSummary(call: ToolCall): string {
  const args = parseArgs(call);
  const parts: string[] = [];
  for (const key of ["path", "file_path", "command", "pattern", "query", "source", "destination"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim())
      parts.push(`${key}=${truncateChars(value, DIGEST_ENTRY_MAX_CHARS)}`);
    if (parts.length >= 2) break;
  }
  return parts.length > 0 ? parts.join(" ") : truncateChars(call.function.arguments || "", 80);
}

export function toolActivityDigest(span: readonly ChatMessage[]): ToolActivityDigest {
  const digest: ToolActivityDigest = {
    filesRead: [],
    filesEdited: [],
    commands: [],
    otherCalls: [],
    foldedPrompts: [],
    lastReply: null,
  };
  const pushUnique = (list: string[], entry: string) => {
    if (entry && !list.includes(entry)) list.push(entry);
  };
  for (const m of span) {
    if (m.role === "assistant") {
      for (const call of m.tool_calls ?? []) {
        const name = call.function?.name ?? "tool";
        const entry = `${name}(${argSummary(call)})`;
        if (COMMAND_TOOLS.has(name)) pushUnique(digest.commands, entry);
        else if (EDIT_TOOLS.has(name)) pushUnique(digest.filesEdited, entry);
        else if (READ_TOOLS.has(name)) pushUnique(digest.filesRead, entry);
        else pushUnique(digest.otherCalls, entry);
      }
      if (isPlainAssistantFinal(m))
        digest.lastReply = truncateChars(messageText(m), NOTICE_REPLY_MAX_CHARS) || null;
    } else if (m.role === "user" && !m.synthetic && !isLegacy(m)) {
      pushUnique(
        digest.foldedPrompts,
        `Earlier request: ${truncateChars(messageText(m), NOTICE_PROMPT_MAX_CHARS)}`,
      );
    }
  }
  return digest;
}

export function digestHasWork(digest: ToolActivityDigest): boolean {
  return (
    digest.filesRead.length > 0 ||
    digest.filesEdited.length > 0 ||
    digest.commands.length > 0 ||
    digest.otherCalls.length > 0 ||
    digest.foldedPrompts.length > 0 ||
    digest.lastReply !== null
  );
}

function section(title: string, entries: string[]): string[] {
  return entries.length > 0 ? [`${title}:`, ...entries.map((e) => `- ${e}`)] : [];
}

export function buildDroppedWorkNotice(digest: ToolActivityDigest): string {
  const lines = [
    DROPPED_WORK_NOTICE_PREFIX,
    "Earlier context was compacted to stay under the context window. Work that happened in the dropped span:",
    ...section("Files read", digest.filesRead),
    ...section("Files edited", digest.filesEdited),
    ...section("Commands ran", digest.commands),
    ...section("Other tool calls", digest.otherCalls),
    ...section("Folded requests", digest.foldedPrompts),
  ];
  if (digest.lastReply) lines.push(`Last reply in dropped span: ${digest.lastReply}`);
  lines.push("Re-read files or re-run commands if you need full detail.");
  return lines.join("\n");
}

export interface CompactionPlan {
  /** Log the plan was computed from. */
  source: readonly ChatMessage[];
  keptIndices: number[];
  foldedIndices: number[];
  legacyIndices: number[];
  /** Newest prior summary text (marker stripped), for rolling integration. */
  priorSummary: string | null;
  tokensBefore: number;
  tokensKept: number;
}

export interface PlanCompactionOptions {
  /** Post-compaction token target for the whole replacement log. */
  targetTokens: number;
  /** Verbatim recent-tail budget. */
  preserveRecentTokens?: number;
  /** Verbatim user-prompt budget (newest-first). */
  userRetentionTokens?: number;
}

export function planCompaction(
  messages: readonly ChatMessage[],
  opts: PlanCompactionOptions,
): CompactionPlan | null {
  // Retention budgets never exceed the post-compaction target (Cline's clamp):
  // on a small window a 20K tail would swallow the whole log and nothing would
  // ever fold, so compaction would no-op exactly when it is needed most.
  const preserveRecent = Math.min(
    opts.preserveRecentTokens ?? PRESERVE_RECENT_TOKENS,
    opts.targetTokens,
  );
  const userRetention = Math.min(
    opts.userRetentionTokens ?? USER_RETENTION_TOKENS,
    opts.targetTokens,
  );
  const n = messages.length;
  const tokensBefore = messages.reduce((sum, m) => sum + msgTokens(m), 0);

  const legacyIndices: number[] = [];
  const promptIndices: number[] = [];
  let priorSummary: string | null = null;
  for (let i = 0; i < n; i++) {
    const m = messages[i]!;
    if (isLegacy(m)) {
      legacyIndices.push(i);
      if (isCompactionSummary(m)) {
        const text = messageText(m).replace(COMPACTION_SUMMARY_PREFIX, "").trim();
        if (text) priorSummary = text;
      }
      continue;
    }
    if (isUserPrompt(m)) promptIndices.push(i);
  }

  const kept = new Set<number>();

  // User prompts survive verbatim, newest-first inside the retention budget.
  let promptBudget = userRetention;
  for (let p = promptIndices.length - 1; p >= 0; p--) {
    const idx = promptIndices[p]!;
    const cost = msgTokens(messages[idx]!);
    if (cost > promptBudget && kept.size > 0) break;
    kept.add(idx);
    promptBudget -= cost;
  }

  // Recent tail: contiguous from the end, then snapped forward to an assistant
  // boundary so the kept suffix never opens on an orphaned tool result.
  let tailStart = n;
  let tailCost = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (kept.has(i)) continue;
    const m = messages[i]!;
    const cost = msgTokens(m);
    if (tailCost + cost > preserveRecent) break;
    tailCost += cost;
    tailStart = i;
  }
  while (tailStart < n && messages[tailStart]!.role !== "assistant") tailStart++;
  for (let i = tailStart; i < n; i++) kept.add(i);

  // Older turns keep their concluding assistant answer when it fits, newest
  // turns first. Runs are the gaps between kept regions.
  const runs = foldedRuns(messages.length, kept, legacyIndices);
  let spare = Math.max(
    0,
    opts.targetTokens - [...kept].reduce((s, i) => s + msgTokens(messages[i]!), 0),
  );
  for (const run of runs) {
    for (let i = run.end; i >= run.start; i--) {
      const m = messages[i]!;
      if (!isPlainAssistantFinal(m)) continue;
      const cost = msgTokens(m);
      if (cost <= spare) {
        kept.add(i);
        spare -= cost;
      }
      break;
    }
  }

  const closed = closeToolPairs(messages, kept, legacyIndices);
  const keptIndices = [...closed].sort((a, b) => a - b);
  const keptSet = new Set(keptIndices);
  const foldedIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!keptSet.has(i) && !legacyIndices.includes(i)) foldedIndices.push(i);
  }
  if (foldedIndices.length === 0) return null;

  const tokensKept = keptIndices.reduce((s, i) => s + msgTokens(messages[i]!), 0);
  return {
    source: messages,
    keptIndices,
    foldedIndices,
    legacyIndices,
    priorSummary,
    tokensBefore,
    tokensKept,
  };
}

interface IndexRun {
  start: number;
  end: number;
}

function foldedRuns(n: number, kept: Set<number>, legacyIndices: number[]): IndexRun[] {
  const legacy = new Set(legacyIndices);
  const runs: IndexRun[] = [];
  let open: IndexRun | null = null;
  for (let i = 0; i < n; i++) {
    if (kept.has(i) || legacy.has(i)) {
      if (open) {
        runs.push(open);
        open = null;
      }
      continue;
    }
    if (!open) open = { start: i, end: i };
    else open.end = i;
  }
  if (open) runs.push(open);
  return runs;
}

/** A kept tool result whose tool_call was folded is an orphan the API rejects;
 *  a kept tool_call with a folded result strands its output. Drop either side
 *  from the kept set until the set is pair-closed. */
function closeToolPairs(
  messages: readonly ChatMessage[],
  kept: Set<number>,
  legacyIndices: number[],
): Set<number> {
  const legacy = new Set(legacyIndices);
  const callOwner = new Map<string, number>();
  messages.forEach((m, i) => {
    for (const call of m.tool_calls ?? []) {
      if (call.id) callOwner.set(call.id, i);
    }
  });
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < messages.length; i++) {
      if (!kept.has(i) || legacy.has(i)) continue;
      const m = messages[i]!;
      if (m.role === "tool") {
        const owner = m.tool_call_id ? callOwner.get(m.tool_call_id) : undefined;
        if (owner === undefined || !kept.has(owner)) {
          kept.delete(i);
          changed = true;
        }
      } else if (m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0) {
        for (const call of m.tool_calls ?? []) {
          const resultKept = messages.some(
            (other, j) => other.role === "tool" && other.tool_call_id === call.id && kept.has(j),
          );
          const resultExists = messages.some(
            (other) => other.role === "tool" && other.tool_call_id === call.id,
          );
          if (resultExists && !resultKept) {
            kept.delete(i);
            changed = true;
            break;
          }
        }
      }
    }
    if (!changed) break;
  }
  return kept;
}

export interface CompactionResult {
  messages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
}

function summarizePlan(plan: CompactionPlan, messages: ChatMessage[]): CompactionResult | null {
  const tokensAfter = messages.reduce((sum, m) => sum + msgTokens(m), 0);
  if (tokensAfter >= plan.tokensBefore) return null;
  return {
    messages,
    tokensBefore: plan.tokensBefore,
    tokensAfter,
    messagesBefore: plan.source.length,
    messagesAfter: messages.length,
  };
}

/** Deterministic fold (Cline basic + Gemini rules): no LLM, safe for overflow
 *  recovery where a summarizer call could overflow the same window again. */
export function renderDeterministic(plan: CompactionPlan): CompactionResult | null {
  const kept = new Set(plan.keptIndices);
  const folded = new Set(plan.foldedIndices);
  const out: ChatMessage[] = [];
  if (plan.priorSummary) {
    out.push({
      role: "user",
      synthetic: true,
      content: `${COMPACTION_SUMMARY_PREFIX}\n${plan.priorSummary}`,
    });
  }
  let gap: number[] = [];
  const flush = () => {
    if (gap.length === 0) return;
    const digest = toolActivityDigest(gap.map((i) => plan.source[i]!));
    if (digestHasWork(digest)) {
      out.push({ role: "user", synthetic: true, content: buildDroppedWorkNotice(digest) });
    }
    gap = [];
  };
  for (let i = 0; i < plan.source.length; i++) {
    if (kept.has(i)) {
      flush();
      out.push(plan.source[i]!);
    } else if (folded.has(i)) {
      gap.push(i);
    }
  }
  flush();
  return summarizePlan(plan, out);
}

/** LLM path: one rolling summary message up front (Gemini state-snapshot
 *  placement), everything folded behind it, no inline notices. */
export function renderWithSummary(
  plan: CompactionPlan,
  summaryText: string,
): CompactionResult | null {
  const text = summaryText.trim();
  if (!text) return null;
  const out: ChatMessage[] = [
    { role: "user", synthetic: true, content: `${COMPACTION_SUMMARY_PREFIX}\n${text}` },
  ];
  for (const i of plan.keptIndices) out.push(plan.source[i]!);
  return summarizePlan(plan, out);
}

function toolNameByIdx(messages: readonly ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      if (call.id) names.set(call.id, call.function?.name ?? "tool");
    }
  }
  return names;
}

export function renderTranscript(messages: readonly ChatMessage[]): string {
  const toolNames = toolNameByIdx(messages);
  const lines: string[] = [];
  for (const m of messages) {
    const text = truncateChars(messageText(m), TRANSCRIPT_MESSAGE_MAX_CHARS);
    switch (m.role) {
      case "user":
        lines.push(`${m.synthetic ? "System note" : "User"}: ${text}`);
        break;
      case "assistant": {
        if (text) lines.push(`Assistant: ${text}`);
        for (const call of m.tool_calls ?? []) {
          const args = truncateChars(call.function?.arguments ?? "", 400);
          lines.push(`Assistant requested tool call ${call.function?.name ?? "tool"}(${args})`);
        }
        break;
      }
      case "tool": {
        const name = (m.tool_call_id && toolNames.get(m.tool_call_id)) || "tool";
        lines.push(`Tool result (${name}): ${text}`);
        break;
      }
      default:
        lines.push(`System: ${text}`);
    }
  }
  return lines.join("\n");
}

const SUMMARIZATION_INSTRUCTION = `You are compacting an agent conversation to free context window space.
Write a dense continuation summary the agent can work from without the original history.
Keep every technical detail that matters for continuing the work: file paths, function names, decisions and their rationale, constraints the user stated, error messages, test results, and the current state of any task in progress.
Keep user requests and intent verbatim where possible.
Do not invent anything that is not in the conversation.
Structure the summary with short sections (Goal, Key decisions, Files and changes, Current state, Next steps).
Write the summary only, with no preamble.`;

function withPriorSummaryAnchor(instruction: string, priorSummary: string | null): string {
  if (!priorSummary)
    return `${instruction}\n\nGenerate a new state summary based on the provided history.`;
  return `${instruction}\n\nA previous compaction summary exists. You MUST integrate all still-relevant information from it, updating it with the more recent events. Do not lose established constraints or critical knowledge.\n\nPrevious summary:\n${priorSummary}`;
}

/** The newest messages of the folded span that fit the budget, and how many older
 *  ones were dropped. Shared so the probe can never re-send more than the summary. */
function cappedSpan(
  plan: CompactionPlan,
  maxInputTokens: number,
): { messages: ChatMessage[]; omitted: number } {
  const span = plan.foldedIndices.map((i) => plan.source[i]!);
  const budget = Math.max(2_000, maxInputTokens);
  const kept: ChatMessage[] = [];
  let cost = 0;
  let omitted = 0;
  for (let i = span.length - 1; i >= 0; i--) {
    const m = span[i]!;
    const mCost = msgTokens(m);
    if (cost + mCost > budget && kept.length > 0) {
      omitted = i + 1;
      break;
    }
    cost += mCost;
    kept.push(m);
  }
  kept.reverse();
  return { messages: kept, omitted };
}

/** Rendered transcript of the capped span, with an omission marker when trimmed. */
function cappedTranscript(plan: CompactionPlan, maxInputTokens: number): string {
  const { messages, omitted } = cappedSpan(plan, maxInputTokens);
  const transcript = renderTranscript(messages);
  return omitted > 0
    ? `${transcript}\n\n(${omitted} older messages omitted from this compaction input)`
    : transcript;
}

/** One user message for the summarizer call: instruction + token-capped transcript. */
export function buildCompactionRequest(
  plan: CompactionPlan,
  maxInputTokens: number = SUMMARIZER_INPUT_MAX_TOKENS,
): ChatMessage[] {
  return [
    {
      role: "user",
      content: `${withPriorSummaryAnchor(SUMMARIZATION_INSTRUCTION, plan.priorSummary)}\n\nConversation to summarize:\n${cappedTranscript(plan, maxInputTokens)}`,
    },
  ];
}

const VERIFICATION_INSTRUCTION = `Critically evaluate the compaction summary above against the conversation.
Did it omit any specific technical details, file paths, tool results, decisions, or user constraints?
If anything is missing or could be more precise, write a FINAL improved summary.
Otherwise repeat the exact same summary again.
Write the summary only, with no preamble or commentary.`;

/** Gemini-style verification probe: the second call self-corrects the summary. It
 *  reads the same capped span as the first, so the probe costs no more than it. */
export function buildVerificationRequest(
  plan: CompactionPlan,
  summaryText: string,
  maxInputTokens: number = SUMMARIZER_INPUT_MAX_TOKENS,
): ChatMessage[] {
  return [
    {
      role: "user",
      content: `Candidate compaction summary:\n${summaryText.trim()}\n\n${VERIFICATION_INSTRUCTION}\n\nConversation:\n${cappedTranscript(plan, maxInputTokens)}`,
    },
  ];
}
