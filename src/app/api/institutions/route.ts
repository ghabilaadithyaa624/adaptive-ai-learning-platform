import { eq } from "drizzle-orm";
import { db } from "@/db";
import { institutions } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { getInstitutionList } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser(async () => ok({ institutions: await getInstitutionList() }));
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    if (user.role !== "admin") return fail("Only platform admins can create institutions.", 403);
    const body = (await request.json()) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    if (!name) return fail("Institution name is required.");
    const slug = String(body.slug ?? name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const existing = await db.select({ id: institutions.id }).from(institutions).where(eq(institutions.slug, slug)).limit(1);
    if (existing.length) return fail("An institution with that slug already exists.", 409);

    const [created] = await db
      .insert(institutions)
      .values({
        name,
        slug,
        type: String(body.type ?? "school"),
        plan: String(body.plan ?? "growth"),
        region: String(body.region ?? "Global"),
        seats: toNumber(body.seats, 0),
      })
      .returning();
    return ok({ institution: created }, 201);
  });
}
