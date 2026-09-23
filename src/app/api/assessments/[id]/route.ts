import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, assessments } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { computeNextSessionQuestion } from "@/lib/engine";
import { getAssessment } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return withUser(async (user) => {
    const { id } = await params;
    const assessmentId = Number(id);
    const rows = await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
    const assessment = rows[0];
    if (!assessment) return fail("Assessment not found", 404);
    if (user.role === "student" && assessment.studentId !== user.id) {
      return fail("You can only open your own sessions.", 403);
    }
    const detail = await getAssessment(assessmentId);
    const next = assessment.status === "in_progress" ? await computeNextSessionQuestion(assessmentId) : null;
    const progress = detail
      ? {
          answered: detail.items.filter((item) => item.studentAnswer !== null).length,
          total: assessment.itemTarget,
          correct: detail.items.filter((item) => item.isCorrect).length,
        }
      : { answered: 0, total: assessment.itemTarget, correct: 0 };
    return ok({ assessment: detail?.assessment ?? assessment, studentName: detail?.studentName, items: detail?.items ?? [], progress, next });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot edit sessions.", 403);
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Partial<typeof assessments.$inferInsert> = {};
    if (body.title !== undefined) patch.title = String(body.title);
    if (body.itemTarget !== undefined) patch.itemTarget = Math.min(20, Math.max(3, toNumber(body.itemTarget, 8)));
    if (body.status !== undefined && ["in_progress", "completed", "abandoned"].includes(String(body.status))) {
      patch.status = String(body.status);
      if (String(body.status) === "completed") patch.completedAt = new Date();
    }
    if (!Object.keys(patch).length) return fail("Nothing to update.");
    const [updated] = await db.update(assessments).set(patch).where(eq(assessments.id, Number(id))).returning();
    if (!updated) return fail("Assessment not found", 404);
    return ok({ assessment: updated });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot delete sessions.", 403);
    const { id } = await params;
    const assessmentId = Number(id);
    await db.delete(assessmentItems).where(eq(assessmentItems.assessmentId, assessmentId));
    await db.delete(assessments).where(eq(assessments.id, assessmentId));
    return ok({ deleted: true });
  });
}
