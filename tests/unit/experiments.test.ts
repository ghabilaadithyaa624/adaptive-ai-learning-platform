/**
 * Experimentation framework — regression tests.
 *
 * These cover the six areas the framework's correctness rests on: stable
 * assignment, tenant isolation, eligibility, metric attribution, variant
 * exposure, and lifecycle.
 *
 * They are deliberately written against the *pure* layer rather than the
 * database, so they actually execute in CI (the DB suites skip without a
 * `TEST_DATABASE_URL`). Every rule that protects an experiment's validity —
 * determinism, stickiness, leakage prevention, tenant scoping — lives in pure
 * functions precisely so it can be tested this way.
 */
import { describe, expect, it } from "vitest";

import {
  allocationProfile,
  assignmentHash,
  assignmentKey,
  bucketFor,
  evaluateEligibility,
  resolveAssignment,
  variantForBucket,
} from "@/lib/experiments/assignment";
import { attributeMetrics, type AttributableItem, type AttributionSubject } from "@/lib/experiments/attribution";
import { buildReadout, formatReadout } from "@/lib/experiments/analysis";
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  effectiveStatus,
  fingerprintConfig,
  guardMutation,
  validateExperiment,
  withFingerprint,
} from "@/lib/experiments/lifecycle";
import { strategyForConfig, validateVariantConfig } from "@/lib/experiments/runtime";
import {
  METRIC_DEFINITIONS,
  POLICY_VARIANT_IDS,
  PRIMARY_METRIC_KEYS,
  SECONDARY_METRIC_KEYS,
  type Experiment,
  type ExperimentVariant,
  type LearnerEligibilitySnapshot,
} from "@/lib/experiments/types";
import { differenceInMeans, proportionSummary, summarise } from "@/lib/experiments/stats";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const variant = (
  key: string,
  allocationPct: number,
  policy: ExperimentVariant["config"]["policy"],
  isControl = false,
): ExperimentVariant => ({
  key,
  label: key,
  allocationPct,
  isControl,
  config: withFingerprint({ policy, version: "1.0.0" }),
});

function makeExperiment(over: Partial<Experiment> = {}): Experiment {
  return {
    id: 1,
    key: "policy-trial",
    name: "Policy trial",
    hypothesis: "v3 beats the mastery-gap baseline on mastery gain",
    institutionId: 7,
    status: "running",
    variants: [variant("control", 50, "mastery-gap-baseline", true), variant("treatment", 50, "adaptive-v3")],
    eligibility: {},
    primaryMetric: "masteryGain",
    secondaryMetrics: ["zpdHitRate"],
    assignmentStrategy: "sticky",
    salt: "salt-policy-trial",
    startAt: new Date("2026-01-01T00:00:00Z"),
    endAt: new Date("2026-06-01T00:00:00Z"),
    exclusionGroup: null,
    createdAt: new Date("2025-12-01T00:00:00Z"),
    updatedAt: new Date("2025-12-01T00:00:00Z"),
    ...over,
  };
}

function learner(over: Partial<LearnerEligibilitySnapshot> = {}): LearnerEligibilitySnapshot {
  return {
    studentId: 1,
    institutionId: 7,
    role: "student",
    gradeLevel: "9",
    cohort: "autumn",
    priorAttempts: 25,
    createdAt: new Date("2025-06-01T00:00:00Z"),
    subjectIds: [1, 2],
    ...over,
  };
}

const NOW = new Date("2026-02-01T00:00:00Z");

/* ------------------------------------------------------------------ */
/* 1. Stable assignment                                                */
/* ------------------------------------------------------------------ */

