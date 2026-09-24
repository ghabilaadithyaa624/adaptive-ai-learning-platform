/**
 * Typed HTTP errors used across the API surface.
 *
 * Handlers (and the centralized authorization layer) throw these instead of
 * returning ad-hoc responses. `withAuth` converts them into safe JSON error
 * responses with the right status code, while logging the real cause
 * server-side. This guarantees we never leak internal error details (stack
 * traces, SQL, etc.) to clients — unexpected errors always become a generic
 * 500.
 */

export type AuditableOutcome = "denied" | "failure";

export class HttpError extends Error {
  readonly status: number;
  /** Safe, user-facing message. Never contains internals. */
  readonly publicMessage: string;
  /** When set, `withAuth` records a security audit entry for this error. */
  readonly auditAction?: string;
  readonly auditOutcome: AuditableOutcome;

  constructor(
    status: number,
    publicMessage: string,
    options: { auditAction?: string; auditOutcome?: AuditableOutcome } = {},
  ) {
    super(publicMessage);
    this.name = "HttpError";
    this.status = status;
    this.publicMessage = publicMessage;
    this.auditAction = options.auditAction;
    this.auditOutcome = options.auditOutcome ?? "failure";
  }
}

export function unauthorized(message = "You must sign in to continue.", auditAction?: string) {
  return new HttpError(401, message, { auditAction, auditOutcome: "denied" });
}

export function forbidden(message = "You do not have permission to do that.", auditAction?: string) {
  return new HttpError(403, message, { auditAction, auditOutcome: "denied" });
}

export function badRequest(message = "Invalid request.") {
  return new HttpError(400, message, { auditOutcome: "failure" });
}

export function notFound(message = "Not found.") {
  return new HttpError(404, message, { auditOutcome: "failure" });
}

export function conflict(message = "That resource already exists.") {
  return new HttpError(409, message, { auditOutcome: "failure" });
}

export function tooManyRequests(message = "Too many requests. Please slow down and try again shortly.") {
  return new HttpError(429, message, { auditOutcome: "denied" });
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
