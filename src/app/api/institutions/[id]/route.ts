import { eq } from "drizzle-orm";
import { db } from "@/db";
import { institutions, users } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { badRequest, forbidden } from "@/lib/http";
import { optString, parseId, readJsonBody } from "@/lib/validation";
import { assertInstitutionAccess, isPlatformAdmin, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageInstitutions", "Only administrators can edit institutions.", "institutions.update");
    const { id } = await params;
    const institutionId = parseId(id);
    // Institution admins may only edit their own tenant; platform admins any.
    await assertInstitutionAccess(user, institutionId, "institutions.update");
    const body = await readJsonBody(request);
    const patch: Partial<typeof institutions.$inferInsert> = {};
    if (body.name !== undefined) patch.name = optString(body.name, "name", { max: 200 });
    if (body.type !== undefined) patch.type = optString(body.type, "type", { max: 40 });
    if (body.plan !== undefined) patch.plan = optString(body.plan, "plan", { max: 40 });
    if (body.region !== undefined) patch.region = optString(body.region, "region", { max: 80 });
    if (body.seats !== undefined) patch.seats = toNumber(body.seats, 0);
    if (!Object.keys(patch).length) throw badRequest("Nothing to update.");
    const [updated] = await db.update(institutions).set(patch).where(eq(institutions.id, institutionId)).returning();
    if (!updated) throw badRequest("Institution not found.");
    await recordAudit({ actor: user, action: "institutions.update", resource: "institutions", resourceId: institutionId, ip });
    return ok({ institution: updated });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    if (!isPlatformAdmin(user)) throw forbidden("Only platform admins can delete institutions.", "institutions.delete");
    const { id } = await params;
    const institutionId = parseId(id);
    await db.update(users).set({ institutionId: null }).where(eq(users.institutionId, institutionId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await recordAudit({ actor: user, action: "institutions.delete", resource: "institutions", resourceId: institutionId, ip });
    return ok({ deleted: true });
  });
}
