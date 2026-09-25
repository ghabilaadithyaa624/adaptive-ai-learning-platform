import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Edge interception (Next.js "proxy" convention).
 *
 * Renamed from `src/middleware.ts` for Next 16, which deprecates the
 * `middleware` file convention in favour of `proxy` (having both is a build
 * error). The module must export a function named `proxy` — Next resolves
 * `mod.proxy ?? mod.default` for this file, and throws E394 otherwise.
 *
 * SCOPE — read before adding to this file: this layer performs NO
 * authentication or authorization. It only attaches a CSP + nonce. Auth gating
 * lives in `lib/auth` (sessions), `lib/api` (`withAuth`/`guardPublic`),
 * `lib/authz` (roles, capabilities, tenancy) and `lib/page-guards` (RSC pages),
 * where the database is reachable and decisions can be audited. Keeping
 * authorization out of the edge is also what makes the platform immune to the
 * class of CVEs where a crafted request bypasses edge-evaluated auth.
 *
 * Content-Security-Policy (defense-in-depth against XSS/injection).
 *
 * We emit a per-request nonce and use `strict-dynamic`, which is the approach
 * Next.js documents for the App Router: when a CSP header is present on the
 * request, Next automatically stamps the same nonce onto the framework's own
 * inline/bootstrap scripts, so we get a strict policy WITHOUT `'unsafe-inline'`
 * for scripts.
 *
 * `style-src` keeps `'unsafe-inline'` because Next/Tailwind inject inline
 * styles that are not nonce-tagged. `frame-ancestors` is intentionally NOT set
 * so the app can still be embedded in trusted preview environments (matching
 * the existing X-Frame-Options decision); tighten it in a real deployment.
 */
export function proxy(request: NextRequest) {
  const isProd = process.env.NODE_ENV === "production";
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const csp = [
    `default-src 'self'`,
    // 'strict-dynamic' + nonce lets scripts loaded by trusted scripts run,
    // while blocking injected inline/external scripts. 'unsafe-eval' is only
    // permitted in dev, where Next's HMR requires it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? "" : " 'unsafe-eval'"}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    // In dev the browser opens a websocket back to the HMR server.
    `connect-src 'self'${isProd ? "" : " ws: wss:"}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-src 'self'`,
    ...(isProd ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  // Pass the nonce through on the request so Next can apply it to its scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // Apply to all routes except static assets and image optimization output.
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
    },
  ],
};
