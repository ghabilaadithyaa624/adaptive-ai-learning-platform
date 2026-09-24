import { registry } from "@/lib/observability";
import "@/db"; // ensure the DB pool is instrumented + its gauges are registered

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Prometheus scrape endpoint (text exposition format).
 *
 * Auth model: the scraper must present `METRICS_TOKEN` as a `Bearer` token
 * (Prometheus `authorization` config) — metrics can reveal traffic shape and
 * must not be world-readable. FAIL CLOSED: if `METRICS_TOKEN` is unset in
 * production the endpoint is disabled (404) rather than served unauthenticated.
 * Outside production, an unset token leaves the endpoint open for local dev.
 * See OBSERVABILITY.md.
 */
export async function GET(request: Request) {
  const token = process.env.METRICS_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === "production") {
      // Never expose metrics unauthenticated in production.
      return new Response("Not found\n", { status: 404 });
    }
  } else {
    const header = request.headers.get("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (provided !== token) {
      return new Response("Unauthorized\n", { status: 401 });
    }
  }

  const body = registry.render();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
