export const MAX_RULE_REGEX_LENGTH = 2048;

export function ruleRegexError(pattern: string): string | null {
  if (!pattern.trim()) return "Regex must not be empty.";
  if (pattern.length > MAX_RULE_REGEX_LENGTH) return `Regex must be at most ${MAX_RULE_REGEX_LENGTH} characters.`;
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (error) {
    return `Invalid regex: ${(error as Error).message}`;
  }
}
