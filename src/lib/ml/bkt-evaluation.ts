/**
 * Offline evaluation + promotion gate for calibrated BKT parameters.
 *
 * Pairs with `bkt-calibration.ts`: that module *fits*, this one decides whether
 * a fit has earned the right to be considered. Nothing here writes to the
 * database or to serving configuration — the output is a report and a
 * recommendation a human acts on.
 *
 * Every metric is computed by **replaying** held-out responses through the BKT
 * recursion exactly as serving would: prediction for response t uses only
 * responses 1..t-1 of that learner's sequence. There is no post-response
 * leakage, and the belief state is rebuilt from the sequence start rather than
 * read from a stored mastery value that a later response has already updated.
 */
import { clamp, mean, round } from "@/lib/utils";
import { brierScore, calibration, type ReliabilityBin } from "@/lib/ml/evaluation";
import { evaluateMasteryStability } from "@/lib/ml/evaluation";
import { decidePromotion, type PromotionDecision } from "@/lib/ml/model-compare";
import {
  buildSequences,
  paramsForSkill,
  type BktCalibrationArtifact,
  type BktResponseRow,
  type BktSkillParams,
  type BktSequence,
} from "./bkt-calibration";

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

/** One prediction made before its outcome was known. */
export interface ReplayPoint {
  learnerId: string;
  skillId: string;
  /** P(correct) from the belief held BEFORE this response. */
  predicted: number;
  actual: 0 | 1;
  /** Belief before the update, i.e. the mastery estimate at decision time. */
  masteryBefore: number;
  /** Simulation-only truth, when the dataset carries it. */
  trueMastery?: number;
  index: number;
  at: number;
}

function predictCorrectWith(mastery: number, p: BktSkillParams): number {
  return clamp(mastery * (1 - p.slip) + (1 - mastery) * p.guess, 0.02, 0.98);
}

function posteriorWith(mastery: number, isCorrect: boolean, p: BktSkillParams): number {
  const numerator = isCorrect ? mastery * (1 - p.slip) : mastery * p.slip;
  const denominator = isCorrect
    ? mastery * (1 - p.slip) + (1 - mastery) * p.guess
    : mastery * p.slip + (1 - mastery) * (1 - p.guess);
  const post = denominator === 0 ? mastery : numerator / denominator;
  return clamp(post + (1 - post) * p.learn, 0.01, 0.995);
}

/**
 * Replay sequences under one parameter set.
 *
 * `betweenSessionDecay` mirrors the serving layer's `applyDecay`, which is
 * applied between practice sessions rather than inside the recursion. Leaving
 * it out would flatter every variant equally but would not be the model
 * production runs.
 */
