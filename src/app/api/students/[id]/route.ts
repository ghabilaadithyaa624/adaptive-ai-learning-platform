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
  tutorInteractions,
  users,
} from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { getStudentDetail } from "@/lib/queries";
import { badRequest, forbidden } from "@/lib/http";
import { optString, parseId, readJsonBody } from "@/lib/validation";
import { assertStudentAccess, can, isAccountAdmin, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    const { id } = await params;
    const studentId = parseId(id);
    // Authorization: student-self, same-institution staff, or platform admin.
    await assertStudentAccess(user, studentId, "students.read");
    const detail = await getStudentDetail(studentId);
    if (!detail) throw badRequest("Learner not found.");
    await recordAudit({
      actor: user,
      action: "students.read",
      resource: "students",
      resourceId: studentId,
      targetStudentId: studentId,
      ip,
    });
    return ok(detail);
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageStudents", "Learners cannot edit profiles.", "students.update");
    const { id } = await params;
    const studentId = parseId(id);
    await assertStudentAccess(user, studentId, "students.update");

    const body = await readJsonBody(request);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) patch.name = optString(body.name, "name", { max: 120 });
    if (body.email !== undefined) patch.email = optString(body.email, "email", { max: 254 })?.toLowerCase();
    if (body.gradeLevel !== undefined) patch.gradeLevel = optString(body.gradeLevel, "gradeLevel", { max: 60 });
    if (body.cohort !== undefined) patch.cohort = optString(body.cohort, "cohort", { max: 120 });
    if (body.goal !== undefined) patch.goal = optString(body.goal, "goal", { max: 300 });
    if (body.status !== undefined) patch.status = optString(body.status, "status", { max: 20 });
    if (body.avatarColor !== undefined) patch.avatarColor = optString(body.avatarColor, "avatarColor", { max: 16 });
    if (body.institutionId !== undefined) {
      // Only account admins may move a learner between institutions, and never
      // out of / into a tenant they don't administer.
      if (!isAccountAdmin(user)) throw forbidden("You cannot reassign a learner's institution.", "students.update");
      const requested = toNumber(body.institutionId, 0) || null;
      if (user.role === "institution" && requested !== user.institutionId) {
        throw forbidden("You can only keep learners within your own institution.", "students.update");
      }
      patch.institutionId = requested;
    }

    if (!Object.keys(patch).length) throw badRequest("Nothing to update.");

    const [updated] = await db
      .update(users)
      .set(patch)
      .where(and(eq(users.id, studentId), eq(users.role, "student")))
      .returning();
    if (!updated) throw badRequest("Learner not found.");
    await recordAudit({
      actor: user,
      action: "students.update",
      resource: "students",
      resourceId: studentId,
      targetStudentId: studentId,
      ip,
      detail: Object.keys(patch).join(","),
    });
    return ok({ student: updated });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    if (!can.manageStaff(user)) throw forbidden("Only administrators can remove learners.", "students.delete");
    const { id } = await params;
    const studentId = parseId(id);
    await assertStudentAccess(user, studentId, "students.delete");

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
    await db.delete(tutorInteractions).where(eq(tutorInteractions.studentId, studentId));
    await db.delete(users).where(and(eq(users.id, studentId), eq(users.role, "student")));
    await recordAudit({
      actor: user,
      action: "students.delete",
      resource: "students",
      resourceId: studentId,
      targetStudentId: studentId,
      ip,
    });
    return ok({ deleted: true });
  });
}
