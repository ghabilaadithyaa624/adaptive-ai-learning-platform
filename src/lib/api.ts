import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import type { User } from "@/db/schema";
import { HttpError, isHttpError, unauthorized } from "@/lib/http";
import { assertSameOrigin, clientIp } from "@/lib/request-context";
import { recordAudit } from "@/lib/audit";

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
 * Central API guard. Every route handler runs inside this:
 *   1. authenticates the session (401 if absent),
 *   2. enforces same-origin (CSRF) on state-changing methods,
 *   3. runs the handler,
 *   4. converts thrown `HttpError`s into safe JSON responses (auditing denials),
 *   5. converts any *unexpected* error into a generic 500 — never leaking
 *      internal error messages / stack traces to the client.
 */
export async function withAuth(
  request: Request,
  handler: (ctx: AuthContext) => Promise<Response>,
): Promise<Response> {
  const ip = clientIp(request);
  const user = await getCurrentUser();
  if (!user) {
    return fail("You must sign in to continue.", 401);
  }

  try {
    assertSameOrigin(request);
    return await handler({ user, request, ip });
  } catch (error) {
    return handleError(error, { user, ip });
  }
}

/** For endpoints that must run without an authenticated session (e.g. auth). */
export async function guardPublic(
  request: Request,
  handler: (ctx: { request: Request; ip: string }) => Promise<Response>,
): Promise<Response> {
  const ip = clientIp(request);
  try {
    assertSameOrigin(request);
    return await handler({ request, ip });
  } catch (error) {
    return handleError(error, { user: null, ip });
  }
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
  console.error("[api] unhandled error", error);
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
    console.error("[api] unhandled error", error);
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
