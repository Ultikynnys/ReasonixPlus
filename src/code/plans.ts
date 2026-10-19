/** The ONE plan store: per-workspace history.json under the workspace directory,
 *  written only by the plan tools; legacy plan.json records migrate in on first read. */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { messageOf } from "@reasonix/core-utils";
import { atomicWriteSync, tmpSiblingPath } from "../core/atomic-write.js";
import { readJsonFileSilently } from "../core/json-file.js";
import {
  listSessionNamesForWorkspace,
  listSessionNamesForWorkspaceFromIndex,
  normalizeWorkspace,
  sanitizeName,
  sessionPlanPath,
  sessionPlansDir,
  workspacesRootDir,
} from "../memory/session.js";
import { coercePlanStep, sanitizeEvidence } from "../tools/plan-sanitize.js";
import type { PlanStep, StepCompletion } from "../tools/plan-types.js";
import {
  type PlanClaim,
  claimOwnerIsLive,
  claimRefusalMessage,
  parsePlanClaim,
} from "./plan-claim.js";

export type PlanStatus =
  | "proposed"
  | "active"
  | "completed"
  | "cancelled"
  | "abandoned"
  | "superseded"
  | "refinement_requested";

export interface PlanRecord {
  id: string;
  status: PlanStatus;
  createdAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  body: string;
  summary?: string;
  steps: PlanStep[];
  completions: Record<string, StepCompletion>;
  revisions: Array<{ at: string; reason: string; steps: PlanStep[] }>;
  replacedBy?: string;
  dispositionReason?: string;
  /** The one live session working this plan. Absent on plans imported from before
   *  ownership existed; the first live session that asks adopts such a plan. */
  claim?: PlanClaim;
}

interface History {
  version: 1;
  revision: number;
  plans: PlanRecord[];
}

export type PlanSummary = Omit<PlanRecord, "body" | "steps" | "completions" | "revisions"> & {
  totalSteps: number;
  completedSteps: number;
};

/** A plan a live owner is actively driving. Only these block another session's
 *  takeover: a finished, superseded, cancelled or sent-back plan belongs to nobody. */
const WORKING_STATUSES: ReadonlySet<PlanStatus> = new Set<PlanStatus>(["proposed", "active"]);

const statuses = new Set<PlanStatus>([
  "proposed",
  "active",
  "completed",
  "cancelled",
  "abandoned",
  "superseded",
  "refinement_requested",
]);

/** Answer to "may this session work this plan?". Refusals are a normal outcome, not
 *  an error: a live session that asks for a plan gets an accept or a reject. */
export type PlanClaimRefusal = {
  accepted: false;
  reason: "owned_by_another_session";
  plan: PlanRecord;
  owner: PlanClaim;
};

