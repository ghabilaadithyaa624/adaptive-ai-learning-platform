import { eq } from "drizzle-orm";
import { db } from "@/db";
import { learningPaths, pathMilestones, skills, subjects } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { getPaths, getStudentMastery, logActivity } from "@/lib/queries";
import { buildLearningPath } from "@/lib/ml/recommender";
import { MASTERY_TARGET, clamp, round } from "@/lib/utils";
import { badRequest, conflict } from "@/lib/http";
import { optBool, readJsonBody } from "@/lib/validation";
import { accessibleStudentIds, assertStudentAccess, isStudent, resolveWritableStudentId } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    const url = new URL(request.url);
    const studentIdParam = url.searchParams.get("studentId");

    if (isStudent(user)) {
      return ok({ paths: await getPaths(user.id) });
    }
    if (studentIdParam) {
      const studentId = Number(studentIdParam);
      await assertStudentAccess(user, studentId, "paths.list");
      return ok({ paths: await getPaths(studentId) });
    }
    const ids = await accessibleStudentIds(user);
    return ok({ paths: await getPaths(undefined, ids ?? undefined) });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    const body = await readJsonBody(request);
    const studentId = await resolveWritableStudentId(
      user,
      body.studentId ? toNumber(body.studentId, 0) : undefined,
      "paths.create",
    );
    const targetMastery = clamp(toNumber(body.targetMastery, MASTERY_TARGET), 0.5, 0.99);
    const autoGenerate = optBool(body.autoGenerate, true);

    const [mastery, skillRows] = await Promise.all([
      getStudentMastery(studentId),
      db
        .select({ skill: skills, subjectName: subjects.name })
        .from(skills)
        .innerJoin(subjects, eq(subjects.id, skills.subjectId)),
    ]);

    let milestones: { skillId: number; targetMastery: number; currentMastery: number; dueDate: string | null; status: string }[] = [];
    let progress = 0;
    let projected: string | null = null;

    if (autoGenerate) {
      if (!mastery.length) throw conflict("No mastery evidence yet — run a diagnostic first.");
      const built = buildLearningPath({
        skills: mastery.map((row) => ({
          id: row.skillId,
          name: row.skillName,
          subjectName: row.subjectName,
          mastery: row.decayed,
          prereqIds: row.prereqIds,
          difficultyBase: row.difficultyBase,
          attempts: row.attempts,
        })),
        targetMastery,
        maxItems: Math.min(8, Math.max(4, toNumber(body.maxItems, 6))),
        horizonDays: toNumber(body.horizonDays, 42),
      });
      milestones = built.milestones;
      progress = built.progress;
      projected = built.projectedCompletion;
    } else {
      const manual = Array.isArray(body.milestones) ? (body.milestones as Record<string, unknown>[]) : [];
      milestones = manual
        .map((entry) => {
          const skillId = toNumber(entry.skillId, 0);
          const row = skillRows.find((candidate) => candidate.skill.id === skillId);
          void row;
          const currentMastery = mastery.find((state) => state.skillId === skillId)?.decayed ?? 0;
          return {
            skillId,
            targetMastery,
            currentMastery: round(currentMastery, 3),
            dueDate: entry.dueDate ? String(entry.dueDate) : null,
            status: String(entry.status ?? "locked"),
          };
        })
        .filter((entry) => entry.skillId > 0);
    }

    if (!milestones.length) throw badRequest("Could not assemble any milestones for this learner.");

    const [path] = await db
      .insert(learningPaths)
      .values({
        studentId,
        title: String(body.title ?? "").trim().slice(0, 200) || "Personalised mastery plan",
        objective: String(body.objective ?? "Close the highest-priority knowledge gaps.").slice(0, 500),
        status: String(body.status ?? "active"),
        strategy: autoGenerate ? "gap-ordered-topological" : "manual",
        targetMastery,
        progress: round(progress, 2),
        projectedCompletion: projected,
      })
      .returning();

    await db.insert(pathMilestones).values(
      milestones.map((milestone, index) => ({
        pathId: path.id,
        skillId: milestone.skillId,
        position: index + 1,
        status: index === 0 && autoGenerate ? "available" : milestone.status ?? "locked",
        targetMastery: milestone.targetMastery,
        currentMastery: milestone.currentMastery,
        dueDate: milestone.dueDate,
      })),
    );

    await logActivity({
      studentId,
      type: "path",
      summary: `Learning path “${path.title}” generated with ${milestones.length} milestones`,
      value: round(progress, 2),
    });
    await recordAudit({ actor: user, action: "paths.create", resource: "paths", resourceId: path.id, targetStudentId: studentId, ip });

    const paths = await getPaths(studentId);
    return ok({ path: paths.find((row) => row.id === path.id) ?? null, paths }, 201);
  });
}
