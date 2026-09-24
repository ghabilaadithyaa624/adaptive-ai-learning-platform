/**
 * Multi-objective adaptive-learning policy — type contracts.
 *
 * The policy is an explicit, transparent scalarisation of ten pedagogical /
 * psychometric objectives. Everything that can change the decision is data:
 *
 *   • `PolicyWeights` — how much each objective counts (tunable, see weights.ts)
 *   • `PolicyParams`  — the shape of each objective (targets, bands, gates)
 *
 * Both are serialisable, fingerprinted and echoed into every decision
 * explanation, so any served item can be replayed exactly.
 */

/* ------------------------------------------------------------------ */
/* Objective keys                                                      */
/* ------------------------------------------------------------------ */

/**
 * Objectives that *add* utility. Mapping to the ten candidate objectives:
 *   1 expected mastery gain        → expectedMasteryGain
 *   2 information gain             → informationGain
 *   3 ZPD targeting                → zpdTargeting
 *   4 prerequisite correctness     → prerequisiteCorrectness (+ gate + risk penalty)
 *   5 skill coverage               → skillCoverage
 *   6 retention                    → retention
 *   7 difficulty appropriateness   → difficultyAppropriateness
 *   8 learner uncertainty reduction→ uncertaintyReduction
 *   9 assessment efficiency        → assessmentEfficiency
 *  10 avoiding repeated exposure   → repeatedExposure (penalty + hard filter)
 */
export const BENEFIT_OBJECTIVES = [
  "expectedMasteryGain",
  "informationGain",
  "zpdTargeting",
  "prerequisiteCorrectness",
  "skillCoverage",
  "retention",
  "difficultyAppropriateness",
  "uncertaintyReduction",
  "assessmentEfficiency",
] as const;

export const PENALTY_OBJECTIVES = ["repeatedExposure", "prerequisiteRisk"] as const;

export type BenefitObjectiveKey = (typeof BENEFIT_OBJECTIVES)[number];
export type PenaltyObjectiveKey = (typeof PENALTY_OBJECTIVES)[number];
export type ObjectiveKey = BenefitObjectiveKey | PenaltyObjectiveKey;

export const ALL_OBJECTIVES: readonly ObjectiveKey[] = [...BENEFIT_OBJECTIVES, ...PENALTY_OBJECTIVES];

export type PolicyWeights = Record<ObjectiveKey, number>;

/* ------------------------------------------------------------------ */
/* Policy parameters (objective shapes)                                */
/* ------------------------------------------------------------------ */

/**
 * Structural parameters of the objectives. These are *not* weights: they define
 * what "good" means for each objective (where the ZPD sits, how conservative the
 * prerequisite gate is, how long a review horizon is). Each has a documented
 * justification in `POLICY_PARAM_RATIONALE`.
 */
export interface PolicyParams {
  /** Mastery level that counts as "learned" for a skill. */
  masteryTarget: number;
  /** Success probability the policy aims for once the estimate is trusted. */
  successTarget: number;
  /** Width (SD) of the Gaussian productive-difficulty kernel. */
  zpdSigma: number;
  /** Prerequisite mastery required before a dependent skill may be served. */
  prereqGate: number;
  /** How many posterior SDs of pessimism the prerequisite gate applies. */
  prereqPessimismZ: number;
  /** Desirable-difficulty offset above estimated mastery, in difficulty units. */
  desirableDifficultyOffset: number;
  /** Half-width of the acceptable |difficulty − ideal| window. */
  difficultyTolerance: number;
  /** Share of the difficulty objective carried by Bloom-level fit (0..1). */
  bloomShare: number;
  /** Review horizon (days) used to forecast forgetting. */
  retentionHorizonDays: number;
  /** Exponential forgetting rate per day used for the retention forecast. */
  forgetPerDay: number;
  /** Share of the coverage objective carried by graph "unblocking" value. */
  coverageUnblockShare: number;
  /** Soft cap of items per skill per session (drives the exposure penalty). */
  maxPerSkill: number;
  /** Soft cap of items per Bloom level per session. */
  maxPerBloom: number;
  /** Hard cap on consecutive items drawn from the same skill. */
  maxConsecutiveSameSkill: number;
  /** Share of the exposure penalty carried by same-skill repetition. */
  exposureSkillShare: number;
  /** Share of the exposure penalty carried by Bloom repetition. */
  exposureBloomShare: number;
  /** Reference time (seconds) an item is allowed to cost before it is "slow". */
  timeReferenceSeconds: number;
  /** Floor on how much time economy counts when the learner is fresh. */
  efficiencyBaseline: number;
  /** Discrimination an item is assumed to have when the bank does not say. */
  referenceDiscrimination: number;
}

export interface PolicyConfig {
  weights: PolicyWeights;
  params: PolicyParams;
}

export interface PolicyConfigOverrides {
  weights?: Partial<PolicyWeights> | Record<string, number>;
  params?: Partial<PolicyParams> | Record<string, number>;
}

/** A resolved, validated, fingerprinted configuration. */
export interface ResolvedPolicyConfig extends PolicyConfig {
  /** Benefit weights renormalised to sum to 1 (score stays on a 0..1 scale). */
  normalizedWeights: PolicyWeights;
  fingerprint: string;
}

/* ------------------------------------------------------------------ */
/* Objective evaluation                                                */
/* ------------------------------------------------------------------ */

export interface ObjectiveValue {
  /** Signal in its natural unit (probability, days, seconds, count …). */
  raw: number;
  /** 0..1 value used in the weighted sum. */
  normalized: number;
  /** One-line explanation of this particular value. */
  detail: string;
}
