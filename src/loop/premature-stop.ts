// Premature-stop detection: conservative mid-thought signals only. False
// positives cost one bounded extra round-trip; the loop gates the narration
// signals on tool activity so plain Q&A answers are never re-prompted.

// Trailing characters that mean the sentence continues — the model was cut
// off right after announcing something ("...give me the patterns:"). `|` and
// `>` excluded: a complete markdown table row or blockquote can end on them.
const MID_THOUGHT_TRAILING = new Set([":", ";", ",", "(", "[", "{", "+", "=", "&", "-", "*"]);

/** Last line is a markdown divider (--- / *** / ___) — a deliberate closer, not mid-thought. */
const DIVIDER_LINE = /^\s*(?:[-*_]\s*){3,}$/;

// Lines narrating the next step of work. "Next steps: run npm test" is a
// legitimate closer — a colon reads as structured guidance, not a cut-off.
const NARRATION_STARTER =
  /^(?:now|next|then|remaining|let me|moving on|continuing|first|second|third|okay|alright|so)\b/i;

/** Odd code-fence count = the reply ends inside an opened block (cut off mid-code). */
const FENCE_LINE = /^[ \t]*```/;

/** Closed code spans/blocks: their punctuation is content, not prose structure. */
const CODE_FENCE_BLOCK = /```[\s\S]*?```/g;
const CODE_SPAN = /`[^`\n]*`/g;

// A sentence cannot end on a function word — "...all consumers of" means the
// provider cut the stream mid-phrase, not that the model finished a thought.
const DANGLING_TAIL =
  /\b(?:a|an|the|of|to|for|with|and|or|in|on|at|by|from|into|than|via|per|as|is|are|was|were|be|been|being|will|would|can|could|should|that|which|while|when|where|if|but|because)$/i;

// A one-word reply ("a", "ok!") is a complete answer, not a truncation: the
// structural checks below only mean "cut off" once there is a phrase to cut.
const MIN_CUT_OFF_CHARS = 12;

/** Unclosed `(` / `[` / `{` in prose: the reply ends inside an opened clause. */
function hasUnclosedDelimiter(text: string): boolean {
  const prose = text.replace(CODE_FENCE_BLOCK, " ").replace(CODE_SPAN, " ");
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (const ch of prose) {
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    else if (ch === "{") braces++;
    else if (ch === "}") braces--;
  }
  return parens > 0 || brackets > 0 || braces > 0;
}

/** Structural truncation: the reply ends inside a phrase or block, which a model
 *  only does when the provider cut the stream under it. Fires with no tool activity. */
export function looksCutOffMidSentence(content: string): boolean {
  const text = content.trimEnd();
  if (text.length < MIN_CUT_OFF_CHARS) return false;

  const lines = text.split("\n");
  if (lines.filter((l) => FENCE_LINE.test(l)).length % 2 === 1) return true;

  const lastLine = lines[lines.length - 1] ?? "";
  // A divider closes the reply deliberately.
  if (DIVIDER_LINE.test(lastLine)) return false;

  return hasUnclosedDelimiter(text) || DANGLING_TAIL.test(text);
}

/** Mid-thought stop: structural truncation, or a reply trailing off on a continuation
 *  character or a narration line announcing work it never did ("Now the remaining
 *  verification"). Ambiguous for Q&A, so the loop gates those on tool activity. */
export function looksLikePrematureStop(content: string): boolean {
  const text = content.trimEnd();
  if (text.length === 0) return false;
  if (looksCutOffMidSentence(content)) return true;

  const lines = text.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  if (DIVIDER_LINE.test(lastLine)) return false;

  const last = text[text.length - 1]!;
  if (MID_THOUGHT_TRAILING.has(last)) return true;

  const trimmedLast = lastLine.trim();
  return (
    NARRATION_STARTER.test(trimmedLast) &&
    // "Next steps: run npm test" is a legitimate closer — a line that already
    // carries a colon reads as structured guidance, not a cut-off thought.
    !trimmedLast.includes(":") &&
    !/[.!?,;)]$/.test(trimmedLast) &&
    trimmedLast.length <= 120
  );
}
