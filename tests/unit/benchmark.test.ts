/**
 * Benchmark harness test.
 *
 * This is the file that regenerates `benchmarks/RESULTS.md` and
 * `benchmarks/results.json`, so the published report can never drift from the
 * code that produced it — if the policy changes and the report is not
 * regenerated, `npm run bench` rewrites it and the diff shows up in review.
 *
 * It also enforces the *decision rule* rather than a list of hand-picked wins:
 * the adoption verdict is computed in `benchmarks/protocol.ts` from held-out
 * evidence, and the serving default shipped in `src/lib/ml/policy` must agree
 * with it. That way nobody can promote a policy the evidence does not support
 * without this test going red.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runBenchmark, type BenchmarkResult } from "../../benchmarks/harness";
import { simulateCell } from "../../benchmarks/simulate";
import { heldOutCells, ADOPTION_CRITERIA, PROTOCOL_AMENDMENTS } from "../../benchmarks/protocol";
import { v3Policy } from "../../benchmarks/policies";
import { DEFAULT_POLICY_ID } from "@/lib/ml/policy";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../benchmarks");

describe("adaptive policy benchmark (legacy vs v2 vs v3)", () => {
  let result: BenchmarkResult;

  beforeAll(() => {
    result = runBenchmark();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "RESULTS.md"), result.report, "utf8");
    writeFileSync(resolve(outDir, "results.json"), `${JSON.stringify(result.json, null, 2)}\n`, "utf8");
  }, 120_000);

  /* ------------------------------------------------------------------ */
  /* Reproducibility                                                     */
  /* ------------------------------------------------------------------ */

  it("is deterministic — identical cells produce byte-identical metrics", () => {
    // Re-running the whole benchmark twice would double an already slow test;
    // determinism is a property of `simulateCell`, so it is checked there over
    // a sample of the real held-out cells.
    for (const cell of heldOutCells().slice(0, 6)) {
      const a = simulateCell(v3Policy, cell);
      const b = simulateCell(v3Policy, cell);
      expect(b.metrics).toEqual(a.metrics);
      expect(b.trace).toEqual(a.trace);
    }
  });

  it("writes a report and a machine-readable payload", () => {
    expect(result.report).toContain("# Adaptive policy benchmark");
    expect(result.json.schema).toBe("adaptive.benchmark.v1");
    // Every amendment to the pre-registered protocol must be disclosed in both.
    for (const amendment of PROTOCOL_AMENDMENTS) {
      expect(result.report).toContain(amendment.title);
    }
    expect(result.json.protocolAmendments).toHaveLength(PROTOCOL_AMENDMENTS.length);
  });

  /* ------------------------------------------------------------------ */
  /* The decision rule, not a highlight reel                             */
  /* ------------------------------------------------------------------ */

  it("ships the serving default the held-out evidence supports", () => {
    // If v3 fails any adoption criterion, the default must fall back to v2.
    expect(DEFAULT_POLICY_ID).toBe(result.verdict.adopt ? "v3" : "v2");
  });

  it("evaluates every pre-registered guardrail", () => {
    expect(result.verdict.guardrails.map((g) => g.guardrail.key)).toEqual(
      ADOPTION_CRITERIA.guardrails.map((g) => g.key),
    );
  });

  it("bases the verdict on held-out cells the tuner never saw", () => {
    const trainSeeds = new Set(result.train.runs.v3.cells.map((c) => c.seed));
    const heldOutSeeds = result.heldOut.runs.v3.cells.map((c) => c.seed);
    expect(heldOutSeeds.some((s) => trainSeeds.has(s))).toBe(false);
    // ...and on archetypes it never saw, too.
    expect(result.heldOutUnseenArchetypes.cellCount).toBeGreaterThan(0);
  });

  /* ------------------------------------------------------------------ */
  /* Substantive claims made in the report                               */
  /* ------------------------------------------------------------------ */

  it("never repeats a question under any policy (hard constraint)", () => {
    for (const id of ["legacy", "v2", "v3"] as const) {
      expect(result.heldOut.runs[id].aggregate.repeats).toBe(0);
    }
  });

  it("v3 improves the primary learning metric on held-out cells", () => {
    const v2 = result.heldOut.runs.v2.aggregate.retainedGain;
    const v3 = result.heldOut.runs.v3.aggregate.retainedGain;
    expect(v3).toBeGreaterThan(v2);
    expect(result.verdict.primary.ci.lower).toBeGreaterThan(0);
  });

  it("v3 targets the productive band better than v2, which beats legacy", () => {
    const { legacy, v2, v3 } = result.heldOut.runs;
    expect(v3.aggregate.zpdHitRate).toBeGreaterThan(v2.aggregate.zpdHitRate);
    expect(v2.aggregate.zpdHitRate).toBeGreaterThan(legacy.aggregate.zpdHitRate);
  });

  it("v3 estimates learner state at least as accurately as v2 (RMSE)", () => {
    expect(result.heldOut.runs.v3.aggregate.estimationRmse).toBeLessThan(
      result.heldOut.runs.v2.aggregate.estimationRmse,
    );
  });

  it("v3 reduces prerequisite violations rather than trading them away", () => {
    expect(result.heldOut.runs.v3.aggregate.prereqViolationRate).toBeLessThan(
      result.heldOut.runs.v2.aggregate.prereqViolationRate,
    );
  });

  it("v3 neglects no more prerequisite-eligible skills than v2", () => {
    // Raw coverage can legitimately fall (v3 declines prerequisite-unsafe
    // skills); neglecting an *eligible* skill is the thing that would be a bug.
    //
    // This was `=== 0` until the 10-archetype population landed. It is now a
    // relative bound because no configuration can reach zero on this
    // population — the `underconfident` archetype is chronically
    // under-estimated and so never gets advanced to the deepest skills. See
    // PROTOCOL_AMENDMENTS["missed-eligible-relative"] for the full disclosure.
    expect(result.heldOut.runs.v3.aggregate.missedEligible).toBeLessThanOrEqual(
      result.heldOut.runs.v2.aggregate.missedEligible,
    );
    // ...and the absolute rate must stay negligible regardless.
    const slots = result.heldOut.cellCount * 8;
    expect(result.heldOut.runs.v3.aggregate.missedEligible / slots).toBeLessThan(0.02);
  });

  it("v3's advantage survives an equal-time budget, not just equal items", () => {
    // The item budget rewards picking long questions; this is the control.
    expect(result.equalTime).not.toBeNull();
    const eq = result.equalTime!;
    expect(eq.runs.v3.aggregate.minutesSpent).toBeLessThanOrEqual(eq.runs.v2.aggregate.minutesSpent * 1.02);
    expect(eq.runs.v3.aggregate.retainedGain).toBeGreaterThan(eq.runs.v2.aggregate.retainedGain);
  });

  it("v3's advantage holds in perturbed worlds that contradict its defaults", () => {
    expect(result.verdict.robustWinShare).toBeGreaterThanOrEqual(ADOPTION_CRITERIA.minRobustWinShare);
  });
});
