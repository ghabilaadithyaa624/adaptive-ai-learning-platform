/**
 * Persistence-boundary parsers — runtime validation of persisted JSON.
 *
 * The shared obligation across every case below: a payload the current build
 * cannot fully interpret must never be *partially* used. Each parser is
 * therefore exercised against the eight failure shapes a JSONB column actually
 * produces in production — valid, missing field, wrong type, malformed nested
 * object, unknown version, legacy (unversioned) payload, null column, and a
 * value corrupted by something that was never our writer.
 */
import { describe, expect, it } from "vitest";

import {
  CLASSIFIER_PARAMS_V1,
  PersistedDataError,
  SNAPSHOT_SCHEMA_V1,
  VARIANT_SCHEMA_V1,
  parseClassifierParams,
  parseEligibilityRule,
  parseEligibilitySnapshot,
  parseExperimentVariants,
  parseModelMetrics,
  serializeEligibilitySnapshot,
  unwrapOrFallback,
  unwrapOrThrow,
  type ParseResult,
} from "@/lib/persistence";
import { FEATURE_NAMES, HEURISTIC_MODEL } from "@/lib/ml/classifier";
import type { LearnerEligibilitySnapshot } from "@/lib/experiments/types";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const WEIGHTS = FEATURE_NAMES.map((_, i) => 0.1 * (i + 1));

function classifierParams(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CLASSIFIER_PARAMS_V1,
    featureNames: [...FEATURE_NAMES],
    weights: [...WEIGHTS],
    means: FEATURE_NAMES.map(() => 0),
    stds: FEATURE_NAMES.map(() => 1),
    ...overrides,
  };
}

function variant(overrides: Record<string, unknown> = {}) {
  return {
    key: "control",
    label: "Control",
    allocationPct: 50,
    isControl: true,
    config: { policy: "adaptive-v2", version: "1.0.0", fingerprint: "abc123" },
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_V1,
    studentId: 42,
    institutionId: 7,
    role: "student",
    gradeLevel: "9",
    cohort: "fall-2025",
    priorAttempts: 18,
    createdAt: "2025-01-04T10:00:00.000Z",
    subjectIds: [1, 2],
    ...overrides,
  };
}

/** Assert a rejection and return the issue, keeping each test to one idea. */
function rejected<T>(result: ParseResult<T>, status: "INVALID" | "UNSUPPORTED_VERSION") {
  expect(result.status).toBe(status);
  if (result.status === "VALID") throw new Error("expected a rejection");
  return result.issue;
}

/* ------------------------------------------------------------------ */
/* Classifier parameters                                               */
/* ------------------------------------------------------------------ */

