/**
 * Canonical vocabularies for the item bank.
 *
 * One source of truth for difficulty bands, Bloom levels, cognitive complexity
 * (Depth of Knowledge), authoring source and the editorial workflow states, so
 * validation, the API, the engine and the UI never drift apart.
 */

/* ----------------------------- difficulty -------------------------------- */

export const DIFFICULTY_LABELS = ["easy", "medium", "hard", "expert"] as const;
export type DifficultyLabel = (typeof DIFFICULTY_LABELS)[number];

/** Nominal difficulty on a 0..1 scale for each authored band. */
export const DIFFICULTY_TO_VALUE: Record<DifficultyLabel, number> = {
  easy: 0.3,
  medium: 0.55,
  hard: 0.75,
  expert: 0.9,
};

/** Map an observed/assigned 0..1 difficulty back to the nearest band. */
export function difficultyLabelForValue(value: number): DifficultyLabel {
  let best: DifficultyLabel = "medium";
  let bestDist = Infinity;
  for (const label of DIFFICULTY_LABELS) {
    const dist = Math.abs(DIFFICULTY_TO_VALUE[label] - value);
    if (dist < bestDist) {
      bestDist = dist;
      best = label;
    }
  }
  return best;
}

/* ------------------------------- Bloom ----------------------------------- */

export const BLOOM_LEVELS = ["remember", "understand", "apply", "analyze", "evaluate", "create"] as const;
export type BloomLevel = (typeof BLOOM_LEVELS)[number];

export const BLOOM_TO_VALUE: Record<BloomLevel, number> = {
  remember: 1,
  understand: 2,
  apply: 3,
  analyze: 4,
  evaluate: 5,
  create: 6,
};

/* ------------------------ cognitive complexity --------------------------- */
/**
 * Webb's Depth of Knowledge — distinct from Bloom. Bloom describes the *type* of
 * cognition; DoK describes its *depth/complexity*. Kept separate because a
 * "remember" item can still demand strategic thinking and vice versa.
 */
export const COGNITIVE_COMPLEXITY_LEVELS = [
  "recall",
  "skill_concept",
  "strategic_thinking",
  "extended_thinking",
] as const;
export type CognitiveComplexity = (typeof COGNITIVE_COMPLEXITY_LEVELS)[number];

export const COGNITIVE_COMPLEXITY_TO_VALUE: Record<CognitiveComplexity, number> = {
  recall: 1,
  skill_concept: 2,
  strategic_thinking: 3,
  extended_thinking: 4,
};

/* ------------------------------- source ---------------------------------- */

export const QUESTION_SOURCES = ["human", "ai", "imported"] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

/* ------------------------------ workflow --------------------------------- */
/**
 * Editorial lifecycle. Items are only delivered to learners once they reach
 * `published` (and stay deliverable while `monitored`). Draft/review/validated
 * are pre-publication; retired is post-publication removal.
 */
export const QUESTION_STATUSES = [
  "draft",
  "review",
  "validated",
  "published",
  "monitored",
  "retired",
] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** Statuses whose items may be served to learners by the adaptive engine. */
export const SERVABLE_STATUSES: QuestionStatus[] = ["published", "monitored"];

export function isServable(status: QuestionStatus, isActive: boolean): boolean {
  return isActive && SERVABLE_STATUSES.includes(status);
}

/* --------------------------- calibration model --------------------------- */
/**
 * Container describing how an item's psychometric parameters were estimated.
 * The `model` discriminator lets us start with a classical/1PL approximation and
 * later drop in a full 2PL/3PL MML calibration WITHOUT a schema change — the
 * parameters simply live in this JSON blob keyed by model.
 */
export type CalibrationModel = "none" | "ctt" | "rasch-approx" | "1pl" | "2pl" | "3pl";

export interface CalibrationParams {
  model: CalibrationModel;
  /** Discrimination (IRT a). null until a 2PL+ calibration runs. */
  a: number | null;
  /** Difficulty (IRT b), on the logit ability scale. */
  b: number | null;
  /** Guessing (IRT c). null until a 3PL calibration runs. */
  c: number | null;
  /** Standard error of the difficulty estimate. */
  seB: number | null;
  /** Sample size the calibration was estimated from. */
  sampleSize: number;
  /** Estimation method, free text for provenance. */
  method: string;
  /** ISO timestamp of the calibration run. */
  calibratedAt: string | null;
}

export const EMPTY_CALIBRATION: CalibrationParams = {
  model: "none",
  a: null,
  b: null,
  c: null,
  seB: null,
  sampleSize: 0,
  method: "uncalibrated",
  calibratedAt: null,
};
