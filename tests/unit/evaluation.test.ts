import { describe, expect, it } from "vitest";
import {
  rocAuc,
  prAuc,
  confusionMatrix,
  logLoss,
  brierScore,
  calibration,
  evaluateClassification,
  evaluateForecast,
  rankingMetricsAtK,
  meanRankingMetrics,
  evaluateRecommendationOutcomes,
  evaluateMasteryStability,
  evaluateKnowledgeTracing,
} from "@/lib/ml/evaluation";

const approx = (value: number | null, expected: number, tol = 1e-9) => {
  expect(value).not.toBeNull();
  expect(Math.abs((value as number) - expected)).toBeLessThan(tol);
};

describe("classification metrics", () => {
  it("computes ROC-AUC via rank statistic (perfect separation = 1)", () => {
    approx(rocAuc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1);
  });

  it("computes ROC-AUC = 0.5 for a coin-flip ordering", () => {
    // scores interleave classes: pos and neg perfectly mixed
    approx(rocAuc([1, 0, 1, 0], [0.4, 0.4, 0.6, 0.6]), 0.5);
  });

  it("returns null ROC-AUC when only one class present", () => {
    expect(rocAuc([1, 1, 1], [0.2, 0.5, 0.9])).toBeNull();
  });

  it("computes PR-AUC (average precision) by hand", () => {
    // ranked desc: labels 1,0,1,0 -> precisions at positives: 1/1, 2/3
    // AP = (1 + 0.6666...) / 2 = 0.833333
    approx(prAuc([1, 0, 1, 0], [0.9, 0.8, 0.7, 0.6]), (1 + 2 / 3) / 2);
  });

  it("returns null PR-AUC when there are no positives", () => {
    expect(prAuc([0, 0, 0], [0.1, 0.2, 0.3])).toBeNull();
  });

  it("builds a confusion matrix at threshold", () => {
    const cm = confusionMatrix([1, 1, 0, 0], [0.9, 0.4, 0.6, 0.1], 0.5);
    expect(cm).toEqual({ truePositive: 1, falseNegative: 1, falsePositive: 1, trueNegative: 1 });
  });

  it("computes log loss and Brier score", () => {
    // single sample, label 1, p 0.5 -> logloss = -ln(0.5) = 0.6931..., brier = 0.25
    approx(logLoss([1], [0.5]), Math.log(2), 1e-9);
    approx(brierScore([1], [0.5]), 0.25);
  });

  it("computes calibration ECE/MCE", () => {
    // two points in one bin: conf 0.8 & 0.8, outcomes 1 & 0 -> acc 0.5, gap 0.3
    const c = calibration([1, 0], [0.8, 0.8], 10);
    approx(c.ece, 0.3, 1e-9);
    approx(c.mce, 0.3, 1e-9);
  });

  it("assembles a full classification report", () => {
    const labels = [1, 0, 1, 0, 1, 0];
    const scores = [0.9, 0.2, 0.7, 0.4, 0.6, 0.1];
    const m = evaluateClassification(labels, scores, { threshold: 0.5 });
    expect(m.samples).toBe(6);
    expect(m.positives).toBe(3);
    // all positives >=0.5, all negatives <0.5 -> perfect classification
    expect(m.accuracy).toBe(1);
    approx(m.precision, 1);
    approx(m.recall, 1);
    approx(m.f1, 1);
    approx(m.rocAuc, 1);
    expect(m.rocAucApplicable).toBe(true);
  });
});

describe("forecasting metrics", () => {
  it("computes MAE, RMSE, bias", () => {
    const m = evaluateForecast([10, 20, 30], [12, 18, 33]);
    // errors: +2, -2, +3 -> mae = 7/3, rmse = sqrt((4+4+9)/3), bias = 1
    approx(m.mae, 7 / 3);
    approx(m.rmse, Math.sqrt(17 / 3));
    approx(m.bias, 1);
  });

  it("marks MAPE inapplicable when an actual is zero", () => {
    const m = evaluateForecast([0, 20], [1, 18]);
    expect(m.mape).toBeNull();
    expect(m.mapeApplicable).toBe(false);
  });

  it("computes prediction-interval coverage (PICP)", () => {
    const m = evaluateForecast([5, 15, 25], [5, 15, 25], {
      intervals: [
        { low: 0, high: 10 },
        { low: 20, high: 30 }, // 15 NOT covered
        { low: 20, high: 30 },
      ],
      nominalCoverage: 0.9,
    });
    approx(m.intervalCoverage, 2 / 3);
    expect(m.nominalCoverage).toBe(0.9);
  });
});

describe("recommendation metrics", () => {
  it("computes Precision@K, Recall@K and NDCG@K", () => {
    // relevant = {1,2,3}; ranked top-3 = [1,4,2] -> hits 2
    const r = rankingMetricsAtK([1, 4, 2, 5], new Set([1, 2, 3]), 3);
    approx(r.precisionAtK, 2 / 3);
    approx(r.recallAtK, 2 / 3);
    // DCG = 1/log2(2) + 0 + 1/log2(4) = 1 + 0.5 = 1.5
    // IDCG (3 relevant) = 1/log2(2)+1/log2(3)+1/log2(4) = 1 + 0.63093 + 0.5 = 2.13093
    approx(r.ndcgAtK, 1.5 / (1 + 1 / Math.log2(3) + 0.5), 1e-9);
  });

  it("averages ranking metrics over events", () => {
    const a = rankingMetricsAtK([1], new Set([1]), 1);
    const b = rankingMetricsAtK([2], new Set([1]), 1);
    const mean = meanRankingMetrics([a, b]);
    approx(mean.precisionAtK, 0.5);
    expect(mean.events).toBe(2);
  });

  it("derives acceptance/completion and learning gain", () => {
    const m = evaluateRecommendationOutcomes([
      { status: "completed", masteryBefore: 0.4, masteryAfter: 0.6 },
      { status: "accepted" },
      { status: "dismissed" },
      { status: "new" },
    ]);
    expect(m.surfaced).toBe(4);
    approx(m.acceptanceRate, 2 / 4); // accepted + completed
    approx(m.completionRate, 1 / 2); // completed / acted
    approx(m.learningGain as number, 0.2);
    expect(m.learningGainSamples).toBe(1);
  });

  it("returns null learning gain when no before/after data", () => {
    const m = evaluateRecommendationOutcomes([{ status: "accepted" }]);
    expect(m.learningGain).toBeNull();
  });
});

describe("knowledge tracing metrics", () => {
  it("scores mastery stability (smooth monotone trajectory)", () => {
    const m = evaluateMasteryStability([[0.2, 0.3, 0.4, 0.5]]);
    approx(m.volatility, 0.1, 1e-9);
    approx(m.monotonicity, 1);
    approx(m.oscillation, 0);
    approx(m.stabilityScore, 0.8, 1e-9);
  });

  it("penalises oscillating trajectories", () => {
    const smooth = evaluateMasteryStability([[0.2, 0.3, 0.4, 0.5]]);
    const jumpy = evaluateMasteryStability([[0.2, 0.6, 0.2, 0.6]]);
    expect(jumpy.oscillation).toBeGreaterThan(smooth.oscillation);
    expect(jumpy.stabilityScore).toBeLessThan(smooth.stabilityScore);
  });

  it("combines predictive + stability", () => {
    const kt = evaluateKnowledgeTracing({
      predicted: [0.9, 0.2, 0.8],
      actual: [1, 0, 1],
      trajectories: [[0.2, 0.4, 0.6]],
    });
    expect(kt.predictive.samples).toBe(3);
    expect(kt.stability.trajectories).toBe(1);
  });
});
