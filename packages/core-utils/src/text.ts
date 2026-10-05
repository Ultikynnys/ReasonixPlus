/** Shared text helpers — whitespace flattening + clipping. Every session
 *  title / summary site used to re-implement `replace(/\s+/g, " ") + trim`
 *  with its own clip-and-ellipsis variant. */

/** Collapse all whitespace runs (incl. newlines) into single spaces, then trim. */
export function flattenText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Remove common credential/data-url forms before text reaches a diagnostic console. */
export function redactDiagnosticText(raw: string, max = 2000): string {
  return raw
    .replace(/data:\S+/gi, "[redacted-data-url]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sk-proj)-[A-Za-z0-9_+\-/=]+/g, "[redacted-key]")
    .replace(/\b(?:ghp|github_pat|xox[baprs])-[A-Za-z0-9_+\-/=]+/g, "[redacted-token]")
    .replace(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, "[redacted-jwt]")
    .replace(
      /([?&](?:token|access_token|refresh_token|api_key|key|signature)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(
      /(access[_-]?token|refresh[_-]?token|api[_-]?key)([\s:=]+)[^\s,;]+/gi,
      "$1$2[redacted]",
    )
    .slice(0, max);
}

/** Recursively redact string leaves in structured diagnostic payloads. */
export function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(redactDiagnosticValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactDiagnosticValue(child)]),
    );
  }
  return value;
}

/** Clip `text` at `max` chars, appending `ellipsis` (default "…") when it had to clip. */
export function clipText(text: string, max: number, ellipsis = "…"): string {
  return text.length > max ? `${text.slice(0, max)}${ellipsis}` : text;
}

/** Clip a one-line index description to fit beside a name, reserving room for the
 *  name and an optional suffix (e.g. a subagent tag). Shared by the skills and
 *  memory index lines, which used to reimplement the same budget math. */
export function clipIndexDescription(
  description: string,
  name: string,
  opts: { suffix?: string; max?: number } = {},
): string {
  const { suffix = "", max = 130 } = opts;
  const safeDesc = description.replace(/\n/g, " ").trim();
  const budget = max - name.length - suffix.length;
  return safeDesc.length > budget ? `${safeDesc.slice(0, Math.max(1, budget - 1))}…` : safeDesc;
}

export interface SanitizeFilenameOptions {
  /** Max length before clamping. Default 64. */
  max?: number;
  /** Replacement for non-safe characters. Default "_". */
  replaceWith?: string;
  /** Keep CJK ideographs (safe on all modern filesystems). Default false. */
  allowCjk?: boolean;
  /** Strip leading/trailing runs of `replaceWith`. Default false. */
  trim?: boolean;
  /** Returned when the result is empty. Default "" — callers decide. */
  fallback?: string;
}

/** Strip non-safe characters → clamp length → fallback when empty. The single
 *  sanitizer for filenames derived from user/model text (session names, tool
 *  names, registry aliases) — those used to be reimplemented per site with
 *  subtly different rules. */
export function sanitizeFilename(name: string, opts: SanitizeFilenameOptions = {}): string {
  const { max = 64, replaceWith = "_", allowCjk = false, trim = false, fallback = "" } = opts;
  const safe = allowCjk ? /[^\w\-\u4e00-\u9fa5]/g : /[^\w\-]/g;
  let cleaned = name.replace(safe, replaceWith);
  if (trim) {
    const escaped = replaceWith.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`^[${escaped}]+|[${escaped}]+$`, "g"), "");
  }
  cleaned = cleaned.slice(0, max);
  return cleaned || fallback;
}

/** Escape HTML special characters (&, <, >, ", ') as numeric character entities. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// --- Terminal text ----------------------------------------------------------
// Text captured from a TTY — command stdout/stderr, logs, files that wrap a
// terminal — carries ANSI escape sequences and control bytes. Rendered verbatim
// they show up as visible mojibake (`[39m[32m…` for SGR colors, `]8;;https://…`
// for OSC hyperlinks). These are the single helpers every display surface routes
// raw process text through.

// Built from char codes so the source carries no literal control bytes, which
// would otherwise trip the `noControlCharactersInRegex` lint.
const ESC = String.fromCharCode(27); // \u001b — introducer for every escape
const BEL = String.fromCharCode(7); // \u0007 — legacy OSC terminator

/** OSC: `ESC ] … (BEL | ST)` — window titles and `ESC]8` hyperlinks. */
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
/** CSI: `ESC [ params intermediates final` — SGR colors, cursor moves, erases. */
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
/** DCS / SOS / PM / APC: `ESC P|X|^|_ … (ST | BEL)`. */
const DCS_RE = new RegExp(`${ESC}[PX^_][^${ESC}]*(?:${ESC}\\\\|${BEL})?`, "g");
/** Two-byte Fe/Fs escapes: `ESC` + one 0x40-0x7E byte (e.g. `ESC c` = reset). */
const ESC_BYTE_RE = new RegExp(`${ESC}[@-~]`, "g");

/** Strip ANSI/terminal escape sequences — CSI colors, OSC titles/hyperlinks,
 *  DCS/PM/APC strings, bare Fe escapes. The escape-only pass; for display
 *  cleanup of the remaining control bytes use `sanitizeTerminalText`. */
export function stripAnsi(text: string): string {
  return text
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(DCS_RE, "")
    .replace(ESC_BYTE_RE, "")
    .split(ESC)
    .join("");
}

/** Full cleanup for text shown in a UI: strip escape sequences, collapse a
 *  `\r`-only progress line to the frame that survived it (terminal semantics —
 *  spinners / bars overwrite the line), and drop any remaining non-printing
 *  control byte (BEL, backspace, DEL, …) while keeping tabs and newlines. */
export function sanitizeTerminalText(text: string): string {
  const lines = stripAnsi(text).split("\n");
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cr = line.lastIndexOf("\r");
    const visible = cr >= 0 ? line.slice(cr + 1) : line;
    for (const ch of visible) {
      const code = ch.codePointAt(0)!;
      // Keep tab (9) and newline (10); drop the remaining C0 controls and DEL.
      if (code === 9 || code === 10 || (code >= 32 && code !== 127)) out += ch;
    }
    if (i < lines.length - 1) out += "\n";
  }
  return out;
}
