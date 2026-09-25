/**
 * Edge-layer (proxy) behavioural equivalence.
 *
 * Next.js 16 renamed the edge-interception convention from `middleware.ts` to
 * `proxy.ts` (`next/dist/lib/constants` → `PROXY_FILENAME`; the build warns on
 * `middleware` and hard-errors if both files exist). The migration is a rename
 * plus an export rename, and this suite is the proof that it is *only* that.
 *
 * `tests/fixtures/edge-headers.golden.json` was generated from the ORIGINAL
 * `src/middleware.ts` before the rename and is asserted against unchanged, so
 * any drift in the emitted CSP, the forwarded request headers, or the matcher
 * fails here rather than in production.
 *
 * Nonces are random per request, so they are normalized to `<N>` — the test
 * separately asserts the nonce is fresh per request and is the same value in
 * the header and the forwarded request.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

import { proxy, config } from "@/proxy";

type Snapshot = {
  status: number;
  csp: string;
  headers: Record<string, string>;
};

const golden = JSON.parse(readFileSync("tests/fixtures/edge-headers.golden.json", "utf8")) as {
  development: Snapshot;
  production: Snapshot;
  apiRoute: Snapshot;
  login: Snapshot;
  config: { matcher: { source: string }[] };
};

const QUOTED_NONCE = /'nonce-[a-f0-9]{32}'/g;

function snap(env: "development" | "production", path: string): Snapshot {
  vi.stubEnv("NODE_ENV", env);
  try {
    const request = new NextRequest(`http://localhost:3000${path}`, {
      headers: { host: "localhost:3000" },
    });
    const response = proxy(request);
    return {
      status: response.status,
      csp: (response.headers.get("content-security-policy") ?? "").replace(QUOTED_NONCE, "'nonce-<N>'"),
      headers: Object.fromEntries(
        [...response.headers.entries()].map(([k, v]) => [
          k,
          v.replace(QUOTED_NONCE, "'nonce-<N>'").replace(/^[a-f0-9]{32}$/, "<N>"),
        ]),
      ),
    };
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("proxy · equivalence with the pre-migration middleware", () => {
  it("emits byte-identical headers in development", () => {
    expect(snap("development", "/dashboard")).toEqual(golden.development);
  });

  it("emits byte-identical headers in production", () => {
    expect(snap("production", "/dashboard")).toEqual(golden.production);
  });

  it("treats API routes exactly as before", () => {
    expect(snap("production", "/api/students")).toEqual(golden.apiRoute);
  });

  it("treats the public login route exactly as before", () => {
    expect(snap("production", "/login")).toEqual(golden.login);
  });

  it("keeps the matcher unchanged", () => {
    expect(config).toEqual(golden.config);
  });
});

describe("proxy · security properties", () => {
  it("passes the request through rather than redirecting or blocking", () => {
    // The edge layer has never made an auth decision; every request continues
    // to the route, which is where authentication actually happens. A redirect
    // or 401 appearing here would be a semantic change.
    const response = proxy(new NextRequest("http://localhost:3000/dashboard"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("never sets an auth cookie or touches the session cookie", () => {
    const request = new NextRequest("http://localhost:3000/dashboard", {
      headers: { cookie: "adaptiq_session=token-value" },
    });
    const response = proxy(request);
    expect(response.headers.get("set-cookie")).toBeNull();
    // The session cookie is forwarded through untouched: the edge layer only
    // ever ADDS the nonce + policy headers, it never rewrites credentials.
    expect(response.headers.get("x-middleware-request-cookie")).toBe("adaptiq_session=token-value");
    const overridden = (response.headers.get("x-middleware-override-headers") ?? "").split(",");
    expect(overridden).toContain("content-security-policy");
    expect(overridden).toContain("x-nonce");
  });

  it("mints a fresh nonce per request", () => {
    const nonces = new Set(
      Array.from({ length: 5 }, () => {
        const response = proxy(new NextRequest("http://localhost:3000/"));
        return response.headers.get("content-security-policy")?.match(/'nonce-([a-f0-9]{32})'/)?.[1];
      }),
    );
    expect(nonces.size).toBe(5);
    expect([...nonces].every((n) => typeof n === "string" && n.length === 32)).toBe(true);
  });

  it("forwards the same nonce it advertises in the policy", () => {
    const response = proxy(new NextRequest("http://localhost:3000/"));
    const headerNonce = response.headers
      .get("content-security-policy")
      ?.match(/'nonce-([a-f0-9]{32})'/)?.[1];
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(headerNonce);
  });

  it("keeps script-src free of 'unsafe-inline' and only allows eval in dev", () => {
    const prod = snap("production", "/").csp;
    expect(prod).toContain("'strict-dynamic'");
    expect(prod).not.toContain("'unsafe-inline'; script");
    expect(prod.split("; ").find((d) => d.startsWith("script-src"))).not.toContain("unsafe-eval");
    expect(snap("development", "/").csp.split("; ").find((d) => d.startsWith("script-src"))).toContain(
      "'unsafe-eval'",
    );
  });

  it("only upgrades insecure requests in production", () => {
    expect(snap("production", "/").csp).toContain("upgrade-insecure-requests");
    expect(snap("development", "/").csp).not.toContain("upgrade-insecure-requests");
  });

  it("still exempts static assets from the matcher", () => {
    const source = config.matcher[0].source;
    const pattern = new RegExp(`^${source}$`);
    // Excluded (served straight from the static pipeline).
    expect(pattern.test("/_next/static/chunk.js")).toBe(false);
    expect(pattern.test("/favicon.ico")).toBe(false);
    expect(pattern.test("/logo.png")).toBe(false);
    // Included (application routes).
    expect(pattern.test("/dashboard")).toBe(true);
    expect(pattern.test("/api/students")).toBe(true);
    expect(pattern.test("/login")).toBe(true);
    expect(pattern.test("/register")).toBe(true);
  });
});
