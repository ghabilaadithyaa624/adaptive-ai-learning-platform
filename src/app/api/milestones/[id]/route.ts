import { eq } from "drizzle-orm";
import { db } from "@/db";
import { learningPaths, masteryStates, pathMilestones } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { logActivity } from "@/lib/queries";
import { clamp, mean, round } from "@/lib/utils";
import { badRequest } from "@/lib/http";
import { oneOf, parseId, readJsonBody } from "@/lib/validation";
import { assertMilestoneAccess, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "managePaths", "Learners cannot edit milestones.", "milestones.update");
    const { id } = await params;
    const milestoneId = parseId(id);
    await assertMilestoneAccess(user, milestoneId, "milestones.update");
    const body = await readJsonBody(request);

    const rows = await db.select().from(pathMilestones).where(eq(pathMilestones.id, milestoneId)).limit(1);
    const milestone = rows[0];
    if (!milestone) throw badRequest("Milestone not found.");

    const patch: Partial<typeof pathMilestones.$inferInsert> = {};
    if (body.status !== undefined) {
      patch.status = oneOf(body.status, ["locked", "available", "in_progress", "completed"] as const, "status");
      patch.completedAt = patch.status === "completed" ? new Date() : null;
    }
    if (body.targetMastery !== undefined) patch.targetMastery = clamp(toNumber(body.targetMastery, 0.85), 0.5, 0.99);
    if (body.dueDate !== undefined) patch.dueDate = body.dueDate ? String(body.dueDate) : null;

    if (patch.status === "completed") {
      const path = await db.select().from(learningPaths).where(eq(learningPaths.id, milestone.pathId)).limit(1);
      const studentId = path[0]?.studentId;
      if (studentId) {
        const stateRows = await db.select().from(masteryStates).where(eq(masteryStates.studentId, studentId));
        const state = stateRows.find((entry) => entry.skillId === milestone.skillId);
        const currentMastery = Math.max(state?.mastery ?? 0, patch.targetMastery ?? milestone.targetMastery);
        patch.currentMastery = round(currentMastery, 3);
        if (state) {
          await db
            .update(masteryStates)
            .set({
              mastery: round(currentMastery, 3),
              history: [...(state.history ?? []), { t: new Date().toISOString(), m: round(currentMastery, 3) }].slice(-40),
              updatedAt: new Date(),
            })
            .where(eq(masteryStates.id, state.id));
        } else {
          await db.insert(masteryStates).values({
            studentId,
            skillId: milestone.skillId,
            mastery: round(currentMastery, 3),
            priorMastery: round(currentMastery, 3),
            attempts: 0,
            correct: 0,
            streak: 0,
            history: [{ t: new Date().toISOString(), m: round(currentMastery, 3) }],
            lastPracticedAt: new Date(),
          });
        }
      }
    }

    if (!Object.keys(patch).length) throw badRequest("Nothing to update.");
    const [updated] = await db.update(pathMilestones).set(patch).where(eq(pathMilestones.id, milestoneId)).returning();

    const siblings = await db.select().from(pathMilestones).where(eq(pathMilestones.pathId, milestone.pathId));
    const progress = round(
      mean(siblings.map((entry) => clamp(entry.currentMastery / (entry.targetMastery || 0.85)))),
      2,
    );
    const [path] = await db
      .update(learningPaths)
      .set({ progress })
      .where(eq(learningPaths.id, milestone.pathId))
      .returning();

    await logActivity({
      studentId: path?.studentId ?? null,
      type: "path",
      skillId: milestone.skillId,
      summary: `Milestone #${milestone.position} marked ${patch.status ?? "updated"} on “${path?.title ?? "path"}”`,
      value: progress,
    });
    await recordAudit({ actor: user, action: "milestones.update", resource: "milestones", resourceId: milestoneId, ip });

    return ok({ milestone: updated, progress });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "managePaths", "Learners cannot edit milestones.", "milestones.delete");
    const { id } = await params;
    const milestoneId = parseId(id);
    await assertMilestoneAccess(user, milestoneId, "milestones.delete");
    const rows = await db.select().from(pathMilestones).where(eq(pathMilestones.id, milestoneId)).limit(1);
    if (!rows.length) throw badRequest("Milestone not found.");
    await db.delete(pathMilestones).where(eq(pathMilestones.id, milestoneId));
    const siblings = await db.select().from(pathMilestones).where(eq(pathMilestones.pathId, rows[0].pathId));
    const progress = siblings.length
      ? round(mean(siblings.map((entry) => clamp(entry.currentMastery / (entry.targetMastery || 0.85)))), 2)
      : 0;
    await db.update(learningPaths).set({ progress }).where(eq(learningPaths.id, rows[0].pathId));
    await recordAudit({ actor: user, action: "milestones.delete", resource: "milestones", resourceId: milestoneId, ip });
    return ok({ deleted: true, progress });
  });
}
