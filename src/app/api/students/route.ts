import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { masteryStates, skills, users } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { listStudents } from "@/lib/queries";
import { buildLearningPath, rankSkills } from "@/lib/ml/recommender";
import { clamp, round } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(async () => {
    const url = new URL(request.url);
    const search = url.searchParams.get("q") ?? undefined;
    const institutionId = url.searchParams.get("institutionId");
    const students = await listStudents(search, institutionId ? Number(institutionId) : undefined);
    return ok({ students });
  });
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Only educators and administrators can add learners.", 403);
    const body = (await request.json()) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!name || !email) return fail("Name and email are required.");

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) return fail("A learner with that email already exists.", 409);

    const ability = clamp(toNumber(body.ability, 0.45), 0.05, 0.95);
    const [student] = await db
      .insert(users)
      .values({
        name,
        email,
        passwordHash: hashPassword(String(body.password ?? "password123")),
        role: "student",
        gradeLevel: body.gradeLevel ? String(body.gradeLevel) : null,
        cohort: body.cohort ? String(body.cohort) : "New Cohort",
        goal: body.goal ? String(body.goal) : "Complete the personalised mastery plan",
        institutionId: body.institutionId ? toNumber(body.institutionId, 0) || null : user.institutionId,
        avatarColor: String(body.avatarColor ?? "#6366f1"),
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

    return ok({ student, priorities: ranked.map((entry) => entry.priority), plan: plan.milestones.length }, 201);
  });
}
