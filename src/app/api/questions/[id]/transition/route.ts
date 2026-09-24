import { eq } from "drizzle-orm";
import { db } from "@/db";
import { questions } from "@/db/schema";
import { ok, withAuth } from "@/lib/api";
import { badRequest, forbidden, notFound } from "@/lib/http";
import { oneOf, optString, parseId, readJsonBody } from "@/lib/validation";
import { can, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { QUESTION_STATUSES } from "@/lib/questions/constants";
import { validateQuestion } from "@/lib/questions/validation";
import { buildValidationContext } from "@/lib/questions/service";
import { canTransition, transitionPatch } from "@/lib/questions/workflow";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Advance an item through the editorial workflow:
 *   Draft → Review → Validated → Published → Monitored → Retired
 * All guards (validation must pass, human review required, AI separation-of-duties)
 * are enforced server-side by `canTransition`.
 */
export async function POST(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageContent", "Learners cannot operate the item workflow.", "questions.transition");
    const { id } = await params;
    const questionId = parseId(id);
    const body = await readJsonBody(request);
    const to = oneOf(body.to, QUESTION_STATUSES, "to");
    const notes = optString(body.notes, "notes", { max: 1000 });

    const [existing] = await db.select().from(questions).where(eq(questions.id, questionId)).limit(1);
    if (!existing) throw notFound("Question not found.");

    // Re-run validation so promotion to validated/published reflects current content.
    const ctx = await buildValidationContext();
    const report = validateQuestion(
      {
        id: questionId,
        stem: existing.stem,
        options: existing.options,
        correctIndex: existing.correctIndex,
        skillId: existing.skillId,
        subskill: existing.subskill,
        prerequisiteSkillIds: existing.prerequisiteSkillIds,
        difficultyLabel: existing.difficultyLabel,
        difficultyValue: existing.difficultyValue,
        bloomLevel: existing.bloomLevel,
        cognitiveComplexity: existing.cognitiveComplexity,
        estimatedSeconds: existing.estimatedSeconds,
        hints: existing.hints,
        distractorMeta: existing.distractorMeta,
        source: existing.source,
      },
      ctx,
    );

    const decision = canTransition(existing.status as never, to, {
      validationPassed: report.valid,
      source: existing.source as never,
      authorId: existing.authorId,
      actorId: user.id,
      actorCanReview: can.reviewContent(user),
      hasHumanReview: existing.reviewedById != null,
      reviewedById: existing.reviewedById,
      observedResponses: existing.exposureCount,
    });

    if (!decision.ok) {
      await recordAudit({
        actor: user,
        action: "questions.transition.denied",
        resource: "questions",
        resourceId: questionId,
        outcome: "denied",
        ip,
        detail: `${existing.status}→${to}: ${decision.reason}`,
      });
      throw forbidden(decision.reason ?? "That transition is not allowed.");
    }

    const patch = transitionPatch(to, {
      validationPassed: report.valid,
      source: existing.source as never,
      authorId: existing.authorId,
      actorId: user.id,
      actorCanReview: can.reviewContent(user),
      hasHumanReview: existing.reviewedById != null,
      reviewedById: existing.reviewedById,
    });
    if (notes) patch.reviewNotes = notes;

    const [updated] = await db.update(questions).set(patch).where(eq(questions.id, questionId)).returning();
    await recordAudit({
      actor: user,
      action: "questions.transition",
      resource: "questions",
      resourceId: questionId,
      ip,
      detail: `${existing.status}→${to}`,
    });
    return ok({ question: updated, from: existing.status, to, warnings: report.warnings });
  });
}
