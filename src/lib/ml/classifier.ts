/**
 * Difficulty / correctness classifier.
 *
 * A logistic-regression classifier predicts P(item correct) for a (student,
 * question) pair. The very same score powers two product features:
 *   1. difficulty prediction + adaptive item selection (target the ZPD band)
 *   2. risk flagging for the performance forecast
 */
import { clamp } from "@/lib/utils";

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
  auc: number;
  brier: number;
  precision: number;
  recall: number;
  testSize: number;
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
  metrics: { accuracy: 0, logLoss: 0, auc: 0, brier: 0, precision: 0, recall: 0, testSize: 0 },
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

function aucScore(labels: number[], scores: number[]) {
  const pairs = labels.map((label, index) => ({ label, score: scores[index] }));
  pairs.sort((a, b) => a.score - b.score);
  let rank = 1;
  const ranks: number[] = new Array(pairs.length).fill(0);
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j < pairs.length - 1 && pairs[j + 1].score === pairs[i].score) j += 1;
    const avgRank = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = avgRank;
    rank += j - i + 1;
    i = j + 1;
  }
  let positives = 0;
  let negatives = 0;
  let rankSum = 0;
  pairs.forEach((pair, index) => {
    if (pair.label === 1) {
      positives += 1;
      rankSum += ranks[index];
    } else {
      negatives += 1;
    }
  });
  if (!positives || !negatives) return 0.5;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

export function trainClassifier(
  rows: { x: number[]; y: number }[],
  options: { epochs?: number; learningRate?: number; l2?: number; seed?: number } = {},
): ClassifierModel {
  const epochs = options.epochs ?? 900;
  const lr0 = options.learningRate ?? 0.35;
  const l2 = options.l2 ?? 0.0025;
  const featureCount = FEATURE_NAMES.length;

  const usable = rows.filter((row) => row.x.length === featureCount);
  if (usable.length < 12) return { ...HEURISTIC_MODEL };

  // cost-sensitive split: shuffle deterministically then 80/20
  let seed = options.seed ?? 20260119;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const shuffled = [...usable];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const testSize = Math.max(8, Math.floor(shuffled.length * 0.2));
  const test = shuffled.slice(0, testSize);
  const train = shuffled.slice(testSize);

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

  const evaluate = (rows: { x: number[]; y: number }[]) => {
    let correct = 0;
    let logLoss = 0;
    let brier = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const labels: number[] = [];
    const scores: number[] = [];
    for (const row of rows) {
      const p = sigmoid(weightedSum(weights, scale(row.x)));
      labels.push(row.y);
      scores.push(p);
      if ((p >= 0.5 ? 1 : 0) === row.y) correct += 1;
      logLoss += -(row.y * Math.log(p + 1e-9) + (1 - row.y) * Math.log(1 - p + 1e-9));
      brier += (p - row.y) ** 2;
      if (p >= 0.5 && row.y === 1) tp += 1;
      if (p >= 0.5 && row.y === 0) fp += 1;
      if (p < 0.5 && row.y === 1) fn += 1;
    }
    return {
      accuracy: correct / rows.length,
      logLoss: logLoss / rows.length,
      auc: aucScore(labels, scores),
      brier: brier / rows.length,
      precision: tp + fp === 0 ? 0 : tp / (tp + fp),
      recall: tp + fn === 0 ? 0 : tp / (tp + fn),
      testSize: rows.length,
    };
  };

  const metrics = evaluate(test.map((row) => ({ x: row.x, y: row.y })));

  return {
    name: "difficulty-classifier",
    version: `lr-${new Date().toISOString().slice(0, 10)}`,
    featureNames: [...FEATURE_NAMES],
    weights,
    means,
    stds,
    samples: usable.length,
    trainedAt: new Date().toISOString(),
    metrics,
  };
}

function weightedSum(weights: number[], x: number[]) {
  let z = 0;
  for (let i = 0; i < weights.length; i += 1) z += weights[i] * x[i];
  return clamp(z, -30, 30);
}
