import { EN } from "./EN.js";
import type { TranslationSchema } from "./types.js";

/** The project is English-only. All translations resolve from the English dictionary. */
const translations: TranslationSchema = EN;

/** Replace `{name}` placeholders. Shared so engine-declared copy interpolates the
 *  same way as the locale dictionary. */
export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  let result = text;
  for (const [k, v] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return result;
}

/** Simple t() — nested keys (e.g. "common.error") + param replacement (e.g. "{code}"). */
export function t(path: string, params?: Record<string, string | number>): string {
  const parts = path.split(".");
  let val: any = translations;

  for (const part of parts) {
    val = val?.[part];
    if (val === undefined) break;
  }

  if (typeof val !== "string") {
    return path;
  }

  return interpolate(val, params);
}
