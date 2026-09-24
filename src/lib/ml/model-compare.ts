/**
 * Model comparison & regression detection.
 *
 * Turns two metric sets (candidate vs. baseline) into an evidence-based verdict.
 * The guiding principle: **never claim a model is better unless the evaluation
 * supports it.** A candidate is only declared an improvement when
 *   1. it was evaluated on a held-out set with enough samples,
 *   2. the primary metric improves beyond a noise threshold, and
 *   3. no guarded metric regresses beyond tolerance.
 */

/** For each metric, whether a higher or a lower value is better. */
export type MetricDirection = "higher" | "lower";

export const METRIC_DIRECTIONS: Record<string, MetricDirection> = {
  // classification
  accuracy: "higher",
  precision: "higher",
  recall: "higher",
  f1: "higher",
  specificity: "higher",
  rocAuc: "higher",
  prAuc: "higher",
  auc: "higher",
  logLoss: "lower",
  brier: "lower",
  calibrationError: "lower",
  maxCalibrationError: "lower",
  // forecasting
  mae: "lower",
  rmse: "lower",
  mape: "lower",
  smape: "lower",
  // recommendation
  precisionAtK: "higher",
  recallAtK: "higher",
  ndcgAtK: "higher",
  acceptanceRate: "higher",
  completionRate: "higher",
  learningGain: "higher",
  // tracing
  stabilityScore: "higher",
  monotonicity: "higher",
  volatility: "lower",
};

export type MetricVerdict = "improved" | "regressed" | "unchanged" | "incomparable";

export interface MetricComparison {
  metric: string;
  direction: MetricDirection;
  baseline: number | null;
  candidate: number | null;
  delta: number | null; // candidate - baseline
  relativeChange: number | null; // signed, fraction of |baseline|
  improvement: number | null; // signed so that + means better
  verdict: MetricVerdict;
}

export interface ComparisonReport {
  metrics: MetricComparison[];
  improvements: string[];
  regressions: string[];
  unchanged: string[];
}

function directionOf(metric: string, overrides?: Record<string, MetricDirection>): MetricDirection | undefined {
  return overrides?.[metric] ?? METRIC_DIRECTIONS[metric];
}

export function compareMetrics(
  candidate: Record<string, number | null | undefined>,
  baseline: Record<string, number | null | undefined>,
  opts: { directions?: Record<string, MetricDirection>; tolerance?: number } = {},
): ComparisonReport {
  const tolerance = opts.tolerance ?? 0.005;
  const keys = Array.from(new Set([...Object.keys(baseline), ...Object.keys(candidate)])).sort();
  const metrics: MetricComparison[] = [];
  const improvements: string[] = [];
  const regressions: string[] = [];
  const unchanged: string[] = [];

  for (const metric of keys) {
    const direction = directionOf(metric, opts.directions);
    if (!direction) continue; // ignore metrics we don't know how to score (e.g. sample counts)
    const b = baseline[metric];
    const c = candidate[metric];
    const bNum = typeof b === "number" && Number.isFinite(b) ? b : null;
    const cNum = typeof c === "number" && Number.isFinite(c) ? c : null;

    if (bNum === null || cNum === null) {
      metrics.push({ metric, direction, baseline: bNum, candidate: cNum, delta: null, relativeChange: null, improvement: null, verdict: "incomparable" });
      continue;
    }
    const delta = cNum - bNum;
    const improvement = direction === "higher" ? delta : -delta;
    const relativeChange = Math.abs(bNum) > 1e-12 ? delta / Math.abs(bNum) : null;
    let verdict: MetricVerdict;
    if (Math.abs(delta) <= tolerance) verdict = "unchanged";
    else if (improvement > 0) verdict = "improved";
    else verdict = "regressed";
    metrics.push({ metric, direction, baseline: bNum, candidate: cNum, delta, relativeChange, improvement, verdict });
    if (verdict === "improved") improvements.push(metric);
    else if (verdict === "regressed") regressions.push(metric);
    else unchanged.push(metric);
  }
  return { metrics, improvements, regressions, unchanged };
}

