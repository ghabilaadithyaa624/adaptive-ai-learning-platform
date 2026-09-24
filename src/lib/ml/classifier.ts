/**
 * Difficulty / correctness classifier.
 *
 * A logistic-regression classifier predicts P(item correct) for a (student,
 * question) pair. The very same score powers two product features:
 *   1. difficulty prediction + adaptive item selection (target the ZPD band)
 *   2. risk flagging for the performance forecast
 */
import { clamp } from "@/lib/utils";
import { evaluateClassification, type ClassificationMetrics } from "./evaluation";

/**
 * Version of the feature pipeline. Bump whenever FEATURE_NAMES or extractFeatures
 * changes so stored models can be matched to the feature contract that produced
 * them (and stale models retired).
 */
export const FEATURE_VERSION = "feat-v2";

export const FEATURE_NAMES = [
  "bias",
  "ability",
  "mastery_before",
  "difficulty_base",
  "zpd_gap",
  "bloom_level",
  "log_time",
  "skill_accuracy",
  "evidence",
] as const;

export type ClassifierModel = {
  name: string;
  /** Optional independently fitted calibration artifact. Absent means identity. */
  calibration?: import("./response-calibration").ResponseCalibrator;
  version: string;
  featureNames: string[];
  weights: number[];
  means: number[];
  stds: number[];
  samples: number;
  trainedAt: string;
  metrics: ModelMetrics;
};

export type ModelMetrics = {
  accuracy: number;
  logLoss: number;
  auc: number; // ROC-AUC (kept key for backwards compatibility)
  brier: number;
  precision: number;
  recall: number;
  testSize: number;
  // expanded metrics (added additively)
  f1: number;
  prAuc: number; // PR-AUC / average precision
  ece: number; // expected calibration error
  mce: number; // maximum calibration error
};

export type FeatureSample = {
  ability: number;
  masteryBefore: number;
  difficultyBase: number;
  bloom: number;
  responseTimeMs: number;
  skillAccuracy: number;
  evidence: number;
};

export const BLOOM_SCALE: Record<string, number> = {
  remember: 1,
  understand: 2,
  apply: 3,
  analyze: 4,
  evaluate: 5,
  create: 6,
};

export function bloomToNumber(level: string) {
  return BLOOM_SCALE[level.toLowerCase()] ?? 3;
}

export function extractFeatures(sample: FeatureSample): number[] {
  return [
    1,
    sample.ability,
    sample.masteryBefore,
    sample.difficultyBase,
    clamp(sample.ability - sample.difficultyBase, -1, 1),
    (sample.bloom - 3) / 3,
    Math.log1p(Math.max(0, sample.responseTimeMs) / 1000) / 3,
    sample.skillAccuracy,
    clamp(sample.evidence, 0, 1),
  ];
}

export const HEURISTIC_WEIGHTS = [0.05, 1.15, 0.95, -0.85, 0.7, -0.16, -0.22, 0.85, 0.3];

export const HEURISTIC_MODEL: ClassifierModel = {
  name: "difficulty-classifier",
  version: "heuristic-0.1",
  featureNames: [...FEATURE_NAMES],
  weights: HEURISTIC_WEIGHTS,
  means: FEATURE_NAMES.map(() => 0),
  stds: FEATURE_NAMES.map(() => 1),
  samples: 0,
  trainedAt: new Date(0).toISOString(),
  metrics: { accuracy: 0, logLoss: 0, auc: 0, brier: 0, precision: 0, recall: 0, testSize: 0, f1: 0, prAuc: 0, ece: 0, mce: 0 },
};

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

export function predictProbability(model: ClassifierModel, sample: FeatureSample) {
  const x = extractFeatures(sample);
  return predictWithFeatures(model, x);
}

export function predictWithFeatures(model: ClassifierModel, x: number[]) {
  let z = 0;
  for (let i = 0; i < x.length; i += 1) {
    const std = model.stds[i] || 1;
    const mean = model.means[i] || 0;
    const scaled = i === 0 ? 1 : (x[i] - mean) / std;
    z += (model.weights[i] ?? 0) * scaled;
  }
  return clamp(sigmoid(z), 0.01, 0.99);
}

export type PredictionLabel = {
  key: "mastered" | "target" | "stretch" | "at_risk";
  label: string;
  tone: "emerald" | "sky" | "amber" | "rose";
  hint: string;
};

export function labelPrediction(p: number): PredictionLabel {
  if (p >= 0.88) {
    return { key: "mastered", label: "Too easy", tone: "emerald", hint: "Likely already mastered — low information value." };
  }
  if (p >= 0.6) {
    return { key: "target", label: "Target zone", tone: "sky", hint: "Right at the edge of ability — highest learning gain." };
  }
  if (p >= 0.32) {
    return { key: "stretch", label: "Productive struggle", tone: "amber", hint: "Stretching but reachable with scaffolding." };
  }
  return { key: "at_risk", label: "Too hard now", tone: "rose", hint: "Prerequisite gap likely — revisit foundations first." };
}

