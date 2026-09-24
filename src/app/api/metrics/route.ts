import { registry } from "@/lib/observability";
import "@/db"; // ensure the DB pool is instrumented + its gauges are registered

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Prometheus scrape endpoint (text exposition format).
 *
 * Auth model: if `METRICS_TOKEN` is set, the scraper must present it as a
 * `Bearer` token (Prometheus `authorization` config) — metrics can reveal
 * traffic shape and should not be world-readable in production. When the env
 * var is unset (local dev), the endpoint is open. See OBSERVABILITY.md.
 */
export async function GET(request: Request) {
  const token = process.env.METRICS_TOKEN;
  if (token) {
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
