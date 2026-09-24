import { readiness } from "@/lib/observability/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Readiness probe — can we serve traffic right now? Checks PostgreSQL
 * reachability and core schema presence. Returns 503 when a critical
 * dependency is down so the load balancer / orchestrator stops routing to this
 * instance without killing it.
 */
export async function GET() {
  const { status, checks } = await readiness();
  const httpStatus = status === "fail" ? 503 : 200;
  return Response.json(
    { status: status === "fail" ? "unready" : "ready", service: "adaptiq", checks, timestamp: new Date().toISOString() },
    { status: httpStatus },
  );
}
