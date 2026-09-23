/** Model registry: persistence + retraining against live response data. */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assessments, assessmentItems, masteryStates, mlModels, questions } from "@/db/schema";
import {
  HEURISTIC_MODEL,
  extractFeatures,
  trainClassifier,
  type ClassifierModel,
} from "./classifier";
import { mean } from "@/lib/utils";

export const CLASSIFIER_NAME = "difficulty-classifier";
export const TRACER_NAME = "bkt-knowledge-tracer";

export async function loadClassifier(): Promise<ClassifierModel> {
  try {
    const rows = await db.select().from(mlModels).where(eq(mlModels.name, CLASSIFIER_NAME)).limit(1);
    const row = rows[0];
    if (!row) return HEURISTIC_MODEL;
    const params = row.params as unknown as Partial<ClassifierModel>;
    if (!params?.weights?.length) return HEURISTIC_MODEL;
    return {
      name: CLASSIFIER_NAME,
      version: row.version,
      featureNames: params.featureNames ?? HEURISTIC_MODEL.featureNames,
      weights: params.weights,
      means: params.means ?? [],
      stds: params.stds ?? [],
      samples: row.samples,
      trainedAt: row.trainedAt.toISOString(),
      metrics: {
        accuracy: row.metrics.accuracy ?? 0,
        logLoss: row.metrics.logLoss ?? 0,
        auc: row.metrics.auc ?? 0,
        brier: row.metrics.brier ?? 0,
        precision: row.metrics.precision ?? 0,
        recall: row.metrics.recall ?? 0,
        testSize: row.metrics.testSize ?? 0,
      },
    };
  } catch {
    return HEURISTIC_MODEL;
  }
}

export async function saveClassifier(model: ClassifierModel) {
  const payload = {
    name: CLASSIFIER_NAME,
    kind: "classifier",
    version: model.version,
    params: {
      featureNames: model.featureNames,
      weights: model.weights,
      means: model.means,
      stds: model.stds,
    } as Record<string, unknown>,
    metrics: { ...model.metrics } as Record<string, number>,
    samples: model.samples,
    trainedAt: new Date(),
  };
  await db
    .insert(mlModels)
    .values(payload)
    .onConflictDoUpdate({ target: mlModels.name, set: payload });
}

export async function saveTracerSnapshot(summary: Record<string, number>, samples: number) {
  const payload = {
    name: TRACER_NAME,
    kind: "tracer",
    version: "bkt-v3",
    params: { slip: 0.1, guess: 0.2, learn: 0.22, forget: 0.035 } as Record<string, unknown>,
    metrics: summary,
    samples,
    trainedAt: new Date(),
  };
  await db
    .insert(mlModels)
    .values(payload)
    .onConflictDoUpdate({ target: mlModels.name, set: payload });
}

/**
 * Retrain the correctness/difficulty classifier on every logged response:
 * features come from the student's latent mastery at the time of the item plus
 * item metadata, the label is whether the response was correct.
 */
export async function trainAndPersistClassifier() {
  const rows = await db
    .select({
      isCorrect: assessmentItems.isCorrect,
      masteryBefore: assessmentItems.masteryBefore,
      responseTimeMs: assessmentItems.responseTimeMs,
      skillId: assessmentItems.skillId,
      studentId: assessments.studentId,
      assessmentId: assessmentItems.assessmentId,
      studentAnswer: assessmentItems.studentAnswer,
      difficultyLabel: questions.difficultyLabel,
      bloom: questions.bloomLevel,
      createdAt: assessmentItems.createdAt,
    })
    .from(assessmentItems)
    .innerJoin(questions, eq(questions.id, assessmentItems.questionId))
    .innerJoin(assessments, eq(assessments.id, assessmentItems.assessmentId))
    .orderBy(assessmentItems.createdAt, assessmentItems.id);

  const abilityRows = await db
    .select({
      id: masteryStates.id,
      studentId: masteryStates.studentId,
      skillId: masteryStates.skillId,
      attempts: masteryStates.attempts,
      mastery: masteryStates.mastery,
    })
    .from(masteryStates);

  const difficultyValue: Record<string, number> = { easy: 0.3, medium: 0.55, hard: 0.75, expert: 0.9 };
  const bloomValue: Record<string, number> = { remember: 1, understand: 2, apply: 3, analyze: 4, evaluate: 5, create: 6 };

  // Features are built causally: only responses that happened *before* the
  // current item contribute to ability/accuracy. This mirrors serving time and
  // avoids the label-leakage you get from using final mastery states.
  const running = new Map<string, { attempts: number; correct: number }>();
  const serviceRanking = new Map<number, number[]>();

  const trainingRows = rows
    .filter((row) => row.isCorrect !== null && row.studentAnswer !== null)
    .map((row) => {
      const key = `${row.studentId}:${row.skillId}`;
      const stats = running.get(key) ?? { attempts: 0, correct: 0 };
      const history = serviceRanking.get(row.studentId) ?? [];
      const ability = history.length ? mean(history) : 0.45;
      const skillAccuracy = stats.attempts ? stats.correct / stats.attempts : 0.5;

      const features = extractFeatures({
        ability,
        masteryBefore: row.masteryBefore,
        difficultyBase: difficultyValue[row.difficultyLabel] ?? 0.55,
        bloom: bloomValue[row.bloom] ?? 3,
        responseTimeMs: row.responseTimeMs,
        skillAccuracy,
        evidence: Math.min(1, stats.attempts / 12),
      });

      const outcome = row.isCorrect ? 1 : 0;
      running.set(key, { attempts: stats.attempts + 1, correct: stats.correct + outcome });
      serviceRanking.set(row.studentId, [...history, row.masteryBefore].slice(-20));

      return { x: features, y: outcome };
    });

  const model = trainClassifier(trainingRows, { epochs: 1400, learningRate: 0.4, l2: 0.003 });
  await saveClassifier(model);

  const tracerSummary = {
    trackedPairs: abilityRows.length,
    avgAttemptsPerSkill: Number(mean(abilityRows.map((row) => row.attempts)).toFixed(2)),
    avgMastery: Number(mean(abilityRows.map((row) => row.mastery)).toFixed(3)),
    avgResponsesPerSession: 0,
    sessions: rows.length ? new Set(rows.map((row) => row.assessmentId)).size : 0,
    responses: rows.length,
  };
  await saveTracerSnapshot(tracerSummary, rows.length);

  return model;
}