function validate(value: unknown): History {
  const history = value as History;
  if (
    !history ||
    history.version !== 1 ||
    !Number.isInteger(history.revision) ||
    !Array.isArray(history.plans)
  )
    throw new Error("Invalid plan history");
  const ids = new Set<string>();
  for (const plan of history.plans) {
    if (
      !plan ||
      typeof plan.id !== "string" ||
      ids.has(plan.id) ||
      !statuses.has(plan.status) ||
      typeof plan.body !== "string" ||
      !Array.isArray(plan.steps) ||
      !Array.isArray(plan.revisions) ||
      !plan.completions ||
      typeof plan.completions !== "object" ||
      Array.isArray(plan.completions) ||
      (plan.createdAt !== null && !Number.isFinite(Date.parse(plan.createdAt))) ||
      !Number.isFinite(Date.parse(plan.updatedAt)) ||
      (plan.finishedAt !== null && !Number.isFinite(Date.parse(plan.finishedAt)))
    )
      throw new Error("Invalid plan record");
    ids.add(plan.id);
    if (plan.status !== "completed" && plan.finishedAt !== null)
      throw new Error("Only completed plans have a finish date");
    if (plan.claim !== undefined && !parsePlanClaim(plan.claim))
      throw new Error("Invalid plan claim");
    for (const [id, completion] of Object.entries(plan.completions)) {
      if (
        !completion ||
        completion.kind !== "step_completed" ||
        completion.stepId !== id ||
        typeof completion.result !== "string"
      )
        throw new Error("Invalid step completion");
    }
    for (const revision of plan.revisions) {
      if (
        !revision ||
        !Number.isFinite(Date.parse(revision.at)) ||
        typeof revision.reason !== "string" ||
        !Array.isArray(revision.steps)
      )
        throw new Error("Invalid plan revision");
    }
    if (
      plan.steps.some(
        (s) =>
          !s ||
          typeof s.id !== "string" ||
          typeof s.title !== "string" ||
          typeof s.action !== "string",
      ) ||
      new Set(plan.steps.map((s) => s.id)).size !== plan.steps.length
    )
      throw new Error("Invalid plan steps");
  }
  // One session drives one plan at a time; two sessions may drive two plans in the
  // same workspace in parallel (unclaimed plans share the "" owner bucket).
  const activeOwners = new Set<string>();
  for (const plan of history.plans) {
    if (plan.status !== "active") continue;
    const owner = ownerKey(plan);
    if (activeOwners.has(owner))
      throw new Error("Multiple active plans for one session in one workspace");
    activeOwners.add(owner);
  }
  return history;
}

/** Stable, filesystem-safe key for a workspace: sanitized basename plus a short
 *  hash of the normalized absolute path, so two distinct workspaces never collide. */
function workspaceKey(workspace: string): string {
  const normalized = normalizeWorkspace(workspace);
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  return `${sanitizeName(basename(normalized) || "workspace")}-${hash}`;
}

/** Workspace-scoped plan storage — one folder per workspace under `~/.reasonix/workspaces/`. */
export function workspacePlansDir(workspace: string): string {
  return join(workspacesRootDir(), workspaceKey(workspace), "plans");
}

const repositories = new Map<string, PlanRepository>();

/** One repository per workspace path so the loop, tools and desktop share a cache. */
export function planRepository(workspace: string): PlanRepository {
  const key = join(workspacePlansDir(workspace), "history.json");
  let repository = repositories.get(key);
  if (!repository) {
    repository = new PlanRepository(workspace);
    repositories.set(key, repository);
    if (repositories.size > 64) repositories.delete(repositories.keys().next().value as string);
  }
  return repository;
}

/** A plan whose steps are all done is complete, whatever status it was sealed with.
 *  Without this a finished leftover reports as "active" and the loop keeps nudging
 *  the model to continue a plan with nothing left to do. */
function sealCompletedPlans(history: History): void {
  for (const plan of history.plans) {
    if (
      plan.status === "active" &&
      plan.steps.length > 0 &&
      plan.steps.every((s) => Object.hasOwn(plan.completions, s.id))
    ) {
      plan.status = "completed";
      plan.finishedAt = plan.updatedAt;
    }
  }
}

/** Ownership bucket for the one-active-per-session invariant. Plans imported before
 *  claims existed share the "" bucket, so such a history stays single-active. */
function ownerKey(plan: PlanRecord): string {
  return plan.claim?.session ?? "";
}

/** Stamp a claim for `session`, keeping the takeover time when the same session (in
 *  the same process) already held it. */
function claimFor(session: string, existing?: PlanClaim): PlanClaim {
  if (existing && existing.session === session && existing.pid === process.pid) return existing;
  const since =
    existing && existing.session === session ? existing.since : new Date().toISOString();
  return { session, pid: process.pid, since };
}

/** The claim that forbids `session` from touching this plan, or null when the plan is
 *  free: only a LIVE owner of a plan still being worked blocks a takeover. */
function blockingClaim(workspace: string, plan: PlanRecord, session: string): PlanClaim | null {
  const claim = plan.claim;
  if (!claim || claim.session === session) return null;
  if (!WORKING_STATUSES.has(plan.status)) return null;
  return claimOwnerIsLive(workspace, claim) ? claim : null;
}

