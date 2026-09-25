/**
 * Runtime contract for persisted JSON (JSONB) structures.
 *
 * Database JSON columns are *untyped at runtime*. Drizzle's `$type<...>()` is a
 * compile-time assertion only: it tells TypeScript what we *hope* is in the
 * column, and the compiler then happily lets us index into it. Anything that
 * ever wrote to that column — an older release, a migration, a hand-run SQL
 * fix, a partially-failed write — can leave a shape the current code does not
 * understand, and the cast makes that indistinguishable from valid data.
 *
 * This module is the small, dependency-free core every persistence parser in
 * `src/lib/persistence` is built on. It intentionally mirrors the style of
 * `src/lib/validation.ts` (hand-written, explicit, no schema framework) because
 * the project already rejects heavyweight validation dependencies — but it is a
 * *separate* module: `validation.ts` validates untrusted **request input** and
 * throws `HttpError(400)`; this validates **our own persisted state**, where a
 * failure is an operational/data-integrity fault, not a client error.
 *
 * Three outcomes are distinguished, and the distinction matters operationally:
 *
 *  • `VALID`               — the payload matches a supported version. Use it.
 *  • `INVALID`             — the payload is malformed: missing field, wrong
 *                            type, corrupted nesting, null where an object was
 *                            required. This is a data-integrity bug; page it.
 *  • `UNSUPPORTED_VERSION` — the payload is *well-formed* but was written by a
 *                            schema version this build cannot interpret
 *                            (usually a rollback behind a newer writer). This
 *                            is a deployment problem, not corruption, and it is
 *                            recoverable by rolling forward.
 *
 * Nothing here coerces. A number-shaped string is not a number, `null` is not
 * an empty object, and a missing field is never defaulted unless the field is
 * explicitly declared optional with a documented default.
 */

export type ParseStatus = "VALID" | "INVALID" | "UNSUPPORTED_VERSION";

/** Machine-readable failure taxonomy, stable enough to alert on. */
export type ParseFailureCode =
  | "MISSING_FIELD"
  | "WRONG_TYPE"
  | "OUT_OF_RANGE"
  | "MALFORMED_STRUCTURE"
  | "UNKNOWN_MEMBER"
  | "UNSUPPORTED_VERSION";

/**
 * A structured, log-safe description of why a persisted value was rejected.
 * Deliberately free of the offending value itself: persisted payloads can carry
 * learner data, and this object is designed to be emitted straight into logs.
 */
export interface ParseIssue {
  /** Logical persistence boundary, e.g. `ml_models.params`. */
  readonly boundary: string;
  readonly code: ParseFailureCode;
  /** Dotted path within the payload, e.g. `variants[1].config.policy`. */
  readonly path: string;
  /** Short operator-facing explanation. Never contains the payload. */
  readonly message: string;
  /** Type/shape actually observed (`"string"`, `"array"`, `"null"`, …). */
  readonly observed?: string;
  /** Version string read off the payload, when one was present. */
  readonly version?: string;
  /** Versions this build can interpret, for `UNSUPPORTED_VERSION`. */
  readonly supportedVersions?: readonly string[];
}

export type ParseResult<T> =
  | { readonly status: "VALID"; readonly value: T }
  | { readonly status: "INVALID"; readonly issue: ParseIssue }
  | { readonly status: "UNSUPPORTED_VERSION"; readonly issue: ParseIssue };

export type ParseFailure = Extract<ParseResult<unknown>, { status: "INVALID" | "UNSUPPORTED_VERSION" }>;

export function isValid<T>(result: ParseResult<T>): result is { status: "VALID"; value: T } {
  return result.status === "VALID";
}

/* ------------------------------------------------------------------ */
/* Operational error                                                   */
/* ------------------------------------------------------------------ */

