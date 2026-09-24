import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { masteryStates, skills, users } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { listStudents } from "@/lib/queries";
import { buildLearningPath, rankSkills } from "@/lib/ml/recommender";
import { clamp, round } from "@/lib/utils";
import { conflict, forbidden } from "@/lib/http";
import { optString, readJsonBody, reqEmail, reqString, validatePassword } from "@/lib/validation";
import { isPlatformAdmin, requireCapability, studentScope } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    // Learner listing is a staff-facing directory; students cannot enumerate.
    requireCapability(user, "manageStudents", "You do not have permission to list learners.", "students.list");

    const url = new URL(request.url);
    const search = url.searchParams.get("q") ?? undefined;

    const scope = studentScope(user);
    // Tenant isolation: non-platform-admins are pinned to their own institution
    // regardless of any institutionId query param they attempt to pass.
    const institutionId = scope.kind === "institution" ? scope.institutionId : undefined;
    if (scope.kind === "none") return ok({ students: [] });

    const students = await listStudents(search, isPlatformAdmin(user) ? undefined : institutionId);
    return ok({ students });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageStudents", "Only educators and administrators can add learners.", "students.create");
    const body = await readJsonBody(request);
    const name = reqString(body.name, "Name", { max: 120 });
    const email = reqEmail(body.email);

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) throw conflict("A learner with that email already exists.");

    // Tenant isolation on create: staff can only add learners to their own
    // institution. A platform admin may target any institution explicitly.
    let institutionId: number | null;
    if (isPlatformAdmin(user)) {
      institutionId = body.institutionId ? toNumber(body.institutionId, 0) || null : null;
    } else {
      const requested = body.institutionId ? toNumber(body.institutionId, 0) || null : null;
      if (requested != null && requested !== user.institutionId) {
        throw forbidden("You can only add learners to your own institution.", "students.create");
      }
      institutionId = user.institutionId ?? null;
    }

    const ability = clamp(toNumber(body.ability, 0.45), 0.05, 0.95);
    const password = body.password === undefined ? "Password123" : validatePassword(body.password);
    const [student] = await db
      .insert(users)
      .values({
        name,
        email,
        passwordHash: hashPassword(password),
        role: "student",
        gradeLevel: optString(body.gradeLevel, "gradeLevel", { max: 60 }) ?? null,
        cohort: optString(body.cohort, "cohort", { max: 120 }) ?? "New Cohort",
        goal: optString(body.goal, "goal", { max: 300 }) ?? "Complete the personalised mastery plan",
        institutionId,
        avatarColor: optString(body.avatarColor, "avatarColor", { max: 16 }) ?? "#6366f1",
      })
      .returning();

    // Cold-start knowledge tracing: an optimistic prior for every foundational skill
    const allSkills = await db.select().from(skills);
    const prerequisitesMet = allSkills.filter((skill) => (skill.prereqIds ?? []).length === 0);
    const seedStates = (prerequisitesMet.length ? prerequisitesMet : allSkills.slice(0, 4)).map((skill) => {
      const prior = round(clamp(ability - skill.difficultyBase * 0.25, 0.05, 0.9), 3);
      return {
        studentId: student.id,
        skillId: skill.id,
        mastery: prior,
        priorMastery: prior,
        attempts: 0,
        correct: 0,
        streak: 0,
        history: [{ t: new Date().toISOString(), m: prior }],
      };
    });
    if (seedStates.length) await db.insert(masteryStates).values(seedStates);

    const freshStates = await db.select().from(masteryStates).where(and(eq(masteryStates.studentId, student.id)));
    const ranked = rankSkills(
      freshStates.map((state) => {
        const skill = allSkills.find((entry) => entry.id === state.skillId);
        return {
          skillId: state.skillId,
          skillName: skill?.name ?? "Skill",
          subjectName: "Onboarding",
          subjectColor: skill ? "#6366f1" : "#6366f1",
          mastery: state.mastery,
          attempts: state.attempts,
          correct: state.correct,
          daysSincePractice: 30,
          prereqReadiness: 1,
          pathAlignment: 0.2,
          questionCount: 3,
          difficultyBase: skill?.difficultyBase ?? 0.5,
        };
      }),
    ).slice(0, 3);

    const plan = buildLearningPath({
      skills: freshStates.map((state) => ({
        id: state.skillId,
        name: allSkills.find((entry) => entry.id === state.skillId)?.name ?? "Skill",
        subjectName: "Onboarding",
        mastery: state.mastery,
        prereqIds: allSkills.find((entry) => entry.id === state.skillId)?.prereqIds ?? [],
        difficultyBase: allSkills.find((entry) => entry.id === state.skillId)?.difficultyBase ?? 0.5,
        attempts: state.attempts,
      })),
      maxItems: 5,
    });

    await recordAudit({
      actor: user,
      action: "students.create",
      resource: "users",
      resourceId: student.id,
      targetStudentId: student.id,
      institutionId,
      ip,
    });
    return ok({ student, priorities: ranked.map((entry) => entry.priority), plan: plan.milestones.length }, 201);
  });
}
