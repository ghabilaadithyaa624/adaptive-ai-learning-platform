import { eq } from "drizzle-orm";
import { db } from "@/db";
import { institutions, users } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role !== "admin" && user.role !== "institution") {
      return fail("Only administrators can edit institutions.", 403);
    }
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Partial<typeof institutions.$inferInsert> = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.type !== undefined) patch.type = String(body.type);
    if (body.plan !== undefined) patch.plan = String(body.plan);
    if (body.region !== undefined) patch.region = String(body.region);
    if (body.seats !== undefined) patch.seats = toNumber(body.seats, 0);
    if (!Object.keys(patch).length) return fail("Nothing to update.");
    const [updated] = await db.update(institutions).set(patch).where(eq(institutions.id, Number(id))).returning();
    if (!updated) return fail("Institution not found", 404);
    return ok({ institution: updated });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role !== "admin") return fail("Only platform admins can delete institutions.", 403);
    const { id } = await params;
    const institutionId = Number(id);
    await db.update(users).set({ institutionId: null }).where(eq(users.institutionId, institutionId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    return ok({ deleted: true });
  });
}
