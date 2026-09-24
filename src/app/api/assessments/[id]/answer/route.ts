import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, assessments } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { gradeItem } from "@/lib/engine";
import { logActivity } from "@/lib/queries";
import { forecastPerformance } from "@/lib/ml/forecast";
import { round } from "@/lib/utils";
import { badRequest } from "@/lib/http";
import { oneOf, parseId, readJsonBody } from "@/lib/validation";
import { assertAssessmentAccess } from "@/lib/authz";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  return withAuth(request, async ({ user }) => {
    const { id } = await params;
    const assessmentId = parseId(id);
    const body = await readJsonBody(request);
    const action = oneOf(body.action, ["answer", "complete", "abandon"] as const, "action", "answer");

    // Authorization: student-self or same-institution staff / platform admin.
    const assessmentRef = await assertAssessmentAccess(user, assessmentId, "assessments.answer");
    const rows = await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
    const assessment = rows[0];
    if (!assessment) throw badRequest("Assessment not found.");
    void assessmentRef;

    if (action === "complete" || action === "abandon") {
      await db
        .delete(assessmentItems)
        .where(and(eq(assessmentItems.assessmentId, assessmentId), isNull(assessmentItems.studentAnswer)));
      const items = await db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, assessmentId));
      const answered = items.filter((item) => item.studentAnswer !== null);
      if (!answered.length) {
        await db.update(assessments).set({ status: "abandoned", completedAt: new Date() }).where(eq(assessments.id, assessmentId));
        return ok({ abandoned: true, completed: true, summary: null, next: null });
      }
      const correct = answered.filter((item) => item.isCorrect).length;
      const score = round(correct / answered.length, 3);
      await db
        .update(assessments)
        .set({ status: "completed", score, completedAt: new Date() })
        .where(eq(assessments.id, assessmentId));
      await logActivity({
        studentId: assessment.studentId,
        type: "assessment",
        summary: `Ended ${assessment.title} early · ${correct}/${answered.length} correct`,
        value: score,
      });
      return ok({
        completed: true,
        abandoned: false,
        next: null,
        summary: {
          score,
          correct,
          total: answered.length,
          forecastLabel: "insufficient-data",
          predictedNext: score,
          weakestSkill: "—",
          strongestSkill: "—",
        },
      });
    }

    if (assessment.status !== "in_progress") throw badRequest("This session is already closed.");

    const itemId = toNumber(body.itemId, 0);
    if (!itemId) throw badRequest("A queued item is required to submit an answer.");
    const studentAnswer = body.studentAnswer === null || body.studentAnswer === undefined ? null : toNumber(body.studentAnswer, -1);
    const responseTimeMs = Math.max(500, toNumber(body.responseTimeMs, 0));

    const result = await gradeItem({ assessmentId, itemId, studentAnswer, responseTimeMs });
    if ("error" in result) throw badRequest(result.error);

    if (result.completed && result.summary) {
      const priorScores = await db
        .select({ score: assessments.score })
        .from(assessments)
        .where(and(eq(assessments.studentId, assessment.studentId), eq(assessments.status, "completed")));
      const forecast = forecastPerformance(
        priorScores.map((row, index) => ({ label: `S${index + 1}`, value: row.score ?? 0 })),
      );
      await db
        .update(assessments)
        .set({ predictedScore: round(forecast.nextValue, 3), forecastLabel: forecast.trendLabel })
        .where(eq(assessments.id, assessmentId));
      result.summary.predictedNext = round(forecast.nextValue, 3);
      result.summary.forecastLabel = forecast.trendLabel;
    }

    return ok(result);
  });
}
