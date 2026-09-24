import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, masteryStates, pathMilestones, questions, skills } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { clamp } from "@/lib/utils";
import { badRequest } from "@/lib/http";
import { idList, parseId, readJsonBody } from "@/lib/validation";
import { requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageContent", "Learners cannot edit the skill taxonomy.", "skills.update");
    const { id } = await params;
    const skillId = parseId(id);
    const body = await readJsonBody(request);
    const patch: Partial<typeof skills.$inferInsert> = {};
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 200);
    if (body.code !== undefined) patch.code = String(body.code).toUpperCase().slice(0, 40);
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 1000);
    if (body.subjectId !== undefined) patch.subjectId = toNumber(body.subjectId, 1);
    if (body.difficultyBase !== undefined) patch.difficultyBase = clamp(toNumber(body.difficultyBase, 0.5), 0.05, 0.98);
    if (body.gradeBand !== undefined) patch.gradeBand = String(body.gradeBand).slice(0, 40);
    if (body.prereqIds !== undefined) patch.prereqIds = idList(body.prereqIds, "prereqIds").filter((value) => value !== skillId);
    if (!Object.keys(patch).length) throw badRequest("Nothing to update.");

    const [updated] = await db.update(skills).set(patch).where(eq(skills.id, skillId)).returning();
    if (!updated) throw badRequest("Skill not found.");
    await recordAudit({ actor: user, action: "skills.update", resource: "skills", resourceId: skillId, ip });
    return ok({ skill: updated });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageContent", "You do not have permission to delete skills.", "skills.delete");
    const { id } = await params;
    const skillId = parseId(id);
    const questionRows = await db.select({ id: questions.id }).from(questions).where(eq(questions.skillId, skillId));
    const questionIds = questionRows.map((row) => row.id);
    if (questionIds.length) {
      await db.delete(assessmentItems).where(inArray(assessmentItems.questionId, questionIds));
      await db.delete(questions).where(inArray(questions.id, questionIds));
    }
    await db.delete(masteryStates).where(eq(masteryStates.skillId, skillId));
    await db.delete(pathMilestones).where(eq(pathMilestones.skillId, skillId));
    await db.delete(skills).where(eq(skills.id, skillId));
    await recordAudit({ actor: user, action: "skills.delete", resource: "skills", resourceId: skillId, ip });
    return ok({ deleted: true });
  });
}
