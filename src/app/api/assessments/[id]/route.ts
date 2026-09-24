import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, assessments } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { computeNextSessionQuestion } from "@/lib/engine";
import { getAssessment } from "@/lib/queries";
import { badRequest, forbidden } from "@/lib/http";
import { oneOf, parseId, readJsonBody } from "@/lib/validation";
import { assertAssessmentAccess, isStudent, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Redact fields that would let a student see the answer key for an item they
 * have not yet answered. Answered items keep the key so review/feedback works.
 */
function redactItemsForStudent(items: { studentAnswer: number | null; correctIndex: number; explanation: string }[]) {
  return items.map((item) =>
    item.studentAnswer === null ? { ...item, correctIndex: -1, explanation: "" } : item,
  );
}

export async function GET(request: Request, { params }: Params) {
  return withAuth(request, async ({ user }) => {
    const { id } = await params;
    const assessmentId = parseId(id);
    const assessment = await assertAssessmentAccess(user, assessmentId, "assessments.read");

    const detail = await getAssessment(assessmentId);
    const isInProgress = assessment.id && detail?.assessment.status === "in_progress";
    const next = isInProgress ? await computeNextSessionQuestion(assessmentId) : null;

    let items = detail?.items ?? [];
    // SECURITY: never expose the answer key for a pending/unanswered item.
    if (isStudent(user)) {
      items = redactItemsForStudent(items as never) as never;
    }

    const progress = detail
      ? {
          answered: detail.items.filter((item) => item.studentAnswer !== null).length,
          total: detail.assessment.itemTarget,
          correct: detail.items.filter((item) => item.isCorrect).length,
        }
      : { answered: 0, total: 0, correct: 0 };
    return ok({ assessment: detail?.assessment ?? null, studentName: detail?.studentName, items, progress, next });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageStudents", "Learners cannot edit sessions.", "assessments.update");
    const { id } = await params;
    const assessmentId = parseId(id);
    await assertAssessmentAccess(user, assessmentId, "assessments.update");

    const body = await readJsonBody(request);
    const patch: Partial<typeof assessments.$inferInsert> = {};
    if (body.title !== undefined) patch.title = String(body.title).slice(0, 200);
    if (body.itemTarget !== undefined) patch.itemTarget = Math.min(20, Math.max(3, toNumber(body.itemTarget, 8)));
    if (body.status !== undefined) {
      patch.status = oneOf(body.status, ["in_progress", "completed", "abandoned"] as const, "status");
      if (patch.status === "completed") patch.completedAt = new Date();
    }
    if (!Object.keys(patch).length) throw badRequest("Nothing to update.");
    const [updated] = await db.update(assessments).set(patch).where(eq(assessments.id, assessmentId)).returning();
    if (!updated) throw badRequest("Assessment not found.");
    await recordAudit({ actor: user, action: "assessments.update", resource: "assessments", resourceId: assessmentId, ip });
    return ok({ assessment: updated });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    if (isStudent(user)) throw forbidden("Learners cannot delete sessions.", "assessments.delete");
    const { id } = await params;
    const assessmentId = parseId(id);
    await assertAssessmentAccess(user, assessmentId, "assessments.delete");
    await db.delete(assessmentItems).where(eq(assessmentItems.assessmentId, assessmentId));
    await db.delete(assessments).where(eq(assessments.id, assessmentId));
    await recordAudit({ actor: user, action: "assessments.delete", resource: "assessments", resourceId: assessmentId, ip });
    return ok({ deleted: true });
  });
}
