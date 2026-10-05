import { t, useLang } from "../i18n";
import { I } from "../icons";
import { ContextMenu, type ContextMenuItem } from "./file-menu";

export type ClearTabsScope = "all" | "right" | "left";

export interface TabMenuProps {
  anchor: { x: number; y: number };
  tabs: readonly { id: string }[];
  activeId: string;
  onClear: (scope: ClearTabsScope) => void;
  onClose: () => void;
}

/**
 * Returns the subset of tabs to clear based on the active tab and scope:
 * - "all": every tab
 * - "right": all tabs to the right of the selected tab
 * - "left": all tabs to the left of the selected tab
 */
export function getTabsToClear<T extends { id: string }>(
  tabs: readonly T[],
  activeId: string,
  scope: ClearTabsScope,
): T[] {
  if (scope === "all") return [...tabs];
  const activeIndex = tabs.findIndex((t) => t.id === activeId);
  if (activeIndex === -1) return [];
  if (scope === "left") return tabs.slice(0, activeIndex);
  if (scope === "right") return tabs.slice(activeIndex + 1);
  return [];
}

/**
 * Dropdown context menu opened on right-clicking the tabs ribbon.
 * Offers options to clear all tabs, tabs to the right, and tabs to the left.
 */
export function TabMenu({ anchor, tabs, activeId, onClear, onClose }: TabMenuProps) {
  useLang();
  const scopeItems: { scope: ClearTabsScope; label: string; icon: React.ReactNode }[] = [
    { scope: "all", label: t("app.tab.clearAll"), icon: <I.x size={12} /> },
    { scope: "right", label: t("app.tab.clearRight"), icon: <I.chevR size={12} /> },
    { scope: "left", label: t("app.tab.clearLeft"), icon: <I.chevL size={12} /> },
  ];
  const items: ContextMenuItem[] = scopeItems.map((item) => ({
    key: item.scope,
    label: item.label,
    icon: item.icon,
    empty: getTabsToClear(tabs, activeId, item.scope).length === 0,
    onSelect: () => {
      onClear(item.scope);
      onClose();
    },
  }));

  return (
    <ContextMenu
      anchor={anchor}
      rootClass="file-menu tab-menu"
      itemClass="file-menu-item tab-menu-item"
      dismissSelector=".tab-menu"
      items={items}
      onClose={onClose}
    />
  );
}
