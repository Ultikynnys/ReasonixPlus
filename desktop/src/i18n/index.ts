import { useEffect, useState } from "react";
import { LruCache } from "../cache";
import { en } from "./en";

/** The project is English-only. The language never changes. */
export type Lang = "en";

function useTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    setTick((n) => n + 1);
  }, []);
}

/** Constant English locale. Kept so components that re-render on language
 *  change keep working without a mass refactor; it never varies. */
export function useLang(): Lang {
  useTick();
  return "en";
}

type Dict = typeof en;
type Path<T, K extends keyof T = keyof T> = K extends string
  ? T[K] extends Record<string, unknown>
    ? `${K}.${Path<T[K]>}`
    : K
  : never;
export type TKey = Path<Dict>;

function resolve(dict: Dict, key: string): string {
  const parts = key.split(".");
  let cursor: unknown = dict;
  for (const p of parts) {
    if (cursor && typeof cursor === "object" && p in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[p];
    } else {
      return key;
    }
  }
  return typeof cursor === "string" ? cursor : key;
}

/** Every visible string calls t() on every render, so the key walk is cached:
 *  a null value marks a key that does not resolve (it echoes its path). The key
 *  set is the closed dictionary, so this map needs no eviction. */
const templates = new Map<string, string | null>();

/** Finished strings per key+params; bounded, since params carry ids and paths. */
const formatted = new LruCache<string, string>(1000);

function templateOf(key: string): string | null {
  const cached = templates.get(key);
  if (cached !== undefined) return cached;
  const raw = resolve(en, key);
  const value = raw === key ? null : raw;
  templates.set(key, value);
  return value;
}

export function t(key: TKey, params?: Record<string, string | number>): string {
  const raw = templateOf(key);
  if (raw === null) return key;
  if (!params) return raw;

  let cacheKey = key;
  for (const name in params) cacheKey += `\u0000${name}\u0001${params[name]}`;
  const cached = formatted.get(cacheKey);
  if (cached !== undefined) return cached;

  const text = raw.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
  formatted.set(cacheKey, text);
  return text;
}