describe("parseClassifierParams", () => {
  it("accepts a valid payload and returns the exact stored values", () => {
    const result = parseClassifierParams(classifierParams());
    expect(result.status).toBe("VALID");
    if (result.status !== "VALID") return;
    expect(result.value.weights).toEqual(WEIGHTS);
    expect(result.value.featureNames).toEqual([...FEATURE_NAMES]);
    expect(result.value.schemaVersion).toBe(CLASSIFIER_PARAMS_V1);
    expect(result.value.calibration).toBeUndefined();
  });

  it("rejects a payload missing the weight vector", () => {
    const { weights, ...withoutWeights } = classifierParams();
    void weights;
    const issue = rejected(parseClassifierParams(withoutWeights), "INVALID");
    expect(issue.code).toBe("MISSING_FIELD");
    expect(issue.path).toBe("$.weights");
  });

  it("rejects numeric strings instead of coercing them", () => {
    // The pre-hardening code accepted this: `["0.4", ...]` has a length, so the
    // `weights?.length` check passed and the strings reached the dot product.
    const issue = rejected(parseClassifierParams(classifierParams({ weights: ["0.4", "0.9"] })), "INVALID");
    expect(issue.code).toBe("WRONG_TYPE");
    expect(issue.path).toBe("$.weights[0]");
    expect(issue.observed).toBe("string");
  });

  it("rejects a null hole punched into the weight vector", () => {
    const corrupted = classifierParams();
    corrupted.weights[3] = null as unknown as number;
    const issue = rejected(parseClassifierParams(corrupted), "INVALID");
    expect(issue.path).toBe("$.weights[3]");
  });

  it("rejects a feature/weight arity mismatch", () => {
    const issue = rejected(
      parseClassifierParams(classifierParams({ featureNames: ["bias", "ability"] })),
      "INVALID",
    );
    expect(issue.code).toBe("MALFORMED_STRUCTURE");
    expect(issue.message).toMatch(/arity mismatch/);
  });

  it("rejects a malformed nested calibration object", () => {
    const issue = rejected(
      parseClassifierParams(
        classifierParams({
          calibration: { kind: "platt", version: "cal-v2", source: "offline-historical", slope: "1.2", intercept: 0, samples: 500 },
        }),
      ),
      "INVALID",
    );
    expect(issue.path).toBe("$.calibration.slope");
    expect(issue.code).toBe("WRONG_TYPE");
  });

  it("rejects a calibrator whose kind is not a known member", () => {
    const issue = rejected(
      parseClassifierParams(
        classifierParams({
          calibration: { kind: "isotonic", version: "cal-v3", source: "production", slope: 1, intercept: 0, samples: 10 },
        }),
      ),
      "INVALID",
    );
    expect(issue.code).toBe("UNKNOWN_MEMBER");
  });

  it("accepts a valid calibrator and preserves it", () => {
    const result = parseClassifierParams(
      classifierParams({
        calibration: { kind: "platt", version: "cal-v2", source: "production", slope: 1.2, intercept: -0.1, samples: 900 },
      }),
    );
    expect(result.status).toBe("VALID");
    if (result.status !== "VALID") return;
    expect(result.value.calibration?.slope).toBe(1.2);
  });

  it("reports UNSUPPORTED_VERSION — not INVALID — for a payload from a newer writer", () => {
    const result = parseClassifierParams(classifierParams({ schemaVersion: "clf-params-v9" }));
    const issue = rejected(result, "UNSUPPORTED_VERSION");
    expect(issue.code).toBe("UNSUPPORTED_VERSION");
    expect(issue.version).toBe("clf-params-v9");
    expect(issue.supportedVersions).toContain(CLASSIFIER_PARAMS_V1);
  });

  it("treats a malformed version field as corruption rather than a version gap", () => {
    const issue = rejected(parseClassifierParams(classifierParams({ schemaVersion: 1 })), "INVALID");
    expect(issue.code).toBe("WRONG_TYPE");
  });

  it("still loads legacy rows written before the version field existed", () => {
    // Requirement: preserve existing valid data. The deployed registry row has
    // no `schemaVersion`; orphaning it would retire a working model.
    const { schemaVersion, ...legacy } = classifierParams();
    void schemaVersion;
    const result = parseClassifierParams(legacy);
    expect(result.status).toBe("VALID");
    if (result.status !== "VALID") return;
    expect(result.value.schemaVersion).toBe(CLASSIFIER_PARAMS_V1);
  });

  it("rejects a null column value", () => {
    const issue = rejected(parseClassifierParams(null), "INVALID");
    expect(issue.code).toBe("MISSING_FIELD");
    expect(issue.observed).toBe("null");
  });

  it("rejects a corrupted database value that is not an object at all", () => {
    // e.g. a column overwritten with a bare JSON string or array by a manual fix.
    expect(rejected(parseClassifierParams("{}"), "INVALID").code).toBe("WRONG_TYPE");
    expect(rejected(parseClassifierParams([1, 2, 3]), "INVALID").observed).toBe("array");
    expect(rejected(parseClassifierParams(classifierParams({ weights: [] })), "INVALID").code).toBe(
      "MALFORMED_STRUCTURE",
    );
  });

  it("never leaks the payload into the structured issue", () => {
    const issue = rejected(parseClassifierParams({ weights: ["secret-value"] }), "INVALID");
    expect(JSON.stringify(issue)).not.toContain("secret-value");
  });
});

