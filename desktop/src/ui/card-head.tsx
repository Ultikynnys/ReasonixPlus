import type { ReactNode } from "react";
import { I } from "../icons";

/** The collapsible heading shared by every card family — the plain `Card` and the
 *  approval cards (`ApprovalCard`). Owns the icon + kind + name + meta + chevron
 *  layout so a new card can't drift from the rest of the transcript.
 *  `wrapName` lets the name slot run onto several lines instead of ellipsising
 *  (approval cards put the whole ask_choice question there); `sub` adds a wrapping
 *  prose row under the title, so long text never competes with the title for room. */
export function CardHead({
  icon,
  kind,
  name,
  meta,
  sub,
  open,
  onToggle,
  wrapName = false,
}: {
  icon: ReactNode;
  kind: string;
  name?: ReactNode;
  meta?: ReactNode;
  sub?: ReactNode;
  open: boolean;
  onToggle: () => void;
  wrapName?: boolean;
}) {
  return (
    <button
      type="button"
      className="card-head"
      onClick={onToggle}
      aria-expanded={open}
      data-wrap={wrapName ? "true" : undefined}
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
      <span className="card-head-top">
        <span className="ico">{icon}</span>
        <span className="kind">{kind}</span>
        {name ? <span className="name">{name}</span> : null}
        <span className="grow" />
        {meta ? <span className="meta">{meta}</span> : null}
        <span className="chev">
          <I.chev size={12} />
        </span>
      </span>
      {sub ? <span className="sub">{sub}</span> : null}
    </button>
  );
}
