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
import { DEFAULT_BKT, applyDecay, posterior, predictCorrect } from "@/lib/ml/knowledge-tracing";
import { labelPrediction, predictProbability, type FeatureSample } from "@/lib/ml/classifier";
import { loadClassifier } from "@/lib/ml/registry";
import { forecastPerformance } from "@/lib/ml/forecast";
import { buildLearnerState, type RawResponse, type RawSkillState } from "@/lib/ml/learner-state";
import { getSelectionStrategy, resolvePolicyId } from "@/lib/ml/policy";
import {
  assignLearnerToActiveExperiments,
  recordExposure,
  strategyForConfig,
} from "@/lib/experiments";
import { LogisticResponseModel } from "@/lib/ml/models/logistic";
import { bktModel } from "@/lib/ml/models/bkt";
import { events, log, now } from "@/lib/observability";
import type { CandidateItem, DecisionExplanation } from "@/lib/ml/interfaces";
import { SERVABLE_STATUSES } from "@/lib/questions/constants";
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
  /**
   * Machine-readable record of *why* this question was selected: every
   * objective's raw/normalised value and weighted contribution, every gate that
   * filtered candidates, the runner-up it beat and by how much. Persisted with
   * the selection event so any served item can be audited after the fact.
   */
  decision: DecisionExplanation | null;
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
  const selectionStart = now();
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
  const [states, candidateRows, skillRows, recentItemRows] = await Promise.all([
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
      // Only published/monitored items are delivered to learners — draft, in-review,
      // validated-but-unpublished and retired items are never served.
      .where(
        and(
          inArray(questions.skillId, targetSkillIds),
          eq(questions.isActive, true),
          inArray(questions.status, SERVABLE_STATUSES),
        ),
      ),
    // Full skill graph (small taxonomy) so prerequisite gating works even for
    // skills the learner has not attempted yet.
    db
      .select({ skill: skills, subjectName: subjects.name })
      .from(skills)
      .innerJoin(subjects, eq(subjects.id, skills.subjectId)),
    // Recent answered responses power recency, response-time and error signals.
    db
      .select({
        skillId: assessmentItems.skillId,
        isCorrect: assessmentItems.isCorrect,
        responseTimeMs: assessmentItems.responseTimeMs,
        estimatedSeconds: questions.estimatedSeconds,
        difficultyLabel: questions.difficultyLabel,
        bloomLevel: questions.bloomLevel,
        createdAt: assessmentItems.createdAt,
      })
      .from(assessmentItems)
      .innerJoin(assessments, eq(assessments.id, assessmentItems.assessmentId))
      .innerJoin(questions, eq(questions.id, assessmentItems.questionId))
      .where(eq(assessments.studentId, assessment.studentId))
      .orderBy(assessmentItems.createdAt)
      .limit(120),
  ]);

  // The full mastery state set for this student is already loaded above; derive
  // the per-skill decayed mastery from it instead of issuing extra queries
  // (`loadSkillFeatures` re-queries mastery_states + a question count) on this
  // hot, per-question-served path.
  const masteryForSkill = (skillId: number) => {
    const st = states.find((row) => row.skillId === skillId);
    return st ? applyDecay(st.mastery, st.lastPracticedAt) : 0;
  };

  if (pending) {
    const questionRow = candidateRows.find((row) => row.question.id === pending.questionId);
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
      mastery: round(masteryForSkill(pending.skillId), 3),
      label: labelPrediction(pending.predictedCorrectProb),
      rationale: "Resuming the item already queued for this session.",
      informationGain: round(pending.predictedCorrectProb * (1 - pending.predictedCorrectProb) * 4, 2),
      // Resumed items were explained when they were first selected; the record
      // lives on that original selection event rather than being re-derived
      // against a learner state that has since moved on.
      decision: null,
    };
  }

  // ---- Build the rich composite learner state (v2 adaptive engine) ----
  const stateBySkill = new Map(states.map((row) => [row.skillId, row]));
  const rawSkillStates: RawSkillState[] = skillRows.map((row) => {
    const state = stateBySkill.get(row.skill.id);
    return {
      skillId: row.skill.id,
      skillName: row.skill.name,
      subjectName: row.subjectName,
      mastery: state ? state.mastery : 0.2,
      attempts: state?.attempts ?? 0,
      correct: state?.correct ?? 0,
      streak: state?.streak ?? 0,
      history: state?.history ?? [],
      lastPracticedAt: state?.lastPracticedAt ?? null,
      prereqIds: row.skill.prereqIds ?? [],
      difficultyBase: row.skill.difficultyBase,
      pathAlignment: assessment.targetSkillIds?.includes(row.skill.id) ? 0.8 : 0.3,
    };
  });

  const recentResponses: RawResponse[] = recentItemRows
    .filter((row) => row.isCorrect !== null)
    .map((row) => ({
      skillId: row.skillId,
      isCorrect: Boolean(row.isCorrect),
      responseTimeMs: row.responseTimeMs,
      estimatedSeconds: row.estimatedSeconds,
      difficulty: DIFFICULTY_VALUE[row.difficultyLabel] ?? 0.55,
      bloom: BLOOM_VALUE[row.bloomLevel] ?? 3,
      createdAt: row.createdAt,
    }));

  const sessionCorrect = answered.filter((item) => item.isCorrect).length;
  const learnerState = buildLearnerState({
    studentId: assessment.studentId,
    skillStates: rawSkillStates,
    responses: recentResponses,
    context: {
      mode: assessment.mode,
      itemsAnswered: answered.length,
      itemTarget: assessment.itemTarget,
      sessionAccuracy: answered.length ? sessionCorrect / answered.length : undefined,
    },
  });

  const candidates: CandidateItem[] = candidateRows.map((row) => ({
    questionId: row.question.id,
    skillId: row.question.skillId,
    skillName: row.skillName,
    subjectName: row.subjectName,
    item: {
      difficulty: DIFFICULTY_VALUE[row.question.difficultyLabel] ?? row.skillDifficulty ?? 0.55,
      bloom: BLOOM_VALUE[row.question.bloomLevel] ?? 3,
      expectedTimeMs: row.question.estimatedSeconds * 1000,
    },
    estimatedSeconds: row.question.estimatedSeconds,
    text: row.question.stem,
  }));

  const askedSkillCounts = new Map<number, number>();
  const askedBloomCounts = new Map<number, number>();
  for (const item of answered) {
    askedSkillCounts.set(item.skillId, (askedSkillCounts.get(item.skillId) ?? 0) + 1);
    const q = candidateRows.find((row) => row.question.id === item.questionId);
    const bloom = q ? BLOOM_VALUE[q.question.bloomLevel] ?? 3 : 3;
    askedBloomCounts.set(bloom, (askedBloomCounts.get(bloom) ?? 0) + 1);
  }

  // Serving policy is pluggable and resolved per request, so a tenant can pin
  // v2 (or a weight preset) via configuration without a deploy. Default is v3 —
  // see `benchmarks/RESULTS.md` §2 for the held-out evidence behind that default.
  const policyId = resolvePolicyId();

  // An active experiment overrides the configured default for enrolled
  // learners. Assignment is deterministic and sticky, so a learner stays in one
  // arm for the life of the experiment. Failures here must never break
  // practice: if the experiment layer throws, the learner silently gets the
  // platform default and contributes no exposure (and therefore no data).
  let experimentArm: {
    experimentId: number;
    variantKey: string;
    configFingerprint: string;
  } | null = null;
  let strategy = getSelectionStrategy(policyId);
  let servingPolicyId: string = policyId;

  try {
    // Tenant scope comes from the learner's own institution, so an experiment
    // scoped to one customer can never be applied to another's learner.
    const [owner] = await db
      .select({ institutionId: users.institutionId })
      .from(users)
      .where(eq(users.id, assessment.studentId))
      .limit(1);
    const decisions = await assignLearnerToActiveExperiments({
      scope: { institutionId: owner?.institutionId ?? null },
      studentId: assessment.studentId,
      now: new Date(),
    });
    const assigned = decisions.find((d) => d.outcome === "assigned" && d.config);
    if (assigned?.config) {
      strategy = strategyForConfig(assigned.config);
      servingPolicyId = assigned.config.policy;
      experimentArm = {
        experimentId: assigned.experimentId,
        variantKey: assigned.variantKey!,
        configFingerprint: assigned.config.fingerprint,
      };
    }
  } catch (error) {
    log.warn("experiment.assignment_failed", {
      assessmentId,
      studentId: assessment.studentId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }

  const { chosen } = strategy.select({
    learner: learnerState,
    candidates,
    seenQuestionIds: new Set(answered.map((item) => item.questionId)),
    askedSkillCounts,
    askedBloomCounts,
    // Most-recent-first, so the policy can see (and break up) a run on one skill.
    recentSkillIds: answered.slice(-6).map((item) => item.skillId),
    responseModel: new LogisticResponseModel(model),
    knowledgeModel: bktModel,
    target: MASTERY_TARGET,
  });

  if (!chosen) {
    events.selectionExhausted({
      assessmentId,
      studentId: assessment.studentId,
      durationMs: Math.round(now() - selectionStart),
    });
    return null;
  }
  // One batched scoring pass over the candidate pool feeds the selection.
  events.modelPrediction({ model: "difficulty-classifier", surface: "selection", count: candidates.length });

  const questionRow = candidateRows.find((row) => row.question.id === chosen.candidate.questionId);
  const chosenMastery = masteryForSkill(chosen.candidate.skillId);
  const [item] = await db
    .insert(assessmentItems)
    .values({
      assessmentId,
      questionId: chosen.candidate.questionId,
      skillId: chosen.candidate.skillId,
      sequence: answered.length + 1,
      predictedCorrectProb: round(chosen.predictedCorrect, 3),
      assignedDifficulty: round(chosen.candidate.item.difficulty, 3),
      masteryBefore: round(chosenMastery, 3),
      masteryAfter: round(chosenMastery, 3),
      responseTimeMs: 0,
    })
    .returning();

  // Exposure is recorded only once an item actually exists, and is keyed to it.
  // That join is what lets attribution credit this learner's outcome to this
  // arm — assignment alone deliberately does not.
  if (experimentArm) {
    try {
      await recordExposure({
        experimentId: experimentArm.experimentId,
        studentId: assessment.studentId,
        variantKey: experimentArm.variantKey,
        configFingerprint: experimentArm.configFingerprint,
        surface: "assessment.next-item",
        entityId: item.id,
        occurredAt: new Date(),
      });
    } catch (error) {
      log.warn("experiment.exposure_failed", {
        assessmentId,
        studentId: assessment.studentId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  events.questionSelected({
    assessmentId,
    studentId: assessment.studentId,
    itemId: item.id,
    questionId: chosen.candidate.questionId,
    skillId: chosen.candidate.skillId,
    sequence: item.sequence,
    predictedSuccess: round(chosen.predictedCorrect, 3),
    informationGain: round(chosen.information, 2),
    durationMs: Math.round(now() - selectionStart),
    policyId: servingPolicyId,
    decision: chosen.decision ?? null,
  });

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
    predictedSuccess: round(chosen.predictedCorrect, 3),
    mastery: round(chosenMastery, 3),
    label: labelPrediction(chosen.predictedCorrect),
    rationale: chosen.explanation,
    informationGain: round(chosen.information, 2),
    decision: chosen.decision ?? null,
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

  events.modelPrediction({
    model: "difficulty-classifier",
    surface: "grading",
    studentId: assessment.studentId,
    questionId: row.question.id,
    probability: round(predicted, 3),
  });

  const isCorrect = params.studentAnswer !== null && params.studentAnswer === row.question.correctIndex;
  const masteryBefore = skill.mastery;
  // Use the per-skill BKT parameters persisted on the mastery state when
  // available (previously ignored) so tracing adapts to how slippery/guessable
  // each skill is; fall back to the population defaults otherwise.
  const bktParams = skill.state
    ? {
        slip: skill.state.slip ?? DEFAULT_BKT.slip,
        guess: skill.state.guess ?? DEFAULT_BKT.guess,
        learn: skill.state.learnRate ?? DEFAULT_BKT.learn,
        forget: DEFAULT_BKT.forget,
      }
    : DEFAULT_BKT;
  const masteryAfter = posterior(masteryBefore, isCorrect, bktParams);
  const nowDate = new Date();

  events.answerSubmitted({
    assessmentId: params.assessmentId,
    studentId: assessment.studentId,
    itemId: row.item.id,
    questionId: row.question.id,
    skillId: row.item.skillId,
    isCorrect,
    responseTimeMs: params.responseTimeMs,
    predictedSuccess: round(predicted, 3),
  });
  events.masteryUpdated({
    studentId: assessment.studentId,
    skillId: row.item.skillId,
    masteryBefore: round(masteryBefore, 3),
    masteryAfter: round(masteryAfter, 3),
    delta: round(masteryAfter - masteryBefore, 3),
  });

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

    events.assessmentCompleted({
      assessmentId: params.assessmentId,
      studentId: assessment.studentId,
      mode: assessment.mode,
      outcome: "completed",
      score,
      items: answeredItems.length,
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
  events.assessmentStarted({
    assessmentId: row.id,
    studentId: params.studentId,
    mode: params.mode,
    itemTarget: params.itemTarget,
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