/** One session works one plan at a time: activating `plan` supersedes the same owner's
 *  other active plans and leaves every other session's active plan alone, so two
 *  sessions can run two plans in one workspace in parallel. */
function supersedeOwnerActives(history: History, plan: PlanRecord, now: string): void {
  const key = ownerKey(plan);
  for (const other of history.plans) {
    if (other.id === plan.id || other.status !== "active" || ownerKey(other) !== key) continue;
    other.status = "superseded";
    other.replacedBy = plan.id;
    other.updatedAt = now;
  }
}

/** A workspace history holds at most one active plan PER OWNER: keep each owner's
 *  most recently updated active plan, mark the rest superseded so validation stays
 *  satisfied. Different owners may each have one. */
function reconcileActive(plans: PlanRecord[]): void {
  const keepers = new Map<string, PlanRecord>();
  for (const plan of plans) {
    if (plan.status !== "active") continue;
    const key = ownerKey(plan);
    const keeper = keepers.get(key);
    if (!keeper || plan.updatedAt > keeper.updatedAt) keepers.set(key, plan);
  }
  for (const plan of plans) {
    if (plan.status !== "active") continue;
    const keeper = keepers.get(ownerKey(plan));
    if (!keeper || keeper.id === plan.id) continue;
    plan.status = "superseded";
    plan.replacedBy = keeper.id;
  }
}

/** The plan `session` owns and is still working, newest first. */
function ownerActive(history: History, session: string): PlanRecord | undefined {
  return history.plans.findLast((p) => p.status === "active" && ownerKey(p) === session);
}

export class PlanRepository {
  private signature = "";
  private cached: History | undefined;
  readonly path: string;

  constructor(private readonly workspace: string) {
    if (!workspace.trim()) throw new Error("Workspace is required for plan access");
    this.path = join(workspacePlansDir(workspace), "history.json");
  }

  private load(): History {
    const stat = existsSync(this.path) ? statSync(this.path) : null;
    const signature = stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : "missing";
    if (this.cached && signature === this.signature) return this.cached;
    const history = stat ? validate(JSON.parse(readFileSync(this.path, "utf8"))) : this.migrate();
    sealCompletedPlans(history);
    this.cached = history;
    this.signature = signature;
    if (!stat) this.adoptMigration(history);
    return history;
  }

  /** Writes a first-read migration through so later boots take the plain file path: the
   *  untouched migration re-aggregated every session of the workspace on each start. A
   *  store that fails validation stays in memory only, never on disk. */
  private adoptMigration(history: History): void {
    try {
      validate(history);
      mkdirSync(dirname(this.path), { recursive: true });
      atomicWriteSync(this.path, `${JSON.stringify(history)}\n`, tmpSiblingPath(this.path));
      const stat = statSync(this.path);
      this.signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    } catch (err) {
      process.stderr.write(`reasonix: plan migration write skipped — ${messageOf(err)}\n`);
    }
  }

  /** First read for a workspace: aggregate every session plan store that belongs
   *  to it (current per-session history.json plus legacy plan.json / *.done.json). */
  private migrate(): History {
    const byId = new Map<string, PlanRecord>();
    const add = (plan: PlanRecord): void => {
      const existing = byId.get(plan.id);
      if (!existing || plan.updatedAt > existing.updatedAt) byId.set(plan.id, plan);
    };
    for (const session of migrationCandidates(this.workspace)) {
      for (const plan of readSessionHistory(session)) add(plan);
      for (const plan of legacyPlans(session)) add(plan);
    }
    const plans = [...byId.values()].sort(
      (a, b) =>
        (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt) ||
        a.updatedAt.localeCompare(b.updatedAt),
    );
    reconcileActive(plans);
    return { version: 1, revision: 0, plans };
  }

