import { eq, max } from "drizzle-orm";
import { db } from "@/db";
import { learningPaths, masteryStates, pathMilestones } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { clamp, mean, round } from "@/lib/utils";
import { badRequest, conflict } from "@/lib/http";
import { parseId, readJsonBody } from "@/lib/validation";
import { assertPathAccess, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "managePaths", "Learners cannot edit milestones.", "milestones.create");
    const body = await readJsonBody(request);
    const pathId = parseId(body.pathId, "pathId");
    const skillId = parseId(body.skillId, "skillId");

    // Authorization: the path (and thus its student) must be in the caller's scope.
    const pathRef = await assertPathAccess(user, pathId, "milestones.create");
    const paths = await db.select().from(learningPaths).where(eq(learningPaths.id, pathId)).limit(1);
    if (!paths.length) throw badRequest("Path not found.");
    void pathRef;

    const existing = await db.select().from(pathMilestones).where(eq(pathMilestones.pathId, pathId));
    if (existing.some((milestone) => milestone.skillId === skillId)) {
      throw conflict("That skill is already a milestone on this path.");
    }
    const maxPosition = await db
      .select({ value: max(pathMilestones.position) })
      .from(pathMilestones)
      .where(eq(pathMilestones.pathId, pathId));
    const position = Number(maxPosition[0]?.value ?? existing.length) + 1;

    const stateRows = await db
      .select()
      .from(masteryStates)
      .where(eq(masteryStates.studentId, paths[0].studentId));
    const currentMastery = stateRows.find((state) => state.skillId === skillId)?.mastery ?? 0;

    const [created] = await db
      .insert(pathMilestones)
      .values({
        pathId,
        skillId,
        position,
        status: String(body.status ?? "locked"),
        targetMastery: clamp(toNumber(body.targetMastery, paths[0].targetMastery), 0.5, 0.99),
        currentMastery: round(currentMastery, 3),
        dueDate: body.dueDate ? String(body.dueDate) : null,
      })
      .returning();

    const all = [...existing, created];
    const progress = round(mean(all.map((milestone) => clamp(milestone.currentMastery / (milestone.targetMastery || 0.85)))), 2);
    await db.update(learningPaths).set({ progress }).where(eq(learningPaths.id, pathId));
    await recordAudit({ actor: user, action: "milestones.create", resource: "milestones", resourceId: created.id, targetStudentId: paths[0].studentId, ip });

    return ok({ milestone: created, progress }, 201);
  });
}
