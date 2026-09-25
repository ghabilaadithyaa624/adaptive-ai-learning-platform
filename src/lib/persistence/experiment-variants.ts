/**
 * Parsers for the experiment JSONB columns:
 *   • `experiments.variants`     — the arms traffic is routed to
 *   • `experiments.eligibility`  — who may enter
 *
 * Why these need runtime validation rather than a cast: `variantForBucket`
 * accumulates `allocationPct` to pick an arm. If a persisted variant carries
 * `allocationPct: "50"`, the accumulator becomes the string `"050"`, the
 * comparison against the bucket silently misbehaves, and learners are assigned
 * to the wrong arm — an error that never throws and permanently contaminates
 * the experiment's results. Likewise a missing `config` makes the served policy
 * `undefined`, which falls through to the platform default while the exposure
 * record still claims the treatment arm.
 *
 * Scope note: this parser validates *structure and version* only. Experiment
 * *semantics* — allocations summing to ≤100, exactly one control, fingerprint
 * freshness — remain owned by `lifecycle.validateExperiment`, which already
 * implements them and reports them as user-facing validation issues. Duplicating
 * those rules here would fork the contract; a legally-persisted draft with two
 * controls must still load so an admin can fix it.
 */
import { POLICY_VARIANT_IDS, type EligibilityRule, type ExperimentVariant, type VersionedPolicyConfig } from "@/lib/experiments/types";
import {
  expectArray,
  expectBoolean,
  expectEnum,
  expectFiniteNumber,
  expectInstant,
  expectInteger,
  expectIntegerArray,
  expectNumberRecord,
  expectObject,
  expectString,
  expectStringArray,
  fail,
  optional,
  resolveVersion,
  runParser,
  type ParseResult,
} from "./result";

export const VARIANTS_BOUNDARY = "experiments.variants";
export const ELIGIBILITY_BOUNDARY = "experiments.eligibility";

/**
 * Schema version of a *stored variant record*. Distinct from
 * `VersionedPolicyConfig.version`, which versions the tuning of a policy and is
 * free-form domain data. Legacy rows (written before the field existed) are
 * still readable as v1.
 */
export const VARIANT_SCHEMA_V1 = "experiment-variant-v1";
export const SUPPORTED_VARIANT_SCHEMA_VERSIONS = [VARIANT_SCHEMA_V1] as const;

const MAX_VARIANTS = 32;
const MAX_WEIGHT_KEYS = 64;

function parseConfig(raw: unknown, path: string): VersionedPolicyConfig {
  const obj = expectObject(raw, path);
  const config: VersionedPolicyConfig = {
    policy: expectEnum(obj.policy, POLICY_VARIANT_IDS, `${path}.policy`),
    // Configuration version: required, free-form, but must be a real string —
    // it is written onto every exposure record and is how a mid-flight config
    // edit is detected at analysis time.
    version: expectString(obj.version, `${path}.version`, { max: 64 }),
    fingerprint: expectString(obj.fingerprint, `${path}.fingerprint`, { max: 128 }),
  };

  const weights = optional(obj.weights, () =>
    expectNumberRecord(obj.weights, `${path}.weights`, { maxKeys: MAX_WEIGHT_KEYS }),
  );
  if (weights) config.weights = weights as VersionedPolicyConfig["weights"];

  const params = optional(obj.params, () =>
    expectNumberRecord(obj.params, `${path}.params`, { maxKeys: MAX_WEIGHT_KEYS }),
  );
  if (params) config.params = params;

  return config;
}

function parseVariant(raw: unknown, path: string): ExperimentVariant {
  const obj = expectObject(raw, path);

  resolveVersion(obj, path, {
    field: "schemaVersion",
    supported: SUPPORTED_VARIANT_SCHEMA_VERSIONS,
    legacyDefault: VARIANT_SCHEMA_V1,
  });

  return {
    key: expectString(obj.key, `${path}.key`, { max: 64 }),
    label: expectString(obj.label, `${path}.label`, { max: 200 }),
    // Not clamped: an out-of-range allocation is a data fault the operator must
    // see, not something to quietly pull back to 100.
    allocationPct: expectFiniteNumber(obj.allocationPct, `${path}.allocationPct`, { min: 0, max: 100 }),
    config: parseConfig(obj.config, `${path}.config`),
    isControl: expectBoolean(obj.isControl, `${path}.isControl`),
  };
}

