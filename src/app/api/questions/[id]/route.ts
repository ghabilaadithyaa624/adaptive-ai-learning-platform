import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, questions } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot edit items.", 403);
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Partial<typeof questions.$inferInsert> = {};
    if (body.stem !== undefined) patch.stem = String(body.stem);
    if (body.skillId !== undefined) patch.skillId = toNumber(body.skillId, 1);
    if (body.options !== undefined) patch.options = (body.options as unknown[]).map((option) => String(option));
    if (body.correctIndex !== undefined) patch.correctIndex = toNumber(body.correctIndex, 0);
    if (body.difficultyLabel !== undefined) patch.difficultyLabel = String(body.difficultyLabel);
    if (body.bloomLevel !== undefined) patch.bloomLevel = String(body.bloomLevel);
    if (body.explanation !== undefined) patch.explanation = String(body.explanation);
    if (body.estimatedSeconds !== undefined) patch.estimatedSeconds = toNumber(body.estimatedSeconds, 60);
    if (body.isActive !== undefined) patch.isActive = Boolean(body.isActive);
    if (!Object.keys(patch).length) return fail("Nothing to update.");

    const [updated] = await db.update(questions).set(patch).where(eq(questions.id, Number(id))).returning();
    if (!updated) return fail("Question not found", 404);
    return ok({ question: updated });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot delete items.", 403);
    const { id } = await params;
    const questionId = Number(id);
    await db.delete(assessmentItems).where(eq(assessmentItems.questionId, questionId));
    await db.delete(questions).where(eq(questions.id, questionId));
    return ok({ deleted: true });
  });
}
