import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  activityEvents,
  assessmentItems,
  assessments,
  institutions,
  learningPaths,
  masteryStates,
  pathMilestones,
  questions,
  recommendations,
  skills,
  subjects,
  users,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { QUESTION_BANK, SEED_SKILLS, SEED_STAFF, SEED_STUDENTS, SEED_SUBJECTS } from "@/lib/seed-content";
import { DEFAULT_BKT, posterior } from "@/lib/ml/knowledge-tracing";
import { buildLearningPath, rankSkills } from "@/lib/ml/recommender";
import { forecastPerformance } from "@/lib/ml/forecast";
import { trainAndPersistClassifier } from "@/lib/ml/registry";
import { computeAndPersistItemStatistics } from "@/lib/questions/analytics";
import { MASTERY_TARGET, clamp, mean, round, seededRandom } from "@/lib/utils";

const DIFFICULTY_VALUE: Record<string, number> = { easy: 0.3, medium: 0.55, hard: 0.75, expert: 0.9 };
const BLOOM_VALUE: Record<string, number> = { remember: 1, understand: 2, apply: 3, analyze: 4, evaluate: 5, create: 6 };

const SEED_INSTITUTIONS = [
  { name: "Northwood Academy", slug: "northwood-academy", type: "school", plan: "growth", region: "North America", seats: 1250 },
  { name: "Helix Institute of Technology", slug: "helix-institute", type: "university", plan: "enterprise", region: "Europe", seats: 8400 },
  { name: "Ascend Skills Bootcamp", slug: "ascend-skills", type: "bootcamp", plan: "starter", region: "APAC", seats: 460 },
  { name: "Veridian Corporate Learning", slug: "veridian-learning", type: "corporate", plan: "enterprise", region: "Global", seats: 3100 },
];

const AVATAR_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#ef4444"];

