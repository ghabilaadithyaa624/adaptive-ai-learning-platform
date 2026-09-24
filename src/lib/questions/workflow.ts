/**
 * Item editorial workflow — an explicit, guarded state machine.
 *
 *   Draft → Review → Validated → Published → Monitored → Retired
 *
 * Design goals:
 *   • Every state change is a declared, auditable transition (no ad-hoc status
 *     writes scattered through the code).
 *   • AI-generated items are never auto-trusted: they must pass human review and
 *     validation before they can be published, and the reviewer cannot be the
 *     author (separation of duties).
 *   • Only validated content can be published; only published content can be
 *     monitored; anything can be retired.
 */
import type { QuestionSource, QuestionStatus } from "./constants";

export interface WorkflowContext {
  /** Result of running `validateQuestion` against the item's current content. */
  validationPassed: boolean;
  /** Authoring source of the item. */
  source: QuestionSource;
  /** User id of the author. */
  authorId: number | null;
  /** User id performing the transition. */
  actorId: number | null;
  /** Whether the actor has content-review capability. */
  actorCanReview: boolean;
  /** Whether a human review has been recorded (reviewedBy set). */
  hasHumanReview: boolean;
  /** User id that recorded the human review, if any. */
  reviewedById: number | null;
  /** Minimum responses required before an item may be retired for "monitoring" reasons. */
  observedResponses?: number;
}

/** Allowed forward/backward transitions, independent of guards. */
export const ALLOWED_TRANSITIONS: Record<QuestionStatus, QuestionStatus[]> = {
  draft: ["review", "retired"],
  review: ["validated", "draft", "retired"], // back to draft = changes requested
  validated: ["published", "review", "retired"],
  published: ["monitored", "retired"],
  monitored: ["published", "retired"],
  retired: ["draft"], // revive as a new working copy
};

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Decide whether `from → to` is permitted for the given context, applying the
 * editorial guards. Pure and deterministic.
 */
export function canTransition(from: QuestionStatus, to: QuestionStatus, ctx: WorkflowContext): TransitionResult {
  if (from === to) return { ok: false, reason: `Item is already ${to}.` };
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `Cannot move an item from "${from}" to "${to}".` };
  }

  // Guard: promoting into a trusted state requires validation to pass.
  if ((to === "validated" || to === "published") && !ctx.validationPassed) {
    return { ok: false, reason: "The item must pass validation before it can be validated or published." };
  }

  // Guard: approving an item as validated requires review capability.
  if (to === "validated" && !ctx.actorCanReview) {
    return { ok: false, reason: "You do not have permission to review items." };
  }

  // Guard: publishing requires a recorded human review.
  if (to === "published") {
    if (!ctx.actorCanReview) return { ok: false, reason: "You do not have permission to publish items." };
    if (!ctx.hasHumanReview) {
      return { ok: false, reason: "Items must be reviewed by a human before publication." };
    }
    // Separation of duties: AI-generated content cannot be reviewed & published
    // by the same person, and the author cannot be the sole reviewer of AI items.
    if (ctx.source === "ai") {
      if (ctx.reviewedById != null && ctx.authorId != null && ctx.reviewedById === ctx.authorId) {
        return { ok: false, reason: "AI-generated items must be reviewed by someone other than the author." };
      }
      if (ctx.actorId != null && ctx.authorId != null && ctx.actorId === ctx.authorId) {
        return { ok: false, reason: "AI-generated items cannot be published by their author." };
      }
    }
  }

  return { ok: true };
}

/**
 * Compute the field mutations that accompany a transition (timestamps, review
 * bookkeeping). Returns a partial patch; callers merge it with `{ status: to }`.
 */
export function transitionPatch(
  to: QuestionStatus,
  ctx: WorkflowContext,
  now: Date = new Date(),
): Record<string, unknown> {
  const patch: Record<string, unknown> = { status: to };
  if (to === "validated") {
    patch.reviewedById = ctx.actorId;
    patch.reviewedAt = now;
  }
  if (to === "published") {
    patch.publishedAt = now;
    // record reviewer if not already captured
    if (!ctx.hasHumanReview) {
      patch.reviewedById = ctx.actorId;
      patch.reviewedAt = now;
    }
  }
  if (to === "retired") {
    patch.retiredAt = now;
    patch.isActive = false;
  }
  if (to === "published" || to === "monitored") {
    patch.isActive = true;
  }
  if (to === "draft") {
    // reviving/returning to draft clears the trusted markers
    patch.isActive = false;
  }
  return patch;
}

/**
 * Suggested next action label for the UI, given a status.
 */
export function nextWorkflowActions(status: QuestionStatus): { to: QuestionStatus; label: string }[] {
  const labels: Record<QuestionStatus, string> = {
    draft: "Draft",
    review: "Send to review",
    validated: "Mark validated",
    published: "Publish",
    monitored: "Monitor",
    retired: "Retire",
  };
  return (ALLOWED_TRANSITIONS[status] ?? []).map((to) => ({ to, label: labels[to] }));
}
