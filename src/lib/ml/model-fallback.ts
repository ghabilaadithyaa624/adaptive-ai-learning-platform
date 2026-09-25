/**
 * Observability for model-registry fallback.
 *
 * The registry deliberately prefers availability: if the registered model
 * cannot be loaded, serving continues on the built-in heuristic classifier.
 * That behaviour is correct and is preserved — a learner mid-assessment should
 * not see an error because a JSONB column is corrupt.
 *
 * What was wrong is that the degradation was *invisible*. `catch { return
 * HEURISTIC_MODEL }` swallowed database failures entirely, and the result is
 * cached, so a whole shift could be served by the heuristic with nothing in the
 * logs and nothing on a dashboard. The only symptom would be a slow, unexplained
 * drop in prediction quality.
 *
 * This module makes fallback loud without making it noisy:
 *
 *  • every fallback increments `adaptiq_ml_model_fallback_total`
 *    {model, version, category} — metrics are never rate-limited, because
 *    counters are how you see a rate;
 *  • a gauge reports whether traffic is being served by a fallback *right now*,
 *    and since when, which is the question an operator actually asks;
 *  • warnings are logged on the first occurrence and then deduplicated per
 *    (model, version, category) for a window, with the suppressed count carried
 *    on the next emission so nothing is lost;
 *  • recovery is always logged, since it is rare and closes the incident.
 *
 * Fallback does **not** disable the application. There is no governance policy
 * in this repository that requires failing closed on a degraded model, and the
 * existing readiness contract gates load-balancer routing — flipping it for a
 * heuristic that still produces usable predictions would convert a quality
 * degradation into an outage. The state is surfaced as a non-critical `warn`
 * health check instead, so humans decide.
 */
import { log, metrics } from "@/lib/observability";

/**
 * Closed set of failure categories. Closed because these become metric label
 * values: an open-ended category (say, a raw error message) would explode
 * cardinality and could carry data that must not reach a metrics backend.
 */
export const FALLBACK_CATEGORIES = [
  /** No row for this model in the registry — expected before the first train. */
  "no_registered_model",
  /** The registry query itself failed (connection, timeout, permissions…). */
  "database_error",
  /** Stored parameters failed runtime validation (see src/lib/persistence). */
  "malformed_params",
  /** Parameters are well-formed but written by an unsupported schema version. */
  "unsupported_version",
  /** The row exists but could not be turned into a usable model. */
  "deserialization_error",
] as const;

export type FallbackCategory = (typeof FALLBACK_CATEGORIES)[number];

/** Label value used when the failure happened before a version could be read. */
export const UNKNOWN_VERSION = "unknown";

/**
 * How long an identical warning is suppressed. One minute keeps a sustained
 * outage to ~60 lines/hour per distinct cause while still proving the condition
 * is ongoing. Tunable for operators who want a quieter or chattier signal.
 */
const DEFAULT_LOG_INTERVAL_MS = 60_000;

function logIntervalMs(): number {
  const raw = Number(process.env.ML_FALLBACK_LOG_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_LOG_INTERVAL_MS;
}

/**
 * Metric label values must be bounded and predictable. Model versions come from
 * the database, so they are constrained here rather than trusted — an oversized
 * or exotic version string would otherwise become an unbounded label dimension.
 */
function safeLabel(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const cleaned = trimmed.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 64);
  return cleaned || fallback;
}

/* ------------------------------------------------------------------ */
/* Serving state                                                       */
/* ------------------------------------------------------------------ */

export interface ModelServingStatus {
  model: string;
  /** What is actually answering prediction calls right now. */
  source: "registry" | "fallback";
  /** Version of the model in force. For a fallback this is the heuristic's. */
  servingVersion: string;
  /** Version of the *registered* model we failed to load, when it was readable. */
  attemptedVersion: string | null;
  category: FallbackCategory | null;
  /** ISO timestamp of the first failure in the current streak. */
  since: string | null;
  /** Consecutive failed loads in the current streak. */
  consecutiveFailures: number;
  /** Warnings withheld by the deduplication window in this streak. */
  suppressedWarnings: number;
  lastEventAt: string;
}

interface StreakState {
  category: FallbackCategory;
  attemptedVersion: string | null;
  since: number;
  consecutiveFailures: number;
  suppressedWarnings: number;
  lastEventAt: number;
}

interface HealthyState {
  version: string;
  lastEventAt: number;
}

const fallbackStreaks = new Map<string, StreakState>();
const healthyModels = new Map<string, HealthyState>();
/** Dedup window state, keyed by model+version+category. */
const lastWarnAt = new Map<string, number>();