describe("parseModelMetrics", () => {
  it("accepts a partial metric bag and defaults only declared-optional entries", () => {
    const result = parseModelMetrics({ auc: 0.81, accuracy: 0.74 }, "test.metrics");
    expect(result.status).toBe("VALID");
    if (result.status !== "VALID") return;
    expect(result.value.auc).toBe(0.81);
    expect(result.value.mce).toBe(0);
  });

  it("rejects a non-numeric metric rather than zeroing it", () => {
    expect(rejected(parseModelMetrics({ auc: "0.81" }, "test.metrics"), "INVALID").path).toBe("$.auc");
  });

  it("rejects a null metrics column", () => {
    expect(rejected(parseModelMetrics(null, "test.metrics"), "INVALID").code).toBe("MISSING_FIELD");
  });
});

/* ------------------------------------------------------------------ */
/* Experiment variants                                                 */
/* ------------------------------------------------------------------ */

describe("parseExperimentVariants", () => {
  it("accepts a valid two-arm payload", () => {
    const result = parseExperimentVariants([
      variant(),
      variant({ key: "treatment", label: "V3", isControl: false, config: { policy: "adaptive-v3", version: "2.1.0", fingerprint: "def456" } }),
    ]);
    expect(result.status).toBe("VALID");
    if (result.status !== "VALID") return;
    expect(result.value.map((v) => v.key)).toEqual(["control", "treatment"]);
    expect(result.value[1].config.policy).toBe("adaptive-v3");
  });

  it("accepts an empty array — a draft legitimately has no arms yet", () => {
    expect(parseExperimentVariants([]).status).toBe("VALID");
  });

  it("rejects a variant missing its config", () => {
    const { config, ...withoutConfig } = variant();
    void config;
    const issue = rejected(parseExperimentVariants([withoutConfig]), "INVALID");
    expect(issue.code).toBe("MISSING_FIELD");
    expect(issue.path).toBe("$[0].config");
  });

  it("rejects a string allocation instead of coercing it", () => {
    // `variantForBucket` sums allocations; a string turns the accumulator into
    // concatenation and assigns learners to the wrong arm, silently.
    const issue = rejected(parseExperimentVariants([variant({ allocationPct: "50" })]), "INVALID");
    expect(issue.code).toBe("WRONG_TYPE");
    expect(issue.path).toBe("$[0].allocationPct");
  });

  it("rejects an out-of-range allocation", () => {
    expect(rejected(parseExperimentVariants([variant({ allocationPct: 140 })]), "INVALID").code).toBe("OUT_OF_RANGE");
  });

  it("rejects a malformed nested config object", () => {
    const issue = rejected(
      parseExperimentVariants([variant({ config: { policy: "adaptive-v3", version: "2.0.0" } })]),
      "INVALID",
    );
    expect(issue.path).toBe("$[0].config.fingerprint");
  });

  it("rejects an unknown policy id", () => {
    const issue = rejected(
      parseExperimentVariants([variant({ config: { policy: "adaptive-v4", version: "1.0.0", fingerprint: "x" } })]),
      "INVALID",
    );
    expect(issue.code).toBe("UNKNOWN_MEMBER");
    expect(issue.path).toBe("$[0].config.policy");
  });

  it("rejects duplicate variant keys, which make arm lookup order-dependent", () => {
    const issue = rejected(
      parseExperimentVariants([variant(), variant({ isControl: false })]),
      "INVALID",
    );
    expect(issue.code).toBe("MALFORMED_STRUCTURE");
    expect(issue.path).toBe("$[1].key");
  });

  it("reports UNSUPPORTED_VERSION for a variant record from a newer writer", () => {
    const issue = rejected(
      parseExperimentVariants([variant({ schemaVersion: "experiment-variant-v7" })]),
      "UNSUPPORTED_VERSION",
    );
    expect(issue.version).toBe("experiment-variant-v7");
  });

  it("accepts legacy unversioned variant records", () => {
    const result = parseExperimentVariants([variant()]);
    expect(result.status).toBe("VALID");
    expect(VARIANT_SCHEMA_V1).toBe("experiment-variant-v1");
  });

  it("rejects a null variants column", () => {
    const issue = rejected(parseExperimentVariants(null), "INVALID");
    expect(issue.code).toBe("MISSING_FIELD");
  });

  it("rejects a corrupted column that holds an object instead of an array", () => {
    expect(rejected(parseExperimentVariants({ control: variant() }), "INVALID").code).toBe("WRONG_TYPE");
    expect(rejected(parseExperimentVariants(["control", "treatment"]), "INVALID").path).toBe("$[0]");
  });
});