export type TrainOptions = {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  /**
   * Held-out rows to evaluate on. These MUST come chronologically after `rows`
   * (the caller — the registry — performs the temporal split) so the reported
   * metrics are an honest out-of-sample estimate with no leakage. When omitted,
   * metrics fall back to in-sample training data and `metricsOutOfSample` is false.
   */
  evalRows?: { x: number[]; y: number }[];
};

export type TrainResult = {
  model: ClassifierModel;
  /** Full held-out classification report (confusion matrix, reliability bins, ...). */
  evaluation: ClassificationMetrics | null;
  metricsOutOfSample: boolean;
};

/**
 * Train the logistic-regression classifier on the supplied rows.
 *
 * IMPORTANT: this function does NOT split the data. Any train/test partitioning
 * must be done chronologically by the caller and passed via `options.evalRows`,
 * so the future never leaks into training or into the reported metrics.
 * Standardisation statistics are learned on the training rows only.
 */
export function trainClassifier(rows: { x: number[]; y: number }[], options: TrainOptions = {}): ClassifierModel {
  return trainClassifierDetailed(rows, options).model;
}

export function trainClassifierDetailed(rows: { x: number[]; y: number }[], options: TrainOptions = {}): TrainResult {
  const epochs = options.epochs ?? 900;
  const lr0 = options.learningRate ?? 0.35;
  const l2 = options.l2 ?? 0.0025;
  const featureCount = FEATURE_NAMES.length;

  const train = rows.filter((row) => row.x.length === featureCount);
  if (train.length < 12) {
    return { model: { ...HEURISTIC_MODEL }, evaluation: null, metricsOutOfSample: false };
  }

  // Standardise using TRAIN statistics only.
  const means: number[] = new Array(featureCount).fill(0);
  const stds: number[] = new Array(featureCount).fill(1);
  for (let f = 1; f < featureCount; f += 1) {
    const values = train.map((row) => row.x[f]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    means[f] = mean;
    stds[f] = Math.sqrt(variance) || 1;
  }

  const scale = (x: number[]) => x.map((value, index) => (index === 0 ? 1 : (value - means[index]) / stds[index]));
  const scaledTrain = train.map((row) => ({ x: scale(row.x), y: row.y }));

  const weights: number[] = new Array(featureCount).fill(0);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const lr = lr0 * (1 - epoch / (epochs * 1.35));
    const grad: number[] = new Array(featureCount).fill(0);
    for (const row of scaledTrain) {
      let z = 0;
      for (let f = 0; f < featureCount; f += 1) z += weights[f] * row.x[f];
      const err = sigmoid(z) - row.y;
      for (let f = 0; f < featureCount; f += 1) grad[f] += err * row.x[f];
    }
    for (let f = 0; f < featureCount; f += 1) {
      const reg = f === 0 ? 0 : l2 * weights[f];
      weights[f] -= lr * (grad[f] / scaledTrain.length + reg);
    }
  }

  // Evaluate out-of-sample when a held-out set is provided; otherwise in-sample.
  const evalRows = (options.evalRows ?? train).filter((row) => row.x.length === featureCount);
  const metricsOutOfSample = Boolean(options.evalRows && options.evalRows.length > 0);
  const labels: number[] = [];
  const scores: number[] = [];
  for (const row of evalRows) {
    labels.push(row.y);
    scores.push(sigmoid(weightedSum(weights, scale(row.x))));
  }
  const report = labels.length ? evaluateClassification(labels, scores) : null;
  const metrics: ModelMetrics = report
    ? {
        accuracy: report.accuracy,
        logLoss: report.logLoss,
        auc: report.rocAuc ?? 0.5,
        brier: report.brier,
        precision: report.precision,
        recall: report.recall,
        testSize: report.samples,
        f1: report.f1,
        prAuc: report.prAuc ?? 0,
        ece: report.calibrationError,
        mce: report.maxCalibrationError,
      }
    : { ...HEURISTIC_MODEL.metrics };

  const model: ClassifierModel = {
    name: "difficulty-classifier",
    version: `lr-${new Date().toISOString().slice(0, 10)}`,
    featureNames: [...FEATURE_NAMES],
    weights,
    means,
    stds,
    samples: train.length,
    trainedAt: new Date().toISOString(),
    metrics,
  };
  return { model, evaluation: report, metricsOutOfSample };
}

function weightedSum(weights: number[], x: number[]) {
  let z = 0;
  for (let i = 0; i < weights.length; i += 1) z += weights[i] * x[i];
  return clamp(z, -30, 30);
}
