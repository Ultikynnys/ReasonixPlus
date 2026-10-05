import type { ReactNode } from "react";
import { I } from "../icons";

/** The collapsible heading shared by every card family — the plain `Card` and the
 *  approval cards (`ApprovalCard`). Owns the icon + kind + name + meta + chevron
 *  layout so a new card can't drift from the rest of the transcript. */
export function CardHead({
  icon,
  kind,
  name,
  meta,
  open,
  onToggle,
}: {
  icon: ReactNode;
  kind: string;
  name?: ReactNode;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="card-head"
      onClick={onToggle}
      aria-expanded={open}
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        background: "none",
        border: "none",
        textAlign: "left",
        font: "inherit",
        color: "inherit",
      }}
    >
      <span className="ico">{icon}</span>
      <span className="kind">{kind}</span>
      {name ? <span className="name">{name}</span> : null}
      <span className="grow" />
      {meta ? <span className="meta">{meta}</span> : null}
      <span className="chev">
        <I.chev size={12} />
      </span>
    </button>
  );
}
