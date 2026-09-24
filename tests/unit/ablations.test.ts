import { beforeAll, describe, expect, it } from "vitest";
import { runV3Ablations, type AblationResult } from "../../benchmarks/ablations";

describe("v3 attribution ablations", () => {
  let result: AblationResult;
  beforeAll(() => { result = runV3Ablations(); }, 120_000);
  const metric = (id: string) => result.rows.find(r => r.id === id)!.metrics;

  it("preserves the embarrassing baseline result rather than redefining it", () => {
    expect(metric("mastery-gap-only").retainedGain).toBeGreaterThan(metric("v3").retainedGain);
  });
  it("detects response-model targeting as a causal failure mode", () => {
    expect(metric("v3-no-response").retainedGain).toBeGreaterThan(metric("v3").retainedGain);
    expect(metric("v3-no-response").wastedRate).toBeLessThan(metric("v3").wastedRate);
  });
  it("finds mastery estimation is secondary and does not alone close the gap", () => {
    expect(metric("v3-true-mastery").retainedGain).toBeGreaterThan(metric("v3").retainedGain);
    expect(metric("v3-true-mastery").retainedGain).toBeLessThan(metric("mastery-gap-only").retainedGain);
  });
  it("does not falsely blame information gain", () => {
    expect(metric("v3-no-information").retainedGain).toBeLessThanOrEqual(metric("v3").retainedGain);
  });
  it("does not trade away prerequisite safety to manufacture a win", () => {
    expect(metric("v3-no-prerequisite-weight").retainedGain).toBeLessThanOrEqual(metric("v3").retainedGain);
  });
  it("detects that removing diversity is not the remedy", () => {
    expect(metric("v3-no-diversity").retainedGain).toBeLessThanOrEqual(metric("v3").retainedGain);
  });
  it("shows mastery-gap skill choice alone cannot repair bad item targeting", () => {
    expect(metric("v3-mastery-gap-skill").retainedGain).toBeLessThan(metric("mastery-gap-only").retainedGain);
    expect(metric("v3-mastery-gap-skill").wastedRate).toBeGreaterThan(metric("mastery-gap-only").wastedRate);
  });
  it("separates synthetic calibration from production evidence", () => {
    expect(result.calibration.source).toBe("synthetic");
    expect(metric("v3-calibrated-response").zpdHitRate).toBeGreaterThan(metric("v3").zpdHitRate);
    expect(metric("v3-calibrated-response").wastedRate).toBeLessThan(metric("v3").wastedRate);
  });
  it("uses oracle response probabilities as a ceiling, not a shippable policy", () => {
    expect(metric("v3-oracle-response").retainedGain).toBeGreaterThan(metric("v3").retainedGain);
    expect(metric("v3-oracle-response").zpdHitRate).toBeGreaterThan(metric("v3-calibrated-response").zpdHitRate);
  });
  it("reports every requested outcome without cherry-picking", () => {
    for (const row of result.rows) {
      for (const key of ["retainedGain", "zpdHitRate", "wastedRate", "prereqViolations", "eligibleCoverage", "retentionRatio", "avgInformation"] as const)
        expect(Number.isFinite(row.metrics[key])).toBe(true);
      expect(row.metrics.itemsToMastery === null || Number.isFinite(row.metrics.itemsToMastery)).toBe(true);
      expect(row.metrics.minutesToMastery === null || Number.isFinite(row.metrics.minutesToMastery)).toBe(true);
    }
  });
});
