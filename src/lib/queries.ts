import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  activityEvents,
  assessmentItems,
  assessments,
  institutions,
  learningPaths,
  itemStatistics,
  masteryStates,
  mlModels,
  modelEvaluations,
  pathMilestones,
  questions,
  recommendations,
  skills,
  subjects,
  users,
  type User,
} from "@/db/schema";
import { MASTERY_TARGET, clamp, daysBetween, mean, round } from "@/lib/utils";
import { applyDecay } from "@/lib/ml/knowledge-tracing";
import { classifyGap, type GapReadout } from "@/lib/ml/gaps";
import { forecastPerformance, type Forecast } from "@/lib/ml/forecast";
import { rankSkills, type SkillSignal } from "@/lib/ml/recommender";

export type SubjectInfo = { id: number; name: string; code: string; color: string };
export type SkillRow = typeof skills.$inferSelect & { subject: SubjectInfo; questionCount: number };

export async function getSubjects(): Promise<SubjectInfo[]> {
  return db.select({ id: subjects.id, name: subjects.name, code: subjects.code, color: subjects.color }).from(subjects).orderBy(subjects.name);
}

export async function getSkillCatalog(): Promise<SkillRow[]> {
  const [skillRows, subjectRows, questionCounts] = await Promise.all([
    db.select().from(skills).orderBy(skills.subjectId, skills.code),
    db.select().from(subjects),
    db
      .select({ skillId: questions.skillId, total: sql<number>`count(*)::int` })
      .from(questions)
      .groupBy(questions.skillId),
  ]);
  const subjectMap = new Map(subjectRows.map((s) => [s.id, s]));
  const countMap = new Map(questionCounts.map((row) => [row.skillId, Number(row.total)]));
  return skillRows.map((skill) => ({
    ...skill,
    subject: subjectMap.get(skill.subjectId) ?? { id: 0, name: "General", code: "GEN", color: "#6366f1" },
    questionCount: countMap.get(skill.id) ?? 0,
  }));
}

export async function getQuestionBank(skillId?: number) {
  const authors = alias(users, "question_authors");
  const reviewers = alias(users, "question_reviewers");
  const rows = await db
    .select({
      question: questions,
      skillName: skills.name,
      subjectName: subjects.name,
      subjectColor: subjects.color,
      difficultyBase: skills.difficultyBase,
      authorName: authors.name,
      reviewerName: reviewers.name,
    })
    .from(questions)
    .innerJoin(skills, eq(skills.id, questions.skillId))
    .innerJoin(subjects, eq(subjects.id, skills.subjectId))
    .leftJoin(authors, eq(authors.id, questions.authorId))
    .leftJoin(reviewers, eq(reviewers.id, questions.reviewedById))
    .orderBy(desc(questions.createdAt))
    .where(skillId ? eq(questions.skillId, skillId) : undefined);

  const stats = await db
    .select({
      questionId: assessmentItems.questionId,
      total: sql<number>`count(*)::int`,
      correct: sql<number>`sum(case when ${assessmentItems.isCorrect} then 1 else 0 end)::int`,
    })
    .from(assessmentItems)
    .groupBy(assessmentItems.questionId);
  const statMap = new Map(stats.map((row) => [row.questionId, row]));

  return rows.map((row) => {
    const stat = statMap.get(row.question.id);
    const total = Number(stat?.total ?? 0);
    const correct = Number(stat?.correct ?? 0);
    const q = row.question;
    return {
      ...q,
      reviewedAt: q.reviewedAt ? q.reviewedAt.toISOString() : null,
      publishedAt: q.publishedAt ? q.publishedAt.toISOString() : null,
      retiredAt: q.retiredAt ? q.retiredAt.toISOString() : null,
      lastAnalyzedAt: q.lastAnalyzedAt ? q.lastAnalyzedAt.toISOString() : null,
      createdAt: q.createdAt.toISOString(),
      skillName: row.skillName,
      subjectName: row.subjectName,
      subjectColor: row.subjectColor,
      skillDifficultyBase: row.difficultyBase,
      authorName: row.authorName,
      reviewerName: row.reviewerName,
      attempts: total,
      correct,
      pCorrect: total ? round(correct / total, 2) : 0,
    };
  });
}

