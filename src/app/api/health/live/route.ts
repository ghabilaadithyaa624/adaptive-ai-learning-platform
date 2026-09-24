import { liveness } from "@/lib/observability/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness probe — is the process up and the event loop turning? No dependency
 * calls, so a slow/unreachable database never trips a container restart.
 */
export async function GET() {
  const result = liveness();
  return Response.json(
    { status: "alive", service: "adaptiq", uptimeSeconds: result.uptimeSeconds, timestamp: new Date().toISOString() },
    { status: 200 },
  );
}
