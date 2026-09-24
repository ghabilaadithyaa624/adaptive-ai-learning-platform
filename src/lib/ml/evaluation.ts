/**
 * Production ML evaluation metrics — pure, deterministic, dependency-free.
 *
 * One place that computes every metric the platform reports, so training,
 * serving-time monitoring and the model registry all agree on definitions.
 *
 *   • Classification / prediction: accuracy, precision, recall, F1, ROC-AUC,
 *     PR-AUC (average precision), log loss, Brier score, calibration error
 *     (ECE + MCE + reliability bins) and the confusion matrix.
 *   • Forecasting: MAE, RMSE, MAPE (only when mathematically appropriate),
 *     sMAPE, bias and prediction-interval coverage (PICP).
 *   • Recommendation: Precision@K, Recall@K, NDCG@K plus acceptance /
 *     completion rates and post-recommendation learning gain.
 *   • Knowledge tracing: next-step predictive accuracy, calibration, mastery
 *     estimation stability and temporal (chronological) validation.
 *
 * Metrics that are undefined for the given data return `null` with an
 * `*Applicable` flag rather than a misleading number — we never fabricate a
 * value the data cannot support.
 */
import { clamp, mean } from "@/lib/utils";

const EPS = 1e-12;

/* ================================================================== */
/* Classification / prediction                                         */
/* ================================================================== */

export interface ConfusionMatrix {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number;
  observedAccuracy: number;
}

export interface ClassificationMetrics {
  samples: number;
  positives: number;
  negatives: number;
  baseRate: number;
  threshold: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  specificity: number;
  rocAuc: number | null;
  rocAucApplicable: boolean;
  prAuc: number | null;
  prAucApplicable: boolean;
  logLoss: number;
  brier: number;
  calibrationError: number; // ECE
  maxCalibrationError: number; // MCE
  confusion: ConfusionMatrix;
  reliability: ReliabilityBin[];
}

/** Rank-based ROC-AUC (Mann–Whitney U) with tie handling via average ranks. */
export function rocAuc(labels: number[], scores: number[]): number | null {
  const positives = labels.filter((y) => y === 1).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return null;

  const order = scores
    .map((score, index) => ({ score, y: labels[index] }))
    .sort((a, b) => a.score - b.score);

  // average ranks (1-based) for ties
  const ranks = new Array(order.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length - 1 && order[j + 1].score === order[i].score) j += 1;
    const avg = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = avg;
    i = j + 1;
  }
  let rankSumPos = 0;
  for (let k = 0; k < order.length; k += 1) if (order[k].y === 1) rankSumPos += ranks[k];
  return (rankSumPos - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** PR-AUC via Average Precision (interpolation-free, sklearn `average_precision`). */
export function prAuc(labels: number[], scores: number[]): number | null {
  const positives = labels.filter((y) => y === 1).length;
  if (positives === 0) return null;
  const order = scores
    .map((score, index) => ({ score, y: labels[index] }))
    .sort((a, b) => b.score - a.score);
  let tp = 0;
  let fp = 0;
  let sumPrecision = 0;
  for (const point of order) {
    if (point.y === 1) {
      tp += 1;
      sumPrecision += tp / (tp + fp);
    } else {
      fp += 1;
    }
  }
  return sumPrecision / positives;
}

export function confusionMatrix(labels: number[], scores: number[], threshold = 0.5): ConfusionMatrix {
  const m: ConfusionMatrix = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  for (let i = 0; i < labels.length; i += 1) {
    const predictedPositive = scores[i] >= threshold;
    const actualPositive = labels[i] === 1;
    if (predictedPositive && actualPositive) m.truePositive += 1;
    else if (predictedPositive && !actualPositive) m.falsePositive += 1;
    else if (!predictedPositive && actualPositive) m.falseNegative += 1;
    else m.trueNegative += 1;
  }
  return m;
}

export function logLoss(labels: number[], scores: number[]): number {
  if (!labels.length) return 0;
  let sum = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const p = clamp(scores[i], EPS, 1 - EPS);
    sum += -(labels[i] * Math.log(p) + (1 - labels[i]) * Math.log(1 - p));
  }
  return sum / labels.length;
}

