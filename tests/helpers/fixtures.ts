/**
 * Deterministic test fixtures + synthetic learner profiles.
 *
 * This module builds a small, fully-specified world with NO randomness and NO
 * dependency on the application seed (`ensureSeeded`, which uses a seeded PRNG).
 * Every value here is fixed, so assertions on adaptive selection, knowledge
 * tracing, recommendations and model training are reproducible run-to-run.
 *
 * Topology
 * --------
 *   Institutions:  Northwind Academy (A)   ·   Eastvale College (B)
 *   Skills (Math): arithmetic → fractions → linear-equations → quadratics
 *                  (a linear prerequisite chain)
 *   People:
 *     - platformAdmin           role=admin,        institution=none (global)
 *     - instAdminA              role=institution,  institution=A
 *     - teacherA                role=teacher,      institution=A
 *     - teacherB                role=teacher,      institution=B
 *     - alice   (ADVANCED)      role=student,      institution=A
 *     - bob     (STRUGGLING)    role=student,      institution=A
 *     - carol   (STALE)         role=student,      institution=B
 *     - dave    (COLD-START)    role=student,      institution=A (no mastery yet)
 *     - erin    (SUSPENDED)     role=student,      institution=A, status=suspended
 *
 * Synthetic learner profiles capture archetypes the adaptive engine must handle:
 *   ADVANCED    — high mastery everywhere, recent practice.
 *   STRUGGLING  — low mastery on foundations, some evidence.
 *   STALE       — high mastery but not practiced for weeks (forgetting curve).
 *   COLD-START  — no mastery evidence at all (brand-new learner).
 */
import { hashPassword } from "@/lib/auth";
import { db } from "@/db";
import {
  assessmentItems,
  assessments,
  institutions,
  masteryStates,
  questions,
  skills,
  subjects,
  users,
} from "@/db/schema";
import { resetDatabase } from "./db";

/** Fixed plaintext password shared by every fixture account. */
export const FIXTURE_PASSWORD = "Sup3rSecret!";

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

export type Ids = Record<string, number>;

export type Fixtures = {
  institutions: { northwind: number; eastvale: number };
  users: {
    platformAdmin: number;
    instAdminA: number;
    teacherA: number;
    teacherB: number;
    alice: number;
    bob: number;
    carol: number;
    dave: number;
    erin: number;
  };
  emails: Record<string, string>;
  subject: number;
  skills: { arithmetic: number; fractions: number; linear: number; quadratics: number };
  /** Servable (published) question ids grouped by skill key. */
  questions: Record<string, number[]>;
  /** A non-servable draft question on arithmetic (never delivered to learners). */
  draftQuestion: number;
  /** A non-servable retired question on arithmetic. */
  retiredQuestion: number;
  /** Alice's completed history assessment (feeds ML training/evaluation). */
  historyAssessment: number;
};

/**
 * Reset the database and insert the deterministic world. Returns a handle with
 * the concrete (serial) ids so tests can reference entities by name.
 */
