import type { Dispatch, SetStateAction } from "react";

export function createComposerDraft() {
  let value = "";
  const listeners = new Set<() => void>();
  const getSnapshot = () => value;
  const setDraft: Dispatch<SetStateAction<string>> = (update) => {
    const next = typeof update === "function" ? update(value) : update;
    if (next === value) return;
    value = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  return { getSnapshot, setDraft, subscribe };
}

export type ComposerDraft = ReturnType<typeof createComposerDraft>;
