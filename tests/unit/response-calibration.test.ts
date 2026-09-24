import { describe, expect, it } from "vitest";
import {
  calibrateResponseProbability,
  evaluateResponseCalibration,
  fitResponseCalibrator,
  splitCalibrationTelemetry,
  type ResponseTelemetry,
} from "@/lib/ml/response-calibration";

function rows(): ResponseTelemetry[] {
  // Deterministic over-confident synthetic telemetry (observed rate ~0.45 while raw is ~0.8).
  return Array.from({ length: 200 }, (_, i) => ({
    rawProbability: .76 + (i % 5) * .02,
    isCorrect: i % 20 < 9,
    occurredAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
    learnerId: i % 10,
    skillId: i % 3,
    difficulty: (i % 10) / 10,
    bloom: 1 + i % 6,
    cohort: i % 2 ? "A" : "B",
    coldStart: i < 20,
  }));
}

describe("response calibration", () => {
  it("learns a separate deterministic mapping that improves synthetic reliability", () => {
    const data = rows();
    const artifact = fitResponseCalibrator(data.slice(0, 150), { version: "synthetic-test-v1", source: "synthetic" });
    const before = evaluateResponseCalibration(data.slice(150));
    const after = evaluateResponseCalibration(data.slice(150), artifact);
    expect(artifact.source).toBe("synthetic");
    expect(after.brier).toBeLessThan(before.brier);
    expect(after.ece).toBeLessThan(before.ece);
    expect(calibrateResponseProbability(.8, artifact)).toBeLessThan(.8);
  });

  it("reports reliability overall and by required operational slices", () => {
    const report = evaluateResponseCalibration(rows());
    expect(report.reliability).toHaveLength(10);
    expect(report.byDifficulty.map(x => x.key)).toEqual(["easy", "hard", "medium"]);
    expect(report.bySkill.length).toBe(3);
    expect(report.byCohort.length).toBe(2);
    expect(report.byBloom.length).toBe(6);
    expect(report.coldStart.length).toBe(2);
    expect(report.meanPredicted).toBeGreaterThan(report.observedCorrect);
  });

  it("prevents future and held-out learner leakage", () => {
    const split = splitCalibrationTelemetry(rows(), [9], .75);
    expect(split.train.every(r => String(r.learnerId) !== "9")).toBe(true);
    expect(split.learnerTest.every(r => String(r.learnerId) === "9")).toBe(true);
    expect(Math.max(...split.train.map(r => +new Date(r.occurredAt))))
      .toBeLessThanOrEqual(Math.min(...split.chronologicalTest.map(r => +new Date(r.occurredAt))));
  });

  it("uses identity for insufficient evidence rather than overfitting cold start", () => {
    const artifact = fitResponseCalibrator(rows().slice(0, 12), { version: "too-small", source: "production" });
    expect(artifact.kind).toBe("identity");
    expect(calibrateResponseProbability(.72, artifact)).toBeCloseTo(.72);
  });
});
