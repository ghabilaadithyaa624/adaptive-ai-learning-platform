/**
 * Adaptive engine — core interfaces & domain types.
 *
 * This module defines the *contracts* the adaptive engine is built against so
 * the concrete algorithms (BKT, IRT, Bayesian, contextual bandits, logistic
 * regression) are swappable without touching the orchestration layer.
 *
 *   KnowledgeTracingModel  — how a per-skill belief evolves with evidence,
 *                            forgetting, and how it predicts a response.
 *   ResponseModel          — P(correct) for a (learner, item) pair. Used by the
 *                            item selector; can be logistic, IRT or BKT-derived.
 *   ItemSelectionStrategy  — chooses the next item and *explains why*.
 *
 * Everything here is deterministic and side-effect free. No randomness that is
 * not seeded, no wall-clock reads — callers pass `now` explicitly.
 */

/* ------------------------------------------------------------------ */
/* Item + observation primitives                                       */
/* ------------------------------------------------------------------ */

/** Psychometric descriptor of a single question/item. */
export interface ItemDescriptor {
  /** Difficulty on a 0..1 scale (0 = trivial, 1 = expert). */
  difficulty: number;
  /** Bloom cognitive level 1 (remember) .. 6 (create). */
  bloom: number;
  /** IRT discrimination (slope). Optional; defaults to 1 for models that use it. */
  discrimination?: number;
  /** Expected time-on-task in ms, used to normalise response time. */
  expectedTimeMs?: number;
  /**
   * Bank-level exposure rate 0..1 (how often this item has already been served
   * across the cohort). Optional; enables Sympson-Hetter style exposure control
   * in the v3 policy. Absent → treated as 0 (unexposed).
   */
  exposureRate?: number;
}

/** A single graded response fed to a knowledge-tracing model. */
export interface TraceObservation {
  isCorrect: boolean;
  /** Observed response time (ms). Optional. */
  responseTimeMs?: number;
  /** Expected/typical response time (ms) for normalisation. Optional. */
  expectedTimeMs?: number;
  /** Item difficulty 0..1. Optional. */
  difficulty?: number;
  /** Bloom level 1..6. Optional. */
  bloom?: number;
  /** Whether a hint/scaffold was used. Optional — "where available". */
  hintUsed?: boolean;
}

/* ------------------------------------------------------------------ */
/* Knowledge-tracing model contract                                    */
/* ------------------------------------------------------------------ */

/**
 * A per-skill belief. `mastery` is the point estimate P(skill known); model
 * internals (Beta counts, IRT theta, ...) live in the opaque `stats` bag so the
 * public shape stays uniform across BKT / IRT / Bayesian implementations.
 */
export interface SkillBelief {
  /** Point estimate of mastery, 0..1. */
  mastery: number;
  /** Epistemic uncertainty of the estimate, 0..1 (1 = no evidence). */
  uncertainty: number;
  /** Convenience = 1 - uncertainty. */
  confidence: number;
  /** Model-internal sufficient statistics (opaque to callers). */
  stats?: Record<string, number>;
}

export type KnowledgeModelKind = "bkt" | "irt" | "bayesian";

/**
 * Contract every knowledge-tracing algorithm implements. Deterministic:
 * identical inputs → identical outputs.
 */
export interface KnowledgeTracingModel<P = Record<string, number>> {
  readonly id: string;
  readonly kind: KnowledgeModelKind;
  /** Belief before any evidence is seen. */
  prior(params?: Partial<P>): SkillBelief;
  /** Fold one graded response into the belief (posterior + learning). */
  observe(belief: SkillBelief, obs: TraceObservation, params?: Partial<P>): SkillBelief;
  /** Apply forgetting/decay for `elapsedDays` since last practice. */
  decay(belief: SkillBelief, elapsedDays: number, params?: Partial<P>): SkillBelief;
  /** Predicted P(correct) for an item, given the current belief. */
  predictCorrect(belief: SkillBelief, item: ItemDescriptor, params?: Partial<P>): number;
}

/* ------------------------------------------------------------------ */
/* Response model contract (P(correct) for selection)                  */
/* ------------------------------------------------------------------ */

export interface ResponseContext {
  learner: LearnerState;
  skill: LearnerSkillState;
  item: ItemDescriptor;
  /** Assumed response time for the prediction (ms). Optional. */
  responseTimeMs?: number;
}

/** Predicts P(correct) for a (learner, item) pair. Deterministic. */
export interface ResponseModel {
  readonly id: string;
  predict(ctx: ResponseContext): number;
}

/* ------------------------------------------------------------------ */
/* Learner state — the 15-signal composite                             */
/* ------------------------------------------------------------------ */

