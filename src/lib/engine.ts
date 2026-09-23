import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  activityEvents,
  assessmentItems,
  assessments,
  masteryStates,
  questions,
  skills,
  subjects,
  users,
} from "@/db/schema";
import { applyDecay, posterior, predictCorrect } from "@/lib/ml/knowledge-tracing";
import { labelPrediction, predictProbability, type FeatureSample } from "@/lib/ml/classifier";
import { selectNextItem, type AdaptiveCandidate } from "@/lib/ml/adaptive";
import { loadClassifier } from "@/lib/ml/registry";
import { forecastPerformance } from "@/lib/ml/forecast";
import { MASTERY_TARGET, clamp, mean, round } from "@/lib/utils";

export const DIFFICULTY_VALUE: Record<string, number> = { easy: 0.3, medium: 0.55, hard: 0.75, expert: 0.9 };
export const BLOOM_VALUE: Record<string, number> = { remember: 1, understand: 2, apply: 3, analyze: 4, evaluate: 5, create: 6 };

export type SessionQuestion = {
  itemId: number;
  questionId: number;
  sequence: number;
  skillId: number;
  skillName: string;
  subjectName: string;
  subjectColor: string;
  stem: string;
  options: string[];
  difficultyLabel: string;
  bloomLevel: string;
  estimatedSeconds: number;
  predictedSuccess: number;
  mastery: number;
  label: { key: string; label: string; tone: string; hint: string };
  rationale: string;
  informationGain: number;
};

export async function loadSkillFeatures(studentId: number, skillId: number) {
  const [states, questionRows] = await Promise.all([
    db.select().from(masteryStates).where(eq(masteryStates.studentId, studentId)),
    db.select({ id: questions.id }).from(questions).where(eq(questions.skillId, skillId)),
  ]);
  const state = states.find((row) => row.skillId === skillId) ?? null;
  const mastery = state ? applyDecay(state.mastery, state.lastPracticedAt) : 0;
  const ability = states.length ? mean(states.map((row) => applyDecay(row.mastery, row.lastPracticedAt))) : 0.45;
  const attempts = state?.attempts ?? 0;
  const correct = state?.correct ?? 0;
  return {
    state,
    mastery,
    ability,
    skillAccuracy: attempts ? round(correct / attempts, 3) : 0.5,
    evidence: clamp(attempts / 12),
    known: Boolean(state),
    questionCount: questionRows.length,
  };
}

function buildSample(params: {
  ability: number;
  mastery: number;
  difficultyBase: number;
  bloom: number;
  responseTimeMs: number;
  skillAccuracy: number;
  evidence: number;
}): FeatureSample {
  return {
    ability: params.ability,
    masteryBefore: params.mastery,
    difficultyBase: params.difficultyBase,
    bloom: params.bloom,
    responseTimeMs: params.responseTimeMs,
    skillAccuracy: params.skillAccuracy,
    evidence: params.evidence,
  };
}