export type QuestionBankRow = Awaited<ReturnType<typeof getQuestionBank>>[number];

/** Historical item-analysis snapshots for a single question (most recent first). */
export async function getItemStatistics(questionId: number, limit = 20) {
  const rows = await db
    .select()
    .from(itemStatistics)
    .where(eq(itemStatistics.questionId, questionId))
    .orderBy(desc(itemStatistics.computedAt))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    windowStart: row.windowStart ? row.windowStart.toISOString() : null,
    windowEnd: row.windowEnd ? row.windowEnd.toISOString() : null,
    computedAt: row.computedAt.toISOString(),
  }));
}

/** Aggregate quality dashboard for the whole item bank. */
export async function getQuestionBankAnalytics() {
  const bank = await getQuestionBank();
  const byStatus: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const flagCounts: Record<string, number> = {};
  let analyzed = 0;
  let qualitySum = 0;
  let flagged = 0;
  for (const q of bank) {
    byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;
    bySource[q.source] = (bySource[q.source] ?? 0) + 1;
    if (q.lastAnalyzedAt) {
      analyzed += 1;
      qualitySum += q.qualityScore;
    }
    for (const f of q.qualityFlags ?? []) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
    if ((q.qualityFlags ?? []).some((f) => f !== "insufficient_sample")) flagged += 1;
  }
  return {
    total: bank.length,
    analyzed,
    meanQuality: analyzed ? round(qualitySum / analyzed, 3) : 0,
    flagged,
    byStatus,
    bySource,
    flagCounts,
  };
}

export type StudentSummary = {
  id: number;
  name: string;
  email: string;
  gradeLevel: string | null;
  cohort: string | null;
  avatarColor: string;
  goal: string | null;
  status: string;
  institutionId: number | null;
  institutionName: string | null;
  avgMastery: number;
  weakestSkill: string | null;
  masteryTrend: number;
  gaps: number;
  assessments: number;
};

export async function listStudents(search?: string, institutionId?: number): Promise<StudentSummary[]> {
  const studentRows = await db
    .select({ user: users, institutionName: institutions.name })
    .from(users)
    .leftJoin(institutions, eq(institutions.id, users.institutionId))
    .where(
      and(
        eq(users.role, "student"),
        search
          ? or(sql`lower(${users.name}) like ${`%${search.toLowerCase()}%`}`, sql`lower(${users.email}) like ${`%${search.toLowerCase()}%`}`)
          : undefined,
        institutionId ? eq(users.institutionId, institutionId) : undefined,
      ),
    )
    .orderBy(users.name);

  const ids = studentRows.map((row) => row.user.id);
  if (!ids.length) return [];

  const [masteryRows, assessmentRows] = await Promise.all([
    db.select().from(masteryStates).where(inArray(masteryStates.studentId, ids)),
    db
      .select({ studentId: assessments.studentId, total: sql<number>`count(*)::int`, score: sql<number>`coalesce(avg(${assessments.score}),0)` })
      .from(assessments)
      .where(and(inArray(assessments.studentId, ids), eq(assessments.status, "completed")))
      .groupBy(assessments.studentId),
  ]);

  const skillRows = await db.select({ id: skills.id, name: skills.name }).from(skills);
  const skillName = new Map(skillRows.map((s) => [s.id, s.name]));

  return studentRows.map((row) => {
    const states = masteryRows.filter((state) => state.studentId === row.user.id);
    const decayed = states.map((state) => ({ ...state, decayed: applyDecay(state.mastery, state.lastPracticedAt) }));
    const avg = decayed.length ? mean(decayed.map((state) => state.decayed)) : 0;
    const weakest = [...decayed].sort((a, b) => a.decayed - b.decayed)[0];
    const trends = states.flatMap((state) => state.history ?? []);
    const recent = trends.slice(-6).map((point) => point.m);
    const earlier = trends.slice(-12, -6).map((point) => point.m);
    const assessment = assessmentRows.find((a) => a.studentId === row.user.id);
    return {
      id: row.user.id,
      name: row.user.name,
      email: row.user.email,
      gradeLevel: row.user.gradeLevel,
      cohort: row.user.cohort,
      avatarColor: row.user.avatarColor,
      goal: row.user.goal,
      status: row.user.status,
      institutionId: row.user.institutionId,
      institutionName: row.institutionName,
      avgMastery: round(avg, 3),
      weakestSkill: weakest ? skillName.get(weakest.skillId) ?? null : null,
      masteryTrend: round((recent.length ? mean(recent) : 0) - (earlier.length ? mean(earlier) : recent.length ? mean(recent) : 0), 3),
      gaps: decayed.filter((state) => state.decayed < 0.6).length,
      assessments: Number(assessment?.total ?? 0),
    };
  });
}