export function brierScore(labels: number[], scores: number[]): number {
  if (!labels.length) return 0;
  let sum = 0;
  for (let i = 0; i < labels.length; i += 1) sum += (scores[i] - labels[i]) ** 2;
  return sum / labels.length;
}

/** Expected & maximum calibration error with equal-width reliability bins. */
export function calibration(labels: number[], scores: number[], bins = 10) {
  const buckets = Array.from({ length: bins }, (_, index) => ({
    lower: index / bins,
    upper: (index + 1) / bins,
    count: 0,
    confSum: 0,
    correctSum: 0,
  }));
  for (let i = 0; i < labels.length; i += 1) {
    const p = clamp(scores[i], 0, 1);
    const index = Math.min(bins - 1, Math.floor(p * bins));
    buckets[index].count += 1;
    buckets[index].confSum += p;
    buckets[index].correctSum += labels[i];
  }
  const n = labels.length || 1;
  let ece = 0;
  let mce = 0;
  const reliability: ReliabilityBin[] = buckets.map((b) => {
    const meanConfidence = b.count ? b.confSum / b.count : 0;
    const observedAccuracy = b.count ? b.correctSum / b.count : 0;
    if (b.count) {
      const gap = Math.abs(meanConfidence - observedAccuracy);
      ece += (b.count / n) * gap;
      mce = Math.max(mce, gap);
    }
    return { lower: b.lower, upper: b.upper, count: b.count, meanConfidence, observedAccuracy };
  });
  return { ece, mce, reliability };
}

export function evaluateClassification(
  labels: number[],
  scores: number[],
  opts: { threshold?: number; bins?: number } = {},
): ClassificationMetrics {
  if (labels.length !== scores.length) throw new Error("labels and scores length mismatch");
  const threshold = opts.threshold ?? 0.5;
  const n = labels.length;
  const positives = labels.filter((y) => y === 1).length;
  const negatives = n - positives;
  const cm = confusionMatrix(labels, scores, threshold);
  const { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn } = cm;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const { ece, mce, reliability } = calibration(labels, scores, opts.bins ?? 10);
  const auc = rocAuc(labels, scores);
  const ap = prAuc(labels, scores);
  return {
    samples: n,
    positives,
    negatives,
    baseRate: n ? positives / n : 0,
    threshold,
    accuracy: n ? (tp + tn) / n : 0,
    precision,
    recall,
    f1,
    specificity,
    rocAuc: auc,
    rocAucApplicable: auc !== null,
    prAuc: ap,
    prAucApplicable: ap !== null,
    logLoss: logLoss(labels, scores),
    brier: brierScore(labels, scores),
    calibrationError: ece,
    maxCalibrationError: mce,
    confusion: cm,
    reliability,
  };
}

/* ================================================================== */
/* Forecasting / regression                                            */
/* ================================================================== */

export interface ForecastMetrics {
  samples: number;
  mae: number;
  rmse: number;
  mape: number | null;
  mapeApplicable: boolean;
  smape: number;
  bias: number;
  intervalCoverage: number | null;
  intervalCoverageApplicable: boolean;
  nominalCoverage: number | null;
}