describe("experiments — stable assignment", () => {
  it("returns the same variant for the same learner every time", () => {
    const experiment = makeExperiment();
    const first = resolveAssignment({ experiment, learner: learner(), now: NOW });
    for (let i = 0; i < 50; i += 1) {
      const again = resolveAssignment({ experiment, learner: learner(), now: NOW });
      expect(again.variantKey).toBe(first.variantKey);
      expect(again.bucket).toBe(first.bucket);
    }
  });

  it("is a pure function of (key, salt, studentId)", () => {
    expect(bucketFor("exp", "salt", 42)).toBe(bucketFor("exp", "salt", 42));
    expect(assignmentKey("exp", "salt", 42)).toBe("exp:salt:42");
    // Different learner, different experiment, and different salt all diverge.
    expect(bucketFor("exp", "salt", 42)).not.toBe(bucketFor("exp", "salt", 43));
    expect(bucketFor("exp", "salt", 42)).not.toBe(bucketFor("other", "salt", 42));
    expect(bucketFor("exp", "salt", 42)).not.toBe(bucketFor("exp", "pepper", 42));
  });

  it("produces buckets in [0,1) — the signed-int32 trap", () => {
    // Omitting `>>> 0` after a shift makes every bucket land in [0, 0.5) and
    // silently breaks any split other than the first variant.
    const buckets: number[] = [];
    for (let id = 1; id <= 4000; id += 1) buckets.push(bucketFor("exp", "salt", id));
    expect(Math.min(...buckets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...buckets)).toBeLessThan(1);
    const mean = buckets.reduce((a, b) => a + b, 0) / buckets.length;
    expect(mean).toBeGreaterThan(0.47);
    expect(mean).toBeLessThan(0.53);
  });

  it("decorrelates consecutive learner ids", () => {
    // Without the avalanche finaliser, sequential ids land in correlated
    // buckets and a 50/50 split becomes a split by signup order.
    const experiment = makeExperiment();
    const seq = Array.from({ length: 200 }, (_, i) => i + 1);
    const profile = allocationProfile(experiment, seq);
    for (const row of profile) {
      expect(row.share).toBeGreaterThan(0.35);
      expect(row.share).toBeLessThan(0.65);
    }
  });

  it("honours a persisted assignment even when allocations change", () => {
    // The scenario stickiness exists for: an operator re-weights traffic
    // mid-flight. A learner already in treatment must not be moved.
    const before = makeExperiment();
    const original = resolveAssignment({ experiment: before, learner: learner({ studentId: 99 }), now: NOW });
    expect(original.outcome).toBe("assigned");

    const after = makeExperiment({
      variants: [variant("control", 95, "mastery-gap-baseline", true), variant("treatment", 5, "adaptive-v3")],
    });
    const sticky = resolveAssignment({
      experiment: after,
      learner: learner({ studentId: 99 }),
      now: NOW,
      existing: {
        id: 1,
        experimentId: 1,
        studentId: 99,
        variantKey: original.variantKey!,
        configFingerprint: original.config!.fingerprint,
        bucket: original.bucket,
        eligibilitySnapshot: learner({ studentId: 99 }),
        assignedAt: NOW,
      },
    });
    expect(sticky.variantKey).toBe(original.variantKey);
    expect(sticky.fromPersisted).toBe(true);
  });

  it("recomputes every time when explicitly configured as rolling", () => {
    // "unless explicitly configured otherwise" — the opt-out must actually work.
    const experiment = makeExperiment({
      assignmentStrategy: "rolling",
      variants: [variant("control", 100, "mastery-gap-baseline", true), variant("treatment", 0, "adaptive-v3")],
    });
    const decision = resolveAssignment({
      experiment,
      learner: learner({ studentId: 99 }),
      now: NOW,
      existing: {
        id: 1,
        experimentId: 1,
        studentId: 99,
        variantKey: "treatment",
        configFingerprint: "x",
        bucket: 0.99,
        eligibilitySnapshot: learner({ studentId: 99 }),
        assignedAt: NOW,
      },
    });
    // Allocation is now 100% control, so a rolling experiment moves them.
    expect(decision.variantKey).toBe("control");
    expect(decision.fromPersisted).toBe(false);
  });

  it("does not honour a persisted assignment to a deleted variant", () => {
    const experiment = makeExperiment();
    const decision = resolveAssignment({
      experiment,
      learner: learner(),
      now: NOW,
      existing: {
        id: 1,
        experimentId: 1,
        studentId: 1,
        variantKey: "removed-arm",
        configFingerprint: "x",
        bucket: 0.5,
        eligibilitySnapshot: learner(),
        assignedAt: NOW,
      },
    });
    expect(decision.variantKey).not.toBe("removed-arm");
  });

  it("keeps allocation stable when variants are merely reordered", () => {
    // Bucketing sorts by key, so a cosmetic edit to config-file ordering must
    // not re-bucket live learners.
    const a = makeExperiment();
    const b = makeExperiment({ variants: [...makeExperiment().variants].reverse() });
    for (let id = 1; id <= 100; id += 1) {
      const left = resolveAssignment({ experiment: a, learner: learner({ studentId: id }), now: NOW });
      const right = resolveAssignment({ experiment: b, learner: learner({ studentId: id }), now: NOW });
      expect(right.variantKey).toBe(left.variantKey);
    }
  });

  it("leaves learners unallocated when allocation sums below 100%", () => {
    const experiment = makeExperiment({
      variants: [variant("control", 10, "mastery-gap-baseline", true), variant("treatment", 10, "adaptive-v3")],
    });
    const outcomes = Array.from({ length: 200 }, (_, i) =>
      resolveAssignment({ experiment, learner: learner({ studentId: i + 1 }), now: NOW }).outcome,
    );
    expect(outcomes).toContain("unallocated");
    expect(outcomes).toContain("assigned");
  });

  it("maps buckets to variants by cumulative allocation", () => {
    const variants = [variant("a", 30, "legacy", true), variant("b", 70, "adaptive-v3")];
    expect(variantForBucket(variants, 0.0)?.key).toBe("a");
    expect(variantForBucket(variants, 0.29)?.key).toBe("a");
    expect(variantForBucket(variants, 0.31)?.key).toBe("b");
    expect(variantForBucket(variants, 0.99)?.key).toBe("b");
    expect(variantForBucket([variant("a", 50, "legacy", true)], 0.75)).toBeNull();
  });

  it("hashes deterministically across calls", () => {
    expect(assignmentHash("stable-input")).toBe(assignmentHash("stable-input"));
    expect(assignmentHash("a")).not.toBe(assignmentHash("b"));
  });
});

/* ------------------------------------------------------------------ */
/* 2. Tenant isolation                                                 */
/* ------------------------------------------------------------------ */