export async function seedFixtures(): Promise<Fixtures> {
  await resetDatabase();

  /* ------------------------------- tenants ------------------------------- */
  const [northwind, eastvale] = await db
    .insert(institutions)
    .values([
      { name: "Northwind Academy", slug: "northwind", type: "school", plan: "growth", seats: 200 },
      { name: "Eastvale College", slug: "eastvale", type: "university", plan: "enterprise", seats: 500 },
    ])
    .returning({ id: institutions.id });

  /* -------------------------------- people ------------------------------- */
  const pw = hashPassword(FIXTURE_PASSWORD);
  const mk = (
    name: string,
    email: string,
    role: string,
    institutionId: number | null,
    extra: Partial<typeof users.$inferInsert> = {},
  ) => ({ name, email, passwordHash: pw, role, institutionId, ...extra });

  const insertedUsers = await db
    .insert(users)
    .values([
      mk("Platform Admin", "admin@platform.test", "admin", null),
      mk("Ivy Institution", "ivy@northwind.test", "institution", northwind.id),
      mk("Tom Teacher", "tom@northwind.test", "teacher", northwind.id),
      mk("Bea Teacher", "bea@eastvale.test", "teacher", eastvale.id),
      mk("Alice Advanced", "alice@northwind.test", "student", northwind.id, { cohort: "A1", gradeLevel: "Grade 10" }),
      mk("Bob Struggling", "bob@northwind.test", "student", northwind.id, { cohort: "A1", gradeLevel: "Grade 10" }),
      mk("Carol Stale", "carol@eastvale.test", "student", eastvale.id, { cohort: "B1", gradeLevel: "Year 1" }),
      // COLD-START: a Northwind learner with NO mastery evidence yet.
      mk("Dave Coldstart", "dave@northwind.test", "student", northwind.id, { cohort: "New Cohort" }),
      mk("Erin Suspended", "erin@northwind.test", "student", northwind.id, { status: "suspended" }),
    ])
    .returning({ id: users.id, email: users.email });

  const byEmail = new Map(insertedUsers.map((u) => [u.email, u.id]));
  const uid = (email: string) => byEmail.get(email)!;

  const usersHandle = {
    platformAdmin: uid("admin@platform.test"),
    instAdminA: uid("ivy@northwind.test"),
    teacherA: uid("tom@northwind.test"),
    teacherB: uid("bea@eastvale.test"),
    alice: uid("alice@northwind.test"),
    bob: uid("bob@northwind.test"),
    carol: uid("carol@eastvale.test"),
    dave: uid("dave@northwind.test"),
    erin: uid("erin@northwind.test"),
  };

  /* ------------------------------- taxonomy ------------------------------ */
  const [subject] = await db
    .insert(subjects)
    .values([{ name: "Mathematics", code: "MATH", color: "#6366f1" }])
    .returning({ id: subjects.id });

  const [arithmetic] = await db
    .insert(skills)
    .values([{ subjectId: subject.id, name: "Arithmetic", code: "MATH.ARITH", difficultyBase: 0.3, prereqIds: [] }])
    .returning({ id: skills.id });
  const [fractions] = await db
    .insert(skills)
    .values([{ subjectId: subject.id, name: "Fractions", code: "MATH.FRAC", difficultyBase: 0.5, prereqIds: [arithmetic.id] }])
    .returning({ id: skills.id });
  const [linear] = await db
    .insert(skills)
    .values([{ subjectId: subject.id, name: "Linear Equations", code: "MATH.LIN", difficultyBase: 0.7, prereqIds: [fractions.id] }])
    .returning({ id: skills.id });
  const [quadratics] = await db
    .insert(skills)
    .values([{ subjectId: subject.id, name: "Quadratics", code: "MATH.QUAD", difficultyBase: 0.85, prereqIds: [linear.id] }])
    .returning({ id: skills.id });

  const skillsHandle = {
    arithmetic: arithmetic.id,
    fractions: fractions.id,
    linear: linear.id,
    quadratics: quadratics.id,
  };

  /* ------------------------------- questions ----------------------------- */
  // Helper to author a batch of published MCQs on a skill with a known key.
  const publishedQuestion = (
    skillId: number,
    stem: string,
    options: string[],
    correctIndex: number,
    difficultyLabel: "easy" | "medium" | "hard" | "expert",
  ) => ({
    skillId,
    stem,
    options,
    correctIndex,
    difficultyLabel,
    difficultyValue: { easy: 0.3, medium: 0.55, hard: 0.75, expert: 0.9 }[difficultyLabel],
    bloomLevel: "apply",
    explanation: `Because ${stem}`,
    status: "published" as const,
    isActive: true,
    estimatedSeconds: 45,
    publishedAt: daysAgo(30),
  });

  const arithRows = await db
    .insert(questions)
    .values([
      publishedQuestion(arithmetic.id, "2 + 2 = ?", ["3", "4", "5", "6"], 1, "easy"),
      publishedQuestion(arithmetic.id, "7 - 3 = ?", ["3", "4", "5", "2"], 1, "easy"),
      publishedQuestion(arithmetic.id, "6 x 3 = ?", ["18", "16", "9", "12"], 0, "medium"),
    ])
    .returning({ id: questions.id });

  const fracRows = await db
    .insert(questions)
    .values([
      publishedQuestion(fractions.id, "1/2 + 1/2 = ?", ["1", "1/4", "2", "1/2"], 0, "medium"),
      publishedQuestion(fractions.id, "3/4 - 1/4 = ?", ["1/2", "1/4", "2/4", "1"], 0, "medium"),
      publishedQuestion(fractions.id, "2/3 of 9 = ?", ["6", "3", "5", "4"], 0, "hard"),
    ])
    .returning({ id: questions.id });

  const linRows = await db
    .insert(questions)
    .values([
      publishedQuestion(linear.id, "Solve x + 3 = 7", ["4", "10", "3", "7"], 0, "hard"),
      publishedQuestion(linear.id, "Solve 2x = 10", ["5", "8", "20", "12"], 0, "hard"),
      publishedQuestion(linear.id, "Slope of y = 3x + 1", ["3", "1", "4", "0"], 0, "expert"),
    ])
    .returning({ id: questions.id });

  const quadRows = await db
    .insert(questions)
    .values([
      publishedQuestion(quadratics.id, "Roots of x^2 = 9", ["±3", "3", "9", "±9"], 0, "expert"),
      publishedQuestion(quadratics.id, "Vertex x of x^2-4x", ["2", "4", "0", "-2"], 0, "expert"),
    ])
    .returning({ id: questions.id });

  // Non-servable items on arithmetic — the adaptive engine must never deliver these.
  const [draft] = await db
    .insert(questions)
    .values([
      { ...publishedQuestion(arithmetic.id, "DRAFT: 9 + 1 = ?", ["10", "8", "11", "9"], 0, "easy"), status: "draft", isActive: false, publishedAt: null },
    ])
    .returning({ id: questions.id });
  const [retired] = await db
    .insert(questions)
    .values([
      { ...publishedQuestion(arithmetic.id, "RETIRED: 5 + 5 = ?", ["10", "9", "11", "8"], 0, "easy"), status: "retired", isActive: false, retiredAt: daysAgo(5) },
    ])
    .returning({ id: questions.id });

  const questionsHandle: Record<string, number[]> = {
    arithmetic: arithRows.map((r) => r.id),
    fractions: fracRows.map((r) => r.id),
    linear: linRows.map((r) => r.id),
    quadratics: quadRows.map((r) => r.id),
  };

  /* --------------------------- mastery profiles -------------------------- */
  const masteryRow = (
    studentId: number,
    skillId: number,
    mastery: number,
    attempts: number,
    correct: number,
    lastPracticedDaysAgo: number | null,
  ) => ({
    studentId,
    skillId,
    mastery,
    priorMastery: mastery,
    attempts,
    correct,
    streak: 0,
    history: [{ t: daysAgo(lastPracticedDaysAgo ?? 40).toISOString(), m: mastery }],
    lastPracticedAt: lastPracticedDaysAgo === null ? null : daysAgo(lastPracticedDaysAgo),
  });

  await db.insert(masteryStates).values([
    // ADVANCED: alice — high, recent
    masteryRow(usersHandle.alice, arithmetic.id, 0.92, 20, 19, 1),
    masteryRow(usersHandle.alice, fractions.id, 0.88, 18, 16, 2),
    masteryRow(usersHandle.alice, linear.id, 0.8, 14, 11, 3),
    masteryRow(usersHandle.alice, quadratics.id, 0.7, 8, 5, 4),
    // STRUGGLING: bob — low on foundations, thin evidence higher up
    masteryRow(usersHandle.bob, arithmetic.id, 0.35, 10, 4, 2),
    masteryRow(usersHandle.bob, fractions.id, 0.2, 4, 1, 3),
    // STALE: carol — high but untouched for weeks (forgetting)
    masteryRow(usersHandle.carol, arithmetic.id, 0.9, 16, 15, 40),
    masteryRow(usersHandle.carol, fractions.id, 0.82, 12, 10, 45),
    // dave (COLD-START): intentionally NO mastery states.
  ]);

  /* --------- alice's completed history assessment (ML training) ---------- */
  const [history] = await db
    .insert(assessments)
    .values([
      {
        studentId: usersHandle.alice,
        title: "Baseline diagnostic",
        mode: "diagnostic",
        status: "completed",
        targetSkillIds: [arithmetic.id, fractions.id, linear.id],
        itemTarget: 12,
        ability: 0.8,
        score: 0.75,
        startedAt: daysAgo(10),
        completedAt: daysAgo(10),
      },
    ])
    .returning({ id: assessments.id });

  // 12 deterministic graded responses. Outcome correlates with difficulty so the
  // classifier learns a real (reproducible) signal: easy→correct, expert→wrong.
  const historyItems: (typeof assessmentItems.$inferInsert)[] = [];
  const plan: { qid: number; skillId: number; correct: boolean; diff: number }[] = [
    { qid: arithRows[0].id, skillId: arithmetic.id, correct: true, diff: 0.3 },
    { qid: arithRows[1].id, skillId: arithmetic.id, correct: true, diff: 0.3 },
    { qid: arithRows[2].id, skillId: arithmetic.id, correct: true, diff: 0.55 },
    { qid: fracRows[0].id, skillId: fractions.id, correct: true, diff: 0.55 },
    { qid: fracRows[1].id, skillId: fractions.id, correct: true, diff: 0.55 },
    { qid: fracRows[2].id, skillId: fractions.id, correct: false, diff: 0.75 },
    { qid: linRows[0].id, skillId: linear.id, correct: true, diff: 0.75 },
    { qid: linRows[1].id, skillId: linear.id, correct: false, diff: 0.75 },
    { qid: linRows[2].id, skillId: linear.id, correct: false, diff: 0.9 },
    { qid: arithRows[0].id, skillId: arithmetic.id, correct: true, diff: 0.3 },
    { qid: fracRows[0].id, skillId: fractions.id, correct: true, diff: 0.55 },
    { qid: linRows[0].id, skillId: linear.id, correct: false, diff: 0.75 },
  ];
  plan.forEach((p, index) => {
    historyItems.push({
      assessmentId: history.id,
      questionId: p.qid,
      skillId: p.skillId,
      sequence: index + 1,
      studentAnswer: p.correct ? 0 : 3, // any wrong index; correctIndex is 0/1 in fixtures
      isCorrect: p.correct,
      responseTimeMs: 20_000 + index * 500,
      predictedCorrectProb: 0.5,
      assignedDifficulty: p.diff,
      masteryBefore: 0.5 + (p.correct ? 0.1 : -0.1),
      masteryAfter: 0.5 + (p.correct ? 0.15 : -0.15),
      createdAt: new Date(daysAgo(10).getTime() + index * 60_000),
    });
  });
  await db.insert(assessmentItems).values(historyItems);

  return {
    institutions: { northwind: northwind.id, eastvale: eastvale.id },
    users: usersHandle,
    emails: {
      alice: "alice@northwind.test",
      bob: "bob@northwind.test",
      carol: "carol@eastvale.test",
      dave: "dave@northwind.test",
      erin: "erin@northwind.test",
      teacherA: "tom@northwind.test",
      teacherB: "bea@eastvale.test",
      instAdminA: "ivy@northwind.test",
      platformAdmin: "admin@platform.test",
    },
    subject: subject.id,
    skills: skillsHandle,
    questions: questionsHandle,
    draftQuestion: draft.id,
    retiredQuestion: retired.id,
    historyAssessment: history.id,
  };
}
