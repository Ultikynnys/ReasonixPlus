/** Outcomes of Settings-owned actions (install, uninstall, MCP spec edits) as a transient
 *  popover stack. The Settings page asked for them, so the chat transcript never sees them. */

import { useEffect, useRef } from "react";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import { type NoticeSeverity, noticeTone } from "./cards";

/** How long one toast stays on screen before it dismisses itself. */
export const TOAST_TTL_MS = 9_000;
/** Stack cap: a burst of failures cannot cover the shell. */
export const TOAST_LIMIT = 4;

export type ToastNotice = {
  id: number;
  text: string;
  severity: NoticeSeverity;
};

/** Ids only have to order one tab's stack, so a plain counter is enough. */
let toastSequence = 0;

/** Append one toast, replacing an identical one already on screen so a repeated failure
 *  never stacks, and dropping the oldest past {@link TOAST_LIMIT}. Returns the list it was
 *  given when there is nothing to say, so a blank frame costs no render. */
export function pushToast(
  list: readonly ToastNotice[],
  text: string,
  severity: NoticeSeverity,
): readonly ToastNotice[] {
  const body = text.trim();
  if (!body) return list;
  toastSequence += 1;
  const kept = list.filter((toast) => toast.text !== body || toast.severity !== severity);
  return [...kept, { id: toastSequence, text: body, severity }].slice(-TOAST_LIMIT);
}

/** Remove one toast; the same list comes back when the id is already gone. */
export function dismissToast(list: readonly ToastNotice[], id: number): readonly ToastNotice[] {
  return list.some((toast) => toast.id === id) ? list.filter((toast) => toast.id !== id) : list;
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: readonly ToastNotice[];
  onDismiss: (id: number) => void;
}) {
  useLang();
  if (toasts.length === 0) return null;
  return (
    <section className="toast-stack" aria-label={t("app.toast.region")}>
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </section>
  );
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastNotice;
  onDismiss: (id: number) => void;
}) {
  // The dismiss handler is re-created per render upstream, so hold it in a ref: a
  // restarting timer on every parent render would keep a toast alive forever.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss.current(toast.id), TOAST_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id]);
  return (
    <div
      className="toast"
      data-tone={noticeTone(toast.severity)}
      role={toast.severity === "error" ? "alert" : "status"}
    >
      <div className="toast-text">{toast.text}</div>
      <button
        type="button"
        className="toast-dismiss"
        aria-label={t("app.toast.dismiss")}
        onClick={() => onDismiss(toast.id)}
      >
        <I.x size={12} />
      </button>
    </div>
  );
}
