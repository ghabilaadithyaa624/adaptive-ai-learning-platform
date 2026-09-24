import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import type { User } from "@/db/schema";
import { HttpError, isHttpError, unauthorized } from "@/lib/http";
import { assertSameOrigin, clientIp } from "@/lib/request-context";
import { recordAudit } from "@/lib/audit";
import {
  log,
  metrics,
  now,
  resolveRequestId,
  runWithContext,
  updateContext,
  type RequestContext,
} from "@/lib/observability";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data as Record<string, unknown>, { status });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export type AuthContext = {
  user: User;
  request: Request;
  ip: string;
};

/**
 * Collapse a concrete request path into a low-cardinality route template so
 * metric/label cardinality stays bounded (e.g. `/api/assessments/42/answer` ->
 * `/api/assessments/:id/answer`).
 */
function routeTemplate(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) ? ":id" : segment))
    .join("/");
}

/**
 * The observability envelope wrapped around every API request:
 *   - establishes the correlation context (honouring inbound `x-request-id` /
 *     `x-correlation-id`, otherwise minting one),
 *   - times the request and records latency + traffic + error-rate metrics,
 *     tagged by method / route / status,
 *   - emits one structured `api.request` log line,
 *   - echoes the correlation id back on `x-request-id`.
 */
function observeRequest(request: Request, run: (ip: string) => Promise<Response>): Promise<Response> {
  const ip = clientIp(request);
  const requestId = resolveRequestId(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const url = new URL(request.url);
  const route = routeTemplate(url.pathname);
  const method = request.method.toUpperCase();

  const ctx: RequestContext = { requestId, method, route, ip, startedAt: now() };

  return runWithContext(ctx, async () => {
    const start = now();
    let response: Response;
    try {
      response = await run(ip);
    } catch (error) {
      // Handlers already catch via handleError; this is a last-resort net so an
      // unexpected throw still produces a metered, opaque 500.
      metrics.appErrorsTotal.inc({ type: "unhandled" });
      log.exception("api.unhandled", error, { route, method });
      response = fail("Something went wrong. Please try again.", 500);
    }

    const durationMs = now() - start;
    const status = response.status;
    const statusLabel = String(status);
    metrics.httpRequestsTotal.inc({ method, route, status: statusLabel });
    metrics.httpRequestDuration.observe(durationMs / 1000, { method, route, status: statusLabel });
    if (status >= 500) metrics.appErrorsTotal.inc({ type: "http_5xx" });

    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    log[level]("api.request", { method, route, status, durationMs: Math.round(durationMs) });

    try {
      response.headers.set("x-request-id", requestId);
    } catch {
      // some Response variants have immutable headers — non-fatal
    }
    return response;
  });
}

/**
 * Central API guard. Every route handler runs inside this:
 *   1. establishes the correlation context + request metrics/logging,
 *   2. authenticates the session (401 if absent),
 *   3. enforces same-origin (CSRF) on state-changing methods,
 *   4. runs the handler,
 *   5. converts thrown `HttpError`s into safe JSON responses (auditing denials),
 *   6. converts any *unexpected* error into a generic 500 — never leaking
 *      internal error messages / stack traces to the client.
 */
export async function withAuth(
  request: Request,
  handler: (ctx: AuthContext) => Promise<Response>,
): Promise<Response> {
  return observeRequest(request, async (ip) => {
    const user = await getCurrentUser();
    if (!user) {
      return fail("You must sign in to continue.", 401);
    }
    updateContext({ userId: user.id, role: user.role, institutionId: user.institutionId });

    try {
      assertSameOrigin(request);
      return await handler({ user, request, ip });
    } catch (error) {
      return handleError(error, { user, ip });
    }
  });
}

/** For endpoints that must run without an authenticated session (e.g. auth). */
export async function guardPublic(
  request: Request,
  handler: (ctx: { request: Request; ip: string }) => Promise<Response>,
): Promise<Response> {
  return observeRequest(request, async (ip) => {
    try {
      assertSameOrigin(request);
      return await handler({ request, ip });
    } catch (error) {
      return handleError(error, { user: null, ip });
    }
  });
}

export async function handleError(
  error: unknown,
  ctx: { user: User | null; ip: string },
): Promise<Response> {
  if (isHttpError(error)) {
    if (error.auditAction) {
      await recordAudit({
        actor: ctx.user,
        action: error.auditAction,
        outcome: error.auditOutcome,
        ip: ctx.ip,
        detail: error.publicMessage,
      });
    }
    return fail(error.publicMessage, error.status);
  }
  // Unexpected: log the real cause server-side, return an opaque message.
  metrics.appErrorsTotal.inc({ type: "unhandled" });
  log.exception("api.unhandled_error", error);
  return fail("Something went wrong. Please try again.", 500);
}

/**
 * Backwards-compatible wrapper retained for endpoints not yet migrated. It now
 * routes through the same safe error handling. Prefer `withAuth`.
 */
export async function withUser(handler: (user: User) => Promise<Response>): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return fail("You must sign in to continue.", 401);
  try {
    return await handler(user);
  } catch (error) {
    if (isHttpError(error)) return fail(error.publicMessage, error.status);
    metrics.appErrorsTotal.inc({ type: "unhandled" });
    log.exception("api.unhandled_error", error);
    return fail("Something went wrong. Please try again.", 500);
  }
}

export { HttpError, unauthorized };

export function toNumber(value: unknown, fallback = 0) {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => toNumber(entry, -1)).filter((id) => id > 0);
}