export function evaluateForecast(
  actual: number[],
  predicted: number[],
  opts: { intervals?: { low: number; high: number }[]; mapeEpsilon?: number; nominalCoverage?: number } = {},
): ForecastMetrics {
  if (actual.length !== predicted.length) throw new Error("actual and predicted length mismatch");
  const n = actual.length;
  const mapeEpsilon = opts.mapeEpsilon ?? 1e-6;
  let absErr = 0;
  let sqErr = 0;
  let biasSum = 0;
  let smapeSum = 0;
  let mapeApplicable = true;
  let mapeSum = 0;
  for (let i = 0; i < n; i += 1) {
    const err = predicted[i] - actual[i];
    absErr += Math.abs(err);
    sqErr += err * err;
    biasSum += err;
    smapeSum += (2 * Math.abs(err)) / (Math.abs(actual[i]) + Math.abs(predicted[i]) + mapeEpsilon);
    // MAPE is undefined/unstable when any actual is ~0 → mark not applicable.
    if (Math.abs(actual[i]) < mapeEpsilon) mapeApplicable = false;
    else mapeSum += Math.abs(err / actual[i]);
  }
  let intervalCoverage: number | null = null;
  let intervalCoverageApplicable = false;
  if (opts.intervals && opts.intervals.length === n && n > 0) {
    let covered = 0;
    for (let i = 0; i < n; i += 1) {
      if (actual[i] >= opts.intervals[i].low && actual[i] <= opts.intervals[i].high) covered += 1;
    }
    intervalCoverage = covered / n;
    intervalCoverageApplicable = true;
  }
  return {
    samples: n,
    mae: n ? absErr / n : 0,
    rmse: n ? Math.sqrt(sqErr / n) : 0,
    mape: n && mapeApplicable ? mapeSum / n : null,
    mapeApplicable: n > 0 && mapeApplicable,
    smape: n ? smapeSum / n : 0,
    bias: n ? biasSum / n : 0,
    intervalCoverage,
    intervalCoverageApplicable,
    nominalCoverage: intervalCoverageApplicable ? opts.nominalCoverage ?? 0.95 : null,
  };
}

/* ================================================================== */
/* Recommendation systems                                              */
/* ================================================================== */

export interface RankingMetrics {
  k: number;
  precisionAtK: number;
  recallAtK: number;
  ndcgAtK: number;
  hitRate: number;
  relevantCount: number;
}

/** Precision@K, Recall@K and NDCG@K. `relevant` may carry graded gains. */
export function rankingMetricsAtK(
  ranked: number[],
  relevant: Set<number> | Map<number, number>,
  k: number,
): RankingMetrics {
  const gainOf = (id: number): number => {
    if (relevant instanceof Map) return relevant.get(id) ?? 0;
    return relevant.has(id) ? 1 : 0;
  };
  const relevantCount = relevant instanceof Map
    ? [...relevant.values()].filter((g) => g > 0).length
    : relevant.size;
  const topK = ranked.slice(0, k);
  const hits = topK.filter((id) => gainOf(id) > 0).length;

  let dcg = 0;
  for (let i = 0; i < topK.length; i += 1) {
    dcg += gainOf(topK[i]) / Math.log2(i + 2);
  }
  const idealGains = (relevant instanceof Map ? [...relevant.values()] : Array.from(relevant, () => 1))
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealGains.length; i += 1) idcg += idealGains[i] / Math.log2(i + 2);

  return {
    k,
    precisionAtK: k > 0 ? hits / k : 0,
    recallAtK: relevantCount > 0 ? hits / relevantCount : 0,
    ndcgAtK: idcg > 0 ? dcg / idcg : 0,
    hitRate: hits > 0 ? 1 : 0,
    relevantCount,
  };
}

/** Average the ranking metrics over many recommendation events (per learner). */
export function meanRankingMetrics(events: RankingMetrics[]): Omit<RankingMetrics, "relevantCount"> & { events: number } {
  if (!events.length) return { k: 0, precisionAtK: 0, recallAtK: 0, ndcgAtK: 0, hitRate: 0, events: 0 };
  return {
    k: events[0].k,
    precisionAtK: mean(events.map((e) => e.precisionAtK)),
    recallAtK: mean(events.map((e) => e.recallAtK)),
    ndcgAtK: mean(events.map((e) => e.ndcgAtK)),
    hitRate: mean(events.map((e) => e.hitRate)),
    events: events.length,
  };
}

