/**
 * Persistence-boundary parsers.
 *
 * Every JSONB column whose contents are *interpreted* (rather than merely
 * echoed to a client) is parsed here before use. See `PERSISTENCE.md` for the
 * boundary inventory and the rationale for which columns are in scope.
 */
export {
  PersistedDataError,
  isValid,
  toError,
  type ParseFailureCode,
  type ParseIssue,
  type ParseResult,
  type ParseStatus,
} from "./result";
export { reportParse, unwrapOrFallback, unwrapOrThrow } from "./report";
export {
  CLASSIFIER_PARAMS_BOUNDARY,
  CLASSIFIER_PARAMS_V1,
  SUPPORTED_CLASSIFIER_PARAM_VERSIONS,
  parseClassifierParams,
  parseModelMetrics,
  type PersistedClassifierParams,
} from "./classifier-params";
export {
  ELIGIBILITY_BOUNDARY,
  SUPPORTED_VARIANT_SCHEMA_VERSIONS,
  VARIANTS_BOUNDARY,
  VARIANT_SCHEMA_V1,
  parseEligibilityRule,
  parseExperimentVariants,
} from "./experiment-variants";
export {
  ELIGIBILITY_SNAPSHOT_BOUNDARY,
  SNAPSHOT_SCHEMA_V1,
  SUPPORTED_SNAPSHOT_VERSIONS,
  parseEligibilitySnapshot,
  serializeEligibilitySnapshot,
} from "./eligibility-snapshot";
