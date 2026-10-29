/** The controls every list shares, so the sidebar's session list and the plan tab's plan
 *  list cannot drift apart in markup, icon or keyboard behaviour. */

import { I } from "../icons";

/** Which shared list control to draw: a row's move-to-top arrow or remove cross, or the
 *  header's trash that empties the whole list. */
export type ListControlKind = "reorder" | "remove" | "clear";

const LIST_CONTROLS = {
  reorder: { className: "reorder-btn", Icon: I.arrowUp },
  remove: { className: "delete-btn", Icon: I.x },
  clear: { className: "clear-all-btn", Icon: I.trash },
} as const;

/** One list control. A row control sits inside a row that is itself the click target, so
 *  it keeps its click and its activation keys from reaching that row. The button element
 *  is handed back to the caller, which may anchor a popover on it. */
export function ListControl({
  kind,
  label,
  disabled,
  onAct,
}: {
  kind: ListControlKind;
  /** Title and accessible name: the control carries no visible text. */
  label: string;
  disabled?: boolean;
  onAct: (button: HTMLButtonElement) => void;
}) {
  const { className, Icon } = LIST_CONTROLS[kind];
  return (
    <button
      type="button"
      className={className}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onAct(event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      <Icon size={12} />
    </button>
  );
}
