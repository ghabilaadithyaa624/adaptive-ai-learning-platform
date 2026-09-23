import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  activityEvents,
  assessmentItems,
  assessments,
  learningPaths,
  masteryStates,
  pathMilestones,
  recommendations,
  users,
} from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { getStudentDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return withUser(async () => {
    const { id } = await params;
    const detail = await getStudentDetail(Number(id));
    if (!detail) return fail("Learner not found", 404);
    return ok(detail);
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot edit profiles.", 403);
    const { id } = await params;
    const studentId = Number(id);
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.email !== undefined) patch.email = String(body.email).toLowerCase();
    if (body.gradeLevel !== undefined) patch.gradeLevel = String(body.gradeLevel);
    if (body.cohort !== undefined) patch.cohort = String(body.cohort);
    if (body.goal !== undefined) patch.goal = String(body.goal);
    if (body.status !== undefined) patch.status = String(body.status);
    if (body.institutionId !== undefined) patch.institutionId = toNumber(body.institutionId, 0) || null;
    if (body.avatarColor !== undefined) patch.avatarColor = String(body.avatarColor);

    if (!Object.keys(patch).length) return fail("Nothing to update.");

    const [updated] = await db
      .update(users)
      .set(patch)
      .where(and(eq(users.id, studentId), eq(users.role, "student")))
      .returning();
    if (!updated) return fail("Learner not found", 404);
    return ok({ student: updated });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role !== "admin" && user.role !== "institution") {
      return fail("Only administrators can remove learners.", 403);
    }
    const { id } = await params;
    const studentId = Number(id);
    const assessmentRows = await db.select({ id: assessments.id }).from(assessments).where(eq(assessments.studentId, studentId));
    const assessmentIds = assessmentRows.map((row) => row.id);
    const pathRows = await db.select({ id: learningPaths.id }).from(learningPaths).where(eq(learningPaths.studentId, studentId));
    const pathIds = pathRows.map((row) => row.id);

    if (assessmentIds.length) await db.delete(assessmentItems).where(inArray(assessmentItems.assessmentId, assessmentIds));
    if (pathIds.length) await db.delete(pathMilestones).where(inArray(pathMilestones.pathId, pathIds));
    await db.delete(assessments).where(eq(assessments.studentId, studentId));
    await db.delete(learningPaths).where(eq(learningPaths.studentId, studentId));
    await db.delete(recommendations).where(eq(recommendations.studentId, studentId));
    await db.delete(masteryStates).where(eq(masteryStates.studentId, studentId));
    await db.delete(activityEvents).where(eq(activityEvents.studentId, studentId));
    await db.delete(users).where(and(eq(users.id, studentId), eq(users.role, "student")));
    return ok({ deleted: true });
  });
}
