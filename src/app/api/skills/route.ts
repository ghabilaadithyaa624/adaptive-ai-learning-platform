import { eq } from "drizzle-orm";
import { db } from "@/db";
import { skills, subjects } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { getSkillCatalog } from "@/lib/queries";
import { clamp } from "@/lib/utils";
import { conflict } from "@/lib/http";
import { idList, optString, readJsonBody, reqString } from "@/lib/validation";
import { requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Skill taxonomy is non-sensitive reference data (no answer keys) — readable
  // by any authenticated user so learners can see their skill catalog.
  return withAuth(request, async () => {
    const [catalog, subjectRows] = await Promise.all([getSkillCatalog(), db.select().from(subjects)]);
    return ok({ skills: catalog, subjects: subjectRows });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageContent", "Learners cannot edit the skill taxonomy.", "skills.create");
    const body = await readJsonBody(request);
    const name = reqString(body.name, "Skill name", { max: 200 });
    const code = reqString(body.code, "Skill code", { max: 40 }).toUpperCase();
    const subjectId = toNumber(body.subjectId, 0);
    const existing = await db.select({ id: skills.id }).from(skills).where(eq(skills.code, code)).limit(1);
    if (existing.length) throw conflict("That skill code is already in use.");

    const [created] = await db
      .insert(skills)
      .values({
        name,
        code,
        subjectId: subjectId || (await db.select({ id: subjects.id }).from(subjects).limit(1))[0]?.id || 1,
        description: optString(body.description, "description", { max: 1000 }) ?? "",
        difficultyBase: clamp(toNumber(body.difficultyBase, 0.5), 0.05, 0.98),
        gradeBand: optString(body.gradeBand, "gradeBand", { max: 40 }) ?? "Core",
        prereqIds: idList(body.prereqIds, "prereqIds"),
      })
      .returning();
    await recordAudit({ actor: user, action: "skills.create", resource: "skills", resourceId: created.id, ip });
    return ok({ skill: created }, 201);
  });
}