/* ------------------------------------------------------------------ */
/* Eligibility rule                                                    */
/* ------------------------------------------------------------------ */

describe("parseEligibilityRule", () => {
  it("accepts a valid rule and revives JSON timestamps into Dates", () => {
    const result = parseEligibilityRule({
      institutionIds: [1, 2],
      roles: ["student"],
      minPriorAttempts: 5,
      createdAfter: "2025-01-01T00:00:00.000Z",
    });
    expect(result.status).toBe("VALID");
    if (result.status !== "VALID") return;
    expect(result.value.createdAfter).toBeInstanceOf(Date);
    expect(result.value.createdAfter?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(result.value.maxPriorAttempts).toBeUndefined();
  });

  it("treats an absent rule as 'no constraints' — the column default", () => {
    expect(parseEligibilityRule({})).toEqual({ status: "VALID", value: {} });
    expect(parseEligibilityRule(null)).toEqual({ status: "VALID", value: {} });
  });

  it("rejects a non-parseable timestamp rather than dropping the constraint", () => {
    const issue = rejected(parseEligibilityRule({ createdAfter: "last tuesday" }), "INVALID");
    expect(issue.code).toBe("MALFORMED_STRUCTURE");
    expect(issue.path).toBe("$.createdAfter");
  });

  it("rejects wrongly-typed constraint values", () => {
    expect(rejected(parseEligibilityRule({ minPriorAttempts: "5" }), "INVALID").code).toBe("WRONG_TYPE");
    expect(rejected(parseEligibilityRule({ roles: "student" }), "INVALID").code).toBe("WRONG_TYPE");
    expect(rejected(parseEligibilityRule({ institutionIds: [1, 2.5] }), "INVALID").path).toBe("$.institutionIds[1]");
  });

  it("rejects a corrupted column that is not an object", () => {
    expect(rejected(parseEligibilityRule("{}"), "INVALID").observed).toBe("string");
  });
});

/* ------------------------------------------------------------------ */
/* Eligibility snapshot                                                */
/* ------------------------------------------------------------------ */

describe("parseEligibilitySnapshot", () => {
  it("accepts a valid snapshot and revives createdAt", () => {
    const result = parseEligibilitySnapshot(snapshot());
    expect(result.status).toBe("VALID");
    if (result.status !== "VALID") return;
    expect(result.value.studentId).toBe(42);
    expect(result.value.createdAt).toBeInstanceOf(Date);
    expect(result.value.subjectIds).toEqual([1, 2]);
  });

  it("accepts a platform-scope learner with a null institution", () => {
    const result = parseEligibilitySnapshot(snapshot({ institutionId: null, gradeLevel: null, cohort: null }));
    expect(result.status).toBe("VALID");
    if (result.status !== "VALID") return;
    expect(result.value.institutionId).toBeNull();
    expect(result.value.cohort).toBeNull();
  });

  it("rejects a snapshot missing the student id", () => {
    const { studentId, ...withoutStudent } = snapshot();
    void studentId;
    const issue = rejected(parseEligibilitySnapshot(withoutStudent), "INVALID");
    expect(issue.code).toBe("MISSING_FIELD");
    expect(issue.path).toBe("$.studentId");
  });

  it("rejects a wrongly-typed prior-attempt count", () => {
    expect(rejected(parseEligibilitySnapshot(snapshot({ priorAttempts: "18" })), "INVALID").code).toBe("WRONG_TYPE");
  });

  it("rejects a malformed nested subject list", () => {
    const issue = rejected(parseEligibilitySnapshot(snapshot({ subjectIds: [1, { id: 2 }] })), "INVALID");
    expect(issue.path).toBe("$.subjectIds[1]");
  });

  it("rejects a createdAt that cannot be revived into an instant", () => {
    expect(rejected(parseEligibilitySnapshot(snapshot({ createdAt: "not-a-date" })), "INVALID").code).toBe(
      "MALFORMED_STRUCTURE",
    );
    expect(rejected(parseEligibilitySnapshot(snapshot({ createdAt: 1735987200000 })), "INVALID").code).toBe(
      "WRONG_TYPE",
    );
  });

  it("reports UNSUPPORTED_VERSION for a snapshot from a newer writer", () => {
    const issue = rejected(
      parseEligibilitySnapshot(snapshot({ schemaVersion: "eligibility-snapshot-v4" })),
      "UNSUPPORTED_VERSION",
    );
    expect(issue.supportedVersions).toEqual([SNAPSHOT_SCHEMA_V1]);
  });

  it("accepts legacy snapshots written before the version field existed", () => {
    const { schemaVersion, ...legacy } = snapshot();
    void schemaVersion;
    expect(parseEligibilitySnapshot(legacy).status).toBe("VALID");
  });

  it("rejects a null snapshot column", () => {
    const issue = rejected(parseEligibilitySnapshot(null), "INVALID");
    expect(issue.code).toBe("MISSING_FIELD");
  });

  it("rejects an empty object left by a partially-failed write", () => {
    expect(rejected(parseEligibilitySnapshot({}), "INVALID").code).toBe("MISSING_FIELD");
  });

  it("round-trips through the serializer used on the write path", () => {
    const learner: LearnerEligibilitySnapshot = {
      studentId: 9,
      institutionId: null,
      role: "student",
      gradeLevel: null,
      cohort: "spring",
      priorAttempts: 3,
      createdAt: new Date("2024-06-01T08:30:00.000Z"),
      subjectIds: [4],
    };
    const result = parseEligibilitySnapshot(serializeEligibilitySnapshot(learner));
    expect(result.status).toBe("VALID");
    if (result.status !== "VALID") return;
    expect(result.value).toEqual(learner);
  });
});

/* ------------------------------------------------------------------ */
/* Failure handling contract                                           */
/* ------------------------------------------------------------------ */

describe("failure handling", () => {
  it("unwrapOrThrow raises a structured operational error", () => {
    let caught: unknown;
    try {
      unwrapOrThrow(parseExperimentVariants(null), "experiments.variants");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistedDataError);
    const error = caught as PersistedDataError;
    expect(error.status).toBe("INVALID");
    expect(error.toFields()).toMatchObject({
      parseStatus: "INVALID",
      boundary: "experiments.variants",
      code: "MISSING_FIELD",
      path: "$",
    });
  });

  it("unwrapOrThrow distinguishes an unsupported version on the error object", () => {
    try {
      unwrapOrThrow(parseEligibilitySnapshot(snapshot({ schemaVersion: "v-future" })), "snap");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistedDataError);
      expect((error as PersistedDataError).status).toBe("UNSUPPORTED_VERSION");
    }
  });

  it("unwrapOrFallback degrades to the documented safe default instead of malformed config", () => {
    const model = unwrapOrFallback(parseClassifierParams({ weights: [null] }), "ml_models.params", {
      schemaVersion: CLASSIFIER_PARAMS_V1,
      featureNames: [...HEURISTIC_MODEL.featureNames],
      weights: [...HEURISTIC_MODEL.weights],
      means: [],
      stds: [],
    });
    expect(model.weights).toEqual(HEURISTIC_MODEL.weights);
  });

  it("passes valid values straight through both unwrappers", () => {
    expect(unwrapOrThrow(parseEligibilityRule({ roles: ["student"] }), "rule")).toEqual({ roles: ["student"] });
    expect(unwrapOrFallback(parseExperimentVariants([]), "variants", [variant()] as never)).toEqual([]);
  });
});
