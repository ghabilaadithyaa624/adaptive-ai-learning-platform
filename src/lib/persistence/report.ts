/**
 * Operational reporting for persistence-boundary parse outcomes.
 *
 * Every read of a persisted JSON structure is observable: a counter per
 * boundary/outcome, and a structured log line (never the payload itself) on
 * rejection. A silent fallback would defeat the purpose of the parsers — the
 * whole point is that "we fell back to the heuristic model because the stored
 * classifier is corrupt" is visible in the dashboard rather than inferred from
 * a mysterious accuracy drop.
 */
import { log, metrics } from "@/lib/observability";
import { PersistedDataError, toError, type ParseResult } from "./result";

/** Record the outcome of one parse. Returns the result unchanged. */
export function reportParse<T>(result: ParseResult<T>, boundary: string): ParseResult<T> {
  metrics.persistedPayloadReadsTotal.inc({ boundary, status: result.status });
  if (result.status === "VALID") return result;

  metrics.persistedPayloadRejectionsTotal.inc({
    boundary,
    status: result.status,
    code: result.issue.code,
  });
  metrics.appErrorsTotal.inc({ type: "persisted_payload" });

  const error = toError(result);
  log.error("persistence.payload_rejected", error.toFields());
  return result;
}

/**
 * Parse-or-throw for callers that have no safe default (experiment variants,
 * eligibility snapshots). Throws the structured `PersistedDataError`.
 */
export function unwrapOrThrow<T>(result: ParseResult<T>, boundary: string): T {
  const reported = reportParse(result, boundary);
  if (reported.status === "VALID") return reported.value;
  throw toError(reported);
}

/**
 * Parse-or-fall-back for callers that *do* have a documented safe default
 * (the classifier falls back to the heuristic model). The fallback is loud:
 * `reportParse` has already logged and counted the rejection.
 */
export function unwrapOrFallback<T>(result: ParseResult<T>, boundary: string, fallback: T): T {
  const reported = reportParse(result, boundary);
  return reported.status === "VALID" ? reported.value : fallback;
}

export { PersistedDataError };
