/** Shared editMode -> auto-resolve rules so the Tauri desktop and any headless
 *  host don't drift. The trust dial has 3 settings: read-only, follow, never-ask. */

import type { EditMode } from "../config.js";
import type { PauseRequest } from "./pause-gate.js";

/** Every never-ask picker waits this long before selecting its first option. */
export const NEVER_ASK_PICKER_COUNTDOWN_MS = 30_000;

/** Mirrors shell.ts's allowAll bypass: only read-only still pauses on checkpoints. */
export function shouldAutoResolveCheckpoint(editMode: EditMode): boolean {
  return editMode === "follow" || editMode === "never-ask";
}

export type AutoResolveOutcome =
  | { kind: "instant"; verdict: unknown }
  | { kind: "countdown"; verdict: unknown; ms: number };

/** True when the tool flagged this gate as forced by an ask rule, so never-ask must not skip it. */
function forcedByAskRule(req: PauseRequest): boolean {
  return (req.payload as { forceAsk?: unknown } | undefined)?.forceAsk === true;
}

export interface PausePolicyOptions {
  /** Set false to make ask_choice wait for a manual pick. On by default, so every
   *  never-ask picker (choice, plan, revision) auto-advances the same way. */
  enableChoiceTimer?: boolean;
}

/** Surface the picker, then select its first option when the window elapses: a
 *  watching user keeps the override, an unattended run never strands the loop. */
function pickerCountdown(verdict: unknown): AutoResolveOutcome {
  return { kind: "countdown", verdict, ms: NEVER_ASK_PICKER_COUNTDOWN_MS };
}

function instant(verdict: unknown): AutoResolveOutcome {
  return { kind: "instant", verdict };
}

/** The option a choice gate falls back to, matching the card's top button. */
function firstOptionId(req: PauseRequest): string | null {
  const payload = req.payload as { options?: unknown[] } | undefined;
  const first = Array.isArray(payload?.options) ? payload.options[0] : undefined;
  const id = first && typeof first === "object" ? (first as { id?: unknown }).id : undefined;
  return typeof id === "string" && id.length > 0 ? id : null;
}

type NeverAskRule = (
  req: PauseRequest,
  opts: PausePolicyOptions | undefined,
) => AutoResolveOutcome | null;

/** One entry per pause kind, exhaustive by type: a new gate cannot compile without
 *  stating how Never Ask resolves it, which is the drift guard this file exists for. */
const NEVER_ASK_RULES: Record<PauseRequest["kind"], NeverAskRule> = {
  // A rule the user marked "ask" outranks never-ask, so those gates still surface.
  run_command: (req) => (forcedByAskRule(req) ? null : instant({ type: "run_once" })),
  run_background: (req) => (forcedByAskRule(req) ? null : instant({ type: "run_once" })),
  path_access: (req) => (forcedByAskRule(req) ? null : instant({ type: "run_once" })),
  // Follow-Rules-only gate: gateWrite returns before asking in any other mode.
  edit: () => null,
  // Sending mail is irreversible, so it is the one gate never-ask still asks about.
  outlook_send: () => null,
  plan_checkpoint: () => instant({ type: "continue" }),
  plan_proposed: () => pickerCountdown({ type: "approve" }),
  plan_revision: () => pickerCountdown({ type: "accepted" }),
  choice: (req, opts) => {
    if (opts?.enableChoiceTimer === false) return null;
    const id = firstOptionId(req);
    // Hang-proof fallback: a choice with no well-formed option cannot be picked.
    return id ? pickerCountdown({ type: "pick", optionId: id }) : instant({ type: "cancel" });
  },
};

/** null = surface to user indefinitely; instant = resolve gate immediately;
 *  countdown = surface the picker, and the UI shows a countdown and resolves with
 *  `verdict` (the first option) when it expires without a user pick. */
export function autoResolveVerdict(
  req: PauseRequest,
  editMode: EditMode,
  opts?: PausePolicyOptions,
): AutoResolveOutcome | null {
  // Follow Rules also auto-continues checkpoints, so this precedes the mode gate.
  if (req.kind === "plan_checkpoint" && shouldAutoResolveCheckpoint(editMode)) {
    return instant({ type: "continue" });
  }
  if (editMode !== "never-ask") return null;
  // The record is exhaustive at compile time; the runtime guard covers a caller
  // outside the typed surface, where a missing rule must surface rather than throw.
  const rule: NeverAskRule | undefined = NEVER_ASK_RULES[req.kind];
  return rule ? rule(req, opts) : null;
}