async function runSeed() {
  const existing = await db.select({ total: sql<number>`count(*)::int` }).from(users);
  if (Number(existing[0]?.total ?? 0) > 0) return;

  const rand = seededRandom(20260214);
  const now = Date.now();
  const daysAgo = (days: number, jitterHours = 0) =>
    new Date(now - days * 86_400_000 - Math.round(rand() * jitterHours) * 3_600_000);

  /* ---------------- institutions ---------------- */
  const institutionRows = await db.insert(institutions).values(SEED_INSTITUTIONS).returning();

  /* ---------------- users ---------------- */
  const passwordHash = hashPassword("password123");
  const studentRows = await db
    .insert(users)
    .values(
      SEED_STUDENTS.map((student, index) => ({
        name: student.name,
        email: student.email,
        passwordHash,
        role: "student",
        institutionId: institutionRows[student.institution]?.id ?? null,
        gradeLevel: student.gradeLevel,
        cohort: student.cohort,
        avatarColor: AVATAR_COLORS[index % AVATAR_COLORS.length],
        goal: student.goal,
        status: "active",
        createdAt: daysAgo(120 - index * 4),
      })),
    )
    .returning();

  const staffRows = await db
    .insert(users)
    .values(
      SEED_STAFF.map((member, index) => ({
        name: member.name,
        email: member.email,
        passwordHash,
        role: member.role,
        institutionId: member.institution === null ? null : institutionRows[member.institution]?.id ?? null,
        cohort: member.cohort,
        avatarColor: AVATAR_COLORS[(index + 3) % AVATAR_COLORS.length],
        goal: member.goal,
        status: "active",
        createdAt: daysAgo(200),
      })),
    )
    .returning();

  /* ---------------- taxonomy ---------------- */
  const subjectRows = await db.insert(subjects).values(SEED_SUBJECTS).returning();
  const subjectByCode = new Map(subjectRows.map((row) => [row.code, row]));

  const insertedSkills = await db
    .insert(skills)
    .values(
      SEED_SKILLS.map((skill) => ({
        subjectId: subjectByCode.get(skill.subjectCode)?.id ?? subjectRows[0].id,
        name: skill.name,
        code: skill.code,
        description: skill.description,
        difficultyBase: skill.difficultyBase,
        gradeBand: skill.gradeBand,
        prereqIds: [] as number[],
      })),
    )
    .returning();

  const skillByCode = new Map(insertedSkills.map((row) => [row.code, row]));
  for (const seedSkill of SEED_SKILLS) {
    const row = skillByCode.get(seedSkill.code);
    if (!row) continue;
    const prereqIds = seedSkill.prereqs.map((code) => skillByCode.get(code)?.id).filter((id): id is number => Boolean(id));
    if (prereqIds.length) {
      await db.update(skills).set({ prereqIds }).where(sql`${skills.id} = ${row.id}`);
      row.prereqIds = prereqIds;
    }
  }

  // Map Bloom → Depth-of-Knowledge for a sensible cognitive-complexity default.
  const BLOOM_TO_DOK: Record<string, string> = {
    remember: "recall",
    understand: "skill_concept",
    apply: "skill_concept",
    analyze: "strategic_thinking",
    evaluate: "strategic_thinking",
    create: "extended_thinking",
  };
  const authorPool = staffRows.map((s) => s.id);
  const reviewerId = staffRows.find((s) => s.role === "admin")?.id ?? authorPool[authorPool.length - 1];

  let qIndex = 0;
  const questionValues = Object.entries(QUESTION_BANK).flatMap(([code, items]) => {
    const skill = skillByCode.get(code);
    if (!skill) return [];
    return items.map(([stem, options, correctIndex, difficultyLabel, bloomLevel, explanation]) => {
      const i = qIndex++;
      // Most items are published/monitored (servable); a deterministic minority
      // demonstrates the rest of the workflow, including an AI-authored draft that
      // has NOT been auto-trusted.
      let status = "published";
      let source = "human";
      let isActive = true;
      let reviewed = true;
      if (i % 7 === 0) status = "monitored";
      if (i % 29 === 3) {
        status = "draft";
        isActive = false;
        reviewed = false;
      } else if (i % 31 === 5) {
        status = "review";
        isActive = false;
        reviewed = false;
      } else if (i % 37 === 9) {
        status = "validated";
        isActive = false;
      } else if (i % 41 === 11) {
        status = "retired";
        isActive = false;
      } else if (i % 43 === 13) {
        status = "draft";
        source = "ai";
        isActive = false;
        reviewed = false;
      }
      const servable = status === "published" || status === "monitored";
      return {
        skillId: skill.id,
        subskill: null as string | null,
        prerequisiteSkillIds: [] as number[],
        stem,
        options,
        correctIndex,
        difficultyLabel,
        difficultyValue: DIFFICULTY_VALUE[difficultyLabel] ?? 0.55,
        bloomLevel,
        cognitiveComplexity: BLOOM_TO_DOK[bloomLevel] ?? "skill_concept",
        explanation,
        hints: [] as string[],
        distractorMeta: [] as { optionIndex: number; misconception?: string; rationale?: string }[],
        estimatedSeconds: 45 + Math.round(DIFFICULTY_VALUE[difficultyLabel] * 90),
        authorId: source === "ai" ? reviewerId : authorPool[i % authorPool.length],
        source,
        version: 1,
        status,
        reviewedById: reviewed ? reviewerId : null,
        reviewedAt: reviewed ? daysAgo(80) : null,
        publishedAt: servable ? daysAgo(75) : null,
        retiredAt: status === "retired" ? daysAgo(20) : null,
        isActive,
        createdAt: daysAgo(90),
      };
    });
  });
  const questionRows = await db.insert(questions).values(questionValues).returning();
  // Learners only ever see servable (published/monitored) items, so the response
  // simulation draws from that pool exclusively.
  const questionsBySkill = new Map<number, typeof questionRows>();
  for (const question of questionRows) {
    if (question.status !== "published" && question.status !== "monitored") continue;
    const list = questionsBySkill.get(question.skillId) ?? [];
    list.push(question);
    questionsBySkill.set(question.skillId, list);
  }

  /* ---------------- learner simulation ---------------- */
  type Impact = {
    skillId: number;
    mastery: number;
    priorMastery: number;
    attempts: number;
    correct: number;
    streak: number;
    lastPracticedAt: Date;
    history: { t: string; m: number }[];
  };

  const masteryValues: (typeof masteryStates.$inferInsert)[] = [];
  const assessmentValues: (typeof assessments.$inferInsert)[] = [];
  const itemDrafts: {
    studentIndex: number;
    assessmentTitle: string;
    skillId: number;
    questionId: number;
    sequence: number;
    studentAnswer: number;
    isCorrect: boolean;
    responseTimeMs: number;
    predictedCorrectProb: number;
    assignedDifficulty: number;
    masteryBefore: number;
    masteryAfter: number;
  }[] = [];
  const activityValues: (typeof activityEvents.$inferInsert)[] = [];
  const impactByStudent = new Map<number, Map<number, Impact>>();
  const depthOf = (code: string, seen = new Set<string>()): number => {
    const skill = SEED_SKILLS.find((row) => row.code === code);
    if (!skill || seen.has(code)) return 0;
    seen.add(code);
    return skill.prereqs.length ? 1 + Math.max(...skill.prereqs.map((prereq) => depthOf(prereq, seen))) : 0;
  };

  SEED_STUDENTS.forEach((seedStudent, studentIndex) => {
    const student = studentRows[studentIndex];
    const impacts = new Map<number, Impact>();
    impactByStudent.set(student.id, impacts);

    const focusSkills = SEED_SKILLS.filter((skill) => seedStudent.subjectFocus.includes(skill.subjectCode)).sort(
      (a, b) => depthOf(a.code) - depthOf(b.code) || a.difficultyBase - b.difficultyBase,
    );
    const targetSkillCount = 6 + Math.floor(rand() * 6);
    const chosen = focusSkills.slice(0, targetSkillCount);
    const ability = clamp(seedStudent.ability + (rand() - 0.5) * 0.08, 0.1, 0.95);

    let sessionDay = 62;
    chosen.forEach((seedSkill, skillIndex) => {
      const skill = skillByCode.get(seedSkill.code);
      if (!skill) return;
      const pool = questionsBySkill.get(skill.id) ?? [];
      if (!pool.length) return;

      let mastery = clamp(ability - skill.difficultyBase * 0.32 + (rand() - 0.5) * 0.3, 0.08, 0.95);
      const priorMastery = mastery;
      let attempts = 0;
      let correct = 0;
      let streak = 0;
      const history: { t: string; m: number }[] = [];
      const sessionCount = 1 + (rand() < 0.55 ? 1 : 0);

      for (let session = 0; session < sessionCount; session += 1) {
        const itemCount = 3 + Math.floor(rand() * 3);
        const startedAt = daysAgo(Math.max(1, sessionDay - rand() * 6), 8);
        let sessionCorrect = 0;
        const sequenceItems: typeof itemDrafts = [];
        for (let index = 0; index < itemCount; index += 1) {
          const question = pool[Math.floor(rand() * pool.length)];
          const difficulty = DIFFICULTY_VALUE[question.difficultyLabel] ?? 0.55;
          const difficultyOffset = (difficulty - 0.55) * 0.28;
          const predicted = clamp(mastery * (1 - DEFAULT_BKT.slip) + (1 - mastery) * DEFAULT_BKT.guess - difficultyOffset, 0.04, 0.96);
          const isCorrect = rand() < predicted;
          const masteryBefore = mastery;
          mastery = posterior(mastery, isCorrect, DEFAULT_BKT);
          attempts += 1;
          if (isCorrect) {
            correct += 1;
            sessionCorrect += 1;
            streak += 1;
          } else {
            streak = 0;
          }
          sequenceItems.push({
            studentIndex,
            assessmentTitle: "",
            skillId: skill.id,
            questionId: question.id,
            sequence: index + 1,
            studentAnswer: isCorrect ? question.correctIndex : (question.correctIndex + 1 + Math.floor(rand() * 3)) % question.options.length,
            isCorrect,
            responseTimeMs: Math.round((8_000 + rand() * 26_000) * (0.6 + difficulty)),
            predictedCorrectProb: round(predicted, 3),
            assignedDifficulty: round(difficulty, 3),
            masteryBefore: round(masteryBefore, 3),
            masteryAfter: round(mastery, 3),
          });
        }

        const mode = session === 0 ? (skillIndex === 0 ? "diagnostic" : "practice") : "adaptive_quiz";
        const title = `${skill.name} — ${mode === "diagnostic" ? "diagnostic checkpoint" : mode === "practice" ? "targeted practice" : "adaptive set"}`;
        assessmentValues.push({
          studentId: student.id,
          title,
          mode,
          status: "completed",
          targetSkillIds: [skill.id],
          itemTarget: itemCount,
          ability: round(mastery, 3),
          score: round(sessionCorrect / itemCount, 3),
          predictedScore: null,
          forecastLabel: null,
          startedAt,
          completedAt: new Date(startedAt.getTime() + itemCount * 75_000),
        });
        sequenceItems.forEach((item) => itemDrafts.push({ ...item, assessmentTitle: title }));
        history.push({ t: startedAt.toISOString(), m: round(mastery, 3) });
        activityValues.push({
          studentId: student.id,
          type: "assessment",
          skillId: skill.id,
          summary: `Completed ${title} · ${sessionCorrect}/${itemCount} correct`,
          value: round(sessionCorrect / itemCount, 3),
          createdAt: new Date(startedAt.getTime() + itemCount * 75_000),
        });
        sessionDay = Math.max(1, sessionDay - (6 + rand() * 9));
      }

      impacts.set(skill.id, {
        skillId: skill.id,
        mastery: round(mastery, 3),
        priorMastery: round(priorMastery, 3),
        attempts,
        correct,
        streak,
        lastPracticedAt: daysAgo(Math.max(0.5, sessionDay - rand() * 4), 6),
        history,
      });

      masteryValues.push({
        studentId: student.id,
        skillId: skill.id,
        mastery: round(mastery, 3),
        priorMastery: round(priorMastery, 3),
        attempts,
        correct,
        streak,
        slip: DEFAULT_BKT.slip,
        guess: DEFAULT_BKT.guess,
        learnRate: DEFAULT_BKT.learn,
        history,
        lastPracticedAt: daysAgo(Math.max(0.5, sessionDay - rand() * 3), 5),
        updatedAt: daysAgo(1),
      });
    });
  });

  const insertedAssessments = await db.insert(assessments).values(assessmentValues).returning();
  const assessmentIdByKey = new Map<string, number>();
  insertedAssessments.forEach((row, index) => {
    assessmentIdByKey.set(`${row.studentId}:${row.title}`, row.id);
    void index;
  });

  const itemValues = itemDrafts.flatMap((draft) => {
    const studentId = studentRows[draft.studentIndex].id;
    const assessmentId = assessmentIdByKey.get(`${studentId}:${draft.assessmentTitle}`);
    if (!assessmentId) return [];
    return [
      {
        assessmentId,
        questionId: draft.questionId,
        skillId: draft.skillId,
        sequence: draft.sequence,
        studentAnswer: draft.studentAnswer,
        isCorrect: draft.isCorrect,
        responseTimeMs: draft.responseTimeMs,
        predictedCorrectProb: draft.predictedCorrectProb,
        assignedDifficulty: draft.assignedDifficulty,
        masteryBefore: draft.masteryBefore,
        masteryAfter: draft.masteryAfter,
        createdAt: daysAgo(20),
      },
    ];
  });
  for (let i = 0; i < itemValues.length; i += 500) {
    await db.insert(assessmentItems).values(itemValues.slice(i, i + 500));
  }
  await db.insert(masteryStates).values(masteryValues);

  /* ---------------- in-progress adaptive sessions ---------------- */
  const liveStudents = [studentRows[0], studentRows[1], studentRows[8]];
  for (const [index, student] of liveStudents.entries()) {
    const impacts = impactByStudent.get(student.id) ?? new Map<number, Impact>();
    const weakest = [...impacts.values()].sort((a, b) => a.mastery - b.mastery).slice(0, 2);
    if (!weakest.length) continue;
    const targetSkillIds = weakest.map((impact) => impact.skillId);
    const startedAt = daysAgo(index * 0.4, 3);
    const [assessment] = await db
      .insert(assessments)
      .values({
        studentId: student.id,
        title: `Adaptive checkpoint — ${SEED_STUDENTS[SEED_STUDENTS.findIndex((s) => s.email === student.email)]?.cohort ?? "Cohort"}`,
        mode: "adaptive_quiz",
        status: "in_progress",
        targetSkillIds,
        itemTarget: 8,
        ability: round(mean(weakest.map((impact) => impact.mastery)), 3),
        startedAt,
      })
      .returning();

    let mastery = assessment.ability;
    let sequence = 1;
    const answered = 2 + Math.floor(rand() * 2);
    for (const impact of weakest) {
      const pool = questionsBySkill.get(impact.skillId) ?? [];
      for (const question of pool.slice(0, answered)) {
        const difficulty = DIFFICULTY_VALUE[question.difficultyLabel] ?? 0.55;
        const predicted = clamp(mastery - (difficulty - 0.55) * 0.3 + 0.35, 0.15, 0.95);
        const isCorrect = rand() < predicted;
        const masteryBefore = mastery;
        mastery = posterior(mastery, isCorrect, DEFAULT_BKT);
        await db.insert(assessmentItems).values({
          assessmentId: assessment.id,
          questionId: question.id,
          skillId: impact.skillId,
          sequence: sequence,
          studentAnswer: isCorrect ? question.correctIndex : (question.correctIndex + 2) % question.options.length,
          isCorrect,
          responseTimeMs: Math.round(12_000 + rand() * 30_000),
          predictedCorrectProb: round(predicted, 3),
          assignedDifficulty: round(difficulty, 3),
          masteryBefore: round(masteryBefore, 3),
          masteryAfter: round(mastery, 3),
          createdAt: startedAt,
        });
        sequence += 1;
      }
    }
    await db.update(assessments).set({ ability: round(mastery, 3) }).where(sql`${assessments.id} = ${assessment.id}`);
  }

  /* ---------------- learning paths + milestones + recommendations ---------------- */
  const pathValues: (typeof learningPaths.$inferInsert)[] = [];
  const pathInputs: { studentIndex: number; pathIndex: number; built: ReturnType<typeof buildLearningPath> }[] = [];

  studentRows.forEach((student, studentIndex) => {
    const impacts = impactByStudent.get(student.id) ?? new Map<number, Impact>();
    const signalsInput = [...impacts.values()].map((impact) => {
      const seedSkill = SEED_SKILLS.find((row) => skillByCode.get(row.code)?.id === impact.skillId);
      const row = insertedSkills.find((skill) => skill.id === impact.skillId);
      return {
        id: impact.skillId,
        name: row?.name ?? "Skill",
        subjectName: subjectRows.find((subject) => subject.id === row?.subjectId)?.name ?? "General",
        mastery: impact.mastery,
        prereqIds: row?.prereqIds ?? [],
        difficultyBase: row?.difficultyBase ?? 0.5,
        attempts: impact.attempts,
      };
    });
    if (signalsInput.length < 2) return;
    const built = buildLearningPath({ skills: signalsInput, targetMastery: MASTERY_TARGET, maxItems: 5 + Math.floor(rand() * 2) });
    if (!built.milestones.length) return;
    const seedStudent = SEED_STUDENTS[studentIndex];
    pathValues.push({
      studentId: student.id,
      title: `${seedStudent.subjectFocus.join(" + ")} mastery plan`,
      objective: seedStudent.goal,
      status: studentIndex < 11 ? "active" : studentIndex < 13 ? "paused" : "completed",
      strategy: "gap-ordered-topological",
      targetMastery: MASTERY_TARGET,
      progress: built.progress,
      projectedCompletion: built.projectedCompletion,
      createdAt: daysAgo(30 - studentIndex),
    });
    pathInputs.push({ studentIndex, pathIndex: pathValues.length - 1, built });
  });

  const insertedPaths = pathValues.length ? await db.insert(learningPaths).values(pathValues).returning() : [];
  const milestoneValues: (typeof pathMilestones.$inferInsert)[] = [];
  pathInputs.forEach(({ pathIndex, built }) => {
    const path = insertedPaths[pathIndex];
    if (!path) return;
    built.milestones.forEach((milestone, index) => {
      const status = index === 0 ? (path.status === "completed" ? "completed" : "in_progress") : index < 2 && rand() < 0.4 ? "in_progress" : milestone.status;
      milestoneValues.push({
        pathId: path.id,
        skillId: milestone.skillId,
        position: milestone.position,
        status,
        targetMastery: milestone.targetMastery,
        currentMastery: milestone.currentMastery,
        dueDate: milestone.dueDate,
        completedAt: status === "completed" ? daysAgo(2 + rand() * 5) : null,
      });
    });
  });
  if (milestoneValues.length) await db.insert(pathMilestones).values(milestoneValues);

  const recommendationValues: (typeof recommendations.$inferInsert)[] = [];
  studentRows.forEach((student, studentIndex) => {
    const impacts = impactByStudent.get(student.id) ?? new Map<number, Impact>();
    const pathMilestonesForStudent = milestoneValues.filter((milestone) => {
      const path = insertedPaths.find((row) => row.id === milestone.pathId);
      return path?.studentId === student.id;
    });
    const pathSkillIds = pathMilestonesForStudent.map((milestone) => milestone.skillId);

    const signals = [...impacts.values()].map((impact) => {
      const row = insertedSkills.find((skill) => skill.id === impact.skillId);
      const prereqMastery = (row?.prereqIds ?? []).map((id) => impacts.get(id)?.mastery ?? 0.55);
      return {
        skillId: impact.skillId,
        skillName: row?.name ?? "Skill",
        subjectName: subjectRows.find((subject) => subject.id === row?.subjectId)?.name ?? "General",
        subjectColor: subjectRows.find((subject) => subject.id === row?.subjectId)?.color ?? "#6366f1",
        mastery: impact.mastery,
        attempts: impact.attempts,
        correct: impact.correct,
        daysSincePractice: Math.max(0.5, (now - impact.lastPracticedAt.getTime()) / 86_400_000),
        prereqReadiness: prereqMastery.length ? mean(prereqMastery) : 1,
        pathAlignment: pathSkillIds.includes(impact.skillId) ? 0.95 : 0.25,
        questionCount: questionsBySkill.get(impact.skillId)?.length ?? 0,
        difficultyBase: row?.difficultyBase ?? 0.5,
      };
    });
    const ranked = rankSkills(signals).slice(0, 4);
    ranked.forEach((scored, index) => {
      const statusPool = ["new", "new", "new", "accepted", "dismissed", "completed"];
      const status = index === 0 && studentIndex % 4 === 0 ? "accepted" : statusPool[Math.floor(rand() * statusPool.length)];
      const createdAt = daysAgo(rand() * 9 + 0.2, 12);
      recommendationValues.push({
        studentId: student.id,
        kind: scored.gap > 0.3 ? "skill" : scored.signal.daysSincePractice > 14 ? "review" : "question",
        skillId: scored.signal.skillId,
        title: `${scored.action}: ${scored.signal.skillName}`,
        reason: scored.reason,
        priority: scored.priority,
        confidence: scored.confidence,
        factors: scored.factors,
        model: "hybrid-v2",
        status,
        createdAt,
        actedAt: status === "new" ? null : new Date(createdAt.getTime() + 3_600_000),
      });
    });
  });
  if (recommendationValues.length) await db.insert(recommendations).values(recommendationValues);
  if (activityValues.length) {
    for (let i = 0; i < activityValues.length; i += 400) {
      await db.insert(activityEvents).values(activityValues.slice(i, i + 400));
    }
  }
  await db.insert(activityEvents).values([
    {
      studentId: studentRows[0].id,
      type: "recommendation",
      summary: "Recommender surfaced 4 new priorities after the latest checkpoint",
      value: 0.91,
      createdAt: daysAgo(0.2),
    },
    {
      studentId: studentRows[1].id,
      type: "path",
      summary: "Learning path regenerated from mastery decay: 5 milestones resequenced",
      value: 0.74,
      createdAt: daysAgo(0.5),
    },
    {
      studentId: studentRows[10].id,
      type: "practice",
      summary: "Fractions, Ratios & Proportion mastery moved 0.21 → 0.44 after remediation",
      value: 0.44,
      createdAt: daysAgo(0.9),
    },
  ]);

  /* ---------------- performance forecasts on completed sessions ---------------- */
  for (const student of studentRows) {
    const rows = await db
      .select({ id: assessments.id, score: assessments.score, startedAt: assessments.startedAt })
      .from(assessments)
      .where(and(eq(assessments.studentId, student.id), eq(assessments.status, "completed")));
    const ordered = rows.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const history = ordered.map((row, index) => ({ label: `S${index + 1}`, value: row.score ?? 0 }));
    if (history.length >= 3) {
      const forecast = forecastPerformance(history, MASTERY_TARGET);
      const target = ordered[ordered.length - 1];
      if (target) {
        await db
          .update(assessments)
          .set({ predictedScore: round(forecast.nextValue, 3), forecastLabel: forecast.trendLabel })
          .where(sql`${assessments.id} = ${target.id}`);
      }
    }
  }

  /* ---------------- train the classifier on simulated response logs ---------------- */
  await trainAndPersistClassifier();

  /* ---------------- item-quality analytics from observed responses ---------------- */
  // Populate quality score, discrimination, calibration container and flags so the
  // item bank ships with real psychometrics, not placeholders.
  await computeAndPersistItemStatistics();

  void staffRows;
  void questionRows;
}

const globalForSeed = globalThis as typeof globalThis & {
  __adaptiqSeedPromise?: Promise<void>;
};

export function ensureSeeded() {
  if (!globalForSeed.__adaptiqSeedPromise) {
    globalForSeed.__adaptiqSeedPromise = runSeed().catch((error) => {
      globalForSeed.__adaptiqSeedPromise = undefined;
      throw error;
    });
  }
  return globalForSeed.__adaptiqSeedPromise;
}

export async function ensureSeededSafe() {
  try {
    await ensureSeeded();
    return { seeded: true as const };
  } catch (error) {
    return { seeded: false as const, error: error instanceof Error ? error.message : "seed failed" };
  }
}
