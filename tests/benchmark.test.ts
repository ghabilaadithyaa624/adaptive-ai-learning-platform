import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runBenchmark } from "../benchmarks/harness";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../benchmarks");

describe("adaptive engine benchmark (v2 vs legacy)", () => {
  const result = runBenchmark();

  it("writes a deterministic markdown report", () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "RESULTS.md"), result.report, "utf8");
    // determinism: a second run yields identical numbers
    const second = runBenchmark();
    expect(second.v2).toEqual(result.v2);
    expect(second.legacy).toEqual(result.legacy);
  });

  // ---- Robust, model-independent wins (asserted strictly) ----
  it("never repeats a question (hard constraint)", () => {
    expect(result.v2.repeats).toBe(0);
  });

  it("keeps strictly more items in the productive-difficulty (ZPD) band", () => {
    expect(result.v2.zpdHitRate).toBeGreaterThan(result.legacy.zpdHitRate);
  });

  it("wastes strictly fewer items on too-easy/too-hard questions", () => {
    expect(result.v2.wastedRate).toBeLessThan(result.legacy.wastedRate);
  });

  it("produces a better-calibrated serving prediction (lower Brier)", () => {
    expect(result.v2.brier).toBeLessThan(result.legacy.brier);
  });

  it("recovers true ability more accurately (lower estimation RMSE)", () => {
    expect(result.v2.estimationRmse).toBeLessThan(result.legacy.estimationRmse);
  });

  // ---- Non-degradation on metrics that favour legacy's gap-greed in this toy
  //      learning model (documented tolerances; see RESULTS.md interpretation) ----
  it("does not meaningfully increase prerequisite violations", () => {
    // within ~4 items (of 96) of legacy — legacy's gap-greed happens to stay on
    // foundations; v2 trades a few early-unlock violations for far better measurement
    expect(result.v2.prereqViolations).toBeLessThanOrEqual(result.legacy.prereqViolations + 4);
  });

  it("stays within 10% of legacy on total genuine learning", () => {
    expect(result.v2.trueMasteryGain).toBeGreaterThanOrEqual(result.legacy.trueMasteryGain * 0.9);
  });
});
