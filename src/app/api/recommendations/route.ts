import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { recommendations } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { getRecommendations, getStudentMastery, buildSkillSignals, logActivity, getPaths } from "@/lib/queries";
import { rankSkills, recommendReviewSkill } from "@/lib/ml/recommender";
import { round } from "@/lib/utils";
import { conflict } from "@/lib/http";
import { readJsonBody } from "@/lib/validation";
import { accessibleStudentIds, assertStudentAccess, isStudent, resolveWritableStudentId } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    const url = new URL(request.url);
    const studentIdParam = url.searchParams.get("studentId");
    const status = url.searchParams.get("status") ?? undefined;
    const statusFilter = status === "all" ? undefined : status;

    if (isStudent(user)) {
      return ok({ recommendations: await getRecommendations({ studentId: user.id, status: statusFilter }) });
    }
    if (studentIdParam) {
      const studentId = Number(studentIdParam);
      await assertStudentAccess(user, studentId, "recommendations.list");
      return ok({ recommendations: await getRecommendations({ studentId, status: statusFilter }) });
    }
    const ids = await accessibleStudentIds(user);
    return ok({ recommendations: await getRecommendations({ status: statusFilter, studentIds: ids ?? undefined }) });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    const body = await readJsonBody(request);
    const studentId = await resolveWritableStudentId(
      user,
      body.studentId ? toNumber(body.studentId, 0) : undefined,
      "recommendations.generate",
    );

    const mastery = await getStudentMastery(studentId);
    if (!mastery.length) throw conflict("No mastery evidence yet — run a diagnostic first.");

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
    await recordAudit({
      actor: user,
      action: "recommendations.generate",
      resource: "recommendations",
      targetStudentId: studentId,
      ip,
    });
    const rows = await getRecommendations({ studentId });
    return ok({ recommendations: rows, generated: inserted.length }, 201);
  });
}
