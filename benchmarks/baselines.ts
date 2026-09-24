/**
 * Baseline floor and ideal-observer ceiling.
 *
 * The legacy/v2/v3 comparison answers "is the new policy better than the old
 * one?". It cannot answer the question that actually matters to the product:
 * **is any of this adaptive machinery earning its complexity?** A policy can
 * beat its predecessor and still lose to three lines of heuristic.
 *
 * So this module brackets every real policy from both sides:
 *
 *   FLOOR    random / difficulty-only / mastery-gap-only — trivial selectors
 *            that no adaptive engine should lose to.
 *   CEILING  an oracle that reads ground truth and serves the item whose *true*
 *            success probability sits at the productive target. Nothing can
 *            beat it, so it converts scores into "% of achievable learning".
 *
 * Reporting a policy without both is how a benchmark flatters itself.
 */
import { ARCHETYPES, BASE_WORLD, ITEMS, SKILLS, initialTrueState, trueProbCorrect } from "./world";
import { aggregateCells, simulateCell, type CellSpec, type AggregateMetrics } from "./simulate";
import {
  difficultyOnlyPolicy,
  legacyPolicy,
  makeOraclePolicy,
  masteryGapOnlyPolicy,
  oraclePolicy,
  randomPolicy,
  v2Policy,
  type BenchPolicy,
} from "./policies";
import { buildLearnerState, type RawSkillState } from "@/lib/ml/learner-state";
import { LogisticResponseModel } from "@/lib/ml/models/logistic";
import { HEURISTIC_MODEL } from "@/lib/ml/classifier";
import { mean } from "@/lib/utils";

export interface FloorRow {
  policyId: string;
  label: string;
  /** "floor" = trivial heuristic, "real" = shippable policy, "ceiling" = oracle. */
  tier: "floor" | "real" | "ceiling";
  aggregate: AggregateMetrics;
  /** Retained gain as a fraction of the oracle ceiling. */
  shareOfCeiling: number;
}

export interface BaselineFloorResult {
  rows: FloorRow[];
  /** Best trivial baseline by retained gain — the bar a real policy must clear. */
  bestFloor: FloorRow;
  ceiling: FloorRow;
  /** Real policies that fail to beat the best trivial baseline. */
  lostToFloor: string[];
}

/** Runs every policy plus the floor and ceiling over one set of cells. */
export function runBaselineFloor(cells: CellSpec[], v3: BenchPolicy): BaselineFloorResult {
  const tiers: [BenchPolicy, FloorRow["tier"]][] = [
    [randomPolicy, "floor"],
    [difficultyOnlyPolicy, "floor"],
    [masteryGapOnlyPolicy, "floor"],
    [legacyPolicy, "real"],
    [v2Policy, "real"],
    [v3, "real"],
    [oraclePolicy, "ceiling"],
  ];

  const raw = tiers.map(([policy, tier]) => {
    const aggregate = aggregateCells(cells.map((cell) => simulateCell(policy, cell)));
    return { policyId: policy.id, label: policy.label, tier, aggregate };
  });

  const ceilingGain = raw.find((r) => r.tier === "ceiling")!.aggregate.retainedGain;
  const rows: FloorRow[] = raw.map((r) => ({
    ...r,
    shareOfCeiling: ceilingGain > 0 ? r.aggregate.retainedGain / ceilingGain : 0,
  }));

  const floors = rows.filter((r) => r.tier === "floor");
  const bestFloor = floors.reduce((a, b) => (b.aggregate.retainedGain > a.aggregate.retainedGain ? b : a));
  const lostToFloor = rows
    .filter((r) => r.tier === "real" && r.aggregate.retainedGain < bestFloor.aggregate.retainedGain)
    .map((r) => r.policyId);

  return { rows, bestFloor, ceiling: rows.find((r) => r.tier === "ceiling")!, lostToFloor };
}

/* ------------------------------------------------------------------ */
/* World validation: is the ZPD premise actually true in this world?   */
/* ------------------------------------------------------------------ */

export interface DifficultySweepPoint {
  target: number;
  masteryGain: number;
  retainedGain: number;
  zpdHitRate: number;
}

/**
 * Sweeps the oracle's target success probability. If learning rose
 * monotonically as the target approached 1.0, this world would simply reward
 * serving trivial questions, and every ZPD-shaped objective in the policy would
 * be unjustified decoration. An interior optimum is what makes the benchmark
 * meaningful, so it is measured rather than asserted.
 */
