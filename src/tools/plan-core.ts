import { claimRefusalMessage, claimingSession } from "../code/plan-claim.js";
import { type PlanRecord, type PlanRepository, planRepository } from "../code/plans.js";
import { pauseGate } from "../core/pause-gate.js";
import type { ToolCallContext, ToolRegistry } from "../tools.js";
import { coercePlanStep, sanitizeEvidence } from "./plan-sanitize.js";
import type { PlanStep, StepCompletion, StepEvidence } from "./plan-types.js";

const SUBMIT_PLAN_DESCRIPTION =
  "Submit ONE concrete plan for review. The user approves / refines / cancels: write a markdown plan body and (strongly preferred) a structured `steps` array. Use for multi-file refactors, architecture changes, anything expensive to undo. Skip for small fixes. Do NOT use for A/B/C menus: the picker has no branch selector, so a menu plan strands the user; call `ask_choice` for branching decisions. See the system prompt for fuller guidance.";

const MARK_STEP_COMPLETE_DESCRIPTION =
  "Mark exactly one approved-plan step as done, once, only after all work and verification for that step are finished. You MUST call this for every structured step, in plan order, before starting the next step. Do not skip, merge, or silently abandon steps. After the FINAL step is accepted, write a brief reply summarizing what was done and end the turn. If requirements or blockers materially change the work, do not continue against stale steps: stop and submit a new approved plan that reflects the changed requirements.";

const REVISE_PLAN_DESCRIPTION =
  "Replace the REMAINING steps of an in-flight plan only for a checkpoint adjustment that preserves the same requirements. Pass `reason`, the new `remainingSteps` tail (done steps are untouched, keep them out), and optional updated `summary`. If requirements or blockers materially change the scope, do not use this to silently continue: submit a new plan for approval instead.";

// Shared between submit_plan + revise_plan; not `as const` because JSONSchema expects mutable arrays.
const STEP_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable id, e.g. step-1." },
    title: { type: "string", description: "Short imperative title." },
    action: { type: "string", description: "One-sentence concrete action." },
    risk: {
      type: "string",
      enum: ["low", "med", "high"],
      description:
        "high = hard-to-undo / prod / API break; med = reversible multi-file; low = safe local. Omit if unsure.",
    },
    targets: {
      type: "array",
      description: "Optional. Files/dirs/modules this step touches.",
      items: { type: "string" },
    },
    acceptance: {
      type: "string",
      description: "Optional. One-sentence completion criterion.",
    },
    verification: {
      type: "array",
      description: "Optional. Verification commands/checks for this step.",
      items: { type: "string" },
    },
  },
  required: ["id", "title", "action"],
};

// Registration options

export interface PlanToolOptions {
  onPlanSubmitted?: (plan: string, steps?: PlanStep[]) => void;
  onStepCompleted?: (update: StepCompletion) => void;
  onPlanRevisionProposed?: (reason: string, remainingSteps: PlanStep[], summary?: string) => void;
  requireStepEvidence?: (args: { stepId: string; title?: string }) => string | null | undefined;
}

// Arg sanitizers — defensive cleanup shared between submit_plan and revise_plan

function sanitizeSteps(raw: unknown): PlanStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    const step = coercePlanStep(entry, { trim: true });
    if (step) steps.push(step);
  }
  return steps.length > 0 ? steps : undefined;
}

function summarizeEvidence(evidence: StepEvidence[] | undefined): string | undefined {
  if (!evidence || evidence.length === 0) return undefined;
  const parts = evidence.map((item) => `${item.kind}: ${item.summary}`);
  return parts.join("; ");
}

function compactStepCompletion(update: StepCompletion): StepCompletion {
  const compact: StepCompletion = {
    kind: "step_completed",
    stepId: update.stepId,
    result: update.result,
  };
  const evidenceSummary = summarizeEvidence(update.evidence);
  if (evidenceSummary) compact.evidenceSummary = evidenceSummary;
  return compact;
}

/** The workspace-scoped plan store for a tool call, or undefined when the context
 *  carries no workspace root (a direct dispatch outside the loop). */
function repositoryFor(ctx: ToolCallContext | undefined): PlanRepository | undefined {
  return ctx?.rootDir ? planRepository(ctx.rootDir) : undefined;
}

/** Ownership identity of the calling session — the same value every plan tool uses,
 *  so submit/activate/complete/mark all agree on who holds the plan. */
function sessionFor(ctx: ToolCallContext | undefined): string {
  return claimingSession(ctx?.sessionName);
}

/** A refusal is a RESULT, not an error: null means the plan is free, so this is the
 *  single place that answers and words "may I take this plan?" — naming the live holder
 *  so the model can pick a different plan instead of retrying into a wall. */