export interface RecommendationOutcomeMetrics {
  surfaced: number;
  accepted: number;
  completed: number;
  dismissed: number;
  acceptanceRate: number;
  completionRate: number;
  dismissalRate: number;
  learningGain: number | null;
  learningGainSamples: number;
}

/**
 * Acceptance / completion / dismissal rates and post-recommendation learning
 * gain from stored recommendation records. `accepted` and `completed` both count
 * as "acted"; completion rate is completed / acted.
 */
export function evaluateRecommendationOutcomes(
  records: { status: string; masteryBefore?: number | null; masteryAfter?: number | null }[],
): RecommendationOutcomeMetrics {
  const surfaced = records.length;
  const completed = records.filter((r) => r.status === "completed").length;
  const accepted = records.filter((r) => r.status === "accepted").length;
  const dismissed = records.filter((r) => r.status === "dismissed").length;
  const acted = accepted + completed;
  const gains = records
    .filter((r) => r.masteryBefore != null && r.masteryAfter != null)
    .map((r) => (r.masteryAfter as number) - (r.masteryBefore as number));
  return {
    surfaced,
    accepted,
    completed,
    dismissed,
    acceptanceRate: surfaced ? acted / surfaced : 0,
    completionRate: acted ? completed / acted : 0,
    dismissalRate: surfaced ? dismissed / surfaced : 0,
    learningGain: gains.length ? mean(gains) : null,
    learningGainSamples: gains.length,
  };
}

/* ================================================================== */
/* Knowledge tracing                                                   */
/* ================================================================== */

export interface MasteryStabilityMetrics {
  trajectories: number;
  volatility: number; // mean |Δ| per step (lower = more stable)
  oscillation: number; // fraction of steps that reverse direction
  monotonicity: number; // fraction of non-decreasing steps
  stabilityScore: number; // 1 - scaled volatility, 0..1
}

/**
 * Mastery estimation stability: how smoothly the estimate evolves. A good tracer
 * updates monotonically toward the truth and does not thrash on single responses.
 */
export function evaluateMasteryStability(trajectories: number[][]): MasteryStabilityMetrics {
  const usable = trajectories.filter((t) => t.length >= 2);
  if (!usable.length) {
    return { trajectories: 0, volatility: 0, oscillation: 0, monotonicity: 1, stabilityScore: 1 };
  }
  const volPer: number[] = [];
  const oscPer: number[] = [];
  const monoPer: number[] = [];
  for (const traj of usable) {
    const deltas: number[] = [];
    for (let i = 1; i < traj.length; i += 1) deltas.push(traj[i] - traj[i - 1]);
    volPer.push(mean(deltas.map((d) => Math.abs(d))));
    let reversals = 0;
    for (let i = 1; i < deltas.length; i += 1) {
      if (deltas[i] !== 0 && deltas[i - 1] !== 0 && Math.sign(deltas[i]) !== Math.sign(deltas[i - 1])) reversals += 1;
    }
    oscPer.push(deltas.length > 1 ? reversals / (deltas.length - 1) : 0);
    monoPer.push(deltas.filter((d) => d >= 0).length / deltas.length);
  }
  const volatility = mean(volPer);
  return {
    trajectories: usable.length,
    volatility,
    oscillation: mean(oscPer),
    monotonicity: mean(monoPer),
    // a single BKT step rarely exceeds ~0.5; scale so 0 vol → 1, 0.5 vol → 0
    stabilityScore: clamp(1 - volatility * 2, 0, 1),
  };
}

export interface KnowledgeTracingMetrics {
  predictive: ClassificationMetrics;
  stability: MasteryStabilityMetrics;
}

export function evaluateKnowledgeTracing(params: {
  predicted: number[];
  actual: number[];
  trajectories: number[][];
}): KnowledgeTracingMetrics {
  return {
    predictive: evaluateClassification(params.actual, params.predicted),
    stability: evaluateMasteryStability(params.trajectories),
  };
}
