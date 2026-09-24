/**
 * Deterministic variant assignment.
 *
 * The whole framework rests on one property: **the same learner, in the same
 * experiment, always lands in the same variant** — in any process, on any node,
 * after any restart, and when a historical decision is replayed months later.
 *
 * That is achieved by making assignment a *pure function* of
 * `(experiment key, salt, learner id)` rather than anything stateful. No
 * counters, no `Math.random`, no wall clock, no database sequence. The database
 * records assignments, but it is a journal of what the function decided, not
 * the source of the decision.
 *
 * There is one deliberate exception, and it is the reason the journal exists:
 * if an operator edits allocations mid-flight, the pure function would re-bucket
 * learners who are already mid-treatment. A persisted `sticky` assignment
 * therefore overrides recomputation. Which rule applies is an explicit property
 * of the experiment (`assignmentStrategy`), never an implicit behaviour.
 */
import type {
  AssignmentDecision,
  EligibilityRule,
  Experiment,
  ExperimentAssignment,
  ExperimentVariant,
  LearnerEligibilitySnapshot,
} from "./types";

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

/**
 * FNV-1a over the assignment key, finalised with an integer avalanche mix.
 *
 * Why not just FNV-1a: its low bits are poorly distributed for short, highly
 * similar inputs, and every input here is short and highly similar
 * ("exp:salt:1", "exp:salt:2", …). Without the finaliser, consecutive learner
 * ids land in correlated buckets and a 50/50 split silently becomes a split by
 * signup order.
 *
 * The `>>> 0` coercions are load-bearing: JavaScript bitwise operators produce
 * *signed* int32, so omitting them makes half the hash space negative and every
 * bucket fall in [0, 0.5).
 */
