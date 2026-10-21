import { useMemo, useState } from "react";
import type { TKey } from "../i18n";
import { t } from "../i18n";
import { I } from "../icons";
import type { SessionEventRecord, SessionEventType } from "../protocol";
import type { JumpTarget } from "./transcript-jump";

/** What the tab reads from the transcript: the user records and their stamps. */
export interface TranscriptRecord {
  kind: string;
  text?: string;
  turn?: number;
  ts?: number;
  /** Machine-written user record (image tool feedback): never a prompt row. */
  injected?: boolean;
}

/** Every group the tab can show. Turns come from the transcript, the rest from
 *  the session's recorded events. */
export type EventKind = "turn" | SessionEventType;

/** One row: a turn read from the transcript, or a recorded gate/fold/spawn.
 *  It carries every recorded field, so a field added to the record surfaces here
 *  (and in the merge below) without a second list to keep in step. */
export interface SessionEvent extends Omit<SessionEventRecord, "type" | "label" | "outcome"> {
  kind: EventKind;
  /** When it happened (epoch ms). A legacy turn record inherits the stamp of the
   *  record before it, so every row still has one. */
  ts: number;
  /** What it was about: the prompt, the plan title, the pick, the fold result. */
  label: string;
  /** Verdict or trigger ("approve", "pick", "auto", …); null for a prompt row. */
  outcome: string | null;
}

const KIND_LABEL: Record<EventKind, TKey> = {
  turn: "contextPanel.eventsKindTurn",
  plan: "contextPanel.eventsKindPlan",
  choice: "contextPanel.eventsKindChoice",
  compaction: "contextPanel.eventsKindCompaction",
  subagent: "contextPanel.eventsKindSubagent",
};

/** Wording for each verdict/trigger the recorder can produce. */
const OUTCOME_LABEL: Record<string, TKey> = {
  approve: "contextPanel.eventsOutcomeApprove",
  refine: "contextPanel.eventsOutcomeRefine",
  cancel: "contextPanel.eventsOutcomeCancel",
  pick: "contextPanel.eventsOutcomePick",
  text: "contextPanel.eventsOutcomeText",
  manual: "contextPanel.eventsOutcomeManual",
  auto: "contextPanel.eventsOutcomeAuto",
  overflow: "contextPanel.eventsOutcomeOverflow",
  started: "contextPanel.eventsOutcomeStarted",
  done: "contextPanel.eventsOutcomeDone",
  failed: "contextPanel.eventsOutcomeFailed",
};

/** A row's headline is one line of context, not the whole message. */
const MAX_LABEL = 160;

const clampLabel = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);

const stampOf = (record: TranscriptRecord): number | null => {
  const { ts } = record;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
};

/** One event per user turn, stamped with when the record was written. A record
 *  written before stamps existed inherits the stamp before it: it must not
 *  leapfrog the records written after it, and it still needs a time. */
