import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, masteryStates, pathMilestones, questions, skills } from "@/db/schema";
import { fail, ok, toIdList, toNumber, withUser } from "@/lib/api";
import { clamp } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot edit the skill taxonomy.", 403);
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Partial<typeof skills.$inferInsert> = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.code !== undefined) patch.code = String(body.code).toUpperCase();
    if (body.description !== undefined) patch.description = String(body.description);
    if (body.subjectId !== undefined) patch.subjectId = toNumber(body.subjectId, 1);
    if (body.difficultyBase !== undefined) patch.difficultyBase = clamp(toNumber(body.difficultyBase, 0.5), 0.05, 0.98);
    if (body.gradeBand !== undefined) patch.gradeBand = String(body.gradeBand);
    if (body.prereqIds !== undefined) patch.prereqIds = toIdList(body.prereqIds).filter((value) => value !== Number(id));
    if (!Object.keys(patch).length) return fail("Nothing to update.");

    const [updated] = await db.update(skills).set(patch).where(eq(skills.id, Number(id))).returning();
    if (!updated) return fail("Skill not found", 404);
    return ok({ skill: updated });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role !== "admin" && user.role !== "institution" && user.role !== "teacher") {
      return fail("Only educators can delete skills.", 403);
    }
    const { id } = await params;
    const skillId = Number(id);
    const questionRows = await db.select({ id: questions.id }).from(questions).where(eq(questions.skillId, skillId));
    const questionIds = questionRows.map((row) => row.id);
    if (questionIds.length) {
      await db.delete(assessmentItems).where(inArray(assessmentItems.questionId, questionIds));
      await db.delete(questions).where(inArray(questions.id, questionIds));
    }
    await db.delete(masteryStates).where(eq(masteryStates.skillId, skillId));
    await db.delete(pathMilestones).where(eq(pathMilestones.skillId, skillId));
    await db.delete(skills).where(eq(skills.id, skillId));
    return ok({ deleted: true });
  });
}
