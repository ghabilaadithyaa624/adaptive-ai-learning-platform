import { eq } from "drizzle-orm";
import { db } from "@/db";
import { skills, subjects } from "@/db/schema";
import { fail, ok, toIdList, toNumber, withUser } from "@/lib/api";
import { getSkillCatalog } from "@/lib/queries";
import { clamp } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser(async () => {
    const [catalog, subjectRows] = await Promise.all([getSkillCatalog(), db.select().from(subjects)]);
    return ok({ skills: catalog, subjects: subjectRows });
  });
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot edit the skill taxonomy.", 403);
    const body = (await request.json()) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const code = String(body.code ?? "").trim().toUpperCase();
    const subjectId = toNumber(body.subjectId, 0);
    if (!name || !code) return fail("Skill name and code are required.");
    const existing = await db.select({ id: skills.id }).from(skills).where(eq(skills.code, code)).limit(1);
    if (existing.length) return fail("That skill code is already in use.", 409);

    const [created] = await db
      .insert(skills)
      .values({
        name,
        code,
        subjectId: subjectId || (await db.select({ id: subjects.id }).from(subjects).limit(1))[0]?.id || 1,
        description: String(body.description ?? ""),
        difficultyBase: clamp(toNumber(body.difficultyBase, 0.5), 0.05, 0.98),
        gradeBand: String(body.gradeBand ?? "Core"),
        prereqIds: toIdList(body.prereqIds),
      })
      .returning();
    return ok({ skill: created }, 201);
  });
}