export function turnEvents(messages: readonly TranscriptRecord[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  const seen = new Set<number>();
  let last = 0;
  for (const message of messages) {
    const stamp = stampOf(message);
    if (stamp !== null) last = stamp;
    const { kind, text, turn } = message;
    if (kind !== "user" || typeof text !== "string" || typeof turn !== "number") continue;
    // Machine-written records deliver images to the model, not prompts to the user.
    if (message.injected === true) continue;
    // A replayed or regenerated turn can arrive twice; one row per turn only.
    if (seen.has(turn)) continue;
    seen.add(turn);
    out.push({
      id: `turn-${turn}`,
      kind: "turn",
      ts: last,
      turn,
      outcome: null,
      label: clampLabel(text),
    });
  }
  return out;
}

/** The session's timeline: turns read from the transcript plus the recorded
 *  verdicts, folds and subagent spawns, ordered by when each happened.
 *  `Array#sort` is stable, so two events in the same millisecond keep the order
 *  they were written in. */
export function sessionEvents(
  messages: readonly TranscriptRecord[],
  recorded: readonly SessionEventRecord[],
): SessionEvent[] {
  const events: SessionEvent[] = turnEvents(messages);
  for (const { type, label, ...rest } of recorded) {
    // A corrupt stamp cannot be placed on the timeline; everything else is
    // carried through as-is, so a new record field needs no change here.
    if (!Number.isFinite(rest.ts)) continue;
    events.push({ ...rest, kind: type, label: clampLabel(label ?? "") });
  }
  return events.sort((left, right) => left.ts - right.ts);
}

/** Wall-clock of one event: time of day on the row, full stamp when expanded. */
export function clockLabel(ts: number, full = false): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const date = new Date(ts);
  return full
    ? date.toLocaleString()
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Localized wording for one entry of a label map, falling back to the raw value
 *  for an outcome this build does not know (a session written by a newer app). */
function labelFor(labels: Record<string, TKey>, key: string): string {
  const label = labels[key];
  return label ? t(label) : key;
}

const kindLabel = (kind: EventKind): string => t(KIND_LABEL[kind]);
const outcomeLabel = (outcome: string): string => labelFor(OUTCOME_LABEL, outcome);

export interface EventsPanelProps {
  messages: readonly TranscriptRecord[];
  events: readonly SessionEventRecord[];
  /** Scroll the chat to a recorded event's location: its own card when the
   *  record carries an anchor, its turn's prompt bubble otherwise. Returns false
   *  when nothing could be located (a rewound session still lists its verdicts),
   *  so a row only marks itself current when the chat actually went there. */
  onJump?: (target: JumpTarget) => boolean | void;
}

/** The Events tab: every type in one timeline, newest last. Each row is tagged
 *  with its event type; clicking a row lands the chat on its turn, and the
 *  chevron expands what else it recorded. */
export function EventsPanel({ messages, events, onJump }: EventsPanelProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const all = useMemo(() => sessionEvents(messages, events), [messages, events]);

  const jump = (event: SessionEvent) => {
    if (!onJump) return;
    // The anchor is the event's own card; without one the row falls back to its
    // turn's prompt bubble. A card that carries two ids keeps both: which one
    // this transcript answers to depends on whether it is live or reloaded.
    const target: JumpTarget = {
      turn: event.turn,
      ...(event.anchor === undefined ? {} : { anchor: event.anchor }),
      ...(event.anchorAlias === undefined ? {} : { anchorAlias: event.anchorAlias }),
    };
    if (onJump(target) === false) return;
    setActive(event.id);
  };

  return (
    <div className="ctx-events">
      {all.length === 0 ? (
        <div className="ctx-empty">{t("contextPanel.eventsEmpty")}</div>
      ) : (
        <div className="ctx-evt-list">
          {all.map((event) => {
            const expanded = open === event.id;
            const jumpable =
              (event.turn > 0 || event.anchor !== undefined || event.anchorAlias !== undefined) &&
              onJump !== undefined;
            const clock = clockLabel(event.ts);
            // The label is suppressed only when the body below already shows the
            // same text: a picked option (marked in the offered list) or the whole
            // plan when the label was just its fallback. Rows written by another
            // build can carry both, so this is derived from the data, not trusted.
            const labelShown =
              event.body === event.label || (event.options?.includes(event.label) ?? false);
            const row = (
              <>
                <span className="ctx-evt-time">{clock}</span>
                <span className="ctx-evt-kind">{kindLabel(event.kind)}</span>
                <span className="ctx-evt-label">
                  {event.outcome ? `${outcomeLabel(event.outcome)} · ${event.label}` : event.label}
                </span>
              </>
            );
            return (
              <div
                key={event.id}
                className="ctx-evt"
                data-kind={event.kind}
                data-open={expanded}
                data-active={active === event.id}
              >
                <div className="ctx-evt-row">
                  {jumpable ? (
                    <button
                      type="button"
                      className="ctx-evt-main"
                      aria-label={
                        (event.anchor ?? event.anchorAlias)
                          ? t("contextPanel.eventsJumpCard")
                          : t("contextPanel.eventsJump", { turn: event.turn })
                      }
                      onClick={() => jump(event)}
                    >
                      {row}
                    </button>
                  ) : (
                    <div className="ctx-evt-main">{row}</div>
                  )}
                  <button
                    type="button"
                    className="ctx-evt-toggle"
                    aria-expanded={expanded}
                    aria-label={t("contextPanel.eventsExpand")}
                    onClick={() => setOpen((prev) => (prev === event.id ? null : event.id))}
                  >
                    <I.chevR size={12} style={{ transform: expanded ? "rotate(90deg)" : "none" }} />
                  </button>
                </div>
                {expanded ? (
                  <div className="ctx-evt-body">
                    <div className="ctx-evt-line">
                      <span className="ctx-evt-key">{t("contextPanel.eventsKindColumn")}</span>
                      <span>{kindLabel(event.kind)}</span>
                    </div>
                    {event.outcome ? (
                      <div className="ctx-evt-line">
                        <span className="ctx-evt-key">{t("contextPanel.eventsOutcomeColumn")}</span>
                        <span>{outcomeLabel(event.outcome)}</span>
                      </div>
                    ) : null}
                    <div className="ctx-evt-line">
                      <span className="ctx-evt-key">{t("contextPanel.eventsWhenColumn")}</span>
                      <span>{clockLabel(event.ts, true)}</span>
                    </div>
                    {event.turn > 0 ? (
                      <div className="ctx-evt-line">
                        <span className="ctx-evt-key">{t("contextPanel.eventsTurnColumn")}</span>
                        <span>{t("contextPanel.eventsTurnValue", { turn: event.turn })}</span>
                      </div>
                    ) : null}
                    {event.detail ? <p className="ctx-evt-detail">{event.detail}</p> : null}
                    {event.result ? (
                      <div className="ctx-evt-result">
                        <span className="ctx-evt-key">{t("contextPanel.eventsResult")}</span>
                        <p className="ctx-evt-detail">{event.result}</p>
                      </div>
                    ) : null}
                    {event.body ? <p className="ctx-evt-detail">{event.body}</p> : null}
                    {event.steps ? (
                      <ol className="ctx-evt-steps" aria-label={t("contextPanel.eventsSteps")}>
                        {event.steps.map((step, index) => (
                          <li key={`${index}-${step}`}>{step}</li>
                        ))}
                      </ol>
                    ) : null}
                    {event.options ? (
                      <ul className="ctx-evt-options" aria-label={t("contextPanel.eventsOptions")}>
                        {event.options.map((option, index) => (
                          <li
                            key={`${index}-${option}`}
                            // Only a "pick" chose one of the offered options; a
                            // typed answer or a cancel matches none of them.
                            data-picked={event.outcome === "pick" && option === event.label}
                          >
                            {option}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {event.label && !labelShown ? (
                      <p className="ctx-evt-detail">{event.label}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
