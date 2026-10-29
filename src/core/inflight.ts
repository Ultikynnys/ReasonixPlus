/** Authoritative running-id set — cards derive `running` from `has(id)` instead of trusting end-event delivery. Loop adds on dispatch entry, deletes in `finally` so every exit path cleans up. */

import { messageOf } from "@reasonix/core-utils";

export type InflightSubscriber = () => void;

export class InflightSet {
  private readonly _set = new Set<string>();
  private readonly _listeners = new Set<InflightSubscriber>();

  add(id: string): void {
    if (this._set.has(id)) return;
    this._set.add(id);
    this._notify();
  }

  delete(id: string): void {
    if (this._set.delete(id)) this._notify();
  }

  has(id: string): boolean {
    return this._set.has(id);
  }

  /** Ids still running that started before `id` — the work the user already sees running.
   *  Insertion order is a total order, so a hold can only wait on strictly older work. */
  startedBefore(id: string): string[] {
    const older: string[] = [];
    for (const running of this._set) {
      if (running === id) break;
      older.push(running);
    }
    return older;
  }

  /** Resolves once nothing that started before `id` is still running, and at once when
   *  `signal` aborts. Every exit path unsubscribes, so a released hold leaves no trace. */
  settledBefore(id: string, signal?: AbortSignal): Promise<void> {
    const quiet = (): boolean => this.startedBefore(id).length === 0;
    if (quiet() || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let stop = (): void => {};
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        stop();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      stop = this.subscribe(() => {
        if (quiet()) finish();
      });
      signal?.addEventListener("abort", finish, { once: true });
      // An abort landing between the first check and this listener still releases.
      if (signal?.aborted) finish();
    });
  }

  /** Snapshot for diagnostics / tests; live view, do not mutate. */
  get size(): number {
    return this._set.size;
  }

  /** Subscribe to add/delete; returns the unsubscribe function. */
  subscribe(fn: InflightSubscriber): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  /** Drop everything — only use at session reset. Notifies once. */
  clear(): void {
    if (this._set.size === 0) return;
    this._set.clear();
    this._notify();
  }

  private _notify(): void {
    for (const fn of this._listeners) {
      try {
        fn();
      } catch (err) {
        /* listener errors must not break the gate — but they must be LOUD */
        process.stderr.write(`reasonix: inflight listener failed — ${messageOf(err)}\n`);
      }
    }
  }
}
