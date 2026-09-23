import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  activityEvents,
  assessmentItems,
  assessments,
  learningPaths,
  masteryStates,
  pathMilestones,
  recommendations,
  sessions,
  users,
} from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { hashPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withUser(async (user) => {
    const { id } = await params;
    const targetId = Number(id);
    if (user.role !== "admin" && user.role !== "institution" && user.id !== targetId) {
      return fail("You can only edit your own account.", 403);
    }
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.role !== undefined && user.role === "admin") patch.role = String(body.role);
    if (body.status !== undefined) patch.status = String(body.status);
    if (body.cohort !== undefined) patch.cohort = String(body.cohort);
    if (body.gradeLevel !== undefined) patch.gradeLevel = String(body.gradeLevel);
    if (body.goal !== undefined) patch.goal = String(body.goal);
    if (body.institutionId !== undefined) patch.institutionId = toNumber(body.institutionId, 0) || null;
    if (body.avatarColor !== undefined) patch.avatarColor = String(body.avatarColor);
    if (body.password !== undefined && String(body.password).length >= 6) {
      patch.passwordHash = hashPassword(String(body.password));
    }
    if (!Object.keys(patch).length) return fail("Nothing to update.");

    const [updated] = await db.update(users).set(patch).where(eq(users.id, targetId)).returning();
    if (!updated) return fail("Account not found", 404);
    const { passwordHash: _hash, ...safe } = updated;
    void _hash;
    return ok({ user: safe });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role !== "admin") return fail("Only platform admins can delete accounts.", 403);
    const { id } = await params;
    const targetId = Number(id);
    if (targetId === user.id) return fail("You cannot delete your own account.", 400);

    const assessmentRows = await db.select({ id: assessments.id }).from(assessments).where(eq(assessments.studentId, targetId));
    const assessmentIds = assessmentRows.map((row) => row.id);
    const pathRows = await db.select({ id: learningPaths.id }).from(learningPaths).where(eq(learningPaths.studentId, targetId));
    const pathIds = pathRows.map((row) => row.id);

    if (assessmentIds.length) await db.delete(assessmentItems).where(inArray(assessmentItems.assessmentId, assessmentIds));
    if (pathIds.length) await db.delete(pathMilestones).where(inArray(pathMilestones.pathId, pathIds));
    await db.delete(assessments).where(eq(assessments.studentId, targetId));
    await db.delete(learningPaths).where(eq(learningPaths.studentId, targetId));
    await db.delete(recommendations).where(eq(recommendations.studentId, targetId));
    await db.delete(masteryStates).where(eq(masteryStates.studentId, targetId));
    await db.delete(activityEvents).where(eq(activityEvents.studentId, targetId));
    await db.delete(sessions).where(eq(sessions.userId, targetId));
    await db.delete(users).where(eq(users.id, targetId));
    return ok({ deleted: true });
  });
}
