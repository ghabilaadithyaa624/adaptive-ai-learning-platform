/**
 * Request-level helpers: client IP extraction and CSRF (same-origin) checks.
 */
import { forbidden } from "@/lib/http";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Extract the client IP, honouring a configured trusted-proxy depth so the
 * value cannot be spoofed by a client-supplied `X-Forwarded-For` header.
 *
 * `X-Forwarded-For` is a left-to-right chain where each proxy APPENDS the IP of
 * the peer that connected to it. If there are `TRUSTED_PROXY_COUNT` (k) trusted
 * reverse proxies in front of the app, the k right-most entries were added by
 * our own infrastructure; the entry at index `len - k` is the client IP as seen
 * by the outermost trusted proxy and is NOT client-controllable. Anything
 * further left in the chain is attacker-supplied and must be ignored.
 *
 * Default k=0 resolves to the right-most entry (the nearest-proxy-observed peer)
 * — the correct, non-spoofable choice behind a single reverse proxy. Operators
 * running multiple proxies (e.g. CDN + load balancer) should set
 * TRUSTED_PROXY_COUNT to the number of trusted hops. See .env.example.
 */
export function clientIp(request: Request): string {
  const trusted = Math.max(0, Number.parseInt(process.env.TRUSTED_PROXY_COUNT ?? "0", 10) || 0);
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) {
      const idx = Math.max(0, Math.min(parts.length - 1, parts.length - trusted));
      return parts[idx]!;
    }
  }
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
