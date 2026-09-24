/**
 * Request-level helpers: client IP extraction and CSRF (same-origin) checks.
 */
import { forbidden } from "@/lib/http";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    "unknown"
  );
}

function candidateHosts(request: Request): Set<string> {
  return new Set(
    [request.headers.get("x-forwarded-host"), request.headers.get("host")]
      .filter((h): h is string => Boolean(h))
      .map((h) => h.toLowerCase()),
  );
}

/**
 * CSRF defense for state-changing requests.
 *
 * Uses `Sec-Fetch-Site` (sent by all modern browsers) as the primary signal
 * and falls back to comparing the `Origin` host against the request host.
 * Same-origin / user-initiated navigations are allowed; cross-site requests
 * are rejected. Non-browser clients (no Origin, no Sec-Fetch-Site) are allowed
 * since they cannot be victims of a browser-driven CSRF.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (!MUTATION_METHODS.has(method)) return;

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) {
    if (secFetchSite === "cross-site") {
      throw forbidden("Cross-origin request blocked.", "security.csrf");
    }
    // same-origin | same-site | none -> allowed
    return;
  }

  const origin = request.headers.get("origin");
  if (!origin) return; // no browser origin => not a CSRF vector

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw forbidden("Invalid request origin.", "security.csrf");
  }
  if (!candidateHosts(request).has(originHost)) {
    throw forbidden("Cross-origin request blocked.", "security.csrf");
  }
}
