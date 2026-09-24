import { eq } from "drizzle-orm";
import { db } from "@/db";
import { institutions } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { getInstitutionList } from "@/lib/queries";
import { conflict } from "@/lib/http";
import { optString, readJsonBody, reqString } from "@/lib/validation";
import { isPlatformAdmin, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    // Institution list reveals every tenant — restrict to account admins and
    // scope institution admins to their own institution.
    requireCapability(user, "manageInstitutions", "You do not have permission to view institutions.", "institutions.list");
    const institutionId = isPlatformAdmin(user) ? undefined : user.institutionId ?? -1;
    return ok({ institutions: await getInstitutionList(institutionId ?? undefined) });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "createInstitution", "Only platform admins can create institutions.", "institutions.create");
    const body = await readJsonBody(request);
    const name = reqString(body.name, "Institution name", { max: 200 });
    const slug = (optString(body.slug, "slug", { max: 80 }) ?? name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const existing = await db.select({ id: institutions.id }).from(institutions).where(eq(institutions.slug, slug)).limit(1);
    if (existing.length) throw conflict("An institution with that slug already exists.");

    const [created] = await db
      .insert(institutions)
      .values({
        name,
        slug,
        type: optString(body.type, "type", { max: 40 }) ?? "school",
        plan: optString(body.plan, "plan", { max: 40 }) ?? "growth",
        region: optString(body.region, "region", { max: 80 }) ?? "Global",
        seats: toNumber(body.seats, 0),
      })
      .returning();
    await recordAudit({ actor: user, action: "institutions.create", resource: "institutions", resourceId: created.id, ip });
    return ok({ institution: created }, 201);
  });
}
