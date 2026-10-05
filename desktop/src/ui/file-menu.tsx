import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openWithDialog, revealInExplorer } from "../Markdown";
import { t, useLang } from "../i18n";
import { I } from "../icons";

/** One entry in a {@link ContextMenu}. */
export interface ContextMenuItem {
  /** Stable identity / React key. */
  key: string;
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  /** Render dimmed (e.g. a clear-tabs item with no tabs to clear). */
  empty?: boolean;
}

/** Clamp a popover/menu anchored at (x, y) inside the viewport, keeping an 8px margin. */
export function useClampedPopupPosition(
  ref: { current: HTMLDivElement | null },
  anchor: { x: number; y: number },
  pos: { left: number; top: number },
  setPos: (next: { left: number; top: number }) => void,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top = anchor.y;
    if (left + rect.width + pad > vw) left = Math.max(pad, vw - rect.width - pad);
    if (top + rect.height + pad > vh) top = Math.max(pad, vh - rect.height - pad);
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
  }, [ref.current, anchor.x, anchor.y, pos.left, pos.top, setPos]);
}

/**
 * Generic right-click / context menu: an anchored popover that dismisses on an
 * outside mousedown or Escape. Shared shell for FileMenu and TabMenu.
 */
export function ContextMenu({
  anchor,
  rootClass,
  itemClass,
  dismissSelector,
  items,
  onClose,
}: {
  anchor: { x: number; y: number };
  rootClass: string;
  itemClass: string;
  /** CSS selector; a mousedown outside it closes the menu. */
  dismissSelector: string;
  items: readonly ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.x,
    top: anchor.y,
  });
  useClampedPopupPosition(ref, anchor, pos, setPos);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(dismissSelector)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, dismissSelector]);

  return (
    <div
      ref={ref}
      className={rootClass}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={itemClass}
          role="menuitem"
          data-empty={item.empty ? "true" : undefined}
          onClick={item.onSelect}
        >
          <span className="ico">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Right-click menu for a file path. Offers "Show in file explorer"
 * (reveals the file/directory in the OS file manager), "Open with…" (the
 * native OS app picker), and "Copy path". Dismisses on outside click or Escape.
 */
export function FileMenu({
  anchor,
  abs,
  onClose,
}: {
  anchor: { x: number; y: number };
  abs: string;
  onClose: () => void;
}) {
  useLang();
  const open = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch {
      /* ignore — the OS picker / explorer reveal is best-effort */
    }
    onClose();
  };

  const items: ContextMenuItem[] = [
    {
      key: "explorer",
      label: t("fileMenu.showInExplorer"),
      icon: <I.link size={12} />,
      onSelect: open(() => revealInExplorer(abs)),
    },
    {
      key: "openWith",
      label: t("fileMenu.openWith"),
      icon: <I.external size={12} />,
      onSelect: open(() => openWithDialog(abs)),
    },
    {
      key: "copyPath",
      label: t("fileMenu.copyPath"),
      icon: <I.copy size={12} />,
      onSelect: () => {
        void navigator.clipboard?.writeText(abs)?.catch(() => undefined);
        onClose();
      },
    },
  ];

  return (
    <ContextMenu
      anchor={anchor}
      rootClass="file-menu"
      itemClass="file-menu-item"
      dismissSelector=".file-menu"
      items={items}
      onClose={onClose}
    />
  );
}
