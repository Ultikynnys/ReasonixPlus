/** The four built-in memory types. A leaf module (no imports) so config.ts can
 *  read the list without the config↔memory cycle importing user.ts would form. */
export const BUILTIN_MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type BuiltinMemoryType = (typeof BUILTIN_MEMORY_TYPES)[number];
