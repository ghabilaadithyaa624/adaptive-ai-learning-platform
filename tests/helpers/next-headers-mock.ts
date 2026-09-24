/**
 * In-memory replacement for `next/headers` `cookies()` used by the API/auth
 * suites. It is a real, mutable cookie jar shared across the module graph, so
 * `createSession` (which calls `cookies().set(...)`) and `getCurrentUser`
 * (which calls `cookies().get(...)`) interoperate exactly as they do at runtime
 * — letting us exercise the genuine session flow against a real database
 * without a running Next.js server.
 *
 * API test files activate it with:
 *   vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
 */
const jar = new Map<string, string>();

export async function cookies() {
  return {
    get(name: string) {
      return jar.has(name) ? { name, value: jar.get(name)! } : undefined;
    },
    set(name: string, value: string, ..._opts: unknown[]) {
      void _opts;
      jar.set(name, value);
    },
    delete(name: string) {
      jar.delete(name);
    },
    has(name: string) {
      return jar.has(name);
    },
  };
}

/** Test-only controls (prefixed so they never collide with the real API). */
export function __resetCookies() {
  jar.clear();
}
export function __getCookie(name = "adaptiq_session") {
  return jar.get(name);
}