function rejectionFor(repository: PlanRepository, planId: string, session: string): string | null {
  const refusal = repository.claimable(planId, session);
  if (!refusal) return null;
  return `rejected: ${claimRefusalMessage(refusal.plan.id, refusal.owner)}. One workspace plan belongs to one live session at a time; finish or abandon it in that session, or work a different plan here.`;
}

type PlanTarget = {
  /** Undefined only when the call carries no workspace root (direct dispatch). */
  repository: PlanRepository | undefined;
  session: string;
  /** The plan this session owns and may advance right now. */
  active: PlanRecord | undefined;
  /** Set when the requested planId belongs to another live session. */
  rejection?: string;
};

/** Resolve the plan the calling session may advance for `planId`. A plan another live
 *  session is working answers with a rejection; anything else this session does not own
 *  throws, because that is misuse rather than a question. */
function resolveOwnedPlan(
  toolName: string,
  ctx: ToolCallContext | undefined,
  planId: string | undefined,
): PlanTarget {
  const repository = repositoryFor(ctx);
  const session = sessionFor(ctx);
  // `adoptUnclaimed` so a session resumed over a pre-ownership store still owns the one
  // in-flight plan it was already working instead of being told it has none.
  const active = repository?.activeFor(session, { adoptUnclaimed: true }) ?? undefined;
  if (!repository || (active && planId === active.id)) return { repository, session, active };
  const rejection = planId === undefined ? null : rejectionFor(repository, planId, session);
  if (rejection) return { repository, session, active, rejection };
  throw new Error(`${toolName}: supply the owning active planId`);
}

/** Confirmation-card label for a plan. Never the raw UUID: prefer the one-line
 *  summary, else the first heading/line of the body, else a neutral fallback. */
function planLabel(plan: PlanRecord): string {
  const summary = plan.summary?.trim();
  if (summary) return summary;
  const line = plan.body
    .split("\n")
    .map((text) => text.replace(/^#+\s*/, "").trim())
    .find((text) => text.length > 0);
  return line || "this plan";
}

// Individual tool registrations — one per screen

function registerSubmitPlan(registry: ToolRegistry, opts: PlanToolOptions): void {
  registry.register({
    name: "submit_plan",
    description: SUBMIT_PLAN_DESCRIPTION,
    readOnly: true,
    userIntervention: true,
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description:
            "Markdown plan: one-line summary, file-by-file breakdown, risks/open questions.",
        },
        steps: {
          type: "array",
          description:
            "Structured step list: strongly recommended for >1 step. Stable ids (step-1, step-2, ...).",
          items: STEP_ITEM_SCHEMA,
        },
        summary: {
          type: "string",
          description: "Optional ~80-char plan title for the picker header and the plans list.",
        },
      },
      required: ["plan"],
    },
    fn: async (args: { plan: string; steps?: unknown; summary?: string }, ctx) => {
      const plan = (args?.plan ?? "").trim();
      if (!plan) {
        throw new Error("submit_plan: empty plan: write a markdown plan and try again.");
      }
      const steps = sanitizeSteps(args?.steps);
      const summary =
        typeof args?.summary === "string" ? args.summary.trim() || undefined : undefined;
      const repository = repositoryFor(ctx);
      const session = sessionFor(ctx);
      const record = repository?.propose(plan, steps, summary, session);
      opts.onPlanSubmitted?.(plan, steps);
      // Block until the user approves, refines, or cancels
      const verdict = await (ctx?.confirmationGate ?? pauseGate).ask({
        kind: "plan_proposed",
        payload: {
          plan,
          steps,
          summary,
          callId: ctx?.callId,
          sessionName: ctx?.sessionName,
          planId: record?.id,
        },
      });
      const fb = verdict.feedback?.trim();
      if (record && repository)
        repository.verdict(
          record.id,
          verdict.type === "approve"
            ? "active"
            : verdict.type === "refine"
              ? "refinement_requested"
              : "cancelled",
          session,
        );
      if (verdict.type === "approve") {
        return `${fb ? `plan approved. user's additional instructions: ${fb}` : "plan approved"}${record ? `\nplanId: ${record.id}` : ""}`;
      }
      if (verdict.type === "refine") {
        throw new Error(fb ? `user requested refinement: ${fb}` : "user requested refinement");
      }
      throw new Error(fb ? `plan cancelled: ${fb}` : "plan cancelled");
    },
  });
}

