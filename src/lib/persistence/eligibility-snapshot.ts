/**
 * Parser for `experiment_assignments.eligibility_snapshot`.
 *
 * The snapshot is the frozen record of *why* a learner entered an experiment.
 * Analysis segments on it, so a corrupted snapshot does not crash anything — it
 * silently reshapes the reported population. That is the worst class of failure
 * this codebase can have: a wrong number that looks like a right one.
 *
 * `createdAt` is the specific trap. It is typed `Date` but stored as an ISO
 * string in JSONB, so the old
 * `row.eligibilitySnapshot as unknown as LearnerEligibilitySnapshot` cast
 * produced an object whose `createdAt.getTime()` throws at runtime while
 * type-checking cleanly.
 */
import type { LearnerEligibilitySnapshot } from "@/lib/experiments/types";
import {
  expectInstant,
  expectInteger,
  expectIntegerArray,
  expectObject,
  expectString,
  fail,
  optional,
  resolveVersion,
  runParser,
  type ParseResult,
} from "./result";

export const ELIGIBILITY_SNAPSHOT_BOUNDARY = "experiment_assignments.eligibility_snapshot";

export const SNAPSHOT_SCHEMA_V1 = "eligibility-snapshot-v1";
export const SUPPORTED_SNAPSHOT_VERSIONS = [SNAPSHOT_SCHEMA_V1] as const;

export function parseEligibilitySnapshot(raw: unknown): ParseResult<LearnerEligibilitySnapshot> {
  return runParser(ELIGIBILITY_SNAPSHOT_BOUNDARY, () => {
    if (raw === null || raw === undefined) {
      fail({
        code: "MISSING_FIELD",
        path: "$",
        message: "assignment carries no eligibility snapshot; its population membership is unprovable",
        observed: raw === null ? "null" : "undefined",
      });
    }
    const obj = expectObject(raw, "$");

    resolveVersion(obj, "$", {
      field: "schemaVersion",
      supported: SUPPORTED_SNAPSHOT_VERSIONS,
      legacyDefault: SNAPSHOT_SCHEMA_V1,
    });

    return {
      studentId: expectInteger(obj.studentId, "$.studentId", { min: 1 }),
      // `null` is meaningful here (a platform-scope learner) and is therefore
      // only accepted where the domain type allows it.
      institutionId:
        obj.institutionId === null || obj.institutionId === undefined
          ? null
          : expectInteger(obj.institutionId, "$.institutionId", { min: 1 }),
      role: expectString(obj.role, "$.role", { max: 64 }),
      gradeLevel: optional(obj.gradeLevel, () => expectString(obj.gradeLevel, "$.gradeLevel", { max: 64 })) ?? null,
      cohort: optional(obj.cohort, () => expectString(obj.cohort, "$.cohort", { max: 128 })) ?? null,
      priorAttempts: expectInteger(obj.priorAttempts, "$.priorAttempts", { min: 0 }),
      createdAt: expectInstant(obj.createdAt, "$.createdAt"),
      subjectIds: expectIntegerArray(obj.subjectIds, "$.subjectIds", { max: 1000, min: 1 }),
    };
  });
}

/**
 * Shape written back to the column. Stamping the schema version on write is
 * what makes a *future* shape change detectable instead of silently
 * reinterpreted; reads still accept unstamped legacy rows.
 */
export function serializeEligibilitySnapshot(
  snapshot: LearnerEligibilitySnapshot,
): Record<string, unknown> {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_V1,
    studentId: snapshot.studentId,
    institutionId: snapshot.institutionId,
    role: snapshot.role,
    gradeLevel: snapshot.gradeLevel,
    cohort: snapshot.cohort,
    priorAttempts: snapshot.priorAttempts,
    createdAt: snapshot.createdAt.toISOString(),
    subjectIds: [...snapshot.subjectIds],
  };
}
