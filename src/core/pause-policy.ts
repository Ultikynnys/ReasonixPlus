/** Shared editMode -> auto-resolve rules so the Tauri desktop and any headless
 *  host don't drift. The trust dial has 3 settings: read-only, follow, never-ask. */

import type { EditMode } from "../config.js";
import type { PauseRequest } from "./pause-gate.js";

/** never-ask plan/choice gates wait this long before auto-selecting the first option. */
export const NEVER_ASK_PLAN_COUNTDOWN_MS = 30_000;

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
  enableChoiceTimer?: boolean;
}

/** null = surface to user indefinitely; instant = resolve gate immediately;
 *  countdown = surface the picker, and the UI shows a countdown and resolves with
 *  `verdict` (the first option) when it expires without a user pick. */
export function autoResolveVerdict(
  req: PauseRequest,
  editMode: EditMode,
  opts?: PausePolicyOptions,
): AutoResolveOutcome | null {
  if (req.kind === "plan_checkpoint" && shouldAutoResolveCheckpoint(editMode)) {
    return { kind: "instant", verdict: { type: "continue" } };
  }
  // never-ask mirrors shell.ts's allowAll bypass: outside-sandbox reads/writes
  // pass through too. Stays "run_once" rather than "always_allow" so the session
  // doesn't pollute the on-disk allowlist with every transient path it touched.
  if (req.kind === "path_access" && editMode === "never-ask" && !forcedByAskRule(req)) {
    return { kind: "instant", verdict: { type: "run_once" } };
  }
  // Shell commands in never-ask: shell.ts's `allowAll` callback should already
  // have skipped gate.ask for these, but that closure reads on-disk config via
  // `loadEditMode()` while a runtime-only never-ask source doesn't write to
  // config. Without this second layer those paths surface a confirmation prompt
  // even though the user chose never-ask. `run_once` matches shell.ts's
  // behavior: don't pollute the persistent allowlist with every transient command.
  if (
    (req.kind === "run_command" || req.kind === "run_background") &&
    editMode === "never-ask" &&
    !forcedByAskRule(req)
  ) {
    return { kind: "instant", verdict: { type: "run_once" } };
  }
  // never-ask: plan_proposed. Instead of approving instantly, surface the
  // picker with a countdown so a watching user can still cancel/refine; the first
  // option (approve) is auto-selected when the window elapses.
  if (req.kind === "plan_proposed" && editMode === "never-ask") {
    return { kind: "countdown", verdict: { type: "approve" }, ms: NEVER_ASK_PLAN_COUNTDOWN_MS };
  }
  // never-ask: plan_revision. Without this the rewrite gate surfaces and
  // stalls forever (nobody is watching in headless). Same countdown semantics:
  // the first option (accept rewrite) is auto-selected after the window.
  if (req.kind === "plan_revision" && editMode === "never-ask") {
    return { kind: "countdown", verdict: { type: "accepted" }, ms: NEVER_ASK_PLAN_COUNTDOWN_MS };
  }
  // never-ask: surface ask_choice with the same manual override window as plan
  // gates, then auto-pick the leading branch so unattended runs cannot strand the
  // loop. Cancel malformed choices immediately as a hang-proof fallback; choice.ts
  // already sanitizes options before gating.
  if (req.kind === "choice" && editMode === "never-ask") {
    if (!opts?.enableChoiceTimer) {
      return null;
    }
    const payload = req.payload as { options?: unknown[] };
    const first = Array.isArray(payload.options) ? payload.options[0] : undefined;
    const id = first && typeof first === "object" ? (first as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.length > 0) {
      return {
        kind: "countdown",
        verdict: { type: "pick", optionId: id },
        ms: NEVER_ASK_PLAN_COUNTDOWN_MS,
      };
    }
    return { kind: "instant", verdict: { type: "cancel" } };
  }
  return null;
}
