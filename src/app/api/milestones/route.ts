import { eq, max } from "drizzle-orm";
import { db } from "@/db";
import { learningPaths, masteryStates, pathMilestones } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { clamp, mean, round } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot edit milestones.", 403);
    const body = (await request.json()) as Record<string, unknown>;
    const pathId = toNumber(body.pathId, 0);
    const skillId = toNumber(body.skillId, 0);
    if (!pathId || !skillId) return fail("A path and a skill are required.");

    const paths = await db.select().from(learningPaths).where(eq(learningPaths.id, pathId)).limit(1);
    if (!paths.length) return fail("Path not found", 404);
    const existing = await db.select().from(pathMilestones).where(eq(pathMilestones.pathId, pathId));
    if (existing.some((milestone) => milestone.skillId === skillId)) {
      return fail("That skill is already a milestone on this path.", 409);
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

    return ok({ milestone: created, progress }, 201);
  });
}