  private mutate<T>(change: (history: History) => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    // Never steal a live harness lock, even if a large write takes longer than expected.
    if (existsSync(lock)) {
      const owner = Number(readFileSync(lock, "utf8"));
      if (Number.isSafeInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") unlinkSync(lock);
        }
      }
    }
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      this.cached = undefined;
      const history = structuredClone(this.load());
      const result = change(history);
      history.revision++;
      validate(history);
      writeFileSync(temporary, `${JSON.stringify(history)}\n`, { flag: "wx" });
      renameSync(temporary, this.path);
      this.cached = undefined;
      return structuredClone(result);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
      unlinkSync(lock);
    }
  }

  list(): PlanSummary[] {
    return this.load()
      .plans.map(({ body: _body, steps, completions, revisions: _revisions, ...summary }) => ({
        ...summary,
        totalSteps: steps.length,
        completedSteps: steps.filter((s) => Object.hasOwn(completions, s.id)).length,
      }))
      .reverse();
  }

  open(id: string): PlanRecord {
    const plan = this.load().plans.find((p) => p.id === id);
    if (!plan) throw new Error(`Unknown plan ID: ${id}`);
    return structuredClone(plan);
  }

  /** The newest active plan in the workspace whatever its owner. Display and history
   *  only — it cannot say whose plan it is, so `activeFor(session)` is the only correct
   *  way to decide what a session works. */
  newestActivePlan(): PlanRecord | null {
    const plan = this.load().plans.findLast((p) => p.status === "active");
    return plan ? structuredClone(plan) : null;
  }

  /** The plan `session` is working, or null. `adoptUnclaimed` takes over an
   *  in-flight plan carrying no claim (written before ownership existed); losing
   *  that race shows nothing rather than a plan another session drives. */
  activeFor(session: string, opts: { adoptUnclaimed?: boolean } = {}): PlanRecord | null {
    const own = ownerActive(this.load(), session);
    if (own) return structuredClone(own);
    return opts.adoptUnclaimed ? this.adoptUnownedActive(session) : null;
  }

  /** Read-only answer to "may this session work this plan?": the live holder when it
   *  may not, null when it may. Lets a surface refuse BEFORE prompting the user. */
  claimable(id: string, session: string): PlanClaimRefusal | null {
    const plan = this.find(this.load(), id);
    const owner = blockingClaim(this.workspace, plan, session);
    if (!owner) return null;
    return {
      accepted: false,
      reason: "owned_by_another_session",
      plan: structuredClone(plan),
      owner,
    };
  }

  private adoptUnownedActive(session: string): PlanRecord | null {
    const candidate = this.load().plans.findLast((p) => p.status === "active" && !p.claim);
    if (!candidate) return null;
    try {
      return this.mutate((history) => {
        const plan = history.plans.find((p) => p.id === candidate.id);
        if (!plan || plan.status !== "active" || plan.claim)
          return ownerActive(history, session) ?? null;
        plan.claim = claimFor(session);
        return plan;
      });
    } catch (err) {
      // A live writer holds the lock, or the history went unreadable between the read
      // and the write. Plan context is additive: degrade to "no plan here" and say so.
      process.stderr.write(`reasonix: plan adoption failed — ${messageOf(err)}\n`);
      return null;
    }
  }

  propose(body: string, steps: PlanStep[] = [], summary?: string, session?: string): PlanRecord {
    if (!body.trim()) throw new Error("Plan body is required");
    return this.mutate((history) => {
      const now = new Date().toISOString();
      const plan: PlanRecord = {
        id: randomUUID(),
        status: "proposed",
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        body,
        steps,
        summary,
        completions: {},
        revisions: [],
      };
      // Claimed at creation: the proposing session owns the plan before the user is
      // even asked, so no other session can pick it up while the card is open.
      if (session) plan.claim = claimFor(session);
      history.plans.push(plan);
      return plan;
    });
  }

  verdict(
    id: string,
    status: "active" | "cancelled" | "refinement_requested",
    session?: string,
  ): PlanRecord {
    return this.mutate((history) => {
      const plan = this.findMutable(history, id);
      if (plan.status !== "proposed") throw new Error("Stale plan verdict");
      const now = new Date().toISOString();
      if (status === "active") {
        if (session) {
          this.requireUnclaimed(plan, session);
          plan.claim = claimFor(session, plan.claim);
        }
        supersedeOwnerActives(history, plan, now);
      }
      plan.status = status;
      plan.updatedAt = now;
      return plan;
    });
  }

  complete(id: string, completion: StepCompletion, session?: string): PlanRecord {
    return this.mutate((history) => {
      const plan = this.findActive(history, id);
      if (session) this.requireOwner(plan, session);
      const next = plan.steps.find((s) => !Object.hasOwn(plan.completions, s.id));
      if (!next || next.id !== completion.stepId)
        throw new Error("Complete exactly the next unfinished plan step");
      if (!completion.result.trim()) throw new Error("Completion result is required");
      plan.completions[completion.stepId] = completion;
      plan.updatedAt = new Date().toISOString();
      if (plan.steps.every((s) => Object.hasOwn(plan.completions, s.id))) {
        plan.status = "completed";
        plan.finishedAt = plan.updatedAt;
      }
      return plan;
    });
  }

  revise(id: string, reason: string, remaining: PlanStep[], session?: string): PlanRecord {
    return this.mutate((history) => {
      const plan = this.findActive(history, id);
      if (session) this.requireOwner(plan, session);
      if (!reason.trim() || remaining.some((s) => Object.hasOwn(plan.completions, s.id)))
        throw new Error("Invalid plan revision");
      plan.revisions.push({
        at: new Date().toISOString(),
        reason,
        steps: structuredClone(plan.steps),
      });
      plan.steps = [
        ...plan.steps.filter((s) => Object.hasOwn(plan.completions, s.id)),
        ...remaining,
      ];
      plan.updatedAt = new Date().toISOString();
      return plan;
    });
  }

  abandon(id: string, reason: string, session?: string): PlanRecord {
    if (!reason.trim()) throw new Error("Abandonment reason is required");
    return this.mutate((history) => {
      const plan = this.findMutable(history, id);
      if (plan.status !== "active" && plan.status !== "proposed")
        throw new Error("Plan cannot be abandoned in its current state");
      if (session) this.requireUnclaimed(plan, session);
      plan.status = "abandoned";
      plan.dispositionReason = reason.trim();
      plan.updatedAt = new Date().toISOString();
      return plan;
    });
  }

  /** Make any non-completed plan this session's active one, superseding this
   *  session's other active plan. A completed plan is frozen, so it can never be
   *  brought back as active, and a plan a live session is working is refused. */
  activate(id: string, session?: string): PlanRecord {
    return this.mutate((history) => {
      const plan = this.findMutable(history, id);
      const mine = !session || plan.claim?.session === session;
      if (session) {
        this.requireUnclaimed(plan, session);
        plan.claim = claimFor(session, plan.claim);
      }
      if (plan.status === "active" && mine) return plan;
      const now = new Date().toISOString();
      supersedeOwnerActives(history, plan, now);
      plan.status = "active";
      plan.finishedAt = null;
      plan.replacedBy = undefined;
      plan.dispositionReason = undefined;
      plan.updatedAt = now;
      return plan;
    });
  }

  /** Delete a plan for good, whatever its state. Completed records are frozen for
   *  edits but a manual remove is the user's explicit call; unknown ids are refused. */
  remove(id: string): void {
    this.mutate((history) => {
      const index = history.plans.findIndex((plan) => plan.id === id);
      if (index === -1) throw new Error(`Unknown plan ID: ${id}`);
      history.plans.splice(index, 1);
    });
  }

  private find(history: History, id: string): PlanRecord {
    const plan = history.plans.find((p) => p.id === id);
    if (!plan) throw new Error(`Unknown plan ID: ${id}`);
    return plan;
  }

  /** A completed plan is frozen for good — mutating it would falsify the record. */
  private findMutable(history: History, id: string): PlanRecord {
    const plan = this.find(history, id);
    if (plan.status === "completed") throw new Error("Plan is completed and cannot be modified");
    return plan;
  }

  private findActive(history: History, id: string): PlanRecord {
    const plan = this.findMutable(history, id);
    if (plan.status !== "active") throw new Error("Plan is no longer active");
    return plan;
  }

  /** A session advances only the plan it owns. Ownership is never stolen here: taking
   *  a plan over is an explicit `activate`, which the owner's liveness gates. */
  private requireOwner(plan: PlanRecord, session: string): void {
    if (plan.claim && plan.claim.session !== session)
      throw new Error(
        `Plan is owned by session "${plan.claim.session}"; activate it from this session first`,
      );
  }

  /** Refuse to touch a plan a LIVE other session is working — the mutator-side twin of
   *  `claimable`, so every write answers "is this plan taken?" the same way. */
  private requireUnclaimed(plan: PlanRecord, session: string): void {
    const owner = blockingClaim(this.workspace, plan, session);
    if (owner) throw new Error(claimRefusalMessage(plan.id, owner));
  }
}

