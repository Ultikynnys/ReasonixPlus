import type { ReactNode } from "react";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import { CardHead } from "./card-head";
import { useJumpOpen } from "./jump-expand";

export type ApprovalTone = "ok" | "warn" | "danger" | "info" | "brand" | "ghost";

export function ApprovalCard({
  kind,
  tone = "info",
  title,
  chip,
  sub,
  body,
  preview,
  meta,
  primaryLabel,
  secondaryLabel,
  tertiaryLabel,
  quaternaryLabel,
  onPrimary,
  onSecondary,
  onTertiary,
  onQuaternary,
  defaultOpen = true,
  anchor,
}: {
  kind: string;
  tone?: ApprovalTone;
  title: ReactNode;
  /** Short value that rides the title row, right-aligned (a path, "2 options"). */
  chip?: string;
  /** Prose about the title (a plan summary): wraps over as many rows as it needs. */
  sub?: string;
  body?: ReactNode;
  preview?: ReactNode;
  meta?: ReactNode;
  primaryLabel?: string;
  secondaryLabel?: string;
  tertiaryLabel?: string;
  quaternaryLabel?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
  onTertiary?: () => void;
  onQuaternary?: () => void;
  defaultOpen?: boolean;
  /** Stable jump target for the Events tab (`call:<id>`), so a recorded event
   *  lands on THIS card instead of its turn's prompt bubble. */
  anchor?: string;
}) {
  useLang();
  const { open, toggle } = useJumpOpen(anchor, defaultOpen);
  return (
    <div className="approval" data-tone={tone} data-open={open} data-anchor={anchor}>
      <div className="card-head-row">
        <CardHead
          icon={<I.shield size={13} />}
          kind={kind}
          name={title}
          meta={chip}
          sub={sub}
          open={open}
          onToggle={toggle}
          wrapName
        />
      </div>
      {open ? (
        <>
          {body ? <div className="ap-body">{body}</div> : null}
          {preview ? <div className="ap-preview">{preview}</div> : null}
          <div className="ap-foot">
            {onPrimary ? (
              <button type="button" className="btn primary" onClick={onPrimary}>
                {primaryLabel ?? t("extraCards.approve")}
              </button>
            ) : null}
            {onSecondary ? (
              <button type="button" className="btn ghost" onClick={onSecondary}>
                {secondaryLabel ?? t("extraCards.reject")}
              </button>
            ) : null}
            {onTertiary && tertiaryLabel ? (
              <button type="button" className="btn ghost" onClick={onTertiary}>
                {tertiaryLabel}
              </button>
            ) : null}
            {onQuaternary && quaternaryLabel ? (
              <button type="button" className="btn ghost" onClick={onQuaternary}>
                {quaternaryLabel}
              </button>
            ) : null}
            <span className="grow" />
            {meta ? <span className="meta">{meta}</span> : null}
          </div>
        </>
      ) : (
        <div className="ap-collapsed-meta">{meta}</div>
      )}
    </div>
  );
}

// ---- Task Card (multi-step execution from active plan) ----

export type TaskStepView = {
  n: string;
  state: "queued" | "running" | "done" | "failed" | "blocked" | "skipped";
  label: string;
  hint?: string;
  durationLabel?: string;
};

export function TaskCard({
  title,
  subtitle,
  steps,
  anchor,
}: {
  title: string;
  subtitle?: string;
  steps: TaskStepView[];
  /** Jump target for the card hosting this checklist (the plan's tool call). */
  anchor?: string;
}) {
  useLang();
  const done = steps.filter((x) => x.state === "done").length;
  const pct = steps.length ? (done / steps.length) * 100 : 0;
  return (
    <div className="task-card" data-anchor={anchor}>
      <div className="th">
        <span className="ico">
          <I.list size={13} />
        </span>
        <div>
          <div className="tt">{title}</div>
          {subtitle ? <div className="ss">{subtitle}</div> : null}
        </div>
        <span className="grow" />
        <span className="ss">
          {done}/{steps.length}
        </span>
        <div className="meter">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="tb">
        {steps.map((st) => (
          <div className="task-step" key={st.n} data-state={st.state}>
            <span className="nx">step.{st.n}</span>
            <span className="st" />
            <div className="l">
              {st.label}
              {st.hint ? <div className="h">{st.hint}</div> : null}
            </div>
            <span className="t">{st.durationLabel ?? "-"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
