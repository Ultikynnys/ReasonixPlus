/** A workspace plan belongs to exactly ONE live session while it is worked; a
 *  refused takeover is recoverable, two sessions driving one plan is not. */

/** Recorded on the plan itself so ownership survives a restart. */
export interface PlanClaim {
  /** Session that owns the plan for as long as it works it. */
  session: string;
  /** Process that made the claim — the dead-owner takeover signal. */
  pid: number;
  /** ISO stamp of when this session took the plan. */
  since: string;
}

/** Host hook answering "is this session still bound to a live surface?" — the only
 *  way to tell two sessions in ONE process (two desktop tabs) apart. Without it a
 *  same-process claim is treated as live. */
export type LiveSessionProbe = (workspace: string, session: string) => boolean;

let liveSessionProbe: LiveSessionProbe | null = null;

export function setLiveSessionProbe(probe: LiveSessionProbe | null): void {
  liveSessionProbe = probe;
}

/** Ownership identity for a tool call. An unnamed caller (library embed, direct
 *  dispatch) is still one distinct owner per process, never a shared bucket that
 *  would let two processes believe they hold the same plan. */
export function claimingSession(sessionName: string | null | undefined): string {
  const name = sessionName?.trim();
  return name ? name : `anonymous-${process.pid}`;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** True while the claiming session can still act on its plan. A live-but-idle owner
 *  keeps its plan: taking it would let a session that may resume and one that just
 *  started work the same plan. */
export function claimOwnerIsLive(workspace: string, claim: PlanClaim): boolean {
  if (claim.pid !== process.pid) return isProcessAlive(claim.pid);
  if (!liveSessionProbe) return true;
  try {
    return liveSessionProbe(workspace, claim.session);
  } catch {
    return true;
  }
}

/** A stored claim, or undefined when absent/malformed — a hand-edited history must
 *  not make the whole store unreadable. */
export function parsePlanClaim(value: unknown): PlanClaim | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const session = typeof raw.session === "string" ? raw.session.trim() : "";
  const pid = raw.pid;
  const since = raw.since;
  if (!session) return undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof since !== "string" || !Number.isFinite(Date.parse(since))) return undefined;
  return { session, pid, since };
}

/** Message shared by the store and the tools so a refusal always names the holder. */
export function claimRefusalMessage(planId: string, owner: PlanClaim): string {
  return `plan ${planId} is being worked on by session "${owner.session}" (pid ${owner.pid}, since ${owner.since})`;
}