function registerMarkStepComplete(registry: ToolRegistry, opts: PlanToolOptions): void {
  registry.register({
    name: "mark_step_complete",
    description: MARK_STEP_COMPLETE_DESCRIPTION,
    readOnly: true,
    userIntervention: true,
    parameters: {
      type: "object",
      properties: {
        planId: {
          type: "string",
          description: "Owning active plan ID returned by submit_plan or list_plans.",
        },
        stepId: {
          type: "string",
          description: "Step id from submit_plan's steps array.",
        },
        title: {
          type: "string",
          description: "Optional. Echoed for the UI; falls back to id.",
        },
        result: {
          type: "string",
          description: "One-sentence summary of what was done.",
        },
        notes: {
          type: "string",
          description: "Optional. Surprises: blockers, revised assumptions, follow-ups.",
        },
        evidence: {
          type: "array",
          description: "Optional. Verification summary / diff / checkpoint ref / manual note.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["verification", "diff", "checkpoint", "manual"] },
              summary: { type: "string" },
              command: { type: "string" },
              paths: { type: "array", items: { type: "string" } },
            },
            required: ["kind", "summary"],
          },
        },
      },
      required: ["stepId", "result"],
    },
    fn: async (
      args: {
        planId?: string;
        stepId: string;
        title?: string;
        result: string;
        notes?: string;
        evidence?: unknown;
      },
      ctx,
    ) => {
      const stepId = (args?.stepId ?? "").trim();
      const result = (args?.result ?? "").trim();
      if (!stepId) {
        throw new Error("mark_step_complete: stepId is required.");
      }
      if (!result) {
        throw new Error(
          "mark_step_complete: result is required: say in one sentence what you did.",
        );
      }
      const title = typeof args?.title === "string" ? args.title.trim() || undefined : undefined;
      const notes = typeof args?.notes === "string" ? args.notes.trim() || undefined : undefined;
      const evidence = sanitizeEvidence(args?.evidence);
      const evidenceReason = opts.requireStepEvidence?.({ stepId, title });
      if (evidenceReason && (!evidence || evidence.length === 0)) {
        throw new Error(`mark_step_complete: evidence required: ${evidenceReason}`);
      }
      const update: StepCompletion = { kind: "step_completed", stepId, result };
      if (title) update.title = title;
      if (notes) update.notes = notes;
      if (evidence) update.evidence = evidence;
      const { repository, session, active, rejection } = resolveOwnedPlan(
        "mark_step_complete",
        ctx,
        args.planId,
      );
      if (rejection) return rejection;
      if (
        active?.steps.find((s) => !Object.hasOwn(active.completions, s.id))?.id !== stepId &&
        repository
      )
        throw new Error("mark_step_complete: complete the next unfinished step");
      // Block until the user continues, revises, or stops
      const verdict = await (ctx?.confirmationGate ?? pauseGate).ask({
        kind: "plan_checkpoint",
        payload: {
          stepId,
          title,
          result,
          notes,
          completion: update,
          sessionName: ctx?.sessionName,
          planId: active?.id,
        },
      });
      if (verdict.type === "continue") {
        const completed =
          active && repository ? repository.complete(active.id, update, session) : undefined;
        opts.onStepCompleted?.(update);
        return JSON.stringify({
          ...compactStepCompletion(update),
          ...(completed ? { planId: completed.id, status: completed.status } : {}),
        });
      }
      if (verdict.type === "revise") {
        if (verdict.feedback) return `revision requested: ${verdict.feedback}`;
        throw new Error("user requested revision at checkpoint");
      }
      throw new Error("user stopped at checkpoint");
    },
  });
}

function registerRevisePlan(registry: ToolRegistry, opts: PlanToolOptions): void {
  registry.register({
    name: "revise_plan",
    description: REVISE_PLAN_DESCRIPTION,
    readOnly: true,
    userIntervention: true,
    parameters: {
      type: "object",
      properties: {
        planId: { type: "string", description: "Owning active plan ID." },
        reason: {
          type: "string",
          description: "One sentence: why you're revising / what the user asked for.",
        },
        remainingSteps: {
          type: "array",
          description: "New tail of the plan. Reuse old ids when adjusting; new ids for new steps.",
          items: STEP_ITEM_SCHEMA,
        },
        summary: {
          type: "string",
          description: "Optional. Updated one-line summary when framing has shifted.",
        },
      },
      required: ["reason", "remainingSteps"],
    },
    fn: async (
      args: { planId?: string; reason: string; remainingSteps: unknown; summary?: string },
      ctx,
    ) => {
      const reason = (args?.reason ?? "").trim();
      if (!reason) {
        throw new Error(
          "revise_plan: reason is required: write one sentence explaining the change.",
        );
      }
      const remainingSteps = sanitizeSteps(args?.remainingSteps);
      if (!remainingSteps || remainingSteps.length === 0) {
        throw new Error(
          "revise_plan: remainingSteps must be a non-empty array of well-formed steps. If the user wants to STOP rather than continue, don't revise: the picker has its own Stop option.",
        );
      }
      const summary =
        typeof args?.summary === "string" ? args.summary.trim() || undefined : undefined;
      const { repository, session, active, rejection } = resolveOwnedPlan(
        "revise_plan",
        ctx,
        args.planId,
      );
      if (rejection) return rejection;
      opts.onPlanRevisionProposed?.(reason, remainingSteps, summary);
      // Block until the user accepts, rejects, or cancels the revision
      const verdict = await (ctx?.confirmationGate ?? pauseGate).ask({
        kind: "plan_revision",
        payload: {
          reason,
          remainingSteps,
          previousSteps: active
            ? active.steps.filter((step) => !Object.hasOwn(active.completions, step.id))
            : [],
          summary,
          sessionName: ctx?.sessionName,
          planId: active?.id,
        },
      });
      if (verdict.type === "accepted") {
        const revised =
          active && repository
            ? repository.revise(active.id, reason, remainingSteps, session)
            : undefined;
        return revised
          ? JSON.stringify({
              planId: revised.id,
              status: revised.status,
              message: "revision accepted",
            })
          : "revision accepted";
      }
      if (verdict.type === "rejected") throw new Error("revision rejected");
      throw new Error("revision cancelled");
    },
  });
}