export type MasteryView = {
  skillId: number;
  skillName: string;
  subjectName: string;
  subjectColor: string;
  mastery: number;
  decayed: number;
  attempts: number;
  correct: number;
  streak: number;
  lastPracticedAt: string | null;
  daysSincePractice: number;
  history: { t: string; m: number }[];
  difficultyBase: number;
  prereqIds: number[];
  questionCount: number;
};

export async function getStudentMastery(studentId: number): Promise<MasteryView[]> {
  const [rows, questionCounts] = await Promise.all([
    db
      .select({
        state: masteryStates,
        skill: skills,
        subjectName: subjects.name,
        subjectColor: subjects.color,
      })
      .from(masteryStates)
      .innerJoin(skills, eq(skills.id, masteryStates.skillId))
      .innerJoin(subjects, eq(subjects.id, skills.subjectId))
      .where(eq(masteryStates.studentId, studentId)),
    db.select({ skillId: questions.skillId, total: sql<number>`count(*)::int` }).from(questions).groupBy(questions.skillId),
  ]);
  const countMap = new Map(questionCounts.map((row) => [row.skillId, Number(row.total)]));

  return rows.map((row) => ({
    skillId: row.skill.id,
    skillName: row.skill.name,
    subjectName: row.subjectName,
    subjectColor: row.subjectColor,
    mastery: round(row.state.mastery, 3),
    decayed: round(applyDecay(row.state.mastery, row.state.lastPracticedAt), 3),
    attempts: row.state.attempts,
    correct: row.state.correct,
    streak: row.state.streak,
    lastPracticedAt: row.state.lastPracticedAt ? row.state.lastPracticedAt.toISOString() : null,
    daysSincePractice: row.state.lastPracticedAt ? round(daysBetween(row.state.lastPracticedAt), 1) : 30,
    history: row.state.history ?? [],
    difficultyBase: row.skill.difficultyBase,
    prereqIds: row.skill.prereqIds ?? [],
    questionCount: countMap.get(row.skill.id) ?? 0,
  }));
}

export function buildSkillSignals(
  mastery: MasteryView[],
  pathSkillIds: number[] = [],
): SkillSignal[] {
  const masteryBySkill = new Map(mastery.map((row) => [row.skillId, row.decayed]));
  return mastery
    .map((row) => {
      const prereqReadiness = row.prereqIds.length
        ? mean(row.prereqIds.map((id) => masteryBySkill.get(id) ?? 0.5))
        : 1;
      return {
        skillId: row.skillId,
        skillName: row.skillName,
        subjectName: row.subjectName,
        subjectColor: row.subjectColor,
        mastery: row.decayed,
        attempts: row.attempts,
        correct: row.correct,
        daysSincePractice: row.daysSincePractice,
        prereqReadiness,
        pathAlignment: pathSkillIds.includes(row.skillId) ? 1 : 0.2,
        questionCount: row.questionCount,
        difficultyBase: row.difficultyBase,
      };
    });
}

export function buildGapReadouts(mastery: MasteryView[], target = MASTERY_TARGET): GapReadout[] {
  const masteryBySkill = new Map(mastery.map((row) => [row.skillId, row.decayed]));
  return mastery
    .map((row) => {
      const prereqGaps = row.prereqIds.filter((id) => (masteryBySkill.get(id) ?? 0) < 0.6).length;
      return classifyGap({
        skillId: row.skillId,
        skillName: row.skillName,
        subjectName: row.subjectName,
        mastery: row.decayed,
        attempts: row.attempts,
        correct: row.correct,
        daysSincePractice: row.daysSincePractice,
        prereqGaps,
        target,
      });
    })
    .sort((a, b) => b.severityScore - a.severityScore);
}

