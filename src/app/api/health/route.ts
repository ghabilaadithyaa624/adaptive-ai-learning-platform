import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ensureSeededSafe } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  const seed = await ensureSeededSafe();
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

  return Response.json({
    status: "ok",
    service: "adaptiq",
    database,
    seeded: seed.seeded,
    seedError: seed.seeded ? undefined : seed.error,
    counts,
    timestamp: new Date().toISOString(),
  });
}
