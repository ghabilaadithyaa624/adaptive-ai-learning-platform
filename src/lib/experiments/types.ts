/**
 * Experimentation framework — domain types.
 *
 * This module is the contract for controlled comparison of adaptive-learning
 * policies. Three properties are designed in rather than bolted on:
 *
 *  1. **Determinism.** Assignment is a pure function of
 *     (experiment key, salt, learner id). No stored counters, no `Math.random`,
 *     no wall clock. The same learner always lands in the same bucket, in any
 *     process, at any time, including after a restart or a replay.
 *
 *  2. **No automated winner.** There is deliberately no `winner`,
 *     `recommendation` or `isSignificant` field anywhere in the analysis types.
 *     The framework reports effect sizes with uncertainty intervals and stops.
 *     Deciding to ship is a human act that should require reading the numbers.
 *
 *  3. **Leakage resistance.** A learner is bound to one variant per experiment,
 *     metrics are attributed only from the moment of first exposure, and every
 *     query is tenant-scoped. See `attribution.ts` for the guarantees and the
 *     specific failure each one prevents.
 */
import type { PolicyWeights } from "@/lib/ml/policy/types";

/* ------------------------------------------------------------------ */
/* Policy variants                                                     */
/* ------------------------------------------------------------------ */

/**
 * Every policy an experiment may route traffic to.
 *
 * The three baselines are first-class arms, not debug tools: offline simulation
 * found a trivial mastery-gap heuristic out-learning every adaptive policy, so
 * "is the adaptive engine better than nothing?" has to be answerable in
 * production too.
 */
export const POLICY_VARIANT_IDS = [
  "legacy",
  "adaptive-v2",
  "adaptive-v3",
  "random-baseline",
  "difficulty-baseline",
  "mastery-gap-baseline",
] as const;

export type PolicyVariantId = (typeof POLICY_VARIANT_IDS)[number];

export function isPolicyVariantId(value: string): value is PolicyVariantId {
  return (POLICY_VARIANT_IDS as readonly string[]).includes(value);
}

/**
 * A *versioned* policy configuration. Two arms may run the same policy with
 * different weights, so the policy id alone never identifies an arm's
 * behaviour. `fingerprint` is a deterministic digest of the whole config and is
 * what gets written to every exposure record — if someone edits weights
 * mid-flight, the change is visible in the data rather than silently mixed into
 * the previous arm's results.
 */
export interface VersionedPolicyConfig {
  policy: PolicyVariantId;
  /** Semantic version of the configuration, not of the code. */
  version: string;
  /** Per-objective weight overrides (v3 only; ignored by other policies). */
  weights?: Partial<PolicyWeights>;
  /** Structural parameter overrides (v3 only). */
  params?: Record<string, number>;
  /** Deterministic digest of {policy, version, weights, params}. */
  fingerprint: string;
}

/* ------------------------------------------------------------------ */
/* Variants                                                            */
/* ------------------------------------------------------------------ */

export interface ExperimentVariant {
  /** Stable key, unique within the experiment (e.g. "control", "v3-retention"). */
  key: string;
  label: string;
  /**
   * Share of eligible traffic, in percent. Variant allocations must sum to
   * ≤ 100; any remainder is unallocated and those learners are simply not
   * enrolled (they see the platform default and are excluded from analysis).
   */
  allocationPct: number;
  config: VersionedPolicyConfig;
  /**
   * Marks the reference arm for comparisons. Exactly one variant must be the
   * control. It is only a *label* — the analysis never treats it preferentially
   * beyond being the subtrahend in a difference.
   */
  isControl: boolean;
}

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

/**
 * Who may enter the experiment. Every field is an AND-ed constraint; omitted
 * fields do not constrain.
 *
 * Eligibility is evaluated against a snapshot of the learner taken at
 * *assignment time* and then frozen into the assignment record. Re-evaluating
 * it later would let a learner drift out of the population mid-experiment and
 * silently stop contributing data, which biases results toward whoever happens
 * to still qualify at analysis time.
 */
export interface EligibilityRule {
  /** Restrict to these institutions. Empty/undefined = all within tenant scope. */
  institutionIds?: number[];
  /** Restrict to these roles (default: students only). */
  roles?: string[];
  gradeLevels?: string[];
  cohorts?: string[];
  /** Minimum prior answered items — excludes learners with too little history. */
  minPriorAttempts?: number;
  /** Maximum prior answered items — e.g. to target new learners only. */
  maxPriorAttempts?: number;
  /** Only learners created on/after this instant. */
  createdAfter?: Date;
  /** Only learners created before this instant. */
  createdBefore?: Date;
  /** Restrict to learners with at least one mastery state in these subjects. */
  subjectIds?: number[];
}

