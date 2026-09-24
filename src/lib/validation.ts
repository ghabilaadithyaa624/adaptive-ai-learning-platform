/**
 * Lightweight, dependency-free input validation.
 *
 * Centralizes coercion + bounds checking so every route validates untrusted
 * input the same way and rejects malformed / oversized payloads instead of
 * silently coercing them. Throws `HttpError(400)` on failure.
 */
import { badRequest } from "@/lib/http";

/** Hard cap on request body size (defense against memory-exhaustion DoS). */
export const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const MAX_STRING = 5_000;
const MAX_ARRAY = 500;

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw badRequest("Request body is too large.");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw badRequest("Request body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw badRequest("Invalid JSON payload.");
  }
}

export function reqString(value: unknown, field: string, opts: { min?: number; max?: number; trim?: boolean } = {}) {
  const trim = opts.trim ?? true;
  if (typeof value !== "string") throw badRequest(`${field} is required.`);
  const out = trim ? value.trim() : value;
  const max = opts.max ?? MAX_STRING;
  if (out.length > max) throw badRequest(`${field} is too long.`);
  if ((opts.min ?? 1) > out.length) throw badRequest(`${field} is required.`);
  return out;
}

export function optString(value: unknown, field: string, opts: { max?: number } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest(`${field} must be a string.`);
  const out = value.trim();
  if (out.length > (opts.max ?? MAX_STRING)) throw badRequest(`${field} is too long.`);
  return out;
}

export function reqEmail(value: unknown, field = "Email") {
  const email = reqString(value, field).toLowerCase();
  // Pragmatic RFC-ish check; not attempting full RFC 5322.
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw badRequest(`${field} is not a valid email address.`);
  }
  return email;
}

export function reqInt(value: unknown, field: string, opts: { min?: number; max?: number } = {}) {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw badRequest(`${field} must be an integer.`);
  if (opts.min !== undefined && n < opts.min) throw badRequest(`${field} is out of range.`);
  if (opts.max !== undefined && n > opts.max) throw badRequest(`${field} is out of range.`);
  return n;
}

/** Parse a route/query id (positive integer). */
export function parseId(value: unknown, field = "id") {
  return reqInt(value, field, { min: 1, max: Number.MAX_SAFE_INTEGER });
}

export function optNumber(value: unknown, fallback: number, opts: { min?: number; max?: number } = {}) {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  let out = Number.isFinite(n) ? n : fallback;
  if (opts.min !== undefined) out = Math.max(opts.min, out);
  if (opts.max !== undefined) out = Math.min(opts.max, out);
  return out;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  const v = typeof value === "string" ? value : "";
  if ((allowed as readonly string[]).includes(v)) return v as T;
  if (fallback !== undefined) return fallback;
  throw badRequest(`${field} must be one of: ${allowed.join(", ")}.`);
}

export function optBool(value: unknown, fallback: boolean) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return Boolean(value);
}

export function idList(value: unknown, field = "ids"): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${field} must be an array.`);
  if (value.length > MAX_ARRAY) throw badRequest(`${field} has too many entries.`);
  return value
    .map((entry) => (typeof entry === "string" ? Number(entry) : typeof entry === "number" ? entry : NaN))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function stringList(value: unknown, field = "options", opts: { max?: number; maxLen?: number } = {}): string[] {
  if (!Array.isArray(value)) throw badRequest(`${field} must be an array.`);
  if (value.length > (opts.max ?? MAX_ARRAY)) throw badRequest(`${field} has too many entries.`);
  return value
    .map((entry) => String(entry))
    .map((entry) => {
      if (entry.length > (opts.maxLen ?? MAX_STRING)) throw badRequest(`${field} entry is too long.`);
      return entry;
    })
    .filter((entry) => entry.trim().length > 0);
}

/**
 * Password policy for account creation / password changes.
 * Minimum 8 chars with at least one letter and one number. Kept deliberately
 * moderate so existing demo credentials and real users are not locked out.
 */
export function validatePassword(value: unknown): string {
  if (typeof value !== "string") throw badRequest("A password is required.");
  if (value.length < 8) throw badRequest("Password must be at least 8 characters.");
  if (value.length > 200) throw badRequest("Password is too long.");
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    throw badRequest("Password must contain at least one letter and one number.");
  }
  return value;
}