describe("experiments — tenant isolation", () => {
  it("refuses to assign a learner from another institution", () => {
    const experiment = makeExperiment({ institutionId: 7 });
    const decision = resolveAssignment({ experiment, learner: learner({ institutionId: 8 }), now: NOW });
    expect(decision.outcome).toBe("tenant-mismatch");
    expect(decision.variantKey).toBeNull();
    expect(decision.config).toBeNull();
  });

  it("refuses learners with no institution when the experiment is tenant-scoped", () => {
    const experiment = makeExperiment({ institutionId: 7 });
    const decision = resolveAssignment({ experiment, learner: learner({ institutionId: null }), now: NOW });
    expect(decision.outcome).toBe("tenant-mismatch");
  });

  it("allows any institution into a platform-wide experiment", () => {
    const experiment = makeExperiment({ institutionId: null });
    for (const institutionId of [1, 2, null]) {
      const decision = resolveAssignment({ experiment, learner: learner({ institutionId }), now: NOW });
      expect(decision.outcome).toBe("assigned");
    }
  });

  it("checks tenancy before stickiness, so a stale assignment cannot leak", () => {
    // If a learner is moved to another institution, the persisted assignment
    // must stop applying rather than keep serving another tenant's treatment.
    const experiment = makeExperiment({ institutionId: 7 });
    const decision = resolveAssignment({
      experiment,
      learner: learner({ institutionId: 8 }),
      now: NOW,
      existing: {
        id: 1,
        experimentId: 1,
        studentId: 1,
        variantKey: "treatment",
        configFingerprint: "x",
        bucket: 0.9,
        eligibilitySnapshot: learner(),
        assignedAt: NOW,
      },
    });
    expect(decision.outcome).toBe("tenant-mismatch");
  });

  it("drops cross-tenant observations during attribution", () => {
    const experiment = makeExperiment({ institutionId: 7 });
    const subjects: AttributionSubject[] = [
      { studentId: 1, institutionId: 7, variantKey: "control", firstExposureAt: new Date("2026-01-05") },
    ];
    const result = attributeMetrics({
      experiment,
      subjects,
      items: [
        makeItem({ studentId: 1, institutionId: 7, answeredAt: new Date("2026-01-06") }),
        // Same learner id, different institution — must not be counted.
        makeItem({ studentId: 1, institutionId: 99, answeredAt: new Date("2026-01-06") }),
      ],
      now: NOW,
    });
    expect(result.diagnostics.crossTenant).toBe(1);
    expect(result.diagnostics.attributed).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Eligibility                                                      */
/* ------------------------------------------------------------------ */

describe("experiments — eligibility", () => {
  it("admits a learner meeting every constraint", () => {
    const result = evaluateEligibility(
      { gradeLevels: ["9"], cohorts: ["autumn"], minPriorAttempts: 10, subjectIds: [1] },
      learner(),
    );
    expect(result.eligible).toBe(true);
    expect(result.failedRule).toBeNull();
  });

  it("defaults to students only", () => {
    expect(evaluateEligibility({}, learner({ role: "teacher" })).eligible).toBe(false);
    expect(evaluateEligibility({}, learner({ role: "student" })).eligible).toBe(true);
  });

  it("reports which rule failed, for funnel diagnostics", () => {
    const cases: [Parameters<typeof evaluateEligibility>[0], Partial<LearnerEligibilitySnapshot>, string][] = [
      [{ roles: ["student"] }, { role: "admin" }, "roles"],
      [{ institutionIds: [1] }, { institutionId: 2 }, "institutionIds"],
      [{ gradeLevels: ["10"] }, { gradeLevel: "9" }, "gradeLevels"],
      [{ cohorts: ["spring"] }, { cohort: "autumn" }, "cohorts"],
      [{ minPriorAttempts: 50 }, { priorAttempts: 10 }, "minPriorAttempts"],
      [{ maxPriorAttempts: 5 }, { priorAttempts: 10 }, "maxPriorAttempts"],
      [{ createdAfter: new Date("2026-01-01") }, { createdAt: new Date("2025-01-01") }, "createdAfter"],
      [{ createdBefore: new Date("2025-01-01") }, { createdAt: new Date("2025-06-01") }, "createdBefore"],
      [{ subjectIds: [99] }, { subjectIds: [1] }, "subjectIds"],
    ];
    for (const [rule, over, expected] of cases) {
      const result = evaluateEligibility(rule, learner(over));
      expect(result.eligible, `${expected} should reject`).toBe(false);
      expect(result.failedRule).toBe(expected);
    }
  });

  it("treats an empty rule as no constraint beyond the role default", () => {
    expect(evaluateEligibility({}, learner({ gradeLevel: null, cohort: null })).eligible).toBe(true);
  });

  it("blocks ineligible learners from assignment entirely", () => {
    const experiment = makeExperiment({ eligibility: { minPriorAttempts: 100 } });
    const decision = resolveAssignment({ experiment, learner: learner({ priorAttempts: 3 }), now: NOW });
    expect(decision.outcome).toBe("not-eligible");
    expect(decision.config).toBeNull();
  });

  it("keeps an already-assigned learner even if they would no longer qualify", () => {
    // Eligibility is evaluated once and frozen. Re-checking it would let
    // learners fall out of the population as their attempt counts grow, which
    // biases the readout toward whoever still qualifies at analysis time.
    const experiment = makeExperiment({ eligibility: { maxPriorAttempts: 10 } });
    const decision = resolveAssignment({
      experiment,
      learner: learner({ priorAttempts: 500 }),
      now: NOW,
      existing: {
        id: 1,
        experimentId: 1,
        studentId: 1,
        variantKey: "treatment",
        configFingerprint: "x",
        bucket: 0.9,
        eligibilitySnapshot: learner({ priorAttempts: 4 }),
        assignedAt: NOW,
      },
    });
    expect(decision.outcome).toBe("assigned");
    expect(decision.variantKey).toBe("treatment");
  });

  it("does not enrol a learner already in a mutually exclusive experiment", () => {
    const experiment = makeExperiment({ exclusionGroup: "item-selection" });
    const decision = resolveAssignment({
      experiment,
      learner: learner(),
      now: NOW,
      conflictingEnrolments: ["other-selection-test"],
    });
    expect(decision.outcome).toBe("excluded-by-group");
  });

  it("does not eject a learner already enrolled here from their exclusion group", () => {
    const experiment = makeExperiment({ exclusionGroup: "item-selection" });
    const decision = resolveAssignment({
      experiment,
      learner: learner(),
      now: NOW,
      conflictingEnrolments: ["other-selection-test"],
      existing: {
        id: 1,
        experimentId: 1,
        studentId: 1,
        variantKey: "control",
        configFingerprint: "x",
        bucket: 0.1,
        eligibilitySnapshot: learner(),
        assignedAt: NOW,
      },
    });
    expect(decision.outcome).toBe("assigned");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Metric attribution                                               */
/* ------------------------------------------------------------------ */

function makeItem(over: Partial<AttributableItem> = {}): AttributableItem {
  return {
    studentId: 1,
    institutionId: 7,
    assessmentId: 1,
    skillId: 1,
    exposedVariantKey: null,
    answeredAt: new Date("2026-01-10T00:00:00Z"),
    isCorrect: true,
    responseTimeMs: 60_000,
    predictedCorrectProb: 0.7,
    masteryBefore: 0.4,
    masteryAfter: 0.5,
    ...over,
  };
}

describe("experiments — metric attribution", () => {
  const subjects: AttributionSubject[] = [
    { studentId: 1, institutionId: 7, variantKey: "control", firstExposureAt: new Date("2026-01-05") },
    { studentId: 2, institutionId: 7, variantKey: "treatment", firstExposureAt: new Date("2026-01-05") },
  ];

  it("R1: excludes observations from before first exposure", () => {
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [
        makeItem({ studentId: 1, answeredAt: new Date("2026-01-01") }), // pre-exposure
        makeItem({ studentId: 1, answeredAt: new Date("2026-01-10") }),
      ],
      now: NOW,
    });
    expect(result.diagnostics.beforeExposure).toBe(1);
    // Only the post-exposure item contributes to mastery gain.
    expect(result.series.masteryGain.byVariant.control[0].value).toBeCloseTo(0.1, 6);
  });

  it("R2: drops observations whose serving variant contradicts the assignment", () => {
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [
        makeItem({ studentId: 1, exposedVariantKey: "control" }),
        makeItem({ studentId: 1, exposedVariantKey: "treatment" }), // contradiction
      ],
      now: NOW,
    });
    expect(result.diagnostics.conflicts).toBe(1);
    expect(result.diagnostics.attributed).toBe(1);
  });

  it("R3: excludes observations after the experiment window closes", () => {
    const result = attributeMetrics({
      experiment: makeExperiment({ endAt: new Date("2026-01-15") }),
      subjects,
      items: [
        makeItem({ studentId: 1, answeredAt: new Date("2026-01-10") }),
        makeItem({ studentId: 1, answeredAt: new Date("2026-02-10") }),
      ],
      now: NOW,
    });
    expect(result.diagnostics.afterWindow).toBe(1);
  });

  it("excludes observations from learners with no assignment", () => {
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [makeItem({ studentId: 404 })],
      now: NOW,
    });
    expect(result.diagnostics.unassigned).toBe(1);
    expect(result.diagnostics.attributed).toBe(0);
  });

  it("never mixes one learner's data into another variant", () => {
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [
        makeItem({ studentId: 1, masteryBefore: 0.1, masteryAfter: 0.2 }),
        makeItem({ studentId: 2, masteryBefore: 0.1, masteryAfter: 0.9 }),
      ],
      now: NOW,
    });
    const control = result.series.masteryGain.byVariant.control;
    const treatment = result.series.masteryGain.byVariant.treatment;
    expect(control).toHaveLength(1);
    expect(treatment).toHaveLength(1);
    expect(control[0].studentId).toBe(1);
    expect(treatment[0].studentId).toBe(2);
    expect(control[0].value).toBeCloseTo(0.1, 6);
    expect(treatment[0].value).toBeCloseTo(0.8, 6);
  });

  it("R5: censors rather than zero-fills learners with no qualifying observation", () => {
    // Scoring an unobserved learner as 0 would drag every rate metric down and
    // make an arm that simply had fewer completers look worse at learning.
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [makeItem({ studentId: 1 })],
      now: NOW,
    });
    expect(result.series.masteryGain.byVariant.treatment).toHaveLength(0);
    expect(result.series.masteryGain.censoredByVariant.treatment).toBe(1);
  });

  it("computes one value per learner, not per item", () => {
    // The learner is the unit of randomisation, so it must be the unit of
    // analysis; averaging over items would understate the variance.
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [makeItem({ studentId: 1 }), makeItem({ studentId: 1 }), makeItem({ studentId: 1 })],
      now: NOW,
    });
    expect(result.series.masteryGain.byVariant.control).toHaveLength(1);
    expect(result.series.masteryGain.byVariant.control[0].value).toBeCloseTo(0.3, 6);
  });

  it("censors time- and questions-to-mastery when the threshold is never crossed", () => {
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [makeItem({ studentId: 1, masteryBefore: 0.1, masteryAfter: 0.2 })],
      now: NOW,
    });
    expect(result.series.timeToMastery.byVariant.control).toHaveLength(0);
    expect(result.series.timeToMastery.censoredByVariant.control).toBe(1);
    expect(result.series.questionsToMastery.censoredByVariant.control).toBe(1);
  });

  it("records time- and questions-to-mastery at the crossing item", () => {
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [
        makeItem({ studentId: 1, answeredAt: new Date("2026-01-06"), masteryBefore: 0.5, masteryAfter: 0.6, responseTimeMs: 60_000 }),
        makeItem({ studentId: 1, answeredAt: new Date("2026-01-07"), masteryBefore: 0.6, masteryAfter: 0.9, responseTimeMs: 120_000 }),
        // Anything after the crossing must not inflate the count.
        makeItem({ studentId: 1, answeredAt: new Date("2026-01-08"), masteryBefore: 0.9, masteryAfter: 0.95, responseTimeMs: 600_000 }),
      ],
      masteryThreshold: 0.85,
      now: NOW,
    });
    expect(result.series.questionsToMastery.byVariant.control[0].value).toBe(2);
    expect(result.series.timeToMastery.byVariant.control[0].value).toBeCloseTo(3, 6);
  });

  it("computes ZPD hit rate, information and calibration over served items", () => {
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [
        makeItem({ studentId: 1, predictedCorrectProb: 0.7, isCorrect: true }), // in band
        makeItem({ studentId: 1, predictedCorrectProb: 0.2, isCorrect: false }), // out of band
      ],
      now: NOW,
    });
    expect(result.series.zpdHitRate.byVariant.control[0].value).toBeCloseTo(0.5, 6);
    // 4·0.7·0.3 = 0.84 ; 4·0.2·0.8 = 0.64 ; mean 0.74
    expect(result.series.informationGain.byVariant.control[0].value).toBeCloseTo(0.74, 6);
    // |0.7−1| = 0.3 ; |0.2−0| = 0.2 ; mean 0.25
    expect(result.series.calibration.byVariant.control[0].value).toBeCloseTo(0.25, 6);
  });

  it("measures retention only on genuinely delayed re-encounters", () => {
    const result = attributeMetrics({
      experiment: makeExperiment({ endAt: null }),
      subjects,
      items: [
        makeItem({ studentId: 1, skillId: 1, answeredAt: new Date("2026-01-06"), masteryAfter: 0.8 }),
        // Same day — not a retention probe.
        makeItem({ studentId: 1, skillId: 1, answeredAt: new Date("2026-01-06T12:00:00Z"), masteryAfter: 0.8 }),
        // 20 days later — a probe.
        makeItem({ studentId: 1, skillId: 1, answeredAt: new Date("2026-01-26"), isCorrect: false, masteryAfter: 0.7 }),
      ],
      retentionDelayDays: 7,
      now: NOW,
    });
    expect(result.series.retention.byVariant.control[0].value).toBe(0);
  });

  it("computes completion and acceptance as per-learner rates", () => {
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects,
      items: [makeItem({ studentId: 1 })],
      assessments: [
        { studentId: 1, institutionId: 7, assessmentId: 1, startedAt: new Date("2026-01-06"), status: "completed" },
        { studentId: 1, institutionId: 7, assessmentId: 2, startedAt: new Date("2026-01-07"), status: "abandoned" },
      ],
      recommendations: [
        { studentId: 1, institutionId: 7, createdAt: new Date("2026-01-06"), status: "accepted" },
        { studentId: 1, institutionId: 7, createdAt: new Date("2026-01-07"), status: "dismissed" },
      ],
      now: NOW,
    });
    expect(result.series.completion.byVariant.control[0].value).toBeCloseTo(0.5, 6);
    expect(result.series.recommendationAcceptance.byVariant.control[0].value).toBeCloseTo(0.5, 6);
  });

  it("defines every declared metric", () => {
    for (const key of [...PRIMARY_METRIC_KEYS, ...SECONDARY_METRIC_KEYS]) {
      expect(METRIC_DEFINITIONS[key], `missing definition for ${key}`).toBeDefined();
      expect(METRIC_DEFINITIONS[key].definition.length).toBeGreaterThan(20);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. Variant exposure                                                 */
/* ------------------------------------------------------------------ */

describe("experiments — variant exposure", () => {
  it("attributes nothing for an assigned learner who was never exposed", () => {
    // Assignment is not treatment. A learner enrolled but never served must
    // contribute no outcome data, or the experiment measures enrolment.
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects: [], // no exposures => no subjects
      items: [makeItem({ studentId: 1 })],
      now: NOW,
    });
    expect(result.diagnostics.attributed).toBe(0);
    expect(result.diagnostics.unassigned).toBe(1);
  });

  it("starts the attribution clock at first exposure, not at assignment", () => {
    const early: AttributionSubject[] = [
      { studentId: 1, institutionId: 7, variantKey: "control", firstExposureAt: new Date("2026-01-20") },
    ];
    const result = attributeMetrics({
      experiment: makeExperiment(),
      subjects: early,
      items: [
        makeItem({ studentId: 1, answeredAt: new Date("2026-01-10") }),
        makeItem({ studentId: 1, answeredAt: new Date("2026-01-25") }),
      ],
      now: NOW,
    });
    expect(result.diagnostics.beforeExposure).toBe(1);
    expect(result.diagnostics.attributed).toBe(1);
  });

  it("reports exposure counts per variant in the readout", () => {
    const experiment = makeExperiment();
    const attribution = attributeMetrics({
      experiment,
      subjects: [
        { studentId: 1, institutionId: 7, variantKey: "control", firstExposureAt: new Date("2026-01-05") },
        { studentId: 2, institutionId: 7, variantKey: "treatment", firstExposureAt: new Date("2026-01-05") },
      ],
      items: [makeItem({ studentId: 1 }), makeItem({ studentId: 2 })],
      now: NOW,
    });
    const readout = buildReadout({
      experiment,
      attribution,
      exposureByVariant: { control: 1, treatment: 1 },
      generatedAt: NOW,
    });
    expect(readout.exposureByVariant).toEqual({ control: 1, treatment: 1 });
  });

  it("maps every policy variant to a distinct serving strategy", () => {
    const seen = new Set<string>();
    for (const policy of POLICY_VARIANT_IDS) {
      const strategy = strategyForConfig(withFingerprint({ policy, version: "1.0.0" }));
      expect(strategy, `no strategy for ${policy}`).toBeDefined();
      seen.add(strategy.id);
    }
    expect(seen.size).toBe(POLICY_VARIANT_IDS.length);
  });

  it("warns when overrides are supplied to a policy that ignores them", () => {
    const warnings = validateVariantConfig(
      withFingerprint({ policy: "random-baseline", version: "1.0.0", params: { prereqGate: 0.5 } }),
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/ignores weight\/param overrides/);
  });

  it("fingerprints configurations so a mid-run edit is visible in the data", () => {
    const a = fingerprintConfig({ policy: "adaptive-v3", version: "1.0.0", weights: { zpdTargeting: 0.2 } });
    const b = fingerprintConfig({ policy: "adaptive-v3", version: "1.0.0", weights: { zpdTargeting: 0.3 } });
    expect(a).not.toBe(b);
    // Key order and float formatting must not change the fingerprint.
    const c = fingerprintConfig({
      policy: "adaptive-v3",
      version: "1.0.0",
      weights: { zpdTargeting: 0.2000000 },
    });
    expect(c).toBe(a);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Lifecycle                                                        */
/* ------------------------------------------------------------------ */

describe("experiments — lifecycle", () => {
  it("permits only the documented transitions", () => {
    expect(canTransition("draft", "running")).toBe(true);
    expect(canTransition("running", "paused")).toBe(true);
    expect(canTransition("paused", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("completed", "archived")).toBe(true);
    // Terminal states stay terminal — restarting would append a second,
    // differently-conditioned population to the same readout.
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("archived", "draft")).toBe(false);
    expect(ALLOWED_TRANSITIONS.archived).toEqual([]);
  });

  it("throws with an actionable message on an illegal transition", () => {
    expect(() => assertTransition("completed", "running")).toThrow(/illegal experiment transition/);
  });

  it("serves no variant unless the experiment is running", () => {
    for (const status of ["draft", "scheduled", "paused", "completed", "archived"] as const) {
      const decision = resolveAssignment({
        experiment: makeExperiment({ status }),
        learner: learner(),
        now: NOW,
      });
      expect(decision.outcome, `status ${status} must not serve`).toBe("experiment-not-running");
    }
  });

  it("stops serving a previously-assigned learner once paused", () => {
    // Otherwise "pause" would not pause anything for the existing cohort — the
    // one case where you most need it to.
    const decision = resolveAssignment({
      experiment: makeExperiment({ status: "paused" }),
      learner: learner(),
      now: NOW,
      existing: {
        id: 1,
        experimentId: 1,
        studentId: 1,
        variantKey: "treatment",
        configFingerprint: "x",
        bucket: 0.9,
        eligibilitySnapshot: learner(),
        assignedAt: NOW,
      },
    });
    expect(decision.outcome).toBe("experiment-not-running");
  });

  it("respects the scheduled window", () => {
    const experiment = makeExperiment();
    expect(
      resolveAssignment({ experiment, learner: learner(), now: new Date("2025-12-01") }).outcome,
    ).toBe("outside-window");
    expect(
      resolveAssignment({ experiment, learner: learner(), now: new Date("2026-07-01") }).outcome,
    ).toBe("outside-window");
    expect(resolveAssignment({ experiment, learner: learner(), now: NOW }).outcome).toBe("assigned");
  });

  it("derives effective status when the scheduler has not caught up", () => {
    const scheduled = makeExperiment({ status: "scheduled" });
    expect(effectiveStatus(scheduled, new Date("2025-12-01"))).toBe("scheduled");
    expect(effectiveStatus(scheduled, NOW)).toBe("running");
    expect(effectiveStatus(scheduled, new Date("2026-07-01"))).toBe("completed");
    const running = makeExperiment({ status: "running" });
    expect(effectiveStatus(running, new Date("2026-07-01"))).toBe("completed");
  });

  it("freezes assignment-affecting fields while running", () => {
    const issues = guardMutation({ status: "running" }, { variants: [], salt: "new", eligibility: {} });
    expect(issues.map((i) => i.field).sort()).toEqual(["eligibility", "salt", "variants"]);
    for (const issue of issues) expect(issue.message).toMatch(/re-bucket/);
  });

  it("allows harmless edits while running", () => {
    expect(guardMutation({ status: "running" }, { name: "x", endAt: new Date(), secondaryMetrics: [] })).toEqual([]);
  });

  it("allows anything while in draft", () => {
    expect(guardMutation({ status: "draft" }, { variants: [], salt: "new" })).toEqual([]);
  });

  it("validates a well-formed experiment", () => {
    expect(validateExperiment(makeExperiment())).toEqual([]);
  });

  it("rejects malformed definitions with every problem at once", () => {
    const issues = validateExperiment(
      makeExperiment({
        key: "X!",
        salt: "s",
        variants: [variant("only", 150, "adaptive-v3", false)],
        primaryMetric: "zpdHitRate" as never,
        endAt: new Date("2020-01-01"),
      }),
    );
    const fields = issues.map((i) => i.field);
    expect(fields).toContain("key");
    expect(fields).toContain("salt");
    expect(fields).toContain("variants");
    expect(fields).toContain("primaryMetric");
    expect(fields).toContain("endAt");
  });

  it("requires exactly one control", () => {
    const none = validateExperiment(
      makeExperiment({ variants: [variant("a", 50, "legacy"), variant("b", 50, "adaptive-v3")] }),
    );
    expect(none.some((i) => i.message.includes("exactly one variant must be the control"))).toBe(true);

    const two = validateExperiment(
      makeExperiment({ variants: [variant("a", 50, "legacy", true), variant("b", 50, "adaptive-v3", true)] }),
    );
    expect(two.some((i) => i.message.includes("exactly one variant must be the control"))).toBe(true);
  });

  it("rejects allocations summing above 100%", () => {
    const issues = validateExperiment(
      makeExperiment({ variants: [variant("a", 60, "legacy", true), variant("b", 60, "adaptive-v3")] }),
    );
    expect(issues.some((i) => i.message.includes("exceeds 100%"))).toBe(true);
  });

  it("rejects a stale config fingerprint", () => {
    const stale = makeExperiment();
    stale.variants[0].config.fingerprint = "tampered";
    const issues = validateExperiment(stale);
    expect(issues.some((i) => i.message.includes("stale fingerprint"))).toBe(true);
  });

  it("only permits learning outcomes as the primary metric", () => {
    // Engagement and prediction quality are deliberately secondary: the
    // platform's objective is learning, and a framework that lets engagement be
    // primary invites optimising the wrong thing.
    for (const key of SECONDARY_METRIC_KEYS) {
      const issues = validateExperiment(makeExperiment({ primaryMetric: key as never }));
      expect(issues.some((i) => i.field === "primaryMetric"), `${key} must be rejected`).toBe(true);
    }
    for (const key of PRIMARY_METRIC_KEYS) {
      expect(validateExperiment(makeExperiment({ primaryMetric: key }))).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Neutral reporting                                                   */
/* ------------------------------------------------------------------ */

describe("experiments — neutral statistical reporting", () => {
  const experiment = makeExperiment();

  function readoutWith(controlValues: number[], treatmentValues: number[]) {
    const subjects: AttributionSubject[] = [
      ...controlValues.map((_, i) => ({
        studentId: 1000 + i,
        institutionId: 7,
        variantKey: "control",
        firstExposureAt: new Date("2026-01-05"),
      })),
      ...treatmentValues.map((_, i) => ({
        studentId: 2000 + i,
        institutionId: 7,
        variantKey: "treatment",
        firstExposureAt: new Date("2026-01-05"),
      })),
    ];
    const items = [
      ...controlValues.map((v, i) =>
        makeItem({ studentId: 1000 + i, masteryBefore: 0, masteryAfter: v }),
      ),
      ...treatmentValues.map((v, i) =>
        makeItem({ studentId: 2000 + i, masteryBefore: 0, masteryAfter: v }),
      ),
    ];
    const attribution = attributeMetrics({ experiment, subjects, items, now: NOW });
    return buildReadout({
      experiment,
      attribution,
      exposureByVariant: { control: controlValues.length, treatment: treatmentValues.length },
      generatedAt: NOW,
    });
  }

  it("never declares a winner, even for an overwhelming effect", () => {
    const readout = readoutWith(
      Array.from({ length: 40 }, () => 0.01),
      Array.from({ length: 40 }, () => 0.99),
    );
    const serialised = JSON.stringify(readout);
    for (const forbidden of ["winner", "recommendation", "significant", "pValue", "verdict"]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("reports an interval on every comparison", () => {
    const readout = readoutWith(
      Array.from({ length: 30 }, (_, i) => 0.3 + i * 0.001),
      Array.from({ length: 30 }, (_, i) => 0.5 + i * 0.001),
    );
    const comparison = readout.primary!.comparisons[0];
    expect(comparison.difference).not.toBeNull();
    expect(comparison.difference!.interval.lower).toBeLessThan(comparison.difference!.interval.upper);
    expect(comparison.bootstrapInterval).not.toBeNull();
    expect(comparison.resolution).toBeGreaterThan(0);
  });

  it("states the smallest difference the sample could resolve", () => {
    // The antidote to reading a null result as proof of equivalence.
    const readout = readoutWith([0.1, 0.9], [0.2, 0.8]);
    expect(readout.primary!.comparisons[0].resolution).toBeGreaterThan(0);
    expect(
      readout.interpretationNotes.some((n) => n.includes("smallest difference")),
    ).toBe(true);
  });

  it("always carries interpretation caveats with the numbers", () => {
    const readout = readoutWith([0.4, 0.5, 0.6], [0.5, 0.6, 0.7]);
    expect(readout.interpretationNotes.length).toBeGreaterThanOrEqual(3);
    expect(readout.interpretationNotes.some((n) => n.includes("does not declare a winning variant"))).toBe(true);
    expect(readout.interpretationNotes.some((n) => n.includes("multiple metrics"))).toBe(true);
  });

  it("escalates attribution conflicts into the notes", () => {
    const attribution = attributeMetrics({
      experiment,
      subjects: [
        { studentId: 1, institutionId: 7, variantKey: "control", firstExposureAt: new Date("2026-01-05") },
      ],
      items: [makeItem({ studentId: 1, exposedVariantKey: "treatment" })],
      now: NOW,
    });
    const readout = buildReadout({
      experiment,
      attribution,
      exposureByVariant: { control: 1 },
      generatedAt: NOW,
    });
    expect(readout.interpretationNotes.some((n) => n.includes("re-bucketing"))).toBe(true);
  });

  it("warns when a metric is mostly censored", () => {
    const subjects: AttributionSubject[] = Array.from({ length: 10 }, (_, i) => ({
      studentId: i + 1,
      institutionId: 7,
      variantKey: "control",
      firstExposureAt: new Date("2026-01-05"),
    }));
    // Only one learner crosses the mastery threshold, so questionsToMastery is
    // 90% censored and the estimate describes a self-selected subgroup.
    const attribution = attributeMetrics({
      experiment: makeExperiment({ primaryMetric: "questionsToMastery" }),
      subjects,
      items: [makeItem({ studentId: 1, masteryBefore: 0.5, masteryAfter: 0.95 })],
      now: NOW,
    });
    const readout = buildReadout({
      experiment: makeExperiment({ primaryMetric: "questionsToMastery" }),
      attribution,
      exposureByVariant: { control: 10 },
      generatedAt: NOW,
    });
    expect(readout.interpretationNotes.some((n) => n.includes("censored"))).toBe(true);
  });

  it("is deterministic, including bootstrap bounds", () => {
    const a = readoutWith([0.1, 0.2, 0.3, 0.4], [0.2, 0.3, 0.4, 0.5]);
    const b = readoutWith([0.1, 0.2, 0.3, 0.4], [0.2, 0.3, 0.4, 0.5]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("renders a text readout that names no leader", () => {
    const text = formatReadout(readoutWith([0.1, 0.1, 0.1], [0.9, 0.9, 0.9]));
    expect(text).toContain("Interpretation notes:");
    expect(text.toLowerCase()).not.toContain("winner");
    expect(text).toContain("resolution");
  });

  it("degrades gracefully when an arm is too small to compare", () => {
    const readout = readoutWith([0.5], [0.6]);
    expect(readout.primary!.comparisons[0].difference).toBeNull();
    expect(() => formatReadout(readout)).not.toThrow();
  });

  it("flags a zero-width interval as an artefact rather than precision", () => {
    // Identical values within each arm collapse the interval to a point, which
    // renders as infinite certainty in any UI that plots it.
    const readout = readoutWith([0.1, 0.1], [0.9, 0.9]);
    const comparison = readout.primary!.comparisons[0];
    expect(comparison.difference!.interval.upper - comparison.difference!.interval.lower).toBeLessThan(1e-9);
    expect(readout.interpretationNotes.some((n) => n.includes("zero width"))).toBe(true);
    expect(readout.interpretationNotes.some((n) => n.includes("uninformative"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

describe("experiments — statistics", () => {
  it("summarises a sample with a t interval", () => {
    const s = summarise([1, 2, 3, 4, 5]);
    expect(s.n).toBe(5);
    expect(s.mean).toBeCloseTo(3, 6);
    expect(s.median).toBeCloseTo(3, 6);
    expect(s.interval!.lower).toBeLessThan(3);
    expect(s.interval!.upper).toBeGreaterThan(3);
  });

  it("returns no interval for a single observation", () => {
    expect(summarise([1]).interval).toBeNull();
  });

  it("widens the interval as spread grows", () => {
    const tight = summarise([5, 5, 5, 5, 5.1]);
    const loose = summarise([1, 5, 9, 2, 8]);
    const width = (s: ReturnType<typeof summarise>) => s.interval!.upper - s.interval!.lower;
    expect(width(loose)).toBeGreaterThan(width(tight));
  });

  it("brackets a known difference in means", () => {
    const control = Array.from({ length: 40 }, (_, i) => 0.5 + (i % 5) * 0.01);
    const treatment = control.map((v) => v + 0.2);
    const diff = differenceInMeans(treatment, control)!;
    expect(diff.absolute).toBeCloseTo(0.2, 6);
    expect(diff.interval.lower).toBeLessThan(0.2);
    expect(diff.interval.upper).toBeGreaterThan(0.2);
    expect(diff.effectSize).toBeGreaterThan(0);
  });

  it("keeps Wilson proportion bounds inside [0,1]", () => {
    // The reason Wilson is used: a Wald interval on 0/5 produces [0,0], and on
    // 5/5 produces [1,1], both of which are visibly wrong.
    for (const [k, n] of [[0, 5], [5, 5], [1, 3], [50, 100]] as const) {
      const p = proportionSummary(k, n);
      expect(p.interval!.lower).toBeGreaterThanOrEqual(0);
      expect(p.interval!.upper).toBeLessThanOrEqual(1);
      expect(p.interval!.lower).toBeLessThanOrEqual(p.interval!.upper);
    }
  });

  it("returns no proportion interval without trials", () => {
    expect(proportionSummary(0, 0).interval).toBeNull();
  });
});
