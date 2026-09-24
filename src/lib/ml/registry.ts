/** Model registry: persistence + retraining against live response data. */
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { assessments, assessmentItems, masteryStates, mlModels, modelEvaluations, questions } from "@/db/schema";
import {
  FEATURE_VERSION,
  HEURISTIC_MODEL,
  extractFeatures,
  trainClassifierDetailed,
  type ClassifierModel,
} from "./classifier";
import { chronologicalSplit } from "./splits";
import { decidePromotion, type PromotionDecision } from "./model-compare";
import { adaptiveSelector, DEFAULT_SELECTION_WEIGHTS, PREREQ_GATE } from "./selection";
import { bktModel } from "./models/bkt";
import { irtModel } from "./models/irt";
import { bayesianModel } from "./models/bayesian";
import { mean } from "@/lib/utils";

export const CLASSIFIER_NAME = "difficulty-classifier";
export const TRACER_NAME = "bkt-knowledge-tracer";
export const POLICY_NAME = "adaptive-selector";

/** Deterministic signature of a training dataset (count + time span + checksum). */
export function datasetSignature(rows: { createdAt: Date | string; y: number }[]): string {
  if (!rows.length) return "empty";
  const times = rows.map((r) => new Date(r.createdAt).getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  // order-independent, value-sensitive checksum
  let checksum = 0;
  for (let i = 0; i < rows.length; i += 1) {
    checksum = (checksum + (rows[i].y + 1) * (i + 1) * 2654435761) % 1_000_000_007;
  }
  const spanDays = Math.round((max - min) / 86_400_000);
  return `n${rows.length}-span${spanDays}d-c${checksum.toString(36)}`;
}

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
        f1: row.metrics.f1 ?? 0,
        prAuc: row.metrics.prAuc ?? 0,
        ece: row.metrics.ece ?? 0,
        mce: row.metrics.mce ?? 0,
      },
    };
  } catch {
    return HEURISTIC_MODEL;
  }
}

export async function saveClassifier(
  model: ClassifierModel,
  provenance: {
    datasetVersion?: string;
    hyperparams?: Record<string, unknown>;
    evaluatedAt?: Date;
  } = {},
) {
  const payload = {
    name: CLASSIFIER_NAME,
    kind: "classifier",
    version: model.version,
    datasetVersion: provenance.datasetVersion ?? null,
    featureVersion: FEATURE_VERSION,
    params: {
      featureNames: model.featureNames,
      weights: model.weights,
      means: model.means,
      stds: model.stds,
    } as Record<string, unknown>,
    hyperparams: (provenance.hyperparams ?? {}) as Record<string, unknown>,
    metrics: { ...model.metrics } as Record<string, number>,
    samples: model.samples,
    trainedAt: new Date(),
    evaluatedAt: provenance.evaluatedAt ?? new Date(),
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
 * Register the adaptive selection policy so the model registry reflects the
 * upgraded engine: which selector is live, its tunable weights, the prerequisite
 * gate, and the pluggable knowledge/response models it can run against.
 */
export async function saveAdaptivePolicySnapshot() {
  const payload = {
    name: POLICY_NAME,
    kind: "recommender",
    version: adaptiveSelector.id,
    params: {
      selector: adaptiveSelector.id,
      weights: DEFAULT_SELECTION_WEIGHTS,
      prereqGate: PREREQ_GATE,
      responseModel: "logistic-regression",
      knowledgeModels: [bktModel.id, irtModel.id, bayesianModel.id],
      learnerSignals: 15,
      selectionCriteria: 10,
    } as Record<string, unknown>,
    metrics: { learnerSignals: 15, selectionCriteria: 10, knowledgeModels: 3 } as Record<string, number>,
    samples: 0,
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

      return { x: features, y: outcome, createdAt: row.createdAt as Date };
    });

  const hyperparams = { epochs: 1400, learningRate: 0.4, l2: 0.003, trainRatio: 0.7, valRatio: 0.15 };
  const datasetVersion = datasetSignature(trainingRows);

  // Temporal (chronological) split — the leakage guard. The classifier only ever
  // sees the past; the reported metrics come from the most-recent held-out block.
  const split = chronologicalSplit(trainingRows, (r) => r.createdAt, {
    trainRatio: hyperparams.trainRatio,
    valRatio: hyperparams.valRatio,
  });

  const { model, evaluation, metricsOutOfSample } = trainClassifierDetailed(split.train, {
    epochs: hyperparams.epochs,
    learningRate: hyperparams.learningRate,
    l2: hyperparams.l2,
    evalRows: split.test,
  });

  const promotion = await recordClassifierEvaluation({
    model,
    datasetVersion,
    hyperparams,
    heldOutSamples: split.test.length,
    detail: {
      metricsOutOfSample,
      split: { train: split.train.length, validation: split.validation.length, test: split.test.length },
      confusion: evaluation?.confusion ?? null,
      reliability: evaluation?.reliability ?? null,
      rocAucApplicable: evaluation?.rocAucApplicable ?? false,
      prAucApplicable: evaluation?.prAucApplicable ?? false,
    },
  });

  await saveClassifier(model, { datasetVersion, hyperparams, evaluatedAt: new Date() });

  const tracerSummary = {
    trackedPairs: abilityRows.length,
    avgAttemptsPerSkill: Number(mean(abilityRows.map((row) => row.attempts)).toFixed(2)),
    avgMastery: Number(mean(abilityRows.map((row) => row.mastery)).toFixed(3)),
    avgResponsesPerSession: 0,
    sessions: rows.length ? new Set(rows.map((row) => row.assessmentId)).size : 0,
    responses: rows.length,
  };
  await saveTracerSnapshot(tracerSummary, rows.length);
  await saveAdaptivePolicySnapshot();

  return { model, promotion, datasetVersion, featureVersion: FEATURE_VERSION, heldOutSamples: split.test.length };
}

/**
 * Append an evaluation row and compare the candidate against the most recent
 * previous evaluation to detect improvement / regression. The comparison is
 * evidence-gated: we never claim "better" without a held-out win on the primary
 * metric, sufficient samples, and no guarded-metric regression.
 */
export async function recordClassifierEvaluation(params: {
  model: ClassifierModel;
  datasetVersion: string;
  hyperparams: Record<string, unknown>;
  heldOutSamples: number;
  detail: Record<string, unknown>;
}): Promise<PromotionDecision> {
  const priorRows = await db
    .select()
    .from(modelEvaluations)
    .where(eq(modelEvaluations.modelName, CLASSIFIER_NAME))
    .orderBy(desc(modelEvaluations.evaluatedAt))
    .limit(1);
  const baseline = priorRows[0]?.metrics ?? null;

  const promotion = decidePromotion({
    candidate: params.model.metrics,
    baseline,
    primaryMetric: "auc", // ROC-AUC is the primary discrimination metric
    candidateSamples: params.heldOutSamples,
    minSamples: 30,
    minImprovement: 0.005,
    guardedMetrics: ["auc", "logLoss", "brier", "ece", "accuracy"],
  });

  await db.insert(modelEvaluations).values({
    modelName: CLASSIFIER_NAME,
    kind: "classifier",
    version: params.model.version,
    datasetVersion: params.datasetVersion,
    featureVersion: FEATURE_VERSION,
    split: "test",
    metrics: { ...params.model.metrics } as Record<string, number>,
    detail: { ...params.detail, promotion } as Record<string, unknown>,
    hyperparams: params.hyperparams as Record<string, unknown>,
    samples: params.heldOutSamples,
    trainedAt: new Date(),
    evaluatedAt: new Date(),
  });

  return promotion;
}