/** Categorical diagnosis of a learner's error behaviour on a skill. */
export interface ErrorProfile {
  type: "none" | "careless" | "struggling" | "guessing" | "slipping" | "insufficient-data";
  /** Fraction of errors that were fast (careless). */
  carelessRate: number;
  /** Fraction of errors that were slow (genuine struggle). */
  strugglingRate: number;
  /** Fraction of *correct* answers that look like fast guesses on hard items. */
  guessRate: number;
  label: string;
}

/** Per-skill slice of the learner state. Combines signals 1-14. */
export interface LearnerSkillState {
  skillId: number;
  skillName: string;
  subjectName: string;

  /** (1) Skill mastery — decayed point estimate. */
  mastery: number;
  /** Pre-decay mastery for reference. */
  rawMastery: number;
  /** (8) Confidence / evidence strength, 0..1. */
  confidence: number;
  /** (8) Epistemic uncertainty, 0..1. */
  uncertainty: number;

  /** (7) Attempt count. */
  attempts: number;
  correct: number;
  streak: number;

  /** (3) Historical performance — all-time accuracy. */
  accuracy: number;
  /** (2) Recent performance — accuracy over the recent window. */
  recentAccuracy: number;

  /** (4) Response time — observed/expected ratio (~1 normal, <1 fast, >1 slow). */
  responseRatio: number;

  /** (9) Forgetting/retention — decayed/raw mastery, 0..1. */
  retention: number;
  daysSincePractice: number;

  /** (12) Learning velocity — mastery slope per recent attempt, -1..1. */
  velocity: number;

  /** (10) Prerequisite mastery. */
  prereqReadiness: number;
  prereqMastery: { skillId: number; name: string; mastery: number }[];

  /** (13) Error patterns. */
  errorProfile: ErrorProfile;

  /** (14) Hint usage — reliance 0..1; hasHintData=false when unavailable. */
  hintReliance: number;
  hasHintData: boolean;

  /** (5) Avg difficulty faced; (6) avg bloom faced. */
  avgDifficulty: number;
  avgBloom: number;

  /** Base difficulty of the skill (item-independent). */
  difficultyBase: number;
  /** Alignment with the active learning path, 0..1. */
  pathAlignment: number;
  prereqIds: number[];
}

/** (11) Assessment context. */
export interface AssessmentContext {
  mode: string;
  itemsAnswered: number;
  itemTarget: number;
  /** Accuracy within the current session. */
  sessionAccuracy: number;
  /** Fatigue proxy 0..1 (grows across a long session). */
  fatigue: number;
}

/** The full learner state. Signals 2/3/11/12/15 live at this level. */
export interface LearnerState {
  studentId: number;
  /** Global ability estimate (mean decayed mastery), 0..1. */
  ability: number;
  /** (3) Historical accuracy across all responses. */
  historicalAccuracy: number;
  /** (2) Recent accuracy across the recent window. */
  recentAccuracy: number;
  /** (4) Global response-time ratio. */
  avgResponseRatio: number;
  /** (12) Global learning velocity. */
  velocity: number;
  /** (15) Recent engagement, 0..1 (recency + consistency + volume). */
  engagement: number;
  /** (11) Assessment context. */
  context: AssessmentContext;
  skills: Map<number, LearnerSkillState>;
}

/* ------------------------------------------------------------------ */
/* Item selection contract                                             */
/* ------------------------------------------------------------------ */

/** A selectable candidate item. */
export interface CandidateItem {
  questionId: number;
  skillId: number;
  skillName: string;
  subjectName: string;
  item: ItemDescriptor;
  estimatedSeconds: number;
  text: string;
}

/** One weighted decision factor with a human-readable explanation. */
export interface DecisionFactor {
  key: string;
  /** Normalised contribution 0..1 before weighting. */
  value: number;
  /** Weighted contribution actually added to the score. */
  weighted: number;
  detail: string;
}

/* ------------------------------------------------------------------ */
/* Machine-readable decision explanation (audit contract)              */
/* ------------------------------------------------------------------ */

/** Stable schema id for persisted/serialised decision explanations. */
export const DECISION_EXPLANATION_SCHEMA = "adaptive.decision.v1" as const;

/** One objective's contribution to a selection decision. */
export interface DecisionObjective {
  /** Stable machine key (e.g. `expectedMasteryGain`). */
  key: string;
  /** Human label for UI. */
  label: string;
  /** The signal in its natural unit (probability, days, seconds, count...). */
  raw: number;
  /** The 0..1 value actually fed into the weighted sum. */
  normalized: number;
  /** Configured weight for this objective. */
  weight: number;
  /** Signed contribution to the final score (`±weight × normalized`). */
  contribution: number;
  /** Whether the term adds utility or subtracts it. */
  direction: "benefit" | "penalty";
  /** Why this objective exists and what this value means. */
  rationale: string;
}

