import { eq } from "drizzle-orm";
import { db } from "@/db";
import { learningPaths, pathMilestones } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { getPaths, logActivity } from "@/lib/queries";
import { clamp, mean, round } from "@/lib/utils";
import { badRequest } from "@/lib/http";
import { oneOf, parseId, readJsonBody } from "@/lib/validation";
import { assertPathAccess, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return withAuth(request, async ({ user }) => {
    const { id } = await params;
    const pathId = parseId(id);
    const ref = await assertPathAccess(user, pathId, "paths.read");
    const paths = await getPaths(ref.studentId);
    return ok({ path: paths.find((entry) => entry.id === pathId) ?? null });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "managePaths", "Learners cannot edit paths.", "paths.update");
    const { id } = await params;
    const pathId = parseId(id);
    await assertPathAccess(user, pathId, "paths.update");
    const body = await readJsonBody(request);

    const patch: Partial<typeof learningPaths.$inferInsert> = {};
    if (body.title !== undefined) patch.title = String(body.title).slice(0, 200);
    if (body.objective !== undefined) patch.objective = String(body.objective).slice(0, 500);
    if (body.status !== undefined) {
      patch.status = oneOf(body.status, ["draft", "active", "paused", "completed"] as const, "status");
    }
    if (body.targetMastery !== undefined) patch.targetMastery = clamp(toNumber(body.targetMastery, 0.85), 0.5, 0.99);

    const milestoneRows = await db.select().from(pathMilestones).where(eq(pathMilestones.pathId, pathId));
    if (milestoneRows.length) {
      const progress = mean(
        milestoneRows.map((milestone) => clamp(milestone.currentMastery / (milestone.targetMastery || 0.85))),
      );
      patch.progress = round(progress, 2);
    }

    if (!Object.keys(patch).length) throw badRequest("Nothing to update.");
    const [updated] = await db.update(learningPaths).set(patch).where(eq(learningPaths.id, pathId)).returning();
    if (!updated) throw badRequest("Path not found.");
    if (patch.status) {
      await logActivity({
        studentId: updated.studentId,
        type: "path",
        summary: `Path “${updated.title}” moved to ${patch.status}`,
        value: updated.progress,
      });
    }
    await recordAudit({ actor: user, action: "paths.update", resource: "paths", resourceId: pathId, targetStudentId: updated.studentId, ip });
    return ok({ path: updated });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "managePaths", "Learners cannot delete paths.", "paths.delete");
    const { id } = await params;
    const pathId = parseId(id);
    await assertPathAccess(user, pathId, "paths.delete");
    await db.delete(pathMilestones).where(eq(pathMilestones.pathId, pathId));
    await db.delete(learningPaths).where(eq(learningPaths.id, pathId));
    await recordAudit({ actor: user, action: "paths.delete", resource: "paths", resourceId: pathId, ip });
    return ok({ deleted: true });
  });
}