export function sweepDifficultyTargets(cells: CellSpec[], targets: number[]): DifficultySweepPoint[] {
  return targets.map((target) => {
    const aggregate = aggregateCells(cells.map((cell) => simulateCell(makeOraclePolicy(target), cell)));
    return {
      target,
      masteryGain: aggregate.masteryGain,
      retainedGain: aggregate.retainedGain,
      zpdHitRate: aggregate.zpdHitRate,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Response-model calibration probe                                    */
/* ------------------------------------------------------------------ */

export interface CalibrationProbe {
  pairs: number;
  meanPredicted: number;
  meanTrue: number;
  bias: number;
  meanAbsError: number;
  rmse: number;
  byDifficulty: { band: string; n: number; predicted: number; trueP: number; bias: number }[];
}

/**
 * Isolates *which* model is miscalibrated.
 *
 * Selection quality depends on a chain: tracer → mastery estimate → response
 * model → P(correct) → chosen difficulty. Improving the tracer is pointless if
 * the link after it is broken, so this probe hands the response model a learner
 * state whose mastery **equals true latent ability** — perfect knowledge
 * tracing — and measures what it predicts anyway. Any residual bias here is
 * attributable to the response model alone and is invisible to every
 * tracer-accuracy metric (RMSE, Brier, ECE) the benchmark reports.
 */
export function probeResponseModelCalibration(): CalibrationProbe {
  const model = new LogisticResponseModel(HEURISTIC_MODEL);
  const now = new Date("2026-01-15T10:00:00Z");
  const rows: { predicted: number; trueP: number; difficulty: number }[] = [];

  for (const archetype of ARCHETYPES) {
    const truth = initialTrueState(archetype, BASE_WORLD);
    const skillStates: RawSkillState[] = SKILLS.map((s) => {
      const ability = truth.skills.get(s.id)!.ability;
      const attempts = 20;
      const correct = Math.round(attempts * ability);
      return {
        skillId: s.id,
        skillName: s.name,
        subjectName: "Mathematics",
        mastery: ability,
        attempts,
        correct,
        streak: 2,
        // A plausible rising mastery trace ending at true ability, so the
        // velocity/confidence features the model consumes are realistic.
        history: Array.from({ length: attempts }, (_, i) => ({
          t: new Date(now.getTime() - (attempts - i) * 86_400_000).toISOString(),
          m: ability * ((i + 1) / attempts),
        })),
        lastPracticedAt: now,
        prereqIds: s.prereqIds,
        difficultyBase: s.difficultyBase,
        pathAlignment: 0.3,
      };
    });
    const learner = buildLearnerState({
      studentId: 1,
      now,
      skillStates,
      responses: [],
      context: { itemsAnswered: 20, itemTarget: 32 },
    });
    for (const item of ITEMS) {
      const skill = learner.skills.get(item.skillId)!;
      rows.push({
        predicted: model.predict({
          learner,
          skill,
          item: {
            difficulty: item.difficulty,
            bloom: item.bloom,
            expectedTimeMs: item.estimatedSeconds * 1000,
          },
        }),
        trueP: trueProbCorrect({ item, truth, day: 0, archetype, world: BASE_WORLD }),
        difficulty: item.difficulty,
      });
    }
  }

  const bands: [number, number][] = [
    [0, 0.3],
    [0.3, 0.5],
    [0.5, 0.7],
    [0.7, 1.01],
  ];

  return {
    pairs: rows.length,
    meanPredicted: mean(rows.map((r) => r.predicted)),
    meanTrue: mean(rows.map((r) => r.trueP)),
    bias: mean(rows.map((r) => r.predicted - r.trueP)),
    meanAbsError: mean(rows.map((r) => Math.abs(r.predicted - r.trueP))),
    rmse: Math.sqrt(mean(rows.map((r) => (r.predicted - r.trueP) ** 2))),
    byDifficulty: bands.map(([lo, hi]) => {
      const b = rows.filter((r) => r.difficulty >= lo && r.difficulty < hi);
      return {
        band: `${lo.toFixed(1)}–${hi > 1 ? "1.0" : hi.toFixed(1)}`,
        n: b.length,
        predicted: mean(b.map((r) => r.predicted)),
        trueP: mean(b.map((r) => r.trueP)),
        bias: mean(b.map((r) => r.predicted - r.trueP)),
      };
    }),
  };
}