/** A hard constraint evaluated before/while scoring. */
export interface DecisionGate {
  key: string;
  label: string;
  /** Did the *selected* item satisfy the gate? */
  passed: boolean;
  /** True when the gate had to be relaxed because nothing satisfied it. */
  relaxed: boolean;
  /** How many candidates the gate removed from the pool. */
  filtered: number;
  detail: string;
}

/**
 * Fully machine-readable justification for one served item. Every policy must
 * emit one for the item it selects, so any decision can be replayed, audited and
 * shown to a learner/teacher without an LLM in the loop.
 */
export interface DecisionExplanation {
  schema: typeof DECISION_EXPLANATION_SCHEMA;
  policyId: string;
  policyVersion: string;
  /** Deterministic fingerprint of the weight/param configuration in force. */
  configFingerprint: string;
  questionId: number;
  skillId: number;
  skillName: string;
  /** Final composite score of the chosen item. */
  score: number;
  /** 1-based rank of this item in the scored pool. */
  rank: number;
  candidatesConsidered: number;
  candidatesFiltered: number;
  objectives: DecisionObjective[];
  gates: DecisionGate[];
  /** Objective keys ordered by |contribution|, best-first. */
  topDrivers: string[];
  /** Why this item rather than the runner-up. */
  counterfactual: {
    runnerUpQuestionId: number | null;
    runnerUpSkillId: number | null;
    scoreMargin: number;
    decidingObjectives: { key: string; delta: number }[];
  } | null;
  /** The learner-state slice the decision was conditioned on. */
  learnerSnapshot: {
    mastery: number;
    uncertainty: number;
    attempts: number;
    predictedSuccess: number;
    prereqReadiness: number;
    prereqReadinessLcb: number;
    daysSincePractice: number;
    retention: number;
  };
  targets: { mastery: number; success: number };
  /** Deterministic, templated natural-language sentence (no LLM). */
  narrative: string;
}

/** The outcome of scoring a single candidate. */
export interface ScoredItem {
  candidate: CandidateItem;
  score: number;
  predictedCorrect: number;
  information: number;
  expectedLearningGain: number;
  factors: DecisionFactor[];
  /** One-sentence, human-readable justification. */
  explanation: string;
  /** Structured chips for UI. */
  steps: { label: string; value: string; tone: string }[];
  /** Machine-readable, auditable decision record (required for every item). */
  decision: DecisionExplanation;
}

export interface SelectionResult {
  chosen: ScoredItem | null;
  /** All candidates, best-first (excludes hard-filtered items). */
  ranked: ScoredItem[];
  /** Items removed by hard constraints (repeats / no candidates). */
  excluded: number;
}

export interface SelectionInput {
  learner: LearnerState;
  candidates: CandidateItem[];
  /** Question ids already served this session (hard-excluded). */
  seenQuestionIds: Set<number>;
  /** How many items already asked per skill this session (diversity). */
  askedSkillCounts: Map<number, number>;
  /** How many items per bloom level this session (diversity). */
  askedBloomCounts?: Map<number, number>;
  /**
   * Skill ids served this session in order (most recent last). Enables
   * blocked-practice detection (consecutive items on one skill). Optional.
   */
  recentSkillIds?: number[];
  responseModel: ResponseModel;
  knowledgeModel: KnowledgeTracingModel;
  /** Mastery target (default 0.85). */
  target?: number;
  /** Optional weight overrides (for tuning / benchmarking). */
  weights?: Partial<SelectionWeights>;
  /**
   * Optional multi-objective (v3) policy overrides. Ignored by the v2 selector;
   * consumed by `MultiObjectivePolicy`. Typed loosely here so the shared
   * contract module stays dependency-free — see `ml/policy/types.ts`.
   */
  policyConfig?: {
    weights?: Record<string, number>;
    params?: Record<string, number>;
  };
}

/** Tunable, documented weights for the composite selection score. */
export interface SelectionWeights {
  masteryGap: number;
  expectedLearningGain: number;
  informationGain: number;
  difficultyFit: number;
  spacedReview: number;
  uncertainty: number;
  exploration: number;
  diversityPenalty: number;
  prereqPenalty: number;
}

export interface ItemSelectionStrategy {
  readonly id: string;
  select(input: SelectionInput): SelectionResult;
}