// Public entry point

export function registerPlanTool(registry: ToolRegistry, opts: PlanToolOptions = {}): ToolRegistry {
  registerSubmitPlan(registry, opts);
  registerMarkStepComplete(registry, opts);
  registerRevisePlan(registry, opts);
  for (const name of ["list_plans", "open_plan", "abandon_plan", "activate_plan"] as const) {
    const isAbandon = name === "abandon_plan";
    const isActivate = name === "activate_plan";
    registry.register({
      name,
      description:
        name === "list_plans"
          ? "List every persisted plan in this workspace, including plans another live session holds, with IDs, statuses, creation/finish dates and progress. Only the plan this session holds is yours to advance."
          : name === "open_plan"
            ? "Open a session plan by ID: full body, steps, accepted results/evidence, revisions and disposition."
            : isAbandon
              ? "Abandon a session plan by ID and reason after user approval. Retain partial work; never mark it completed. A plan another live session is working is refused."
              : "Make a non-completed session plan the active plan (supersedes this session's current one). A completed plan is immutable and cannot be activated. Asking for a plan another live session is working is refused, naming the holder.",
      readOnly: true,
      userIntervention: isAbandon || isActivate,
      parameters: {
        type: "object",
        properties:
          name === "list_plans"
            ? {}
            : {
                planId: { type: "string" },
                ...(isAbandon ? { reason: { type: "string" } } : {}),
              },
        required: name === "list_plans" ? [] : isAbandon ? ["planId", "reason"] : ["planId"],
      },
      fn: async (args: { planId?: string; reason?: string }, ctx) => {
        const repository = repositoryFor(ctx);
        if (!repository) throw new Error("Plan tools require an owning workspace");
        const session = sessionFor(ctx);
        if (name === "list_plans") return JSON.stringify(repository.list());
        if (!args.planId) throw new Error("planId is required");
        if (name === "open_plan") return JSON.stringify(repository.open(args.planId));
        if (isAbandon) {
          if (!args.reason?.trim()) throw new Error("Abandonment reason is required");
          const plan = repository.open(args.planId);
          // Refuse before asking the user: a live session's plan is not ours to discard.
          const rejection = rejectionFor(repository, args.planId, session);
          if (rejection) return rejection;
          const verdict = await (ctx?.confirmationGate ?? pauseGate).ask({
            kind: "choice",
            payload: {
              question: `Abandon plan "${planLabel(plan)}": ${args.reason}?`,
              options: [
                { id: "abandon", title: "Abandon plan" },
                { id: "keep", title: "Keep plan" },
              ],
              allowCustom: false,
            },
          });
          if (verdict.type !== "pick" || verdict.optionId !== "abandon")
            throw new Error("Abandonment not approved");
          return JSON.stringify(repository.abandon(args.planId, args.reason, session));
        }
        // activate_plan — a completed plan is immutable, so it can never be re-activated.
        const plan = repository.open(args.planId);
        if (plan.status === "completed")
          throw new Error("activate_plan: a completed plan cannot be modified or activated");
        // Asking for a plan another LIVE session is working is answered here, before the
        // user is prompted: accept means this session now owns it, reject names the holder.
        const rejection = rejectionFor(repository, args.planId, session);
        if (rejection) return rejection;
        const verdict = await (ctx?.confirmationGate ?? pauseGate).ask({
          kind: "choice",
          payload: {
            question: `Set plan "${planLabel(plan)}" as the active plan?`,
            options: [
              { id: "activate", title: "Set active" },
              { id: "keep", title: "Keep current" },
            ],
            allowCustom: false,
          },
        });
        if (verdict.type !== "pick" || verdict.optionId !== "activate")
          throw new Error("activation cancelled");
        return JSON.stringify(repository.activate(args.planId, session));
      },
    });
  }
  return registry;
}