export type PerformanceView = {
  forecast: Forecast;
  completed: {
    id: number;
    title: string;
    score: number;
    predictedScore: number | null;
    mode: string;
    completedAt: string | null;
    itemCount: number;
  }[];
  accuracyBySkill: { skillName: string; subjectName: string; subjectColor: string; attempts: number; accuracy: number; mastery: number }[];
  abilityTrajectory: { label: string; value: number }[];
};

export async function getStudentPerformance(studentId: number, mastery: MasteryView[]): Promise<PerformanceView> {
  const completedRows = await db
    .select()
    .from(assessments)
    .where(and(eq(assessments.studentId, studentId), eq(assessments.status, "completed")))
    .orderBy(assessments.completedAt);

  const ids = completedRows.map((row) => row.id);
  const itemCounts = ids.length
    ? await db
        .select({ assessmentId: assessmentItems.assessmentId, total: sql<number>`count(*)::int` })
        .from(assessmentItems)
        .where(inArray(assessmentItems.assessmentId, ids))
        .groupBy(assessmentItems.assessmentId)
    : [];
  const countMap = new Map(itemCounts.map((row) => [row.assessmentId, Number(row.total)]));

  const history = completedRows.map((row, index) => ({
    label: `S${index + 1}`,
    value: row.score ?? 0,
  }));
  const forecast = forecastPerformance(history, MASTERY_TARGET);

  const abilityTrajectory = mastery
    .flatMap((state) => state.history.map((point) => ({ t: point.t, m: point.m })))
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
    .slice(-14)
    .map((point, index) => ({ label: `P${index + 1}`, value: point.m }));

  return {
    forecast,
    completed: completedRows.map((row) => ({
      id: row.id,
      title: row.title,
      score: row.score ?? 0,
      predictedScore: row.predictedScore,
      mode: row.mode,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      itemCount: countMap.get(row.id) ?? 0,
    })),
    accuracyBySkill: mastery.map((row) => ({
      skillName: row.skillName,
      subjectName: row.subjectName,
      subjectColor: row.subjectColor,
      attempts: row.attempts,
      accuracy: row.attempts ? round(row.correct / row.attempts, 2) : 0,
      mastery: row.decayed,
    })),
    abilityTrajectory,
  };
}

export async function getPaths(studentId?: number, studentIds?: number[]) {
  if (studentIds && studentIds.length === 0) return [];
  const pathRows = await db
    .select({ path: learningPaths, studentName: users.name, avatarColor: users.avatarColor })
    .from(learningPaths)
    .innerJoin(users, eq(users.id, learningPaths.studentId))
    .where(
      and(
        studentId ? eq(learningPaths.studentId, studentId) : undefined,
        studentIds ? inArray(learningPaths.studentId, studentIds) : undefined,
      ),
    )
    .orderBy(desc(learningPaths.createdAt));

  const ids = pathRows.map((row) => row.path.id);
  const milestoneRows = ids.length
    ? await db
        .select({ milestone: pathMilestones, skillName: skills.name, subjectName: subjects.name, subjectColor: subjects.color })
        .from(pathMilestones)
        .innerJoin(skills, eq(skills.id, pathMilestones.skillId))
        .innerJoin(subjects, eq(subjects.id, skills.subjectId))
        .where(inArray(pathMilestones.pathId, ids))
        .orderBy(pathMilestones.position)
    : [];

  return pathRows.map((row) => ({
    ...row.path,
    createdAt: row.path.createdAt.toISOString(),
    studentName: row.studentName,
    avatarColor: row.avatarColor,
    milestones: milestoneRows
      .filter((m) => m.milestone.pathId === row.path.id)
      .map((m) => ({
        ...m.milestone,
        skillName: m.skillName,
        subjectName: m.subjectName,
        subjectColor: m.subjectColor,
        completedAt: m.milestone.completedAt ? m.milestone.completedAt.toISOString() : null,
      })),
  }));
}