/** Choose (and persist) the next adaptive item for an in-progress assessment. */
export async function computeNextSessionQuestion(assessmentId: number): Promise<SessionQuestion | null> {
  const assessmentRows = await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
  const assessment = assessmentRows[0];
  if (!assessment || assessment.status !== "in_progress") return null;

  const existingItems = await db
    .select()
    .from(assessmentItems)
    .where(eq(assessmentItems.assessmentId, assessmentId));

  const pending = existingItems.find((item) => item.studentAnswer === null);
  const answered = existingItems.filter((item) => item.studentAnswer !== null);

  if (answered.length >= assessment.itemTarget && !pending) return null;

  const targetSkillIds = assessment.targetSkillIds?.length
    ? assessment.targetSkillIds
    : (await db.select({ id: skills.id }).from(skills).limit(4)).map((row) => row.id);

  const model = await loadClassifier();
  const [states, candidateRows] = await Promise.all([
    db.select().from(masteryStates).where(eq(masteryStates.studentId, assessment.studentId)),
    db
      .select({
        question: questions,
        skillName: skills.name,
        subjectName: subjects.name,
        subjectColor: subjects.color,
        skillDifficulty: skills.difficultyBase,
      })
      .from(questions)
      .innerJoin(skills, eq(skills.id, questions.skillId))
      .innerJoin(subjects, eq(subjects.id, skills.subjectId))
      .where(and(inArray(questions.skillId, targetSkillIds), eq(questions.isActive, true))),
  ]);

  if (pending) {
    const questionRow = candidateRows.find((row) => row.question.id === pending.questionId);
    const skill = await loadSkillFeatures(assessment.studentId, pending.skillId);
    return {
      itemId: pending.id,
      questionId: pending.questionId,
      sequence: pending.sequence,
      skillId: pending.skillId,
      skillName: questionRow?.skillName ?? "Skill",
      subjectName: questionRow?.subjectName ?? "General",
      subjectColor: questionRow?.subjectColor ?? "#6366f1",
      stem: questionRow?.question.stem ?? "",
      options: questionRow?.question.options ?? [],
      difficultyLabel: questionRow?.question.difficultyLabel ?? "medium",
      bloomLevel: questionRow?.question.bloomLevel ?? "apply",
      estimatedSeconds: questionRow?.question.estimatedSeconds ?? 60,
      predictedSuccess: pending.predictedCorrectProb,
      mastery: round(skill.mastery, 3),
      label: labelPrediction(pending.predictedCorrectProb),
      rationale: "Resuming the item already queued for this session.",
      informationGain: round(pending.predictedCorrectProb * (1 - pending.predictedCorrectProb) * 4, 2),
    };
  }

  const ability = states.length ? mean(states.map((row) => applyDecay(row.mastery, row.lastPracticedAt))) : 0.45;
  const skillPriorities = new Map<number, number>();
  const askedCounts = new Map<number, number>();
  for (const item of answered) {
    askedCounts.set(item.skillId, (askedCounts.get(item.skillId) ?? 0) + 1);
  }

  for (const skillId of targetSkillIds) {
    const state = states.find((row) => row.skillId === skillId);
    const mastery = state ? applyDecay(state.mastery, state.lastPracticedAt) : 0;
    const attempts = state?.attempts ?? 0;
    const gap = 1 - mastery;
    const evidence = clamp(attempts / 12);
    const staleness = state?.lastPracticedAt
      ? clamp((Date.now() - state.lastPracticedAt.getTime()) / (86_400_000 * 30))
      : 1;
    skillPriorities.set(skillId, clamp(gap * (0.55 + 0.45 * evidence) * 0.8 + staleness * 0.2, 0, 1));
  }

  const candidates: AdaptiveCandidate[] = candidateRows.map((row) => ({
    questionId: row.question.id,
    skillId: row.question.skillId,
    skillName: row.skillName,
    difficultyBase: DIFFICULTY_VALUE[row.question.difficultyLabel] ?? row.skillDifficulty ?? 0.55,
    bloom: BLOOM_VALUE[row.question.bloomLevel] ?? 3,
    estimatedSeconds: row.question.estimatedSeconds,
    text: row.question.stem,
  }));

  const seen = new Set(answered.map((item) => item.questionId));
  const chosen = selectNextItem({
    candidates,
    skillPriorities,
    askedCounts,
    model,
    ability,
    baseSample: {
      ability,
      masteryBefore: 0.5,
      skillAccuracy: 0.5,
      evidence: 0.4,
      responseTimeMs: 30_000,
    },
    seen,
  });

  if (!chosen) return null;

  const questionRow = candidateRows.find((row) => row.question.id === chosen.candidate.questionId);
  const skill = await loadSkillFeatures(assessment.studentId, chosen.candidate.skillId);
  const [item] = await db
    .insert(assessmentItems)
    .values({
      assessmentId,
      questionId: chosen.candidate.questionId,
      skillId: chosen.candidate.skillId,
      sequence: answered.length + 1,
      predictedCorrectProb: round(chosen.probability, 3),
      assignedDifficulty: round(chosen.candidate.difficultyBase, 3),
      masteryBefore: round(skill.mastery, 3),
      masteryAfter: round(skill.mastery, 3),
      responseTimeMs: 0,
    })
    .returning();

  return {
    itemId: item.id,
    questionId: chosen.candidate.questionId,
    sequence: item.sequence,
    skillId: chosen.candidate.skillId,
    skillName: questionRow?.skillName ?? "Skill",
    subjectName: questionRow?.subjectName ?? "General",
    subjectColor: questionRow?.subjectColor ?? "#6366f1",
    stem: questionRow?.question.stem ?? "",
    options: questionRow?.question.options ?? [],
    difficultyLabel: questionRow?.question.difficultyLabel ?? "medium",
    bloomLevel: questionRow?.question.bloomLevel ?? "apply",
    estimatedSeconds: questionRow?.question.estimatedSeconds ?? 60,
    predictedSuccess: round(chosen.probability, 3),
    mastery: round(skill.mastery, 3),
    label: labelPrediction(chosen.probability),
    rationale: chosen.rationale,
    informationGain: round(chosen.information, 2),
  };
}