/** Test hook. Also used to reset state between simulated incidents. */
export function resetModelFallbackState(): void {
  fallbackStreaks.clear();
  healthyModels.clear();
  lastWarnAt.clear();
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

export interface FallbackEvent {
  /** Registry model name, e.g. "difficulty-classifier". */
  model: string;
  category: FallbackCategory;
  /** Version of the model we tried and failed to load, if it was readable. */
  attemptedVersion?: string | null;
  /** Version of the fallback that is now serving. */
  servingVersion: string;
  /**
   * Optional non-sensitive structured context (a validation path, an error
   * name). Must never contain learner data, payload contents, or credentials —
   * callers pass pre-sanitized fields; see `safeFailureContext`.
   */
  context?: Record<string, string | number | boolean>;
}

/**
 * Record that a load fell back. Always increments the counter; logs subject to
 * the dedup window.
 */
export function recordModelFallback(event: FallbackEvent): void {
  const model = safeLabel(event.model, "unknown_model");
  const version = safeLabel(event.attemptedVersion, UNKNOWN_VERSION);
  const nowMs = Date.now();

  metrics.mlModelFallbackTotal.inc({ model, version, category: event.category });

  const previous = fallbackStreaks.get(event.model);
  const streak: StreakState = {
    category: event.category,
    attemptedVersion: event.attemptedVersion ?? null,
    // A streak spans consecutive failures even if the cause changes; what
    // matters operationally is "how long have we been degraded".
    since: previous?.since ?? nowMs,
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    suppressedWarnings: previous?.suppressedWarnings ?? 0,
    lastEventAt: nowMs,
  };
  healthyModels.delete(event.model);

  metrics.mlModelFallbackActive.set(1, { model });
  metrics.mlModelFallbackSince.set(Math.floor(streak.since / 1000), { model });

  // Dedup on the *cause*, not merely the model: a database outage followed by a
  // corrupt payload are two different incidents and both deserve a first line.
  const dedupKey = `${event.model}|${version}|${event.category}`;
  const last = lastWarnAt.get(dedupKey);
  const interval = logIntervalMs();
  const shouldLog = last === undefined || nowMs - last >= interval;

  if (shouldLog) {
    lastWarnAt.set(dedupKey, nowMs);
    log.warn("ml.model_fallback", {
      model: event.model,
      category: event.category,
      attemptedVersion: event.attemptedVersion ?? UNKNOWN_VERSION,
      servingVersion: event.servingVersion,
      servingSource: "fallback",
      consecutiveFailures: streak.consecutiveFailures,
      fallbackSince: new Date(streak.since).toISOString(),
      // Carried forward so a suppressed burst is still quantified in the logs.
      suppressedWarnings: streak.suppressedWarnings,
      suppressionWindowMs: interval,
      ...(event.context ?? {}),
    });
    streak.suppressedWarnings = 0;
  } else {
    streak.suppressedWarnings += 1;
  }

  fallbackStreaks.set(event.model, streak);
}

/**
 * Record a successful load of the registered model. Clears the gauges and, if a
 * streak was open, logs the recovery — an incident that ends silently is only
 * half-observable.
 */
export function recordModelLoaded(params: { model: string; version: string }): void {
  const model = safeLabel(params.model, "unknown_model");
  const streak = fallbackStreaks.get(params.model);
  const nowMs = Date.now();

  metrics.mlModelFallbackActive.set(0, { model });
  metrics.mlModelFallbackSince.set(0, { model });

  if (streak) {
    fallbackStreaks.delete(params.model);
    for (const key of [...lastWarnAt.keys()]) {
      if (key.startsWith(`${params.model}|`)) lastWarnAt.delete(key);
    }
    log.info("ml.model_fallback_recovered", {
      model: params.model,
      version: params.version,
      servingSource: "registry",
      degradedForMs: nowMs - streak.since,
      consecutiveFailures: streak.consecutiveFailures,
      suppressedWarnings: streak.suppressedWarnings,
      lastCategory: streak.category,
    });
  }

  healthyModels.set(params.model, { version: params.version, lastEventAt: nowMs });
}

/* ------------------------------------------------------------------ */
/* Operator surface                                                    */
/* ------------------------------------------------------------------ */

/**
 * Current serving state for one model, or `null` if it has not been loaded in
 * this process yet (a fresh replica that has served no traffic).
 */
export function getModelServingStatus(model: string): ModelServingStatus | null {
  const streak = fallbackStreaks.get(model);
  if (streak) {
    return {
      model,
      source: "fallback",
      servingVersion: "heuristic",
      attemptedVersion: streak.attemptedVersion,
      category: streak.category,
      since: new Date(streak.since).toISOString(),
      consecutiveFailures: streak.consecutiveFailures,
      suppressedWarnings: streak.suppressedWarnings,
      lastEventAt: new Date(streak.lastEventAt).toISOString(),
    };
  }
  const healthy = healthyModels.get(model);
  if (!healthy) return null;
  return {
    model,
    source: "registry",
    servingVersion: healthy.version,
    attemptedVersion: null,
    category: null,
    since: null,
    consecutiveFailures: 0,
    suppressedWarnings: 0,
    lastEventAt: new Date(healthy.lastEventAt).toISOString(),
  };
}

/** Every model this process has loaded, for the health endpoint. */
export function listModelServingStatus(): ModelServingStatus[] {
  const names = new Set([...fallbackStreaks.keys(), ...healthyModels.keys()]);
  return [...names]
    .map((name) => getModelServingStatus(name))
    .filter((status): status is ModelServingStatus => status !== null)
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** True when any model in this process is currently degraded. */
export function isServingFallback(): boolean {
  return fallbackStreaks.size > 0;
}

/* ------------------------------------------------------------------ */
/* Safe error context                                                  */
/* ------------------------------------------------------------------ */

/**
 * Reduce an arbitrary thrown value to log-safe fields.
 *
 * Deliberately *not* `safeError`: a driver error's `message` can contain the
 * failing SQL, parameter values (learner ids, answers) and sometimes the
 * connection string. The error's class and its driver error code are enough to
 * route an incident and carry no payload.
 */
export function safeFailureContext(error: unknown): Record<string, string> {
  const out: Record<string, string> = { errorName: "NonError" };
  if (error instanceof Error) {
    out.errorName = safeLabel(error.name, "Error");
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      out.errorCode = safeLabel(String(code), "unknown");
    }
  }
  return out;
}