/** The learner facts an eligibility rule is evaluated against. */
export interface LearnerEligibilitySnapshot {
  studentId: number;
  institutionId: number | null;
  role: string;
  gradeLevel: string | null;
  cohort: string | null;
  priorAttempts: number;
  createdAt: Date;
  subjectIds: number[];
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

/**
 * Primary metrics are *learning outcomes*. They are deliberately the only
 * metrics permitted as an experiment's primary, because the platform's stated
 * objective is measurable learning improvement — not engagement, and not
 * prediction accuracy.
 */
export const PRIMARY_METRIC_KEYS = [
  "masteryGain",
  "timeToMastery",
  "retention",
  "questionsToMastery",
] as const;
export type PrimaryMetricKey = (typeof PRIMARY_METRIC_KEYS)[number];

export const SECONDARY_METRIC_KEYS = [
  "zpdHitRate",
  "recommendationAcceptance",
  "completion",
  "informationGain",
  "calibration",
  "engagement",
] as const;
export type SecondaryMetricKey = (typeof SECONDARY_METRIC_KEYS)[number];

export type MetricKey = PrimaryMetricKey | SecondaryMetricKey;

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  /** What it measures, in one sentence a non-specialist can check. */
  definition: string;
  unit: "ratio" | "minutes" | "count" | "probability";
  /**
   * Whether a higher value is conventionally desirable. Used **only** for
   * rendering direction hints — never to pick a winner, and never to flip the
   * sign of a reported interval.
   */
  higherIsBetter: boolean;
  /**
   * Learners with no qualifying observation are excluded rather than scored
   * zero. `censorable` marks metrics where that exclusion is common enough that
   * the analysis must report the censored count alongside the estimate.
   */
  censorable: boolean;
}

export const METRIC_DEFINITIONS: Record<MetricKey, MetricDefinition> = {
  masteryGain: {
    key: "masteryGain",
    label: "Mastery gain",
    definition:
      "Sum of per-skill mastery increase across items served after exposure, from mastery_before to mastery_after.",
    unit: "ratio",
    higherIsBetter: true,
    censorable: false,
  },
  timeToMastery: {
    key: "timeToMastery",
    label: "Time to mastery",
    definition:
      "Minutes of on-task response time from first exposure until a skill first crosses the mastery threshold.",
    unit: "minutes",
    higherIsBetter: false,
    censorable: true,
  },
  retention: {
    key: "retention",
    label: "Retention",
    definition:
      "Accuracy on items in a skill re-encountered at least 7 days after that skill last reached its peak mastery.",
    unit: "ratio",
    higherIsBetter: true,
    censorable: true,
  },
  questionsToMastery: {
    key: "questionsToMastery",
    label: "Questions to mastery",
    definition: "Count of items served after exposure until a skill first crosses the mastery threshold.",
    unit: "count",
    higherIsBetter: false,
    censorable: true,
  },
  zpdHitRate: {
    key: "zpdHitRate",
    label: "ZPD hit rate",
    definition:
      "Share of served items whose predicted success probability fell inside the productive band [0.50, 0.85].",
    unit: "ratio",
    higherIsBetter: true,
    censorable: false,
  },
  recommendationAcceptance: {
    key: "recommendationAcceptance",
    label: "Recommendation acceptance",
    definition: "Share of recommendations surfaced after exposure that the learner accepted or completed.",
    unit: "ratio",
    higherIsBetter: true,
    censorable: true,
  },
  completion: {
    key: "completion",
    label: "Assessment completion",
    definition: "Share of assessments started after exposure that reached a completed status.",
    unit: "ratio",
    higherIsBetter: true,
    censorable: true,
  },
  informationGain: {
    key: "informationGain",
    label: "Information per item",
    definition: "Mean binary-outcome information 4·p·(1−p) at the predicted success probability of served items.",
    unit: "ratio",
    higherIsBetter: true,
    censorable: false,
  },
  calibration: {
    key: "calibration",
    label: "Calibration error",
    definition:
      "Mean absolute difference between predicted success probability and realised correctness, over served items.",
    unit: "probability",
    higherIsBetter: false,
    censorable: false,
  },
  engagement: {
    key: "engagement",
    label: "Engagement",
    definition: "Distinct active days after exposure, divided by days elapsed since exposure.",
    unit: "ratio",
    higherIsBetter: true,
    censorable: false,
  },
};

/* ------------------------------------------------------------------ */
/* Experiment                                                          */
/* ------------------------------------------------------------------ */

