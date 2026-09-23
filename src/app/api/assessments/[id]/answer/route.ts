import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, assessments } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { gradeItem } from "@/lib/engine";
import { logActivity } from "@/lib/queries";
import { forecastPerformance } from "@/lib/ml/forecast";
import { round } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  return withUser(async (user) => {
    const { id } = await params;
    const assessmentId = Number(id);
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "answer");

    const rows = await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
    const assessment = rows[0];
    if (!assessment) return fail("Assessment not found", 404);
    if (user.role === "student" && assessment.studentId !== user.id) {
      return fail("You can only answer your own sessions.", 403);
    }

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

    if (assessment.status !== "in_progress") return fail("This session is already closed.", 409);

    const itemId = toNumber(body.itemId, 0);
    if (!itemId) return fail("A queued item is required to submit an answer.");
    const studentAnswer = body.studentAnswer === null || body.studentAnswer === undefined ? null : toNumber(body.studentAnswer, -1);
    const responseTimeMs = Math.max(500, toNumber(body.responseTimeMs, 0));

    const result = await gradeItem({ assessmentId, itemId, studentAnswer, responseTimeMs });
    if ("error" in result) return fail(result.error, 400);

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