export type PathView = Awaited<ReturnType<typeof getPaths>>[number];

export async function getRecommendations(
  options: { studentId?: number; status?: string; studentIds?: number[] } = {},
) {
  if (options.studentIds && options.studentIds.length === 0) return [] as never[];
  const rows = await db
    .select({
      recommendation: recommendations,
      studentName: users.name,
      avatarColor: users.avatarColor,
      skillName: skills.name,
      subjectName: subjects.name,
    })
    .from(recommendations)
    .innerJoin(users, eq(users.id, recommendations.studentId))
    .leftJoin(skills, eq(skills.id, recommendations.skillId))
    .leftJoin(subjects, eq(subjects.id, skills.subjectId))
    .where(
      and(
        options.studentId ? eq(recommendations.studentId, options.studentId) : undefined,
        options.studentIds ? inArray(recommendations.studentId, options.studentIds) : undefined,
        options.status ? eq(recommendations.status, options.status) : undefined,
      ),
    )
    .orderBy(desc(recommendations.priority))
    .limit(120);

  return rows.map((row) => ({
    ...row.recommendation,
    createdAt: row.recommendation.createdAt.toISOString(),
    actedAt: row.recommendation.actedAt ? row.recommendation.actedAt.toISOString() : null,
    studentName: row.studentName,
    avatarColor: row.avatarColor,
    skillName: row.skillName,
    subjectName: row.subjectName,
    priority: round(row.recommendation.priority, 3),
  }));
}

export type RecommendationView = Awaited<ReturnType<typeof getRecommendations>>[number];

export async function listAssessments(studentId?: number, limit = 60, studentIds?: number[]) {
  if (studentIds && studentIds.length === 0) return [] as never[];
  const rows = await db
    .select({ assessment: assessments, studentName: users.name, avatarColor: users.avatarColor })
    .from(assessments)
    .innerJoin(users, eq(users.id, assessments.studentId))
    .where(
      and(
        studentId ? eq(assessments.studentId, studentId) : undefined,
        studentIds ? inArray(assessments.studentId, studentIds) : undefined,
      ),
    )
    .orderBy(desc(assessments.startedAt))
    .limit(limit);

  const ids = rows.map((row) => row.assessment.id);
  const itemStats = ids.length
    ? await db
        .select({
          assessmentId: assessmentItems.assessmentId,
          total: sql<number>`count(*)::int`,
          answered: sql<number>`sum(case when ${assessmentItems.isCorrect} is not null then 1 else 0 end)::int`,
          correct: sql<number>`sum(case when ${assessmentItems.isCorrect} then 1 else 0 end)::int`,
        })
        .from(assessmentItems)
        .where(inArray(assessmentItems.assessmentId, ids))
        .groupBy(assessmentItems.assessmentId)
    : [];
  const statsMap = new Map(itemStats.map((row) => [row.assessmentId, row]));

  return rows.map((row) => ({
    ...row.assessment,
    startedAt: row.assessment.startedAt.toISOString(),
    completedAt: row.assessment.completedAt ? row.assessment.completedAt.toISOString() : null,
    studentName: row.studentName,
    avatarColor: row.avatarColor,
    items: Number(statsMap.get(row.assessment.id)?.total ?? 0),
    answered: Number(statsMap.get(row.assessment.id)?.answered ?? 0),
    correct: Number(statsMap.get(row.assessment.id)?.correct ?? 0),
  }));
}

export type AssessmentView = Awaited<ReturnType<typeof listAssessments>>[number];