/**
 * Thrown by the `...OrThrow` helpers when a caller cannot meaningfully continue
 * without the persisted structure (e.g. experiment variants: there is no safe
 * default arm). Carries the structured issue so log sites emit fields rather
 * than a formatted string.
 *
 * This is deliberately NOT an `HttpError`: it is not the caller's fault and it
 * must not be rendered as a 400. Route-level handlers map it to a 500 through
 * the existing generic-error path, which already avoids leaking internals.
 */
export class PersistedDataError extends Error {
  readonly name = "PersistedDataError";
  readonly status: Exclude<ParseStatus, "VALID">;
  readonly issue: ParseIssue;

  constructor(status: Exclude<ParseStatus, "VALID">, issue: ParseIssue) {
    super(`${status} persisted payload at ${issue.boundary} (${issue.path}): ${issue.message}`);
    this.status = status;
    this.issue = issue;
  }

  /** Flat field bag for the structured logger / metrics labels. */
  toFields(): Record<string, unknown> {
    return {
      parseStatus: this.status,
      boundary: this.issue.boundary,
      code: this.issue.code,
      path: this.issue.path,
      reason: this.issue.message,
      ...(this.issue.observed ? { observed: this.issue.observed } : {}),
      ...(this.issue.version ? { payloadVersion: this.issue.version } : {}),
      ...(this.issue.supportedVersions ? { supportedVersions: [...this.issue.supportedVersions] } : {}),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Internal control flow                                               */
/* ------------------------------------------------------------------ */

/**
 * Internal signal used to unwind out of a nested parser. Never escapes this
 * package: `runParser` converts it into a `ParseResult`.
 */
class ParseAbort extends Error {
  constructor(
    readonly parseStatus: Exclude<ParseStatus, "VALID">,
    readonly partial: Omit<ParseIssue, "boundary">,
  ) {
    super(partial.message);
    this.name = "ParseAbort";
  }
}

export function fail(partial: Omit<ParseIssue, "boundary">): never {
  throw new ParseAbort("INVALID", partial);
}

export function failUnsupportedVersion(partial: Omit<ParseIssue, "boundary" | "code">): never {
  throw new ParseAbort("UNSUPPORTED_VERSION", { ...partial, code: "UNSUPPORTED_VERSION" });
}

/**
 * Run a parser body, converting aborts into results. Any *unexpected* throw is
 * also reported as `INVALID` rather than propagating: a parser must never be a
 * new source of crashes on the read path.
 */
export function runParser<T>(boundary: string, body: () => T): ParseResult<T> {
  try {
    return { status: "VALID", value: body() };
  } catch (error) {
    if (error instanceof ParseAbort) {
      const issue: ParseIssue = { boundary, ...error.partial };
      return error.parseStatus === "UNSUPPORTED_VERSION"
        ? { status: "UNSUPPORTED_VERSION", issue }
        : { status: "INVALID", issue };
    }
    return {
      status: "INVALID",
      issue: {
        boundary,
        code: "MALFORMED_STRUCTURE",
        path: "$",
        message: "parser failed unexpectedly while reading the persisted payload",
      },
    };
  }
}

/** Turn a non-VALID result into the operational error. */
export function toError(result: ParseFailure): PersistedDataError {
  return new PersistedDataError(result.status, result.issue);
}

/* ------------------------------------------------------------------ */
/* Shape primitives                                                    */
/* ------------------------------------------------------------------ */

/** Describe what we actually got, for the issue report. Value never included. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || value === undefined) {
    fail({ code: "MISSING_FIELD", path, message: "expected an object, found nothing", observed: describe(value) });
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    fail({ code: "WRONG_TYPE", path, message: "expected a JSON object", observed: describe(value) });
  }
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown, path: string, opts: { max?: number } = {}): unknown[] {
  if (value === null || value === undefined) {
    fail({ code: "MISSING_FIELD", path, message: "expected an array, found nothing", observed: describe(value) });
  }
  if (!Array.isArray(value)) {
    fail({ code: "WRONG_TYPE", path, message: "expected a JSON array", observed: describe(value) });
  }
  if (opts.max !== undefined && value.length > opts.max) {
    fail({ code: "OUT_OF_RANGE", path, message: `array has more than ${opts.max} entries` });
  }
  return value;
}

export function expectString(
  value: unknown,
  path: string,
  opts: { min?: number; max?: number } = {},
): string {
  if (value === undefined || value === null) {
    fail({ code: "MISSING_FIELD", path, message: "required string is absent", observed: describe(value) });
  }
  if (typeof value !== "string") {
    fail({ code: "WRONG_TYPE", path, message: "expected a string", observed: describe(value) });
  }
  if (value.length < (opts.min ?? 1)) {
    fail({ code: "OUT_OF_RANGE", path, message: "string is shorter than allowed" });
  }
  if (opts.max !== undefined && value.length > opts.max) {
    fail({ code: "OUT_OF_RANGE", path, message: "string is longer than allowed" });
  }
  return value;
}

/**
 * A finite JSON number. `NaN`/`Infinity` cannot survive a JSON round-trip as
 * numbers, but they arrive as `null` or as strings from sloppy writers — both
 * are rejected rather than coerced, because a silently-zeroed model weight is
 * exactly the failure mode this module exists to prevent.
 */
export function expectFiniteNumber(
  value: unknown,
  path: string,
  opts: { min?: number; max?: number } = {},
): number {
  if (value === undefined || value === null) {
    fail({ code: "MISSING_FIELD", path, message: "required number is absent", observed: describe(value) });
  }
  if (typeof value !== "number") {
    fail({ code: "WRONG_TYPE", path, message: "expected a number (strings are not coerced)", observed: describe(value) });
  }
  if (!Number.isFinite(value)) {
    fail({ code: "OUT_OF_RANGE", path, message: "number must be finite" });
  }
  if (opts.min !== undefined && value < opts.min) {
    fail({ code: "OUT_OF_RANGE", path, message: `number is below the minimum of ${opts.min}` });
  }
  if (opts.max !== undefined && value > opts.max) {
    fail({ code: "OUT_OF_RANGE", path, message: `number is above the maximum of ${opts.max}` });
  }
  return value;
}

export function expectInteger(value: unknown, path: string, opts: { min?: number; max?: number } = {}): number {
  const n = expectFiniteNumber(value, path, opts);
  if (!Number.isInteger(n)) {
    fail({ code: "WRONG_TYPE", path, message: "expected an integer" });
  }
  return n;
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (value === undefined || value === null) {
    fail({ code: "MISSING_FIELD", path, message: "required boolean is absent", observed: describe(value) });
  }
  if (typeof value !== "boolean") {
    fail({ code: "WRONG_TYPE", path, message: "expected a boolean (0/1/\"true\" are not coerced)", observed: describe(value) });
  }
  return value;
}

export function expectNumberArray(
  value: unknown,
  path: string,
  opts: { min?: number; max?: number; length?: number; maxLength?: number } = {},
): number[] {
  const arr = expectArray(value, path, { max: opts.maxLength });
  if (opts.length !== undefined && arr.length !== opts.length) {
    fail({
      code: "MALFORMED_STRUCTURE",
      path,
      message: `expected exactly ${opts.length} numbers, found ${arr.length}`,
    });
  }
  return arr.map((entry, i) => expectFiniteNumber(entry, `${path}[${i}]`, { min: opts.min, max: opts.max }));
}

export function expectStringArray(value: unknown, path: string, opts: { max?: number } = {}): string[] {
  const arr = expectArray(value, path, { max: opts.max });
  return arr.map((entry, i) => expectString(entry, `${path}[${i}]`));
}

export function expectIntegerArray(value: unknown, path: string, opts: { max?: number; min?: number } = {}): number[] {
  const arr = expectArray(value, path, { max: opts.max });
  return arr.map((entry, i) => expectInteger(entry, `${path}[${i}]`, { min: opts.min }));
}

export function expectEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const s = expectString(value, path);
  if (!(allowed as readonly string[]).includes(s)) {
    fail({
      code: "UNKNOWN_MEMBER",
      path,
      message: `value is not one of the permitted members (${allowed.join(", ")})`,
    });
  }
  return s as T;
}

/**
 * A timestamp that survived a JSON round-trip. Postgres returns JSONB dates as
 * ISO strings even though the in-memory type says `Date` — this is one of the
 * concrete lies the old casts told. Reviving the string is an explicit,
 * documented decode of a known encoding, not a coercion of a wrong type: the
 * string must parse to a real instant or the payload is rejected.
 */
export function expectInstant(value: unknown, path: string): Date {
  if (value === undefined || value === null) {
    fail({ code: "MISSING_FIELD", path, message: "required timestamp is absent", observed: describe(value) });
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      fail({ code: "MALFORMED_STRUCTURE", path, message: "timestamp is an Invalid Date" });
    }
    return value;
  }
  if (typeof value !== "string") {
    fail({ code: "WRONG_TYPE", path, message: "expected an ISO-8601 timestamp string", observed: describe(value) });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    fail({ code: "MALFORMED_STRUCTURE", path, message: "timestamp is not a parseable ISO-8601 instant" });
  }
  return parsed;
}

/** Read an optional field: absent/`null` yields `undefined`, anything else is parsed. */
export function optional<T>(value: unknown, read: () => T): T | undefined {
  if (value === undefined || value === null) return undefined;
  return read();
}

/** A `Record<string, number>` with every entry validated. */
export function expectNumberRecord(
  value: unknown,
  path: string,
  opts: { maxKeys?: number } = {},
): Record<string, number> {
  const obj = expectObject(value, path);
  const keys = Object.keys(obj);
  if (opts.maxKeys !== undefined && keys.length > opts.maxKeys) {
    fail({ code: "OUT_OF_RANGE", path, message: `object has more than ${opts.maxKeys} keys` });
  }
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = expectFiniteNumber(obj[key], `${path}.${key}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* Version handling                                                    */
/* ------------------------------------------------------------------ */

export interface VersionPolicy {
  /** Name of the field carrying the schema version. */
  readonly field: string;
  /** Versions this build can interpret. */
  readonly supported: readonly string[];
  /**
   * Version assumed when the field is absent. Payloads written before the
   * version field existed are legacy-but-valid, and must keep working — see
   * requirement "preserve existing valid data". Set to `null` to make the
   * version field mandatory.
   */
  readonly legacyDefault: string | null;
}

/**
 * Resolve and check the schema version of a payload.
 *
 * Ordering is deliberate: a *malformed* version field (wrong type) is `INVALID`,
 * while a well-formed but unrecognised one is `UNSUPPORTED_VERSION`. Conflating
 * them would route a corruption incident to the deploy runbook.
 */
export function resolveVersion(
  obj: Record<string, unknown>,
  path: string,
  policy: VersionPolicy,
): string {
  const raw = obj[policy.field];
  const fieldPath = `${path === "$" ? "$" : path}.${policy.field}`;

  if (raw === undefined || raw === null) {
    if (policy.legacyDefault === null) {
      fail({
        code: "MISSING_FIELD",
        path: fieldPath,
        message: "payload carries no schema version and none can be assumed",
        supportedVersions: policy.supported,
      });
    }
    return policy.legacyDefault;
  }

  if (typeof raw !== "string" || raw.length === 0) {
    fail({
      code: "WRONG_TYPE",
      path: fieldPath,
      message: "schema version must be a non-empty string",
      observed: describe(raw),
      supportedVersions: policy.supported,
    });
  }

  if (!policy.supported.includes(raw)) {
    failUnsupportedVersion({
      path: fieldPath,
      message: "payload was written by a schema version this build cannot interpret",
      version: raw,
      supportedVersions: policy.supported,
    });
  }

  return raw;
}