export function replaySequences(
  sequences: BktSequence[],
  resolve: (skillId: string) => BktSkillParams,
  opts: { betweenSessionDecay?: boolean } = {},
): { points: ReplayPoint[]; trajectories: number[][] } {
  const decayEnabled = opts.betweenSessionDecay ?? true;
  const points: ReplayPoint[] = [];
  const trajectories: number[][] = [];

  for (const seq of sequences) {
    const params = resolve(seq.skillId);
    let mastery = params.priorMastery;
    let previousAt: number | null = null;
    const trajectory: number[] = [];

    seq.responses.forEach((response, index) => {
      if (decayEnabled && previousAt !== null) {
        const days = Math.max(0, (response.at - previousAt) / 86_400_000);
        if (days > 0) mastery = clamp(mastery * Math.exp(-params.forget * days), 0.01, 0.995);
      }
      const predicted = predictCorrectWith(mastery, params);
      points.push({
        learnerId: seq.learnerId,
        skillId: seq.skillId,
        predicted,
        actual: response.isCorrect ? 1 : 0,
        masteryBefore: mastery,
        ...(response.trueMastery !== undefined ? { trueMastery: response.trueMastery } : {}),
        index,
        at: response.at,
      });
      mastery = posteriorWith(mastery, response.isCorrect, params);
      trajectory.push(mastery);
      previousAt = response.at;
    });

    if (trajectory.length) trajectories.push(trajectory);
  }

  return { points, trajectories };
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

export interface BktMetricSet {
  responses: number;
  learners: number;
  /** Next-response accuracy at the 0.5 threshold. */
  accuracy: number;
  brier: number;
  logLoss: number;
  /** Expected calibration error (10 bins). */
  calibrationError: number;
  maxCalibrationError: number;
  reliability: ReliabilityBin[];
  /**
   * RMSE of the mastery estimate against simulation ground truth. `null` on
   * real data, where latent mastery is unobservable — reported as null rather
   * than proxied, because a proxy here would be indistinguishable from a
   * measurement.
   */
  masteryRmse: number | null;
  /** Mean |Δmastery| per step: lower is steadier. */
  volatility: number;
  stabilityScore: number;
  monotonicity: number;
}

function logLossOf(points: ReplayPoint[]): number {
  if (!points.length) return 0;
  return (
    -mean(
      points.map((p) => {
        const q = clamp(p.predicted, 1e-6, 1 - 1e-6);
        return p.actual === 1 ? Math.log(q) : Math.log(1 - q);
      }),
    )
  );
}

export function scoreReplay(points: ReplayPoint[], trajectories: number[][]): BktMetricSet {
  const labels = points.map((p) => p.actual);
  const scores = points.map((p) => p.predicted);
  const cal = calibration(labels, scores, 10);
  const stability = evaluateMasteryStability(trajectories);

  const withTruth = points.filter((p) => p.trueMastery !== undefined);
  const masteryRmse = withTruth.length
    ? Math.sqrt(mean(withTruth.map((p) => (p.masteryBefore - (p.trueMastery as number)) ** 2)))
    : null;

  return {
    responses: points.length,
    learners: new Set(points.map((p) => p.learnerId)).size,
    accuracy: points.length
      ? points.filter((p) => (p.predicted >= 0.5 ? 1 : 0) === p.actual).length / points.length
      : 0,
    brier: points.length ? brierScore(labels, scores) : 0,
    logLoss: logLossOf(points),
    calibrationError: cal.ece,
    maxCalibrationError: cal.mce,
    reliability: cal.reliability.filter((b) => b.count > 0),
    masteryRmse: masteryRmse === null ? null : round(masteryRmse, 4),
    volatility: stability.volatility,
    stabilityScore: stability.stabilityScore,
    monotonicity: stability.monotonicity,
  };
}

/* ------------------------------------------------------------------ */
/* Temporal stability                                                  */
/* ------------------------------------------------------------------ */

export interface TemporalStability {
  /** Metric computed per chronological block of the test set. */
  blocks: { block: number; responses: number; brier: number; accuracy: number }[];
  /** Max − min Brier across blocks. Large ⇒ parameters are period-specific. */
  brierRange: number;
  /** Standard deviation of Brier across blocks. */
  brierStdDev: number;
}

/**
 * Do the parameters hold up across time, or did they fit one period?
 *
 * A variant that wins on average but swings between blocks is more fragile than
 * its headline number suggests — that is exactly the failure a single held-out
 * score hides, so it is reported alongside rather than folded into the primary
 * metric.
 */
export function temporalStability(points: ReplayPoint[], blocks = 4): TemporalStability {
  if (points.length < blocks * 10) {
    return { blocks: [], brierRange: 0, brierStdDev: 0 };
  }
  const ordered = [...points].sort((a, b) => a.at - b.at || a.index - b.index);
  const size = Math.floor(ordered.length / blocks);
  const results: TemporalStability["blocks"] = [];

  for (let b = 0; b < blocks; b += 1) {
    const slice = b === blocks - 1 ? ordered.slice(b * size) : ordered.slice(b * size, (b + 1) * size);
    if (!slice.length) continue;
    results.push({
      block: b + 1,
      responses: slice.length,
      brier: round(brierScore(slice.map((p) => p.actual), slice.map((p) => p.predicted)), 5),
      accuracy: round(slice.filter((p) => (p.predicted >= 0.5 ? 1 : 0) === p.actual).length / slice.length, 5),
    });
  }

  const briers = results.map((r) => r.brier);
  const avg = briers.length ? mean(briers) : 0;
  return {
    blocks: results,
    brierRange: briers.length ? round(Math.max(...briers) - Math.min(...briers), 5) : 0,
    brierStdDev: briers.length ? round(Math.sqrt(mean(briers.map((x) => (x - avg) ** 2))), 5) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Downstream adaptive-selection proxy                                 */
/* ------------------------------------------------------------------ */

export interface SelectionImpact {
  /**
   * Share of served items whose predicted success probability fell in the
   * productive band [0.50, 0.85] — the same ZPD definition the platform's
   * experiment metrics use.
   */
  zpdHitRate: number;
  /** Mean binary-outcome information 4·p·(1−p) at the predicted probability. */
  informationPerItem: number;
  /**
   * Share of responses where the belief crossed the mastery threshold at a
   * point the learner then answered incorrectly — premature-advance risk.
   */
  prematureMasteryRate: number;
}

/**
 * Downstream impact of the parameter set on adaptive selection.
 *
 * This is an OBSERVATIONAL proxy, not a counterfactual: the logged responses
 * were served by the current policy, so we cannot know what a re-parameterised
 * policy would have picked without running it. What it does measure is whether
 * the beliefs a variant produces would place the *already served* items inside
 * the productive band — a variant whose mastery estimates are systematically
 * high or low degrades selection even when its Brier score is fine. A true
 * counterfactual needs the simulation harness (`benchmarks/`) or a live
 * experiment; both are out of scope for an offline parameter fit and are noted
 * as the next gate in BKT_CALIBRATION.md.
 */
export function selectionImpact(points: ReplayPoint[], masteryThreshold = 0.85): SelectionImpact {
  if (!points.length) return { zpdHitRate: 0, informationPerItem: 0, prematureMasteryRate: 0 };
  const inBand = points.filter((p) => p.predicted >= 0.5 && p.predicted <= 0.85).length;
  const information = mean(points.map((p) => 4 * p.predicted * (1 - p.predicted)));
  const premature = points.filter((p) => p.masteryBefore >= masteryThreshold && p.actual === 0).length;
  return {
    zpdHitRate: round(inBand / points.length, 5),
    informationPerItem: round(information, 5),
    prematureMasteryRate: round(premature / points.length, 5),
  };
}

/* ------------------------------------------------------------------ */
/* Variant evaluation                                                  */
/* ------------------------------------------------------------------ */

export interface VariantEvaluation {
  variant: string;
  /** Same learners as training, strictly later responses. */
  chronological: BktMetricSet;
  /** Learners never seen during fitting. */
  heldOutLearners: BktMetricSet;
  temporal: TemporalStability;
  selection: SelectionImpact;
  /** How many skills actually received non-global parameters. */
  skillsWithOwnParams: number;
  skillsOnGlobalFallback: number;
}

export function evaluateVariant(params: {
  variant: string;
  artifact: BktCalibrationArtifact;
  chronologicalTest: BktResponseRow[];
  heldOutLearnerTest: BktResponseRow[];
}): VariantEvaluation {
  const resolve = (skillId: string) => paramsForSkill(params.artifact, skillId);

  const chrono = replaySequences(buildSequences(params.chronologicalTest), resolve);
  const held = replaySequences(buildSequences(params.heldOutLearnerTest), resolve);

  const entries = Object.values(params.artifact.skills);
  return {
    variant: params.variant,
    chronological: scoreReplay(chrono.points, chrono.trajectories),
    heldOutLearners: scoreReplay(held.points, held.trajectories),
    temporal: temporalStability(chrono.points),
    selection: selectionImpact(chrono.points),
    skillsWithOwnParams: entries.filter((e) => e.source !== "global-fallback").length,
    skillsOnGlobalFallback: entries.filter((e) => e.source === "global-fallback").length,
  };
}

/* ------------------------------------------------------------------ */
/* Promotion gate                                                      */
/* ------------------------------------------------------------------ */

export interface BktPromotionReport {
  /** Candidate vs. the current global BKT, on held-out learners. */
  decision: PromotionDecision;
  /**
   * ALWAYS false. Calibrated parameters change how every learner's mastery is
   * estimated, which changes what the adaptive policy serves — that is a
   * judgement call with pedagogical consequences, not a threshold. The gate
   * reports evidence; a human edits the serving constants.
   */
  autoPromote: false;
  recommendation: "adopt-candidate" | "keep-current" | "insufficient-evidence";
  rationale: string[];
}

/**
 * Compare a candidate variant against the current global parameters and
 * recommend — never perform — a promotion.
 *
 * Primary metric is Brier on HELD-OUT LEARNERS: a proper scoring rule (accuracy
 * at a 0.5 threshold is insensitive to exactly the probability shifts that
 * matter for selection), measured on the population the model has never seen.
 */
export function assessBktPromotion(params: {
  candidate: VariantEvaluation;
  baseline: VariantEvaluation;
  minHeldOutResponses?: number;
  minImprovement?: number;
}): BktPromotionReport {
  const minSamples = params.minHeldOutResponses ?? 500;
  const minImprovement = params.minImprovement ?? 0.002;
  const c = params.candidate;
  const b = params.baseline;

  const decision = decidePromotion({
    candidate: {
      brier: c.heldOutLearners.brier,
      accuracy: c.heldOutLearners.accuracy,
      logLoss: c.heldOutLearners.logLoss,
      calibrationError: c.heldOutLearners.calibrationError,
      stabilityScore: c.heldOutLearners.stabilityScore,
    },
    baseline: {
      brier: b.heldOutLearners.brier,
      accuracy: b.heldOutLearners.accuracy,
      logLoss: b.heldOutLearners.logLoss,
      calibrationError: b.heldOutLearners.calibrationError,
      stabilityScore: b.heldOutLearners.stabilityScore,
    },
    primaryMetric: "brier",
    candidateSamples: c.heldOutLearners.responses,
    minSamples,
    minImprovement,
    guardedMetrics: ["brier", "logLoss", "calibrationError", "accuracy", "stabilityScore"],
  });

  const rationale: string[] = [...decision.reasons];

  // Extra gates the generic comparator does not know about.
  if (c.heldOutLearners.responses < minSamples) {
    rationale.push(
      `Held-out learner responses (${c.heldOutLearners.responses}) are below the ${minSamples} minimum.`,
    );
  }
  if (c.skillsWithOwnParams === 0) {
    rationale.push("No skill met the evidence thresholds — the candidate is the global model in disguise.");
  }
  const temporalWorse = c.temporal.brierStdDev > b.temporal.brierStdDev * 1.5 && c.temporal.blocks.length > 1;
  if (temporalWorse) {
    rationale.push(
      `Temporal stability regressed (Brier SD ${c.temporal.brierStdDev} vs ${b.temporal.brierStdDev}) — ` +
        "the candidate is more period-specific than the current parameters.",
    );
  }
  const selectionWorse = c.selection.prematureMasteryRate > b.selection.prematureMasteryRate + 0.01;
  if (selectionWorse) {
    rationale.push(
      `Premature-mastery rate rose (${c.selection.prematureMasteryRate} vs ${b.selection.prematureMasteryRate}) — ` +
        "the candidate would let learners advance before they are ready.",
    );
  }

  let recommendation: BktPromotionReport["recommendation"];
  if (c.heldOutLearners.responses < minSamples || c.skillsWithOwnParams === 0) {
    recommendation = "insufficient-evidence";
  } else if (decision.verdict === "improved" && !temporalWorse && !selectionWorse) {
    recommendation = "adopt-candidate";
  } else if (decision.verdict === "insufficient-evidence") {
    recommendation = "insufficient-evidence";
  } else {
    recommendation = "keep-current";
  }

  return { decision, autoPromote: false, recommendation, rationale };
}

/* ------------------------------------------------------------------ */
/* Full comparison                                                     */
/* ------------------------------------------------------------------ */

export interface BktComparisonReport {
  variants: VariantEvaluation[];
  promotions: Record<string, BktPromotionReport>;
  /** The variant a human should look at first, or null if none qualifies. */
  bestCandidate: string | null;
  /** Never true. Present so the field is explicit in serialized reports. */
  promotedAutomatically: false;
}

export function compareBktVariants(params: {
  baseline: VariantEvaluation;
  candidates: VariantEvaluation[];
  minHeldOutResponses?: number;
}): BktComparisonReport {
  const promotions: Record<string, BktPromotionReport> = {};
  for (const candidate of params.candidates) {
    promotions[candidate.variant] = assessBktPromotion({
      candidate,
      baseline: params.baseline,
      minHeldOutResponses: params.minHeldOutResponses,
    });
  }
  const adoptable = params.candidates
    .filter((c) => promotions[c.variant].recommendation === "adopt-candidate")
    .sort((a, b) => a.heldOutLearners.brier - b.heldOutLearners.brier);

  return {
    variants: [params.baseline, ...params.candidates],
    promotions,
    bestCandidate: adoptable[0]?.variant ?? null,
    promotedAutomatically: false,
  };
}
