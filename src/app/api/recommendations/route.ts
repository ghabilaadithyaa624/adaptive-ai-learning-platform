import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { recommendations } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { getRecommendations, getStudentMastery, buildSkillSignals, logActivity } from "@/lib/queries";
import { rankSkills, recommendReviewSkill } from "@/lib/ml/recommender";
import { getPaths } from "@/lib/queries";
import { round } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(async (user) => {
    const url = new URL(request.url);
    const studentIdParam = url.searchParams.get("studentId");
    const studentId = user.role === "student" ? user.id : studentIdParam ? Number(studentIdParam) : undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const rows = await getRecommendations({ studentId, status: status === "all" ? undefined : status });
    return ok({ recommendations: rows });
  });
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as Record<string, unknown>;
    const studentId = user.role === "student" ? user.id : toNumber(body.studentId, 0);
    if (!studentId) return fail("Choose a learner to refresh priorities for.");

    const mastery = await getStudentMastery(studentId);
    if (!mastery.length) return fail("No mastery evidence yet — run a diagnostic first.", 409);

    const paths = await getPaths(studentId);
    const pathSkillIds = paths.flatMap((path) => path.milestones.map((milestone) => milestone.skillId));
    const signals = buildSkillSignals(mastery, pathSkillIds);
    const ranked = rankSkills(signals);
    const review = recommendReviewSkill(signals);
    const fresh = [...(review ? [review] : []), ...ranked].slice(0, 6);

    const pending = await db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(and(eq(recommendations.studentId, studentId), eq(recommendations.status, "new")));
    const dismissed = await db
      .select({ skillId: recommendations.skillId })
      .from(recommendations)
      .where(and(eq(recommendations.studentId, studentId), eq(recommendations.status, "dismissed")));
    const dismissedSkills = new Set(dismissed.map((row) => row.skillId));
    if (pending.length) await db.delete(recommendations).where(inArray(recommendations.id, pending.map((row) => row.id)));

    const values = fresh
      .filter((entry) => !dismissedSkills.has(entry.signal.skillId))
      .map((entry) => ({
        studentId,
        kind: entry.gap > 0.3 ? "skill" : entry.signal.daysSincePractice > 14 ? "review" : "question",
        skillId: entry.signal.skillId,
        title: `${entry.action}: ${entry.signal.skillName}`,
        reason: entry.reason,
        priority: round(entry.priority, 3),
        confidence: entry.confidence,
        factors: entry.factors,
        model: "hybrid-v2",
        status: "new",
      }));

    if (!values.length) return ok({ recommendations: [], message: "No new priorities — learner is on top of every tracked skill." });
    const inserted = await db.insert(recommendations).values(values).returning();
    await logActivity({
      studentId,
      type: "recommendation",
      summary: `Recommendation engine refreshed ${inserted.length} priorities`,
      value: round(inserted[0]?.priority ?? 0, 2),
    });
    const rows = await getRecommendations({ studentId });
    return ok({ recommendations: rows, generated: inserted.length }, 201);
  });
}
