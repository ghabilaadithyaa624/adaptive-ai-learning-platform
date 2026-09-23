import { eq } from "drizzle-orm";
import { db } from "@/db";
import { learningPaths, pathMilestones } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { getPaths, logActivity } from "@/lib/queries";
import { clamp, mean, round } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot edit paths.", 403);
    const { id } = await params;
    const pathId = Number(id);
    const body = (await request.json()) as Record<string, unknown>;

    const patch: Partial<typeof learningPaths.$inferInsert> = {};
    if (body.title !== undefined) patch.title = String(body.title);
    if (body.objective !== undefined) patch.objective = String(body.objective);
    if (body.status !== undefined && ["draft", "active", "paused", "completed"].includes(String(body.status))) {
      patch.status = String(body.status);
    }
    if (body.targetMastery !== undefined) patch.targetMastery = clamp(toNumber(body.targetMastery, 0.85), 0.5, 0.99);

    const milestoneRows = await db.select().from(pathMilestones).where(eq(pathMilestones.pathId, pathId));
    if (milestoneRows.length) {
      const progress = mean(
        milestoneRows.map((milestone) => clamp(milestone.currentMastery / (milestone.targetMastery || 0.85))),
      );
      patch.progress = round(progress, 2);
    }

    if (!Object.keys(patch).length) return fail("Nothing to update.");
    const [updated] = await db.update(learningPaths).set(patch).where(eq(learningPaths.id, pathId)).returning();
    if (!updated) return fail("Path not found", 404);
    if (patch.status) {
      await logActivity({
        studentId: updated.studentId,
        type: "path",
        summary: `Path “${updated.title}” moved to ${patch.status}`,
        value: updated.progress,
      });
    }
    return ok({ path: updated });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot delete paths.", 403);
    const { id } = await params;
    const pathId = Number(id);
    await db.delete(pathMilestones).where(eq(pathMilestones.pathId, pathId));
    await db.delete(learningPaths).where(eq(learningPaths.id, pathId));
    return ok({ deleted: true });
  });
}

export async function GET(request: Request, { params }: Params) {
  return withUser(async () => {
    const { id } = await params;
    const pathId = Number(id);
    const rows = await db.select().from(learningPaths).where(eq(learningPaths.id, pathId)).limit(1);
    if (!rows.length) return fail("Path not found", 404);
    const paths = await getPaths(rows[0].studentId);
    return ok({ path: paths.find((entry) => entry.id === pathId) ?? null });
  });
}
