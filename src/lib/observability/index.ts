/**
 * Observability barrel — structured logging, metrics, correlation context,
 * domain event emitters, and health checks.
 *
 * See OBSERVABILITY.md for the full design (signals, dashboard, alerting, and
 * the sensitive-data policy).
 */
export { log } from "./logger";
export { metrics, registry, now, Counter, Gauge, Histogram, Registry } from "./metrics";
export { events } from "./events";
export {
  getContext,
  updateContext,
  runWithContext,
  resolveRequestId,
  currentRequestId,
  type RequestContext,
} from "./context";
export { redact, safeError, maskEmail, maskString } from "./redact";
export * as health from "./health";