export async function getAssessment(id: number) {
  const rows = await db
    .select({ assessment: assessments, studentName: users.name, avatarColor: users.avatarColor })
    .from(assessments)
    .innerJoin(users, eq(users.id, assessments.studentId))
    .where(eq(assessments.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const items = await db
    .select({
      item: assessmentItems,
      stem: questions.stem,
      options: questions.options,
      correctIndex: questions.correctIndex,
      explanation: questions.explanation,
      difficultyLabel: questions.difficultyLabel,
      bloomLevel: questions.bloomLevel,
      estimatedSeconds: questions.estimatedSeconds,
      skillName: skills.name,
      subjectName: subjects.name,
    })
    .from(assessmentItems)
    .innerJoin(questions, eq(questions.id, assessmentItems.questionId))
    .innerJoin(skills, eq(skills.id, assessmentItems.skillId))
    .innerJoin(subjects, eq(subjects.id, skills.subjectId))
    .where(eq(assessmentItems.assessmentId, id))
    .orderBy(assessmentItems.sequence);

  return {
    assessment: {
      ...row.assessment,
      startedAt: row.assessment.startedAt.toISOString(),
      completedAt: row.assessment.completedAt ? row.assessment.completedAt.toISOString() : null,
    },
    studentName: row.studentName,
    avatarColor: row.avatarColor,
    items: items.map((item) => ({
      ...item.item,
      stem: item.stem,
      options: item.options,
      correctIndex: item.correctIndex,
      explanation: item.explanation,
      difficultyLabel: item.difficultyLabel,
      bloomLevel: item.bloomLevel,
      estimatedSeconds: item.estimatedSeconds,
      skillName: item.skillName,
      subjectName: item.subjectName,
    })),
  };
}

export async function getActivity(studentId?: number, limit = 12, studentIds?: number[]) {
  if (studentIds && studentIds.length === 0) return [] as never[];
  const rows = await db
    .select({ event: activityEvents, studentName: users.name, skillName: skills.name })
    .from(activityEvents)
    .leftJoin(users, eq(users.id, activityEvents.studentId))
    .leftJoin(skills, eq(skills.id, activityEvents.skillId))
    .where(
      and(
        studentId ? eq(activityEvents.studentId, studentId) : undefined,
        studentIds ? inArray(activityEvents.studentId, studentIds) : undefined,
      ),
    )
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    ...row.event,
    createdAt: row.event.createdAt.toISOString(),
    studentName: row.studentName,
    skillName: row.skillName,
  }));
}

export type ActivityView = Awaited<ReturnType<typeof getActivity>>[number];

export async function getCohortSnapshot(institutionId?: number) {
  const studentRows = await db
    .select({ id: users.id, name: users.name, cohort: users.cohort, avatarColor: users.avatarColor })
    .from(users)
    .where(
      and(eq(users.role, "student"), institutionId !== undefined ? eq(users.institutionId, institutionId) : undefined),
    );
  // When scoped to an institution, restrict all downstream data to that
  // institution's learners so a tenant admin never sees cross-tenant metrics.
  const scopedIds = institutionId !== undefined ? studentRows.map((row) => row.id) : null;
  const inScope = <T extends { studentId: number }>(rows: T[]) =>
    scopedIds === null ? rows : rows.filter((row) => scopedIds.includes(row.studentId));

  const [masteryRowsAll, assessmentRowsAll, recommendationRowsAll, pathRowsAll, institutionRows] = await Promise.all([
    db.select().from(masteryStates),
    db.select().from(assessments),
    db.select().from(recommendations),
    db.select().from(learningPaths),
    institutionId !== undefined
      ? db.select().from(institutions).where(eq(institutions.id, institutionId))
      : db.select().from(institutions),
  ]);
  const masteryRows = inScope(masteryRowsAll);
  const assessmentRows = inScope(assessmentRowsAll);
  const recommendationRows = inScope(recommendationRowsAll);
  const pathRows = inScope(pathRowsAll);

  const skillRows = await db.select({ id: skills.id, name: skills.name }).from(skills);
  const skillName = new Map(skillRows.map((row) => [row.id, row.name]));

  const weakTopics = skillName.size
    ? [...new Set(masteryRows.map((row) => row.skillId))]
        .map((skillId) => {
          const rowsForSkill = masteryRows.filter((row) => row.skillId === skillId);
          const avg = mean(rowsForSkill.map((row) => applyDecay(row.mastery, row.lastPracticedAt)));
          return {
            skillId,
            skillName: skillName.get(skillId) ?? "Unknown",
            avgMastery: round(avg, 3),
            learners: rowsForSkill.length,
            atRisk: rowsForSkill.filter((row) => applyDecay(row.mastery, row.lastPracticedAt) < 0.5).length,
            attempts: rowsForSkill.reduce((acc, row) => acc + row.attempts, 0),
          };
        })
        .sort((a, b) => a.avgMastery - b.avgMastery)
        .slice(0, 8)
    : [];

  const cohortMap = new Map<string, { total: number; masterySum: number; count: number }>();
  for (const student of studentRows) {
    const key = student.cohort ?? "Unassigned";
    const bucket = cohortMap.get(key) ?? { total: 0, masterySum: 0, count: 0 };
    bucket.total += 1;
    const states = masteryRows.filter((row) => row.studentId === student.id);
    bucket.masterySum += states.length ? mean(states.map((row) => applyDecay(row.mastery, row.lastPracticedAt))) : 0;
    bucket.count += 1;
    cohortMap.set(key, bucket);
  }

  const activeFlags = assessmentRows.filter((row) => row.status === "in_progress").length;
  const completed = assessmentRows.filter((row) => row.status === "completed");
  const avgScore = completed.length ? mean(completed.map((row) => row.score ?? 0)) : 0;

  return {
    learners: studentRows.length,
    institutions: institutionRows.length,
    activeAssessments: activeFlags,
    completedAssessments: completed.length,
    avgScore: round(avgScore, 3),
    masteryStates: masteryRows.length,
    openRecommendations: recommendationRows.filter((row) => row.status === "new").length,
    acceptedRecommendations: recommendationRows.filter((row) => row.status !== "new" && row.status !== "dismissed").length,
    activePaths: pathRows.filter((row) => row.status === "active").length,
    weakTopics,
    cohorts: [...cohortMap.entries()].map(([cohort, bucket]) => ({
      cohort,
      learners: bucket.total,
      avgMastery: round(bucket.count ? bucket.masterySum / bucket.count : 0, 3),
    })),
  };
}