export interface PromotionDecision {
  promote: boolean;
  verdict: "improved" | "regressed" | "mixed" | "unchanged" | "insufficient-evidence";
  reasons: string[];
  comparison: ComparisonReport;
  regressionAlerts: MetricComparison[];
}

/**
 * Decide whether a candidate should be promoted over the baseline. Conservative
 * by design — abstains ("insufficient-evidence") rather than over-claiming when
 * the sample is too small or the primary metric is missing.
 */
export function decidePromotion(params: {
  candidate: Record<string, number | null | undefined>;
  baseline: Record<string, number | null | undefined> | null;
  primaryMetric: string;
  candidateSamples: number;
  minSamples?: number;
  minImprovement?: number;
  guardedMetrics?: string[];
  tolerance?: number;
  directions?: Record<string, MetricDirection>;
}): PromotionDecision {
  const minSamples = params.minSamples ?? 30;
  const minImprovement = params.minImprovement ?? 0.005;
  const tolerance = params.tolerance ?? 0.005;
  const guarded = params.guardedMetrics ?? ["rocAuc", "logLoss", "brier", "calibrationError", "accuracy"];
  const reasons: string[] = [];

  // No baseline → first model. We register it but do not *claim* it is better.
  if (!params.baseline) {
    return {
      promote: true,
      verdict: "insufficient-evidence",
      reasons: ["No baseline to compare against — registering the first evaluation without a superiority claim."],
      comparison: { metrics: [], improvements: [], regressions: [], unchanged: [] },
      regressionAlerts: [],
    };
  }

  const comparison = compareMetrics(params.candidate, params.baseline, { directions: params.directions, tolerance });
  const regressionAlerts = comparison.metrics.filter(
    (m) => guarded.includes(m.metric) && m.verdict === "regressed",
  );

  if (params.candidateSamples < minSamples) {
    reasons.push(`Held-out sample count ${params.candidateSamples} < required ${minSamples}; cannot support a superiority claim.`);
    return { promote: false, verdict: "insufficient-evidence", reasons, comparison, regressionAlerts };
  }

  const primary = comparison.metrics.find((m) => m.metric === params.primaryMetric);
  if (!primary || primary.improvement === null) {
    reasons.push(`Primary metric "${params.primaryMetric}" is not comparable on both models.`);
    return { promote: false, verdict: "insufficient-evidence", reasons, comparison, regressionAlerts };
  }

  if (regressionAlerts.length) {
    reasons.push(
      `Guarded metric regression detected: ${regressionAlerts
        .map((m) => `${m.metric} ${formatDelta(m)}`)
        .join(", ")}.`,
    );
    return { promote: false, verdict: "regressed", reasons, comparison, regressionAlerts };
  }

  if (primary.improvement >= minImprovement) {
    reasons.push(`Primary metric "${params.primaryMetric}" improved by ${primary.improvement.toFixed(4)} (≥ ${minImprovement}).`);
    const verdict = comparison.regressions.length ? "mixed" : "improved";
    if (verdict === "mixed") reasons.push(`Non-guarded regressions: ${comparison.regressions.join(", ")}.`);
    return { promote: true, verdict, reasons, comparison, regressionAlerts };
  }

  reasons.push(`Primary metric "${params.primaryMetric}" change (${primary.improvement.toFixed(4)}) is within noise (< ${minImprovement}); no superiority claim.`);
  return { promote: false, verdict: "unchanged", reasons, comparison, regressionAlerts };
}

function formatDelta(m: MetricComparison): string {
  if (m.delta === null) return "n/a";
  const sign = m.delta >= 0 ? "+" : "";
  return `${sign}${m.delta.toFixed(4)}`;
}