export type GradeResult = {
  isCorrect: boolean;
  correctIndex: number;
  explanation: string;
  predictedSuccess: number;
  masteryBefore: number;
  masteryAfter: number;
  delta: number;
  masteryPrediction: number;
  streak: number;
  answeredCount: number;
  itemTarget: number;
  completed: boolean;
  next: SessionQuestion | null;
  summary: {
    score: number;
    correct: number;
    total: number;
    forecastLabel: string;
    predictedNext: number;
    weakestSkill: string;
    strongestSkill: string;
  } | null;
};

export async function gradeItem(params: {
  assessmentId: number;
  itemId: number;
  studentAnswer: number | null;
  responseTimeMs: number;
}): Promise<GradeResult | { error: string }> {
  const assessmentRows = await db.select().from(assessments).where(eq(assessments.id, params.assessmentId)).limit(1);
  const assessment = assessmentRows[0];
  if (!assessment) return { error: "Assessment not found" };

  const itemRows = await db
    .select({
      item: assessmentItems,
      question: questions,
      skillName: skills.name,
    })
    .from(assessmentItems)
    .innerJoin(questions, eq(questions.id, assessmentItems.questionId))
    .innerJoin(skills, eq(skills.id, assessmentItems.skillId))
    .where(and(eq(assessmentItems.id, params.itemId), eq(assessmentItems.assessmentId, params.assessmentId)))
    .limit(1);
  const row = itemRows[0];
  if (!row) return { error: "Item not found" };
  if (row.item.studentAnswer !== null) return { error: "Item already answered" };

  const skill = await loadSkillFeatures(assessment.studentId, row.item.skillId);
  const model = await loadClassifier();
  const predicted = predictProbability(
    model,
    buildSample({
      ability: skill.ability,
      mastery: skill.mastery,
      difficultyBase: DIFFICULTY_VALUE[row.question.difficultyLabel] ?? 0.55,
      bloom: BLOOM_VALUE[row.question.bloomLevel] ?? 3,
      responseTimeMs: params.responseTimeMs || row.question.estimatedSeconds * 1000,
      skillAccuracy: skill.skillAccuracy,
      evidence: skill.evidence,
    }),
  );

  const isCorrect = params.studentAnswer !== null && params.studentAnswer === row.question.correctIndex;
  const masteryBefore = skill.mastery;
  const masteryAfter = posterior(masteryBefore, isCorrect);
  const nowDate = new Date();

  await db
    .update(assessmentItems)
    .set({
      studentAnswer: params.studentAnswer,
      isCorrect,
      responseTimeMs: params.responseTimeMs,
      predictedCorrectProb: round(predicted, 3),
      masteryBefore: round(masteryBefore, 3),
      masteryAfter: round(masteryAfter, 3),
    })
    .where(eq(assessmentItems.id, row.item.id));

  const priorState = skill.state;
  const history = [...(priorState?.history ?? []), { t: nowDate.toISOString(), m: round(masteryAfter, 3) }].slice(-40);
  const attempts = (priorState?.attempts ?? 0) + 1;
  const correct = (priorState?.correct ?? 0) + (isCorrect ? 1 : 0);
  const streak = isCorrect ? (priorState?.streak ?? 0) + 1 : 0;

  if (priorState) {
    await db
      .update(masteryStates)
      .set({ mastery: round(masteryAfter, 3), attempts, correct, streak, history, lastPracticedAt: nowDate, updatedAt: nowDate })
      .where(eq(masteryStates.id, priorState.id));
  } else {
    await db.insert(masteryStates).values({
      studentId: assessment.studentId,
      skillId: row.item.skillId,
      mastery: round(masteryAfter, 3),
      priorMastery: round(masteryAfter, 3),
      attempts,
      correct,
      streak,
      history,
      lastPracticedAt: nowDate,
    });
  }

  await db.insert(activityEvents).values({
    studentId: assessment.studentId,
    type: "practice",
    skillId: row.item.skillId,
    summary: `${isCorrect ? "Correct" : "Incorrect"} · ${row.skillName} · predicted ${(predicted * 100).toFixed(0)}%`,
    value: round(masteryAfter, 3),
  });

  const allItems = await db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, params.assessmentId));
  const answeredItems = allItems.filter((entry) => entry.studentAnswer !== null);
  const correctCount = answeredItems.filter((entry) => entry.isCorrect).length;
  const shouldComplete = answeredItems.length >= assessment.itemTarget;

  let summary: GradeResult["summary"] = null;
  if (shouldComplete) {
    const [skillNames, priorAssessments] = await Promise.all([
      db.select({ id: skills.id, name: skills.name }).from(skills),
      db
        .select({ score: assessments.score, startedAt: assessments.startedAt })
        .from(assessments)
        .where(and(eq(assessments.studentId, assessment.studentId), eq(assessments.status, "completed")))
        .orderBy(assessments.startedAt),
    ]);
    const score = round(correctCount / Math.max(1, answeredItems.length), 3);
    const historyPoints = [
      ...priorAssessments.map((entry, index) => ({ label: `S${index + 1}`, value: entry.score ?? 0 })),
      { label: `S${priorAssessments.length + 1}`, value: score },
    ];
    const forecast = forecastPerformance(historyPoints, MASTERY_TARGET);
    const bySkill = new Map<number, { correct: number; total: number }>();
    for (const entry of answeredItems) {
      const bucket = bySkill.get(entry.skillId) ?? { correct: 0, total: 0 };
      bucket.total += 1;
      if (entry.isCorrect) bucket.correct += 1;
      bySkill.set(entry.skillId, bucket);
    }
    const skillRanking = [...bySkill.entries()]
      .map(([skillId, bucket]) => ({
        name: skillNames.find((entry) => entry.id === skillId)?.name ?? "Skill",
        rate: bucket.correct / bucket.total,
      }))
      .sort((a, b) => a.rate - b.rate);

    await db
      .update(assessments)
      .set({
        status: "completed",
        score,
        ability: round(masteryAfter, 3),
        predictedScore: round(forecast.nextValue, 3),
        forecastLabel: forecast.trendLabel,
        completedAt: new Date(),
      })
      .where(eq(assessments.id, params.assessmentId));

    await db.insert(activityEvents).values({
      studentId: assessment.studentId,
      type: "assessment",
      summary: `Completed ${assessment.title} · ${correctCount}/${answeredItems.length} correct (${(score * 100).toFixed(0)}%)`,
      value: score,
    });

    summary = {
      score,
      correct: correctCount,
      total: answeredItems.length,
      forecastLabel: forecast.trendLabel,
      predictedNext: round(forecast.nextValue, 3),
      weakestSkill: skillRanking[0]?.name ?? "—",
      strongestSkill: skillRanking.at(-1)?.name ?? "—",
    };
  }

  const next = shouldComplete ? null : await computeNextSessionQuestion(params.assessmentId);

  return {
    isCorrect,
    correctIndex: row.question.correctIndex,
    explanation: row.question.explanation,
    predictedSuccess: round(predicted, 3),
    masteryBefore: round(masteryBefore, 3),
    masteryAfter: round(masteryAfter, 3),
    delta: round(masteryAfter - masteryBefore, 3),
    masteryPrediction: round(predictCorrect(masteryAfter), 3),
    streak,
    answeredCount: answeredItems.length,
    itemTarget: assessment.itemTarget,
    completed: shouldComplete,
    next,
    summary,
  };
}

export async function startAssessment(params: {
  studentId: number;
  title: string;
  mode: string;
  targetSkillIds: number[];
  itemTarget: number;
}) {
  const [row] = await db
    .insert(assessments)
    .values({
      studentId: params.studentId,
      title: params.title,
      mode: params.mode,
      status: "in_progress",
      targetSkillIds: params.targetSkillIds,
      itemTarget: params.itemTarget,
      ability: 0.5,
    })
    .returning();
  await db.insert(activityEvents).values({
    studentId: params.studentId,
    type: "assessment",
    summary: `Started ${params.title} (${params.itemTarget} adaptive items)`,
    value: 0,
  });
  return row;
}

export async function studentName(studentId: number) {
  const rows = await db.select({ name: users.name }).from(users).where(eq(users.id, studentId)).limit(1);
  return rows[0]?.name ?? "Learner";
}

export async function countRows(table: "assessments") {
  void table;
  const result = await db.select({ total: sql<number>`count(*)::int` }).from(assessments);
  return Number(result[0]?.total ?? 0);
}