export function assignmentHash(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h ^ input.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Avalanche (murmur3 finaliser) so neighbouring inputs decorrelate.
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

/** The exact string that gets hashed. Stable and inspectable by design. */
export function assignmentKey(experimentKey: string, salt: string, studentId: number): string {
  return `${experimentKey}:${salt}:${studentId}`;
}

/**
 * Uniform bucket in [0, 1) for a learner in an experiment.
 *
 * Exported because reproducibility must be checkable from outside: given an
 * experiment and a learner id, anyone can recompute the bucket and verify the
 * stored assignment without access to the assignment service.
 */
export function bucketFor(experimentKey: string, salt: string, studentId: number): number {
  return assignmentHash(assignmentKey(experimentKey, salt, studentId)) / 4_294_967_296;
}

/* ------------------------------------------------------------------ */
/* Allocation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Map a bucket to a variant using cumulative allocation over variants sorted by
 * key.
 *
 * Sorting by key (not by array order) is what makes allocation stable against
 * cosmetic edits: reordering the variants array in a config file must not
 * re-bucket live learners. Adding or removing a variant *will* re-bucket, which
 * is why `lifecycle.ts` forbids it while an experiment is running.
 *
 * Returns `null` when the bucket falls in the unallocated remainder — those
 * learners are not enrolled and contribute no data.
 */
export function variantForBucket(variants: ExperimentVariant[], bucket: number): ExperimentVariant | null {
  const ordered = [...variants].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let cumulative = 0;
  for (const variant of ordered) {
    cumulative += variant.allocationPct / 100;
    if (bucket < cumulative) return variant;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

export interface EligibilityResult {
  eligible: boolean;
  /** The first failing constraint, for funnel diagnostics. Null when eligible. */
  failedRule: string | null;
  reason: string;
}

/**
 * Evaluate an eligibility rule against a learner snapshot.
 *
 * Pure and synchronous: the caller is responsible for building the snapshot, so
 * eligibility can be unit-tested exhaustively and — critically — so the
 * snapshot can be *frozen* into the assignment record. Re-deriving eligibility
 * at analysis time would let learners silently leave the population as their
 * attempt counts grow, biasing results toward whoever still qualifies.
 */
export function evaluateEligibility(
  rule: EligibilityRule,
  learner: LearnerEligibilitySnapshot,
): EligibilityResult {
  const fail = (failedRule: string, reason: string): EligibilityResult => ({
    eligible: false,
    failedRule,
    reason,
  });

  // Default: experiments enrol students only. Staff accounts exercising the
  // product would otherwise pollute learning metrics.
  const roles = rule.roles ?? ["student"];
  if (!roles.includes(learner.role)) {
    return fail("roles", `role ${learner.role} is not in [${roles.join(", ")}]`);
  }

  if (rule.institutionIds?.length) {
    if (learner.institutionId === null || !rule.institutionIds.includes(learner.institutionId)) {
      return fail("institutionIds", `institution ${learner.institutionId ?? "none"} not in allow-list`);
    }
  }

  if (rule.gradeLevels?.length) {
    if (!learner.gradeLevel || !rule.gradeLevels.includes(learner.gradeLevel)) {
      return fail("gradeLevels", `grade ${learner.gradeLevel ?? "none"} not in allow-list`);
    }
  }

  if (rule.cohorts?.length) {
    if (!learner.cohort || !rule.cohorts.includes(learner.cohort)) {
      return fail("cohorts", `cohort ${learner.cohort ?? "none"} not in allow-list`);
    }
  }

  if (rule.minPriorAttempts !== undefined && learner.priorAttempts < rule.minPriorAttempts) {
    return fail("minPriorAttempts", `${learner.priorAttempts} prior attempts < ${rule.minPriorAttempts}`);
  }

  if (rule.maxPriorAttempts !== undefined && learner.priorAttempts > rule.maxPriorAttempts) {
    return fail("maxPriorAttempts", `${learner.priorAttempts} prior attempts > ${rule.maxPriorAttempts}`);
  }

  if (rule.createdAfter && learner.createdAt < rule.createdAfter) {
    return fail("createdAfter", `created ${learner.createdAt.toISOString()} before window opens`);
  }

  if (rule.createdBefore && learner.createdAt >= rule.createdBefore) {
    return fail("createdBefore", `created ${learner.createdAt.toISOString()} after window closes`);
  }

  if (rule.subjectIds?.length) {
    const overlap = learner.subjectIds.some((id) => rule.subjectIds!.includes(id));
    if (!overlap) return fail("subjectIds", "no mastery state in any required subject");
  }

  return { eligible: true, failedRule: null, reason: "meets all eligibility constraints" };
}

/* ------------------------------------------------------------------ */
/* Assignment                                                          */
/* ------------------------------------------------------------------ */

export interface AssignmentContext {
  experiment: Experiment;
  learner: LearnerEligibilitySnapshot;
  /** Evaluation instant. Passed explicitly — never read from the clock here. */
  now: Date;
  /** Existing persisted assignment for this (experiment, learner), if any. */
  existing?: ExperimentAssignment | null;
  /**
   * Experiment keys in the same exclusion group that this learner is already
   * enrolled in. Non-empty means this experiment must not enrol them.
   */
  conflictingEnrolments?: string[];
}

/**
 * Resolve which variant a learner should receive.
 *
 * Order of checks is deliberate. Tenant and window checks come *before* the
 * sticky short-circuit so that a paused or ended experiment stops serving
 * treatment even to learners who were previously assigned — otherwise "pause"
 * would not actually pause anything for the existing cohort, which is the one
 * case where you most need it to.
 */
export function resolveAssignment(ctx: AssignmentContext): AssignmentDecision {
  const { experiment, learner, now } = ctx;
  const bucket = bucketFor(experiment.key, experiment.salt, learner.studentId);

  const base = {
    experimentId: experiment.id,
    experimentKey: experiment.key,
    studentId: learner.studentId,
    bucket,
    fromPersisted: false,
  };

  // --- Tenant isolation -------------------------------------------------
  // A tenant-scoped experiment may only ever touch its own learners. This is
  // checked here as well as in the query layer: defence in depth, because a
  // single missed `WHERE institution_id = ?` would otherwise leak treatment
  // across customers.
  if (experiment.institutionId !== null && learner.institutionId !== experiment.institutionId) {
    return {
      ...base,
      outcome: "tenant-mismatch",
      variantKey: null,
      config: null,
      reason: `learner belongs to institution ${learner.institutionId ?? "none"}, experiment is scoped to ${experiment.institutionId}`,
    };
  }

  // --- Lifecycle --------------------------------------------------------
  if (experiment.status !== "running") {
    return {
      ...base,
      outcome: "experiment-not-running",
      variantKey: null,
      config: null,
      reason: `experiment status is ${experiment.status}`,
    };
  }

  if (now < experiment.startAt) {
    return {
      ...base,
      outcome: "outside-window",
      variantKey: null,
      config: null,
      reason: `now is before startAt (${experiment.startAt.toISOString()})`,
    };
  }
  if (experiment.endAt && now >= experiment.endAt) {
    return {
      ...base,
      outcome: "outside-window",
      variantKey: null,
      config: null,
      reason: `now is at or after endAt (${experiment.endAt.toISOString()})`,
    };
  }

  // --- Mutual exclusion -------------------------------------------------
  // Only blocks *new* enrolment. A learner already assigned here keeps their
  // arm; retroactively ejecting them would delete treatment history.
  if (
    experiment.exclusionGroup &&
    ctx.conflictingEnrolments?.length &&
    !ctx.existing
  ) {
    return {
      ...base,
      outcome: "excluded-by-group",
      variantKey: null,
      config: null,
      reason: `already enrolled in ${ctx.conflictingEnrolments.join(", ")} (exclusion group ${experiment.exclusionGroup})`,
    };
  }

  // --- Sticky assignment ------------------------------------------------
  // The persisted record wins, so reallocating traffic never moves a learner
  // who is mid-treatment. Only honoured if the variant still exists — if it was
  // deleted, fall through and re-resolve rather than serve a dangling arm.
  if (ctx.existing && experiment.assignmentStrategy === "sticky") {
    const variant = experiment.variants.find((v) => v.key === ctx.existing!.variantKey);
    if (variant) {
      return {
        ...base,
        outcome: "assigned",
        variantKey: variant.key,
        config: variant.config,
        bucket: ctx.existing.bucket,
        reason: "sticky assignment from persisted record",
        fromPersisted: true,
      };
    }
  }

  // --- Eligibility ------------------------------------------------------
  const eligibility = evaluateEligibility(experiment.eligibility, learner);
  if (!eligibility.eligible) {
    return {
      ...base,
      outcome: "not-eligible",
      variantKey: null,
      config: null,
      reason: eligibility.reason,
    };
  }

  // --- Bucket -> variant ------------------------------------------------
  const variant = variantForBucket(experiment.variants, bucket);
  if (!variant) {
    return {
      ...base,
      outcome: "unallocated",
      variantKey: null,
      config: null,
      reason: `bucket ${bucket.toFixed(6)} falls outside allocated traffic`,
    };
  }

  return {
    ...base,
    outcome: "assigned",
    variantKey: variant.key,
    config: variant.config,
    reason: `bucket ${bucket.toFixed(6)} → ${variant.key}`,
  };
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

/**
 * Observed allocation over a set of learner ids.
 *
 * Useful in tests and in an operator UI to confirm that a 50/50 split is
 * actually 50/50 on the real population, rather than trusting the hash. Small
 * populations legitimately deviate; this reports what happened without judging
 * it.
 */
export function allocationProfile(
  experiment: Pick<Experiment, "key" | "salt" | "variants">,
  studentIds: number[],
): { variantKey: string | null; count: number; share: number }[] {
  const counts = new Map<string | null, number>();
  for (const studentId of studentIds) {
    const bucket = bucketFor(experiment.key, experiment.salt, studentId);
    const variant = variantForBucket(experiment.variants, bucket);
    const key = variant?.key ?? null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = studentIds.length || 1;
  return [...counts.entries()]
    .map(([variantKey, count]) => ({ variantKey, count, share: count / total }))
    .sort((a, b) => (a.variantKey ?? "~").localeCompare(b.variantKey ?? "~"));
}
