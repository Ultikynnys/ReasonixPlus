/** Insertion-ordered Map => least-recently-used eviction; a hit is re-inserted
 *  so `get` promotes. Mirrors src/core/lru.ts, which the desktop bundle cannot
 *  import (separate rootDir), so both desktop caches share THIS one copy. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}