/** Sessions the first read aggregates. The persisted session index answers this without
 *  a meta.json read per session; an unusable cache falls back to the full walk, which at
 *  ~12k sessions is seconds of blocking I/O. */
function migrationCandidates(workspace: string): string[] {
  return (
    listSessionNamesForWorkspaceFromIndex(workspace) ?? listSessionNamesForWorkspace(workspace)
  );
}

/** Read a session's current per-session history.json; a malformed file is skipped
 *  so one bad session can't abort the whole workspace migration. */
function readSessionHistory(session: string): PlanRecord[] {
  const path = join(sessionPlansDir(session), "history.json");
  if (!existsSync(path)) return [];
  try {
    return validate(JSON.parse(readFileSync(path, "utf8"))).plans;
  } catch {
    return [];
  }
}

/** Read-only migration of the retired per-session plan.json + plans/*.done.json format. */

interface LegacyPlanFile {
  version?: unknown;
  steps?: unknown;
  completedStepIds?: unknown;
  updatedAt?: unknown;
  stepCompletions?: unknown;
  body?: unknown;
  summary?: unknown;
}

interface LegacyPlanData {
  steps: PlanStep[];
  completedStepIds: string[];
  stepCompletions?: Record<string, StepCompletion>;
  updatedAt: string;
  body?: string;
  summary?: string;
}

function legacySteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    const step = coercePlanStep(entry, { trim: false });
    if (step) steps.push(step);
  }
  return steps;
}

function legacyCompletions(
  completedStepIds: string[],
  provided: Record<string, StepCompletion> | undefined,
): { completions: Record<string, StepCompletion> } {
  const completions: Record<string, StepCompletion> = { ...(provided ?? {}) };
  for (const stepId of completedStepIds) {
    completions[stepId] ??= {
      kind: "step_completed",
      stepId,
      result: "Legacy completion; original result unavailable",
    };
  }
  return { completions };
}

function readLegacyPlanFile(path: string): LegacyPlanData | null {
  const raw = readJsonFileSilently<LegacyPlanFile>(
    path,
    (v): v is LegacyPlanFile => !!v && typeof v === "object",
  );
  if (!raw) return null;
  if (raw.version !== 1 && raw.version !== 2) return null;
  const steps = legacySteps(raw.steps);
  if (steps.length === 0) return null;
  const completedStepIds = Array.isArray(raw.completedStepIds)
    ? raw.completedStepIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const data: LegacyPlanData = { steps, completedStepIds, updatedAt: "" };
  if (typeof raw.updatedAt === "string") data.updatedAt = raw.updatedAt;
  const stepCompletions = legacyStepCompletions(raw.stepCompletions);
  if (stepCompletions) data.stepCompletions = stepCompletions;
  if (typeof raw.body === "string" && raw.body) data.body = raw.body;
  if (typeof raw.summary === "string" && raw.summary) data.summary = raw.summary;
  return data;
}

