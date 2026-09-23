import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { fail, ok, toIdList, toNumber, withUser } from "@/lib/api";
import { computeNextSessionQuestion, startAssessment } from "@/lib/engine";
import { listAssessments, getStudentMastery } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(async (user) => {
    const url = new URL(request.url);
    const studentIdParam = url.searchParams.get("studentId");
    const studentId = user.role === "student" ? user.id : studentIdParam ? Number(studentIdParam) : undefined;
    const rows = await listAssessments(studentId, 80);
    return ok({ assessments: rows });
  });
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as Record<string, unknown>;
    const studentId = user.role === "student" ? user.id : toNumber(body.studentId, 0);
    if (!studentId) return fail("Pick a learner to assess.");

    const studentRows = await db.select().from(users).where(eq(users.id, studentId)).limit(1);
    if (!studentRows.length) return fail("Learner not found", 404);

    let targetSkillIds = toIdList(body.targetSkillIds);
    const mastery = await getStudentMastery(studentId);
    if (!targetSkillIds.length) {
      targetSkillIds = [...mastery]
        .sort((a, b) => a.decayed - b.decayed)
        .slice(0, 3)
        .map((row) => row.skillId);
    }

    const mode = ["diagnostic", "adaptive_quiz", "practice"].includes(String(body.mode))
      ? String(body.mode)
      : "adaptive_quiz";
    const itemTarget = Math.min(20, Math.max(3, toNumber(body.itemTarget, 8)));
    const title =
      String(body.title ?? "").trim() ||
      (mode === "diagnostic"
        ? `Diagnostic checkpoint — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
        : mode === "practice"
          ? "Targeted practice set"
          : "Adaptive quiz");

    const assessment = await startAssessment({ studentId, title, mode, targetSkillIds, itemTarget });
    const first = await computeNextSessionQuestion(assessment.id);
    return ok({ assessmentId: assessment.id, session: first }, 201);
  });
}
