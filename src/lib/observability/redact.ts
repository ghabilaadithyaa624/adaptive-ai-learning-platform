/**
 * Redaction — the safety net that keeps secrets and unnecessary PII out of logs.
 *
 * Policy (see OBSERVABILITY.md § "Sensitive data"):
 *   - Credentials / session material are DROPPED entirely (never logged).
 *   - Direct PII (email, name, phone, …) is MASKED, never emitted in the clear.
 *   - Opaque identifiers (numeric user / student / question ids) are ALLOWED —
 *     they are required for correlation and are not themselves sensitive.
 *   - Free-text learner content (question stems, answers, goals) is treated as
 *     PII and masked; call sites should simply never pass it.
 *
 * Every structured field bag passes through `redact()` before serialization, so
 * a careless call site cannot leak a secret it happened to include.
 */

/** Keys whose values are secrets — dropped completely. */
const SECRET_KEYS = new Set([
  "password",
  "passwordhash",
  "password_hash",
  "newpassword",
  "currentpassword",
  "token",
  "sessiontoken",
  "session_token",
  "session",
  "sessionid",
  "cookie",
  "setcookie",
  "authorization",
  "auth",
  "secret",
  "apikey",
  "api_key",
  "accesstoken",
  "refreshtoken",
  "csrf",
  "csrftoken",
  "privatekey",
]);

/** Keys treated as personal data — masked rather than dropped. */
const PII_KEYS = new Set([
  "email",
  "name",
  "fullname",
  "firstname",
  "lastname",
  "phone",
  "phonenumber",
  "address",
  "dob",
  "birthdate",
  "goal",
  "stem",
  "answer",
  "studentanswer",
  "explanation",
]);

const MAX_STRING = 512;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Mask an email as `a***@e***.com`, preserving only shape. */
export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return maskString(value);
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";
  const host = dot >= 0 ? domain.slice(0, dot) : domain;
  return `${local[0] ?? "?"}***@${host[0] ?? "?"}***${tld}`;
}

/** Mask an arbitrary string, keeping only the first character. */
export function maskString(value: string): string {
  if (!value) return "";
  if (value.length <= 2) return "***";
  return `${value[0]}***`;
}

function maskPii(key: string, value: unknown): unknown {
  if (typeof value !== "string") return "[redacted]";
  if (normalizeKey(key) === "email") return maskEmail(value);
  return maskString(value);
}

function truncate(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((entry) => redactValue(entry, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…[+${value.length - MAX_ARRAY}]`);
    return out;
  }
  if (typeof value === "object") return redactObject(value as Record<string, unknown>, depth + 1);
  return String(value);
}

function redactObject(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const norm = normalizeKey(key);
    if (SECRET_KEYS.has(norm)) continue; // drop secrets entirely
    if (PII_KEYS.has(norm)) {
      out[key] = maskPii(key, value);
      continue;
    }
    out[key] = redactValue(value, depth);
  }
  return out;
}

/** Redact a structured field bag prior to logging. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return redactObject(fields, 0);
}

/**
 * Normalize an unknown thrown value into a safe, structured shape. Stack traces
 * are only included outside production (they can embed paths / query fragments).
 */
export function safeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    const includeStack = process.env.NODE_ENV !== "production";
    return {
      name: error.name,
      message: truncate(error.message),
      ...(includeStack && error.stack ? { stack: truncate(error.stack) } : {}),
    };
  }
  return { name: "NonError", message: truncate(String(error)) };
}