export type CohortSnapshot = Awaited<ReturnType<typeof getCohortSnapshot>>;

export async function getUserDirectory(search?: string, institutionId?: number) {
  const rows = await db
    .select({ user: users, institutionName: institutions.name })
    .from(users)
    .leftJoin(institutions, eq(institutions.id, users.institutionId))
    .where(
      and(
        search
          ? or(sql`lower(${users.name}) like ${`%${search.toLowerCase()}%`}`, sql`lower(${users.email}) like ${`%${search.toLowerCase()}%`}`)
          : undefined,
        institutionId !== undefined ? eq(users.institutionId, institutionId) : undefined,
      ),
    )
    .orderBy(users.role, users.name);
  return rows.map((row) => ({
    id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.user.role,
    status: row.user.status,
    cohort: row.user.cohort,
    gradeLevel: row.user.gradeLevel,
    institutionId: row.user.institutionId,
    institutionName: row.institutionName,
    avatarColor: row.user.avatarColor,
    createdAt: row.user.createdAt.toISOString(),
  }));
}

export type DirectoryUser = Awaited<ReturnType<typeof getUserDirectory>>[number];

export async function getInstitutionList(institutionId?: number) {
  const rows = await db
    .select()
    .from(institutions)
    .where(institutionId !== undefined ? eq(institutions.id, institutionId) : undefined)
    .orderBy(institutions.name);
  const counts = await db
    .select({ institutionId: users.institutionId, total: sql<number>`count(*)::int` })
    .from(users)
    .groupBy(users.institutionId);
  const countMap = new Map(counts.map((row) => [row.institutionId, Number(row.total)]));
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    members: countMap.get(row.id) ?? 0,
  }));
}

export type InstitutionView = Awaited<ReturnType<typeof getInstitutionList>>[number];

export async function getModelRegistry() {
  const rows = await db.select().from(mlModels).orderBy(mlModels.name);
  return rows.map((row) => ({
    ...row,
    trainedAt: row.trainedAt.toISOString(),
    evaluatedAt: row.evaluatedAt ? row.evaluatedAt.toISOString() : null,
  }));
}

export type ModelView = Awaited<ReturnType<typeof getModelRegistry>>[number];