/**
 * Lifecycle. Transitions are validated in `lifecycle.ts`; the important
 * invariant is that variant definitions and allocations freeze once an
 * experiment is `running`, because changing them mid-flight silently
 * re-buckets learners and mixes populations.
 */
export const EXPERIMENT_STATUSES = ["draft", "scheduled", "running", "paused", "completed", "archived"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/**
 * How a learner's variant is resolved on repeat visits.
 *
 *  • `sticky`  — the persisted assignment always wins, even if allocations
 *                change later. This is the default and the only safe choice for
 *                a learning experiment, where the treatment *is* a sustained
 *                course of instruction.
 *  • `rolling` — recompute from the hash on every call. Only appropriate for
 *                stateless surfaces; explicitly opt-in because it destroys
 *                per-learner causal attribution.
 */
export type AssignmentStrategy = "sticky" | "rolling";

export interface Experiment {
  /** Surrogate id (database identity). */
  id: number;
  /** Stable human-readable identifier, unique per tenant. Used in hashing. */
  key: string;
  name: string;
  hypothesis: string;
  /**
   * Owning institution, or `null` for a platform-wide experiment. Every read
   * path filters on this; see `tenant.ts`.
   */
  institutionId: number | null;
  status: ExperimentStatus;
  variants: ExperimentVariant[];
  eligibility: EligibilityRule;
  primaryMetric: PrimaryMetricKey;
  secondaryMetrics: SecondaryMetricKey[];
  assignmentStrategy: AssignmentStrategy;
  /**
   * Hash salt. Distinct per experiment so that a learner who is in the
   * treatment arm of one experiment is not systematically in the treatment arm
   * of the next — correlated bucketing across experiments would confound both.
   */
  salt: string;
  startAt: Date;
  endAt: Date | null;
  /**
   * Experiments sharing a non-null exclusion group never enrol the same
   * learner. Two experiments that both change item selection would otherwise
   * interact, and neither result would be interpretable.
   */
  exclusionGroup: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields a caller supplies when creating an experiment. */
export interface ExperimentDraft {
  key: string;
  name: string;
  hypothesis?: string;
  institutionId: number | null;
  variants: (Omit<ExperimentVariant, "config"> & { config: Omit<VersionedPolicyConfig, "fingerprint"> })[];
  eligibility?: EligibilityRule;
  primaryMetric: PrimaryMetricKey;
  secondaryMetrics?: SecondaryMetricKey[];
  assignmentStrategy?: AssignmentStrategy;
  salt?: string;
  startAt: Date;
  endAt?: Date | null;
  exclusionGroup?: string | null;
}

/* ------------------------------------------------------------------ */
/* Assignment & exposure                                               */
/* ------------------------------------------------------------------ */

/**
 * The reason a learner is (or is not) in a variant. Recording this makes the
 * enrolment funnel auditable: "why is this cohort small?" is answerable from
 * data instead of by re-reading the rule.
 */
export type AssignmentOutcome =
  | "assigned"
  | "not-eligible"
  | "unallocated"
  | "experiment-not-running"
  | "outside-window"
  | "excluded-by-group"
  | "tenant-mismatch";

export interface AssignmentDecision {
  experimentId: number;
  experimentKey: string;
  studentId: number;
  outcome: AssignmentOutcome;
  /** Null unless `outcome === "assigned"`. */
  variantKey: string | null;
  /** Null unless assigned. The config in force for this learner. */
  config: VersionedPolicyConfig | null;
  /** The uniform draw in [0,1) that produced the bucket. Always recorded. */
  bucket: number;
  /** Human-readable justification, safe to log. */
  reason: string;
  /** True when the decision came from a persisted (sticky) assignment. */
  fromPersisted: boolean;
}

export interface ExperimentAssignment {
  id: number;
  experimentId: number;
  studentId: number;
  variantKey: string;
  /** Config fingerprint at the moment of assignment. */
  configFingerprint: string;
  bucket: number;
  /** Frozen eligibility snapshot — see `EligibilityRule` for why. */
  eligibilitySnapshot: LearnerEligibilitySnapshot;
  assignedAt: Date;
}

/**
 * A single moment where a learner actually *experienced* the variant. Exposure
 * is what licenses metric attribution: being assigned to an arm but never
 * served by it must not contribute outcome data, or the experiment measures
 * assignment rather than treatment.
 */
export interface ExperimentExposure {
  id: number;
  experimentId: number;
  studentId: number;
  variantKey: string;
  /** Config fingerprint actually in force when the item was served. */
  configFingerprint: string;
  /** Where the exposure happened, e.g. "assessment.next-item". */
  surface: string;
  /** Related domain row (assessment item id), for attribution joins. */
  entityId: number | null;
  occurredAt: Date;
}
