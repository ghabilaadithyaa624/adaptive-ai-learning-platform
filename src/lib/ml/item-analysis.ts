/**
 * Item-quality analytics from observed responses.
 *
 * Classical Test Theory (CTT) item analysis plus a forward-compatible IRT
 * calibration path:
 *   • facility / p-value (difficulty index)
 *   • discrimination (corrected point-biserial + upper/lower index)
 *   • distractor analysis (selection rates, distractor discrimination, mis-key detection)
 *   • a composite, explainable quality score in [0,1]
 *   • a Rasch (1PL) difficulty approximation that populates the calibration
 *     container so a full 2PL/3PL estimator can be swapped in later WITHOUT any
 *     schema change.
 *
 * Pure and deterministic. Imports only clamp/mean from utils.
 */
import { clamp, mean } from "@/lib/utils";
import { difficultyLabelForValue, type CalibrationParams } from "@/lib/questions/constants";

/** Below this many responses, statistics are reported but flagged provisional. */
export const MIN_RELIABLE_SAMPLE = 20;

export interface ItemResponse {
  correct: boolean;
  /** Respondent ability proxy on a continuous scale (e.g. rest-score accuracy in [0,1]). */
  ability: number;
  /** The option the respondent selected (null if unanswered). */
  chosenOption: number | null;
  responseTimeMs?: number | null;
}

export interface OptionStat {
  optionIndex: number;
  isKey: boolean;
  count: number;
  selectionRate: number;
  meanAbility: number | null;
  /** Point-biserial of "chose this option" vs ability. Positive for a good key, negative for a good distractor. */
  discrimination: number | null;
  /** For distractors: attracts lower-ability respondents and is chosen often enough to be useful. */
  functioning: boolean;
}

export interface ItemAnalysis {
  sampleSize: number;
  facility: number; // proportion correct (a.k.a. p-value / difficulty index)
  successRate: number; // alias kept explicit for the persisted column
  discrimination: number | null; // corrected point-biserial
  discriminationIndex: number | null; // upper-minus-lower 27% groups
  meanResponseTimeMs: number | null;
  raschDifficulty: number | null; // 1PL b approximation (logit scale)
  options: OptionStat[];
  flags: string[];
  qualityScore: number; // 0..1
  reliable: boolean; // sampleSize >= MIN_RELIABLE_SAMPLE
}

/** Pearson correlation; returns null when either series has zero variance. */
export function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Point-biserial correlation between a dichotomous item score and continuous ability. */
export function pointBiserial(itemScores: number[], ability: number[]): number | null {
  return pearson(itemScores, ability);
}

/** Upper-minus-lower discrimination index using the top/bottom 27% by ability. */
export function discriminationIndex(responses: ItemResponse[]): number | null {
  const n = responses.length;
  if (n < 4) return null;
  const sorted = [...responses].sort((a, b) => a.ability - b.ability);
  const groupSize = Math.max(1, Math.floor(n * 0.27));
  const lower = sorted.slice(0, groupSize);
  const upper = sorted.slice(n - groupSize);
  const pUpper = mean(upper.map((r) => (r.correct ? 1 : 0)));
  const pLower = mean(lower.map((r) => (r.correct ? 1 : 0)));
  return pUpper - pLower;
}

/** Rasch (1PL) difficulty approximation from facility: b = ln((1-p)/p), clamped. */
export function raschDifficulty(facility: number): number | null {
  if (facility <= 0 || facility >= 1) return facility <= 0 ? 4 : -4;
  return clamp(Math.log((1 - facility) / facility), -4, 4);
}

export interface AnalyzeOptions {
  optionCount: number;
  correctIndex: number;
  /** Authored difficulty band, used only for the calibration-consistency term of the quality score. */
  authoredDifficultyLabel?: string;
}

export function analyzeItem(responses: ItemResponse[], opts: AnalyzeOptions): ItemAnalysis {
  const n = responses.length;
  const flags: string[] = [];

  if (n === 0) {
    return {
      sampleSize: 0,
      facility: 0,
      successRate: 0,
      discrimination: null,
      discriminationIndex: null,
      meanResponseTimeMs: null,
      raschDifficulty: null,
      options: [],
      flags: ["no_responses"],
      qualityScore: 0,
      reliable: false,
    };
  }

  const itemScores = responses.map((r) => (r.correct ? 1 : 0));
  const abilities = responses.map((r) => r.ability);
  const facility = mean(itemScores);
  const discrimination = pointBiserial(itemScores, abilities);
  const discIndex = discriminationIndex(responses);
  const times = responses.map((r) => r.responseTimeMs).filter((t): t is number => typeof t === "number" && t >= 0);
  const meanResponseTimeMs = times.length ? Math.round(mean(times)) : null;
  const overallAbility = mean(abilities);

  // per-option analysis
  const options: OptionStat[] = [];
  for (let idx = 0; idx < opts.optionCount; idx += 1) {
    const chose = responses.map((r) => (r.chosenOption === idx ? 1 : 0));
    const count = chose.reduce((a: number, b: number) => a + b, 0);
    const selectionRate = n ? count / n : 0;
    const choosers = responses.filter((r) => r.chosenOption === idx);
    const meanAbility = choosers.length ? mean(choosers.map((r) => r.ability)) : null;
    const disc = pointBiserial(chose, abilities);
    const isKey = idx === opts.correctIndex;
    // A distractor "functions" if it draws a non-trivial share of *lower-ability*
    // respondents (negative discrimination). The key should discriminate positively.
    const functioning = isKey
      ? disc != null && disc > 0
      : selectionRate >= 0.05 && meanAbility != null && meanAbility < overallAbility;
    options.push({ optionIndex: idx, isKey, count, selectionRate, meanAbility, discrimination: disc, functioning });
  }

  /* ------------------------------- flags -------------------------------- */
  const reliable = n >= MIN_RELIABLE_SAMPLE;
  if (!reliable) flags.push("insufficient_sample");
  if (facility > 0.92) flags.push("too_easy");
  if (facility < 0.2) flags.push("too_hard");
  if (discrimination != null && discrimination < 0) flags.push("negative_discrimination");
  else if (discrimination != null && discrimination < 0.15) flags.push("low_discrimination");

  const distractors = options.filter((o) => !o.isKey);
  if (distractors.some((o) => o.selectionRate < 0.02)) flags.push("nonfunctional_distractor");
  // mis-key suspicion: a distractor chosen a lot by *higher*-ability respondents than the key
  const key = options[opts.correctIndex];
  if (
    key &&
    key.meanAbility != null &&
    distractors.some((o) => o.selectionRate >= 0.15 && o.meanAbility != null && o.meanAbility > key.meanAbility!)
  ) {
    flags.push("possible_miskey");
  }

  /* --------------------------- quality score ---------------------------- */
  const qualityScore = computeQualityScore({ facility, discrimination, options, sampleSize: n }, opts.authoredDifficultyLabel);

  return {
    sampleSize: n,
    facility: round3(facility),
    successRate: round3(facility),
    discrimination: discrimination == null ? null : round3(discrimination),
    discriminationIndex: discIndex == null ? null : round3(discIndex),
    meanResponseTimeMs,
    raschDifficulty: raschDifficulty(facility) == null ? null : round3(raschDifficulty(facility) as number),
    options: options.map((o) => ({
      ...o,
      selectionRate: round3(o.selectionRate),
      meanAbility: o.meanAbility == null ? null : round3(o.meanAbility),
      discrimination: o.discrimination == null ? null : round3(o.discrimination),
    })),
    flags,
    qualityScore,
    reliable,
  };
}

