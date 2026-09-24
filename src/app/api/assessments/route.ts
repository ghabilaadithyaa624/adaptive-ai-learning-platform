import { ok, toIdList, toNumber, withAuth } from "@/lib/api";
import { computeNextSessionQuestion, startAssessment } from "@/lib/engine";
import { listAssessments, getStudentMastery } from "@/lib/queries";
import { readJsonBody, oneOf } from "@/lib/validation";
import { accessibleStudentIds, assertStudentAccess, isStudent, resolveWritableStudentId } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    const url = new URL(request.url);
    const studentIdParam = url.searchParams.get("studentId");

    if (isStudent(user)) {
      return ok({ assessments: await listAssessments(user.id, 80) });
    }
    if (studentIdParam) {
      const studentId = Number(studentIdParam);
      await assertStudentAccess(user, studentId, "assessments.list");
      return ok({ assessments: await listAssessments(studentId, 80) });
    }
    // Staff overview: scope to the caller's institution (null => platform admin).
    const ids = await accessibleStudentIds(user);
    return ok({ assessments: await listAssessments(undefined, 80, ids ?? undefined) });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    const body = await readJsonBody(request);
    const studentId = await resolveWritableStudentId(
      user,
      body.studentId ? toNumber(body.studentId, 0) : undefined,
      "assessments.create",
    );

    let targetSkillIds = toIdList(body.targetSkillIds);
    const mastery = await getStudentMastery(studentId);
    if (!targetSkillIds.length) {
      targetSkillIds = [...mastery]
        .sort((a, b) => a.decayed - b.decayed)
        .slice(0, 3)
        .map((row) => row.skillId);
    }

    const mode = oneOf(body.mode, ["diagnostic", "adaptive_quiz", "practice"] as const, "mode", "adaptive_quiz");
    const itemTarget = Math.min(20, Math.max(3, toNumber(body.itemTarget, 8)));
    const title =
      String(body.title ?? "").trim().slice(0, 200) ||
      (mode === "diagnostic"
        ? `Diagnostic checkpoint — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
          : mode === "practice"
          ? "Targeted practice set"
          : "Adaptive quiz");

    const assessment = await startAssessment({ studentId, title, mode, targetSkillIds, itemTarget });
    const first = await computeNextSessionQuestion(assessment.id);
    await recordAudit({
      actor: user,
      action: "assessments.create",
      resource: "assessments",
      resourceId: assessment.id,
      targetStudentId: studentId,
      ip,
    });
    return ok({ assessmentId: assessment.id, session: first }, 201);
  });
}
