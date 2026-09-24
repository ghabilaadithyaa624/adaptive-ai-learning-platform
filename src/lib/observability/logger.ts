/**
 * Structured JSON logger.
 *
 * One JSON object per line (newline-delimited JSON), the lingua franca of
 * modern log pipelines (Loki, CloudWatch, Elastic, Datadog…). Every line is
 * automatically enriched with the active request-correlation context and every
 * field bag is redacted before serialization, so secrets / PII cannot leak even
 * from a careless call site.
 *
 * Log level is controlled by `LOG_LEVEL` (debug|info|warn|error|silent). In the
 * `test` environment it defaults to `silent` to keep test output clean; in all
 * other environments it defaults to `info`.
 */
import { getContext } from "./context";
import { redact, safeError } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function threshold(): number {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  if (configured && configured in LEVEL_WEIGHT) return LEVEL_WEIGHT[configured as keyof typeof LEVEL_WEIGHT];
  if (process.env.NODE_ENV === "test") return LEVEL_WEIGHT.silent;
  return LEVEL_WEIGHT.info;
}

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < threshold()) return;

  const ctx = getContext();
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  if (ctx) {
    line.requestId = ctx.requestId;
    if (ctx.method) line.method = ctx.method;
    if (ctx.route) line.route = ctx.route;
    if (ctx.userId != null) line.userId = ctx.userId;
    if (ctx.role != null) line.role = ctx.role;
    if (ctx.institutionId != null) line.institutionId = ctx.institutionId;
  }
  if (fields) Object.assign(line, redact(fields));

  const serialized = JSON.stringify(line);
  // warn/error go to stderr; everything else to stdout — standard 12-factor.
  if (level === "error" || level === "warn") process.stderr.write(`${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
  /** Log an error event, folding a normalized `error` object into the fields. */
  exception: (event: string, error: unknown, fields?: Record<string, unknown>) =>
    emit("error", event, { ...(fields ?? {}), error: safeError(error) }),
};
