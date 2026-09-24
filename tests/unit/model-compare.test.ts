import { describe, expect, it } from "vitest";
import { compareMetrics, decidePromotion, METRIC_DIRECTIONS } from "@/lib/ml/model-compare";

describe("compareMetrics", () => {
  it("respects metric direction (higher-is-better vs lower-is-better)", () => {
    const report = compareMetrics(
      { rocAuc: 0.85, logLoss: 0.4 },
      { rocAuc: 0.8, logLoss: 0.5 },
    );
    const auc = report.metrics.find((m) => m.metric === "rocAuc")!;
    const ll = report.metrics.find((m) => m.metric === "logLoss")!;
    expect(auc.verdict).toBe("improved"); // auc up = better
    expect(ll.verdict).toBe("improved"); // logloss down = better
    expect(report.improvements.sort()).toEqual(["logLoss", "rocAuc"]);
  });

  it("flags regressions", () => {
    const report = compareMetrics({ accuracy: 0.7 }, { accuracy: 0.8 });
    expect(report.regressions).toContain("accuracy");
  });

  it("treats sub-tolerance change as unchanged", () => {
    const report = compareMetrics({ accuracy: 0.801 }, { accuracy: 0.8 }, { tolerance: 0.005 });
    expect(report.unchanged).toContain("accuracy");
  });

  it("marks incomparable metrics when a value is missing", () => {
    const report = compareMetrics({ rocAuc: null }, { rocAuc: 0.8 });
    const auc = report.metrics.find((m) => m.metric === "rocAuc")!;
    expect(auc.verdict).toBe("incomparable");
  });

  it("ignores unknown metrics without a direction", () => {
    const report = compareMetrics({ mysteryMetric: 5 }, { mysteryMetric: 1 });
    expect(report.metrics.length).toBe(0);
  });
});

describe("decidePromotion", () => {
  const baseline = { rocAuc: 0.8, logLoss: 0.5, accuracy: 0.78 };

  it("registers the first model without a superiority claim", () => {
    const d = decidePromotion({
      candidate: { rocAuc: 0.8 },
      baseline: null,
      primaryMetric: "rocAuc",
      candidateSamples: 100,
    });
    expect(d.promote).toBe(true);
    expect(d.verdict).toBe("insufficient-evidence");
  });

  it("promotes when the primary metric improves beyond noise with enough samples", () => {
    const d = decidePromotion({
      candidate: { rocAuc: 0.86, logLoss: 0.45, accuracy: 0.82 },
      baseline,
      primaryMetric: "rocAuc",
      candidateSamples: 100,
      minSamples: 30,
      minImprovement: 0.005,
    });
    expect(d.promote).toBe(true);
    expect(d.verdict).toBe("improved");
  });

  it("refuses to promote on insufficient samples", () => {
    const d = decidePromotion({
      candidate: { rocAuc: 0.99 },
      baseline,
      primaryMetric: "rocAuc",
      candidateSamples: 5,
      minSamples: 30,
    });
    expect(d.promote).toBe(false);
    expect(d.verdict).toBe("insufficient-evidence");
  });

  it("blocks promotion when a guarded metric regresses", () => {
    const d = decidePromotion({
      candidate: { rocAuc: 0.9, logLoss: 0.7, accuracy: 0.82 }, // logLoss got worse
      baseline,
      primaryMetric: "rocAuc",
      candidateSamples: 100,
      guardedMetrics: ["logLoss"],
    });
    expect(d.promote).toBe(false);
    expect(d.verdict).toBe("regressed");
    expect(d.regressionAlerts.map((m) => m.metric)).toContain("logLoss");
  });

  it("does not claim superiority when the primary change is within noise", () => {
    const d = decidePromotion({
      candidate: { rocAuc: 0.802, logLoss: 0.5, accuracy: 0.78 },
      baseline,
      primaryMetric: "rocAuc",
      candidateSamples: 100,
      minImprovement: 0.005,
    });
    expect(d.promote).toBe(false);
    expect(d.verdict).toBe("unchanged");
  });
});

describe("METRIC_DIRECTIONS", () => {
  it("covers the core metric families", () => {
    expect(METRIC_DIRECTIONS.rocAuc).toBe("higher");
    expect(METRIC_DIRECTIONS.logLoss).toBe("lower");
    expect(METRIC_DIRECTIONS.mae).toBe("lower");
    expect(METRIC_DIRECTIONS.ndcgAtK).toBe("higher");
  });
});