/**
 * Explainable composite quality score in [0,1]. Weighted blend of discrimination,
 * facility band, distractor functioning, sample adequacy and (optionally)
 * authored-vs-observed difficulty consistency.
 */
export function computeQualityScore(
  a: { facility: number; discrimination: number | null; options: OptionStat[]; sampleSize: number },
  authoredDifficultyLabel?: string,
): number {
  // 1) discrimination (0.35): 0.4 point-biserial ≈ excellent
  const discComponent = a.discrimination == null ? 0 : clamp(a.discrimination / 0.4, 0, 1);
  // 2) facility band (0.25): flat 1 within [0.4,0.85], linear decay to 0 at 0.1 / 1.0
  const facilityComponent = facilityScore(a.facility);
  // 3) distractor functioning (0.20)
  const distractors = a.options.filter((o) => !o.isKey);
  const distractorComponent = distractors.length ? distractors.filter((o) => o.functioning).length / distractors.length : 0;
  // 4) sample adequacy (0.10)
  const sampleComponent = clamp(a.sampleSize / MIN_RELIABLE_SAMPLE, 0, 1);
  // 5) calibration consistency (0.10)
  let calibrationComponent = 0.75; // neutral when we cannot check
  if (authoredDifficultyLabel) {
    calibrationComponent = difficultyLabelForValue(1 - a.facility) === authoredDifficultyLabel ? 1 : 0.5;
  }
  const score =
    0.35 * discComponent +
    0.25 * facilityComponent +
    0.2 * distractorComponent +
    0.1 * sampleComponent +
    0.1 * calibrationComponent;
  return round3(clamp(score, 0, 1));
}

function facilityScore(facility: number): number {
  if (facility >= 0.4 && facility <= 0.85) return 1;
  if (facility < 0.4) return clamp((facility - 0.1) / 0.3, 0, 1);
  return clamp((1 - facility) / 0.15, 0, 1);
}

/**
 * Build the calibration container from an analysis. Starts as a Rasch (1PL)
 * approximation; a future estimator can overwrite this with real 2PL/3PL params.
 */
export function calibrationFromAnalysis(analysis: ItemAnalysis, now: Date = new Date()): CalibrationParams {
  if (analysis.sampleSize === 0) {
    return { model: "none", a: null, b: null, c: null, seB: null, sampleSize: 0, method: "uncalibrated", calibratedAt: null };
  }
  const b = analysis.raschDifficulty;
  // Standard error of a logit from a proportion: 1/sqrt(n p (1-p)), guarded.
  const p = clamp(analysis.facility, 0.01, 0.99);
  const seB = round3(1 / Math.sqrt(Math.max(1, analysis.sampleSize) * p * (1 - p)));
  return {
    model: analysis.reliable ? "rasch-approx" : "ctt",
    a: analysis.discrimination, // provisional discrimination; a full 2PL will refine
    b,
    c: null,
    seB,
    sampleSize: analysis.sampleSize,
    method: analysis.reliable ? "logit-of-facility (1PL approximation)" : "classical (provisional)",
    calibratedAt: now.toISOString(),
  };
}

/** KR-20 reliability for a respondents × items score matrix (0/1). */
export function kr20(scoreMatrix: number[][]): number | null {
  const k = scoreMatrix[0]?.length ?? 0;
  const n = scoreMatrix.length;
  if (k < 2 || n < 2) return null;
  // total score variance
  const totals = scoreMatrix.map((row) => row.reduce((a, b) => a + b, 0));
  const totalVar = variance(totals);
  if (totalVar <= 0) return 0;
  let sumPQ = 0;
  for (let j = 0; j < k; j += 1) {
    const col = scoreMatrix.map((row) => row[j]);
    const p = mean(col);
    sumPQ += p * (1 - p);
  }
  return (k / (k - 1)) * (1 - sumPQ / totalVar);
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return mean(values.map((v) => (v - m) ** 2));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
