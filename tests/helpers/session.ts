/**
 * Session helpers for API/auth suites. These drive the *real* session code
 * (`createSession`/`destroySession` from `@/lib/auth`) which reads/writes the
 * mocked cookie jar and inserts real rows into the `sessions` table — so
 * `getCurrentUser` inside route handlers authenticates exactly as in production.
 *
 * NOTE: the importing test file MUST have mocked `next/headers` first, e.g.
 *   vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
 */
import { createSession, destroySession } from "@/lib/auth";
import { __resetCookies } from "./next-headers-mock";

/** Establish an authenticated session for the given user id. */
export async function loginAs(userId: number): Promise<void> {
  await createSession(userId);
}

/** Drop the current session (server-side + cookie). */
export async function logout(): Promise<void> {
  await destroySession();
}

/** Become anonymous without touching the DB (clears the cookie jar only). */
export function becomeAnonymous(): void {
  __resetCookies();
}