function legacyStepCompletions(raw: unknown): Record<string, StepCompletion> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, StepCompletion> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const completion = legacyStepCompletion(value, key);
    if (completion) out[completion.stepId] = completion;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function legacyStepCompletion(raw: unknown, fallbackStepId?: string): StepCompletion | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const stepId =
    typeof entry.stepId === "string" && entry.stepId.trim()
      ? entry.stepId.trim()
      : fallbackStepId?.trim();
  const result = typeof entry.result === "string" ? entry.result.trim() : "";
  if (!stepId || !result) return undefined;
  const completion: StepCompletion = { kind: "step_completed", stepId, result };
  if (typeof entry.title === "string" && entry.title.trim()) completion.title = entry.title.trim();
  if (typeof entry.notes === "string" && entry.notes.trim()) completion.notes = entry.notes.trim();
  const evidence = sanitizeEvidence(entry.evidence);
  if (evidence) completion.evidence = evidence;
  return completion;
}

function readLegacyActivePlan(session: string): LegacyPlanData | null {
  return readLegacyPlanFile(sessionPlanPath(session));
}

function readLegacyArchives(
  session: string,
): Array<LegacyPlanData & { path: string; completedAt: string }> {
  const dir = sessionPlansDir(session);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const archives: Array<LegacyPlanData & { path: string; completedAt: string }> = [];
  for (const name of entries) {
    if (!name.endsWith(".done.json")) continue;
    const path = join(dir, name);
    const data = readLegacyPlanFile(path);
    if (!data) continue;
    // Prefer the file's own timestamp; fall back to mtime so a hand-edited archive still sorts.
    let completedAt = data.updatedAt;
    if (!completedAt || Number.isNaN(Date.parse(completedAt))) {
      try {
        completedAt = statSync(path).mtime.toISOString();
      } catch {
        completedAt = new Date(0).toISOString();
      }
    }
    archives.push({ ...data, path, completedAt });
  }
  // Ascending (oldest first) so the push order matches fresh plans; list() reverses to newest-first.
  archives.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  return archives;
}

/** Convert one session's legacy plan.json / *.done.json records into PlanRecords,
 *  keyed by source path so ids never collide across sessions in a merge. */
function legacyPlans(session: string): PlanRecord[] {
  const plans: PlanRecord[] = [];
  for (const archive of readLegacyArchives(session)) {
    const completed =
      archive.steps.length > 0 &&
      archive.steps.every((s) => archive.completedStepIds.includes(s.id));
    plans.push({
      ...legacyCompletions(archive.completedStepIds, archive.stepCompletions),
      id: `legacy-${Buffer.from(archive.path).toString("base64url")}`,
      status: completed ? "completed" : "abandoned",
      createdAt: null,
      updatedAt: archive.completedAt,
      finishedAt: completed ? archive.completedAt : null,
      body: archive.body ?? "",
      summary: archive.summary,
      steps: archive.steps,
      revisions: [],
      dispositionReason:
        "Imported legacy archive; original creation date and disposition are unavailable",
    });
  }
  const active = readLegacyActivePlan(session);
  if (active) {
    // A legacy plan whose steps are all done is finished, not in-flight —
    // otherwise it would re-inject "continue the next step" forever.
    const activeDone =
      active.steps.length > 0 && active.steps.every((s) => active.completedStepIds.includes(s.id));
    const activeUpdatedAt = active.updatedAt || new Date().toISOString();
    plans.push({
      ...legacyCompletions(active.completedStepIds, active.stepCompletions),
      id: `legacy-${Buffer.from(sessionPlanPath(session)).toString("base64url")}`,
      status: activeDone ? "completed" : "active",
      createdAt: null,
      updatedAt: activeUpdatedAt,
      finishedAt: activeDone ? activeUpdatedAt : null,
      body: active.body ?? "",
      summary: active.summary,
      steps: active.steps,
      revisions: [],
      dispositionReason: activeDone
        ? "Imported legacy completed plan; original creation date is unavailable"
        : "Imported legacy active plan; original creation date is unavailable",
    });
  }
  return plans;
}
