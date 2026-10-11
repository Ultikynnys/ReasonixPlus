/** The ONE plan store: per-session history at `plans/history.json`. Plan tools are
 *  the only writers; legacy plan.json / .done.json records migrate in on first read. */

import { randomUUID } from "node:crypto";
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
import { dirname, join } from "node:path";
import { readJsonFileSilently } from "../core/json-file.js";
import { sessionPlanPath, sessionPlansDir } from "../memory/session.js";
import { coercePlanStep, sanitizeEvidence } from "../tools/plan-sanitize.js";
import type { PlanStep, StepCompletion } from "../tools/plan-types.js";

export type SessionPlanStatus =
  | "proposed"
  | "active"
  | "completed"
  | "cancelled"
  | "abandoned"
  | "superseded"
  | "refinement_requested";

export interface SessionPlan {
  id: string;
  status: SessionPlanStatus;
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
}

interface History {
  version: 1;
  revision: number;
  plans: SessionPlan[];
}

export type SessionPlanSummary = Omit<
  SessionPlan,
  "body" | "steps" | "completions" | "revisions"
> & {
  totalSteps: number;
  completedSteps: number;
};

const statuses = new Set<SessionPlanStatus>([
  "proposed",
  "active",
  "completed",
  "cancelled",
  "abandoned",
  "superseded",
  "refinement_requested",
]);

function validate(value: unknown): History {
  const history = value as History;
  if (
    !history ||
    history.version !== 1 ||
    !Number.isInteger(history.revision) ||
    !Array.isArray(history.plans)
  )
    throw new Error("Invalid session plan history");
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
      throw new Error("Invalid session plan record");
    ids.add(plan.id);
    if (plan.status !== "completed" && plan.finishedAt !== null)
      throw new Error("Only completed plans have a finish date");
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
      throw new Error("Invalid session plan steps");
  }
  if (history.plans.filter((p) => p.status === "active").length > 1)
    throw new Error("Multiple active plans in one session");
  return history;
}

const repositories = new Map<string, SessionPlanRepository>();

/** One repository per session path so the loop, tools and desktop share a cache. */
export function sessionPlanRepository(session: string): SessionPlanRepository {
  const key = join(sessionPlansDir(session), "history.json");
  let repository = repositories.get(key);
  if (!repository) {
    repository = new SessionPlanRepository(session);
    repositories.set(key, repository);
    if (repositories.size > 64) repositories.delete(repositories.keys().next().value as string);
  }
  return repository;
}

export class SessionPlanRepository {
  private signature = "";
  private cached: History | undefined;
  readonly path: string;

  constructor(private readonly session: string) {
    if (!session.trim()) throw new Error("Session is required for plan access");
    this.path = join(sessionPlansDir(session), "history.json");
  }

  private load(): History {
    const stat = existsSync(this.path) ? statSync(this.path) : null;
    const signature = stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : "missing";
    if (this.cached && signature === this.signature) return this.cached;
    const history = stat ? validate(JSON.parse(readFileSync(this.path, "utf8"))) : this.legacy();
    this.cached = history;
    this.signature = signature;
    return history;
  }

  /** Seal any legacy plan.json / .done.json records into the unified history shape. */
  private legacy(): History {
    const plans: SessionPlan[] = [];
    for (const archive of readLegacyArchives(this.session)) {
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
    const active = readLegacyActivePlan(this.session);
    if (active) {
      // A legacy plan whose steps are all done is finished, not in-flight —
      // otherwise it would re-inject "continue the next step" forever.
      const activeDone =
        active.steps.length > 0 &&
        active.steps.every((s) => active.completedStepIds.includes(s.id));
      const activeUpdatedAt = active.updatedAt || new Date().toISOString();
      plans.push({
        ...legacyCompletions(active.completedStepIds, active.stepCompletions),
        id: "legacy-active",
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

  list(): SessionPlanSummary[] {
    return this.load()
      .plans.map(({ body: _body, steps, completions, revisions: _revisions, ...summary }) => ({
        ...summary,
        totalSteps: steps.length,
        completedSteps: steps.filter((s) => Object.hasOwn(completions, s.id)).length,
      }))
      .reverse();
  }

  open(id: string): SessionPlan {
    const plan = this.load().plans.find((p) => p.id === id);
    if (!plan) throw new Error(`Unknown plan ID: ${id}`);
    return structuredClone(plan);
  }

  active(): SessionPlan | null {
    const plan = this.load().plans.findLast((p) => p.status === "active");
    return plan ? structuredClone(plan) : null;
  }

  propose(body: string, steps: PlanStep[] = [], summary?: string): SessionPlan {
    if (!body.trim()) throw new Error("Plan body is required");
    return this.mutate((history) => {
      const now = new Date().toISOString();
      const plan: SessionPlan = {
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
      history.plans.push(plan);
      return plan;
    });
  }

  verdict(id: string, status: "active" | "cancelled" | "refinement_requested"): SessionPlan {
    return this.mutate((history) => {
      const plan = this.find(history, id);
      if (plan.status !== "proposed") throw new Error("Stale plan verdict");
      const now = new Date().toISOString();
      if (status === "active")
        for (const previous of history.plans) {
          if (previous.id !== id && previous.status === "active") {
            previous.status = "superseded";
            previous.replacedBy = id;
            previous.updatedAt = now;
          }
        }
      plan.status = status;
      plan.updatedAt = now;
      return plan;
    });
  }

  complete(id: string, completion: StepCompletion): SessionPlan {
    return this.mutate((history) => {
      const plan = this.findActive(history, id);
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

  revise(id: string, reason: string, remaining: PlanStep[]): SessionPlan {
    return this.mutate((history) => {
      const plan = this.findActive(history, id);
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

  abandon(id: string, reason: string): SessionPlan {
    if (!reason.trim()) throw new Error("Abandonment reason is required");
    return this.mutate((history) => {
      const plan = this.find(history, id);
      if (plan.status !== "active" && plan.status !== "proposed")
        throw new Error("Plan cannot be abandoned in its current state");
      plan.status = "abandoned";
      plan.dispositionReason = reason.trim();
      plan.updatedAt = new Date().toISOString();
      return plan;
    });
  }

  private find(history: History, id: string): SessionPlan {
    const plan = history.plans.find((p) => p.id === id);
    if (!plan) throw new Error(`Unknown plan ID: ${id}`);
    return plan;
  }

  private findActive(history: History, id: string): SessionPlan {
    const plan = this.find(history, id);
    if (plan.status !== "active") throw new Error("Plan is no longer active");
    return plan;
  }
}

/** Read-only migration of the retired plan.json + plans/*.done.json format. */

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