/**
 * Parse the whole `variants` array. An empty array is structurally valid — a
 * draft experiment legitimately has none yet, and `lifecycle` is what refuses
 * to start it.
 */
export function parseExperimentVariants(raw: unknown): ParseResult<ExperimentVariant[]> {
  return runParser(VARIANTS_BOUNDARY, () => {
    if (raw === null || raw === undefined) {
      fail({
        code: "MISSING_FIELD",
        path: "$",
        message: "variants column is null; an experiment row must carry a variants array",
        observed: raw === null ? "null" : "undefined",
      });
    }
    const arr = expectArray(raw, "$", { max: MAX_VARIANTS });
    const variants = arr.map((entry, i) => parseVariant(entry, `$[${i}]`));

    // Duplicate keys are a *structural* fault, not a policy one: assignment
    // looks arms up by key, so two arms sharing a key makes the served config
    // depend on array order.
    const seen = new Set<string>();
    for (const [i, variant] of variants.entries()) {
      if (seen.has(variant.key)) {
        fail({
          code: "MALFORMED_STRUCTURE",
          path: `$[${i}].key`,
          message: "duplicate variant key: arms are resolved by key and would be ambiguous",
        });
      }
      seen.add(variant.key);
    }
    return variants;
  });
}

/**
 * Parse `experiments.eligibility`.
 *
 * `createdAfter` / `createdBefore` are typed as `Date` on `EligibilityRule` but
 * JSONB round-trips them to ISO strings. The previous cast therefore handed
 * comparison code a string wearing a `Date` type — `learner.createdAt >= rule.createdAfter`
 * across a Date and a string compares by coercion and gives wrong answers at
 * the boundary. Reviving them here is the fix, and a non-parseable instant is
 * rejected rather than dropped.
 */
export function parseEligibilityRule(raw: unknown): ParseResult<EligibilityRule> {
  return runParser(ELIGIBILITY_BOUNDARY, () => {
    // An absent rule means "no constraints" and is the column default. That is
    // a real, valid state — distinct from a rule object with corrupt contents.
    if (raw === null || raw === undefined) return {};
    const obj = expectObject(raw, "$");
    const rule: EligibilityRule = {};

    const institutionIds = optional(obj.institutionIds, () =>
      expectIntegerArray(obj.institutionIds, "$.institutionIds", { max: 1000, min: 1 }),
    );
    if (institutionIds) rule.institutionIds = institutionIds;

    const roles = optional(obj.roles, () => expectStringArray(obj.roles, "$.roles", { max: 32 }));
    if (roles) rule.roles = roles;

    const gradeLevels = optional(obj.gradeLevels, () => expectStringArray(obj.gradeLevels, "$.gradeLevels", { max: 64 }));
    if (gradeLevels) rule.gradeLevels = gradeLevels;

    const cohorts = optional(obj.cohorts, () => expectStringArray(obj.cohorts, "$.cohorts", { max: 256 }));
    if (cohorts) rule.cohorts = cohorts;

    const minPriorAttempts = optional(obj.minPriorAttempts, () =>
      expectInteger(obj.minPriorAttempts, "$.minPriorAttempts", { min: 0 }),
    );
    if (minPriorAttempts !== undefined) rule.minPriorAttempts = minPriorAttempts;

    const maxPriorAttempts = optional(obj.maxPriorAttempts, () =>
      expectInteger(obj.maxPriorAttempts, "$.maxPriorAttempts", { min: 0 }),
    );
    if (maxPriorAttempts !== undefined) rule.maxPriorAttempts = maxPriorAttempts;

    const createdAfter = optional(obj.createdAfter, () => expectInstant(obj.createdAfter, "$.createdAfter"));
    if (createdAfter) rule.createdAfter = createdAfter;

    const createdBefore = optional(obj.createdBefore, () => expectInstant(obj.createdBefore, "$.createdBefore"));
    if (createdBefore) rule.createdBefore = createdBefore;

    const subjectIds = optional(obj.subjectIds, () =>
      expectIntegerArray(obj.subjectIds, "$.subjectIds", { max: 1000, min: 1 }),
    );
    if (subjectIds) rule.subjectIds = subjectIds;

    return rule;
  });
}
