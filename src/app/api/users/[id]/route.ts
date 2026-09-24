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
  tutorInteractions,
  users,
} from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { hashPassword, revokeUserSessions } from "@/lib/auth";
import { badRequest, forbidden } from "@/lib/http";
import { oneOf, optString, parseId, readJsonBody, validatePassword } from "@/lib/validation";
import { ROLES, assertUserAccess, isPlatformAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    const { id } = await params;
    const targetId = parseId(id);
    // Central check: self, platform admin, or same-tenant account admin.
    const target = await assertUserAccess(user, targetId, { write: true }, "users.update");

    const body = await readJsonBody(request);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) patch.name = optString(body.name, "name", { max: 120 });
    // Only a platform admin may change roles, and never elevate someone to admin
    // implicitly through another path.
    if (body.role !== undefined) {
      if (!isPlatformAdmin(user)) throw forbidden("Only a platform administrator can change roles.", "users.update");
      if (targetId === user.id) throw forbidden("You cannot change your own role.", "users.update");
      patch.role = oneOf(body.role, ROLES, "role");
    }
    if (body.status !== undefined) {
      patch.status = oneOf(body.status, ["active", "invited", "suspended"] as const, "status");
    }
    if (body.cohort !== undefined) patch.cohort = optString(body.cohort, "cohort", { max: 120 });
    if (body.gradeLevel !== undefined) patch.gradeLevel = optString(body.gradeLevel, "gradeLevel", { max: 60 });
    if (body.goal !== undefined) patch.goal = optString(body.goal, "goal", { max: 300 });
    if (body.institutionId !== undefined) {
      // Only platform admins can move accounts across tenants.
      if (!isPlatformAdmin(user)) throw forbidden("You cannot change an account's institution.", "users.update");
      patch.institutionId = toNumber(body.institutionId, 0) || null;
    }
    if (body.avatarColor !== undefined) patch.avatarColor = optString(body.avatarColor, "avatarColor", { max: 16 });
    let passwordChanged = false;
    if (body.password !== undefined) {
      patch.passwordHash = hashPassword(validatePassword(body.password));
      passwordChanged = true;
    }
    if (!Object.keys(patch).length) throw badRequest("Nothing to update.");

    const [updated] = await db.update(users).set(patch).where(eq(users.id, targetId)).returning();
    if (!updated) throw badRequest("Account not found.");

    // Invalidate existing sessions when credentials or access are changed.
    if (passwordChanged || patch.status === "suspended" || patch.role) {
      await revokeUserSessions(targetId);
    }

    await recordAudit({
      actor: user,
      action: "users.update",
      resource: "users",
      resourceId: targetId,
      institutionId: updated.institutionId ?? null,
      ip,
      detail: Object.keys(patch).join(","),
    });
    const { passwordHash: _hash, ...safe } = updated;
    void _hash;
    void target;
    return ok({ user: safe });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    const { id } = await params;
    const targetId = parseId(id);
    if (targetId === user.id) throw badRequest("You cannot delete your own account.");
    // assertUserAccess(write) confines institution admins to their tenant and
    // blocks acting on platform admins; platform admins may delete anyone else.
    await assertUserAccess(user, targetId, { write: true }, "users.delete");

    // Atomic cascade: delete all of the account's dependent rows and the user
    // in a single transaction so a mid-sequence failure cannot leave orphans.
    // DB-level ON DELETE cascades back this up, but the explicit deletes keep
    // the intent obvious and independent of any one constraint.
    const assessmentRows = await db.select({ id: assessments.id }).from(assessments).where(eq(assessments.studentId, targetId));
    const assessmentIds = assessmentRows.map((row) => row.id);
    const pathRows = await db.select({ id: learningPaths.id }).from(learningPaths).where(eq(learningPaths.studentId, targetId));
    const pathIds = pathRows.map((row) => row.id);

    await db.transaction(async (tx) => {
      if (assessmentIds.length) await tx.delete(assessmentItems).where(inArray(assessmentItems.assessmentId, assessmentIds));
      if (pathIds.length) await tx.delete(pathMilestones).where(inArray(pathMilestones.pathId, pathIds));
      await tx.delete(assessments).where(eq(assessments.studentId, targetId));
      await tx.delete(learningPaths).where(eq(learningPaths.studentId, targetId));
      await tx.delete(recommendations).where(eq(recommendations.studentId, targetId));
      await tx.delete(masteryStates).where(eq(masteryStates.studentId, targetId));
      await tx.delete(activityEvents).where(eq(activityEvents.studentId, targetId));
      await tx.delete(tutorInteractions).where(eq(tutorInteractions.studentId, targetId));
      await tx.delete(sessions).where(eq(sessions.userId, targetId));
      await tx.delete(users).where(eq(users.id, targetId));
    });
    await recordAudit({ actor: user, action: "users.delete", resource: "users", resourceId: targetId, ip });
    return ok({ deleted: true });
  });
}