export async function getModelEvaluations(modelName?: string, limit = 20) {
  const rows = modelName
    ? await db
        .select()
        .from(modelEvaluations)
        .where(eq(modelEvaluations.modelName, modelName))
        .orderBy(desc(modelEvaluations.evaluatedAt))
        .limit(limit)
    : await db.select().from(modelEvaluations).orderBy(desc(modelEvaluations.evaluatedAt)).limit(limit);
  return rows.map((row) => ({
    ...row,
    trainedAt: row.trainedAt.toISOString(),
    evaluatedAt: row.evaluatedAt.toISOString(),
  }));
}

export type ModelEvaluationView = Awaited<ReturnType<typeof getModelEvaluations>>[number];

export async function getStudentDetail(studentId: number) {
  const rows = await db
    .select({ user: users, institutionName: institutions.name })
    .from(users)
    .leftJoin(institutions, eq(institutions.id, users.institutionId))
    .where(and(eq(users.id, studentId), eq(users.role, "student")))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const mastery = await getStudentMastery(studentId);
  const [paths, performance, recommendationFeed, activity, assessmentList] = await Promise.all([
    getPaths(studentId),
    getStudentPerformance(studentId, mastery),
    getRecommendations({ studentId }),
    getActivity(studentId, 8),
    listAssessments(studentId, 12),
  ]);

  const pathSkillIds = paths.flatMap((path) => path.milestones.map((milestone) => milestone.skillId));
  const signals = buildSkillSignals(mastery, pathSkillIds);
  const ranked = rankSkills(signals);
  const gaps = buildGapReadouts(mastery);

  const avgMastery = mastery.length ? mean(mastery.map((row) => row.decayed)) : 0;
  const subjectRollup = [...new Set(mastery.map((row) => row.subjectName))].map((subjectName) => {
    const rows2 = mastery.filter((row) => row.subjectName === subjectName);
    return {
      subjectName,
      color: rows2[0]?.subjectColor ?? "#6366f1",
      mastery: round(mean(rows2.map((row) => row.decayed)), 3),
      skills: rows2.length,
      weakest: [...rows2].sort((a, b) => a.decayed - b.decayed)[0]?.skillName ?? "",
    };
  });

  return {
    student: {
      ...row.user,
      createdAt: row.user.createdAt.toISOString(),
      institutionName: row.institutionName,
    },
    mastery,
    paths,
    performance,
    recommendations: recommendationFeed,
    activity,
    assessments: assessmentList,
    topRecommendations: ranked.slice(0, 6),
    gaps,
    subjectRollup,
    avgMastery: round(avgMastery, 3),
    retentionRisk: mastery.filter((row) => row.decayed < row.mastery - 0.05).length,
    readiness: round(clamp(avgMastery * 0.6 + (1 - gaps.filter((gap) => gap.severity === "critical").length / Math.max(1, gaps.length)) * 0.4), 3),
    predictions: {
      masteredCount: mastery.filter((row) => row.decayed >= MASTERY_TARGET).length,
      gapCount: gaps.filter((gap) => gap.severity === "critical" || gap.severity === "high").length,
    },
  };
}

export type StudentDetail = NonNullable<Awaited<ReturnType<typeof getStudentDetail>>>;

export async function getStudentOptions(institutionId?: number) {
  const rows = await db
    .select({ id: users.id, name: users.name, cohort: users.cohort, avatarColor: users.avatarColor })
    .from(users)
    .where(
      and(
        eq(users.role, "student"),
        institutionId !== undefined ? eq(users.institutionId, institutionId) : undefined,
      ),
    )
    .orderBy(users.name);
  return rows;
}

export async function logActivity(entry: {
  studentId?: number | null;
  type: string;
  skillId?: number | null;
  summary: string;
  value?: number;
}) {
  await db.insert(activityEvents).values({
    studentId: entry.studentId ?? null,
    type: entry.type,
    skillId: entry.skillId ?? null,
    summary: entry.summary,
    value: entry.value ?? 0,
  });
}

export function scopeStudentIdsFor(user: User) {
  return user.role === "student" ? [user.id] : null;
}
