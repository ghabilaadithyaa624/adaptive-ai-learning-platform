import { sql } from "drizzle-orm";
import { db } from "@/db";
import { deepHealth } from "@/lib/observability/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Deep health / status endpoint for humans, uptime checks, and the operations
 * dashboard. Reports the application, PostgreSQL, and critical dependencies
 * with per-check latency, plus table counts for a quick data-presence sanity
 * check.
 *
 * Unlike the previous implementation this endpoint does NOT trigger database
 * seeding — a health check must be a cheap, read-only observation.
 *
 * Returns HTTP 503 when a critical dependency is failing so uptime monitors and
 * orchestrators react correctly.
 */
export async function GET() {
  const health = await deepHealth();

  let database: "up" | "down" = "down";
  let counts: Record<string, number> = {};
  try {
    const result = await db.execute(
      sql`select
        (select count(*)::int from users) as users,
        (select count(*)::int from skills) as skills,
        (select count(*)::int from questions) as questions,
        (select count(*)::int from assessments) as assessments,
        (select count(*)::int from recommendations) as recommendations`,
    );
    const row = (result.rows?.[0] ?? {}) as Record<string, number>;
    counts = {
      users: Number(row.users ?? 0),
      skills: Number(row.skills ?? 0),
      questions: Number(row.questions ?? 0),
      assessments: Number(row.assessments ?? 0),
      recommendations: Number(row.recommendations ?? 0),
    };
    database = "up";
  } catch {
    database = "down";
  }

  const status = health.status === "pass" ? "ok" : health.status === "warn" ? "degraded" : "error";
  const httpStatus = health.status === "fail" ? 503 : 200;

  return Response.json(
    {
      status,
      service: "adaptiq",
      database,
      seeded: counts.users > 0,
      uptimeSeconds: health.uptimeSeconds,
      checks: health.checks,
      counts,
      timestamp: new Date().toISOString(),
    },
    { status: httpStatus },
  );
}
